"""Player-selected cooperation policies; all action outcomes still come from World."""
from collections import Counter
from copy import deepcopy
import random

from app.schemas import Action, Resource
from app.simulation.agent import MOVES
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination_models import MessageIntent, MessageType, TaskType
from app.simulation.corruption import IncidentStatus
from app.simulation.memory import BeliefStatus, BeliefType, EvidenceKind
from app.simulation.meta_models import MetaBelief, VerificationPolicyEffect
from app.simulation.task_engine import claim_key


TERMINAL = {IncidentStatus.REPAIRED, IncidentStatus.REVOKED, IncidentStatus.PREVENTED}
DISPUTES = dict(zip("ABCD", ("broadcast_freeze", "local_recheck", "revoke_only", "ignore")))
METAS = dict(zip("ABCD", ("context_diversity", "source_diversity", "verify_before_adopt", "none")))
LABELS = {
    "D1": ("话最多的", "最孤僻的", "随便挑", "让它自己挑"),
    "D2": ("敲锣", "再试一次", "划掉", "算了"),
    "D3": ("换个地方再试", "三个人才算", "自己先试", "不定规矩"),
    "D4": ("够了", "更挑剔", "必须跨区", "轮流把关"),
}
ENDINGS = {
    "慎信部落": ("🔍", "别人讲的先自己试，慢一点，但不会被传染"),
    "敲锣部落": ("🔔", "出事立刻全部落停，快，但会误伤真常识"),
    "走远部落": ("🧭", "人多不等于地方多"),
    "胆小部落": ("🐚", "谣言进不来了，可部落也不敢再相信任何东西"),
    "健忘部落": ("🌀", "什么都没学到，第二次照样中招"),
    "糊涂部落": ("🌫", "划掉了错的，也不知道为什么错"),
}


def classify_ending(first, second, choices, verified_before, verified_after):
    """Ordered PRD predicates. Missing timings are unknown, never zero."""
    if (second["spread"] <= 1 and second["detect_turns"] is not None
            and second["detect_turns"] <= 3):
        return "慎信部落"
    if (choices.get("D2") == "A" and first["repair_turns"] is not None
            and first["repair_turns"] > 0 and second["repair_turns"] is not None
            and second["repair_turns"] <= first["repair_turns"] / 2):
        return "敲锣部落"
    if choices.get("D3") == "A" and second["bad_actions"] <= 1:
        return "走远部落"
    if (second["spread"] <= 1 and second["bad_actions"] == 0 and verified_before > 0
            and verified_after <= verified_before * 0.7):
        return "胆小部落"
    improved = any(second[key] < first[key] for key in ("spread", "bad_actions"))
    improved |= second["contexts_before_adoption"] > first["contexts_before_adoption"]
    for key in ("detect_turns", "repair_turns"):
        improved |= second[key] is not None and (first[key] is None or second[key] < first[key])
    return "糊涂部落" if improved else "健忘部落"


class MergedGame:
    def __init__(self, engine, optional_choices=False, max_attack_turns=60):
        self.engine = engine
        self.optional_choices = optional_choices
        self.max_attack_turns = max_attack_turns
        self.choices = {}
        self.awaiting_choice = None
        self.phase = "exploring"
        self.complete = False
        self.choice_events = []
        self.policy_events = []
        self._first_counter = None
        self._counters = {}
        self._broadcast_pending = {}
        self._applying = False
        self._first_metrics = None
        self._paradigm = None
        self._verified_before = None
        self._pending_adoptions = {}
        self._adoption_delays = []
        self._reviewers = {}
        self._second_wait_started = None
        self.verify_threshold = 0.75
        self.require_cross_region = False
        self.reviewer_rotation = False
        self.target_policy = "least_counterevidence"
        engine.merged_game = self
        engine.belief_engine.dispute_handler = self._on_counter
        engine.belief_engine.verification_policy = self._verification_allowed
        engine.belief_engine.adoption_policy = self._adoption_allowed

    @property
    def broadcast_enabled(self):
        return self.engine.swarm.broadcast_enabled

    @broadcast_enabled.setter
    def broadcast_enabled(self, enabled):
        self.engine.swarm.broadcast_enabled = bool(enabled)

    def before_step(self):
        if self.awaiting_choice or self.complete:
            raise ValueError("CHOICE_REQUIRED" if self.awaiting_choice else "GAME_COMPLETE")

    def _offer(self, point, title, reason, evidence_ids=()):
        self.awaiting_choice = {
            "point": point, "title": title, "story": reason, "reason": reason,
            "turn": self.engine.world.turn, "evidence_ids": list(evidence_ids),
            "options": [{"key": option, "option": option, "title": label, "label": label}
                        for option, label in zip("ABCD", LABELS[point])],
        }

    def _verified_count(self):
        return len({claim_key(b) for b in self.engine.belief_engine.beliefs
                    if b.status == BeliefStatus.VERIFIED})

    def _family(self, belief):
        return tuple(b for b in self.engine.belief_engine.beliefs
                     if claim_key(b) == claim_key(belief) and b.status != BeliefStatus.REVOKED)

    def _on_counter(self, prior, updated, evidence, turn):
        if self._applying or prior.type != BeliefType.CONDITIONAL_EFFECT:
            return BeliefStatus.DISPUTED
        incident = next((item for item in self.engine.corruption.incidents
                         if claim_key(self.engine.belief_engine.get(item.root_belief_id)) == claim_key(prior)), None)
        if incident is None:
            return BeliefStatus.DISPUTED
        key = (incident.id, evidence.agent_id)
        local = self._counters.setdefault(key, [])
        if evidence.id not in local:
            local.append(evidence.id)
        if self._first_counter is None:
            self._first_counter = (prior.id, evidence.id)
        option = self.choices.get("D2")
        if option is None:
            return BeliefStatus.VERIFIED
        if option == "D":
            return BeliefStatus.VERIFIED
        if option == "B" and len(local) < 3:
            return BeliefStatus.VERIFIED
        self._broadcast_pending[incident.id] = (prior.id, evidence.id)
        return BeliefStatus.DISPUTED if option != "C" else BeliefStatus.VERIFIED

    def _apply_counter(self, belief_id, evidence_id, revoke=False):
        engine = self.engine
        memory = engine.belief_engine
        belief = memory.get(belief_id)
        family = self._family(belief)
        self._applying = True
        try:
            for held in family:
                updated = memory.submit_evidence(held.id, evidence_id, turn=engine.world.turn)
                if updated.status != BeliefStatus.DISPUTED:
                    updated = updated.model_copy(update={"status": BeliefStatus.DISPUTED,
                                                         "updated_turn": engine.world.turn})
                    memory._beliefs[held.id] = updated
                    memory._change(updated, "BELIEF_DISPUTED", held.status, evidence_id)
                if not revoke:
                    owner = next(agent for agent in engine.agents if agent.id == held.owner_agent_id)
                    engine.swarm.dispatch(owner, MessageIntent(type=MessageType.RAISE_DISPUTE,
                                                               belief_id=held.id), engine.agents,
                                          memory, engine.task_engine, engine.world.turn)
            engine.corruption.sync(memory, engine.swarm, engine.task_engine,
                                   turn=engine.world.turn, event_cursor=len(engine.event_log.events))
            if revoke:
                revoked = tuple(memory.revoke_disputed(held.id, turn=engine.world.turn).id
                                for held in family)
                root = engine.swarm.root_ancestor(belief.id, memory)
                engine.corruption.record_resolution(root, None, revoked, None, turn=engine.world.turn)
            engine.task_engine.sync(engine.agents, memory, engine.world.turn)
            self.policy_events.append({"type": "REVOKE_WITHOUT_INVESTIGATION" if revoke else "BROADCAST_FREEZE",
                                       "turn": engine.world.turn, "belief_ids": [b.id for b in family],
                                       "evidence_id": evidence_id})
        finally:
            self._applying = False

    def _verification_allowed(self, belief):
        if belief.confidence < self.verify_threshold:
            return False
        if len(belief.independent_agent_ids) < self.engine.belief_engine.minimum_independent_agents:
            return False
        if self.require_cross_region and belief.type == BeliefType.CONDITIONAL_EFFECT:
            regions = {self.engine.belief_engine.evidence_by_id(i).region for i in belief.evidence_ids}
            if len(regions) < 2:
                return False
        if self.reviewer_rotation:
            reviewer = self._reviewers.setdefault(
                claim_key(belief), self.engine.agents[len(self._reviewers) % len(self.engine.agents)].id)
            if reviewer not in belief.independent_agent_ids:
                return False
        return True

    def _adoption_allowed(self, agent, belief, sender, message_id, turn):
        if not self.broadcast_enabled:
            return False
        if self.choices.get("D3") != "C":
            return True
        support = any(e.kind == EvidenceKind.ACTION_EFFECT and evaluate_evidence(belief, e) is True
                      for e in self.engine.belief_engine.evidence_for(agent.id))
        if belief.type != BeliefType.CONDITIONAL_EFFECT or support:
            return True
        self._pending_adoptions.setdefault((agent.id, belief.id), {
            "sender": sender, "message_id": message_id, "turn": turn,
        })
        return False

    def _local_trial_action(self, agent, belief, fallback, position=None):
        observation = self.engine.world.observe(agent)
        candidates = [item.position for item in agent.known_cells.values()
                      if item.object == belief.object
                      and (belief.conditions.region is None or item.region == belief.conditions.region)]
        if position is not None:
            candidates = [position]
        if not candidates or agent.energy < 12:
            return fallback
        x, y = agent.position
        target = min(candidates, key=lambda p: (abs(x - p[0]) + abs(y - p[1]), p))
        if target != agent.position:
            moves = [(action, (x + dx, y + dy)) for action, (dx, dy) in MOVES
                     if 0 <= x + dx < 8 and 0 <= y + dy < 8]
            return min(moves, key=lambda item: abs(item[1][0] - target[0]) + abs(item[1][1] - target[1]))[0]
        if belief.conditions.weather is not None and observation.weather != belief.conditions.weather:
            return Action.INSPECT
        return Action.USE_MOSS if observation.object == Resource.MOSS else fallback

    def filter_action(self, agent, proposed):
        if self.choices.get("D2") == "B":
            for (incident_id, owner), ids in self._counters.items():
                if owner != agent.id or not 0 < len(ids) < 3:
                    continue
                incident = next(item for item in self.engine.corruption.incidents if item.id == incident_id)
                if incident.status in TERMINAL:
                    continue
                belief = self.engine.belief_engine.get(incident.root_belief_id)
                evidence = self.engine.belief_engine.evidence_by_id(ids[0])
                return self._local_trial_action(agent, belief, proposed, evidence.position)
        for (owner, belief_id), request in self._pending_adoptions.items():
            if owner == agent.id:
                belief = self.engine.belief_engine.get(belief_id)
                return self._local_trial_action(agent, belief, proposed)
        if self.choices.get("D2") == "A" and proposed == Action.USE_MOSS:
            task = self.engine.task_engine.get(agent.active_task) if agent.active_task else None
            if task is None or task.type != TaskType.INVESTIGATION:
                observation = self.engine.world.observe(agent)
                if any(b.status == BeliefStatus.DISPUTED and b.object == Resource.MOSS
                       and (b.conditions.region is None or b.conditions.region == observation.region)
                       and (b.conditions.weather is None or b.conditions.weather == observation.weather)
                       for b in self.engine.belief_engine.beliefs):
                    return Action.INSPECT
        return proposed

    def _apply_meta(self, option):
        memory = self.engine.belief_engine
        if option == "A":
            meta = MetaBelief(id="MB1", principle="独立的人数不等于独立的场景；泛化结论需要跨场景验证。",
                              learned_from_incident_id=self.engine.corruption.incidents[0].id,
                              created_turn=self.engine.world.turn,
                              policy_effect=VerificationPolicyEffect(dimensions=("region", "weather")))
            self.engine.meta_belief_engine._beliefs[meta.id] = meta
            memory.activate_meta_beliefs((meta,), turn=self.engine.world.turn)
        elif option == "B":
            memory.minimum_independent_agents = 3
        self._reevaluate()

    def _reevaluate(self):
        memory = self.engine.belief_engine
        for belief in memory.beliefs:
            if belief.status == BeliefStatus.VERIFIED and not memory._verification_eligible(belief):
                updated = belief.model_copy(update={"status": BeliefStatus.TENTATIVE,
                                                     "updated_turn": self.engine.world.turn})
                memory._beliefs[belief.id] = updated
                memory._change(updated, "BELIEF_UPDATED", belief.status)

    def _set_targets(self):
        agents = self.engine.agents
        if self.target_policy == "least_counterevidence":
            self.engine.corruption.target_preference = ()
            return
        shares = Counter(message.from_agent for message in self.engine.swarm.messages
                         if message.type == MessageType.SHARE_BELIEF)
        names = [agent.id for agent in agents]
        if self.target_policy == "most_active":
            names.sort(key=lambda name: (-shares[name], name))
        elif self.target_policy == "isolated":
            activity = {agent.id: shares[agent.id] + len(agent.adopted_shared_beliefs) for agent in agents}
            names.sort(key=lambda name: (activity[name], name))
        elif self.target_policy == "random":
            random.Random(self.engine.config.seed + len(self.engine.corruption.incidents)).shuffle(names)
        self.engine.corruption.target_preference = tuple(names)

    async def inject(self, second=False, target_policy=None):
        if target_policy:
            if target_policy not in ("most_active", "isolated", "random", "least_counterevidence"):
                raise ValueError("UNKNOWN_TARGET_POLICY")
            self.target_policy = target_policy
        self._set_targets()
        if not second:
            self._verified_before = self._verified_count()
            incident = await self.engine.inject_false_memory_async()
        else:
            first = self.engine.corruption.incidents[0]
            other = "weather" if first.omitted_condition == "region" else "region"
            incident = await self.engine.corruption._inject(
                self.engine.world, self.engine.agents, self.engine.belief_engine,
                self.engine._experimental_reasoning, turn=self.engine.world.turn,
                attack_number=2, omitted_condition=other, event_cursor=len(self.engine.event_log.events))
        self.phase = "attack2" if second else "attack1"
        return incident

    async def choose(self, point, option):
        if self.awaiting_choice is None or self.awaiting_choice["point"] != point:
            raise ValueError("CHOICE_NOT_PENDING")
        if option not in "ABCD" or len(option) != 1:
            raise ValueError("INVALID_CHOICE_OPTION")
        self.choices[point] = option
        self.choice_events.append({"point": point, "option": option, "turn": self.engine.world.turn})
        self.awaiting_choice = None
        if point == "D1":
            self.target_policy = dict(zip("ABCD", ("most_active", "isolated", "random", "least_counterevidence")))[option]
            await self.inject()
        elif point == "D2":
            if option in "AC":
                self._apply_counter(*self._first_counter, revoke=option == "C")
        elif point == "D3":
            self._apply_meta(option)
            self._second_wait_started = self.engine.world.turn
            if self.optional_choices:
                self._offer("D4", "第二次谣言前，还要改变门槛吗？", "这次加码会改变后续验证门槛与任务。")
            else:
                await self._try_second()
        elif point == "D4":
            self.verify_threshold = 0.9 if option == "B" else self.verify_threshold
            self.require_cross_region = option == "C"
            self.reviewer_rotation = option == "D"
            self._reevaluate()
            await self._try_second()
        await self.after_step()
        return self.state_fields()

    async def _try_second(self):
        if len(self.engine.corruption.incidents) >= 2:
            return
        try:
            await self.inject(second=True)
        except ValueError as error:
            if str(error) != "NO_VALID_CORRUPTION_CANDIDATE":
                raise
            self.phase = "awaiting_second_candidate"

    def _settle_adoptions(self):
        if not self.broadcast_enabled:
            return False
        changed = False
        memory = self.engine.belief_engine
        for (owner, belief_id), request in tuple(self._pending_adoptions.items()):
            belief = memory.get(belief_id)
            evidence = memory.evidence_for(owner)
            tested = [e for e in evidence if e.turn >= request["turn"] and e.kind == EvidenceKind.ACTION_EFFECT
                      and evaluate_evidence(belief, e) is not None]
            if belief.status != BeliefStatus.VERIFIED or any(evaluate_evidence(belief, e) is False for e in tested):
                del self._pending_adoptions[(owner, belief_id)]
            elif tested:
                agent = next(a for a in self.engine.agents if a.id == owner)
                adopted = memory.adopt_shared(agent, belief_id, sender_agent_id=request["sender"],
                                             message_id=request["message_id"], turn=self.engine.world.turn)
                if adopted:
                    changed = True
                    self._adoption_delays.append(self.engine.world.turn - request["turn"])
                    del self._pending_adoptions[(owner, belief_id)]
        return changed

    async def after_step(self):
        if self.complete or self.awaiting_choice:
            return self.state_fields()
        if self._settle_adoptions():
            # Deferred recipient confirmation can complete teaching after the
            # engine's normal end-of-turn observation, including the final turn.
            self.engine.cognition.observe(
                self.engine.agents, self.engine.belief_engine, self.engine.swarm,
                self.engine.investigation, self.engine.event_log.events, self.engine.world.turn)
        for incident_id, pair in tuple(self._broadcast_pending.items()):
            self._apply_counter(*pair, revoke=self.choices.get("D2") == "C")
            del self._broadcast_pending[incident_id]
        incidents = self.engine.corruption.incidents
        if not incidents and self.engine.first_attack_ready:
            if self.optional_choices:
                self._offer("D1", "谣言会找上谁？", "部落已有经独立验证的共享知识，第一轮攻击现在可发生。")
            else:
                await self.inject()
            return self.state_fields()
        if incidents and "D2" not in self.choices and self._first_counter:
            belief_id, evidence_id = self._first_counter
            evidence = self.engine.belief_engine.evidence_by_id(evidence_id)
            self._offer("D2", "有人按常识行动，却掉了能量。", f"{evidence.agent_id} 在 {evidence.region.value} / {evidence.weather.value} 使用苔藓，实际能量变化 {evidence.energy_delta:+g}。部落如何处理？", (evidence_id,))
        elif incidents and "D2" in self.choices and "D3" not in self.choices:
            first = incidents[0]
            timeout = self.engine.world.turn - first.injected_turn >= self.max_attack_turns
            if first.status in TERMINAL or timeout:
                self._first_metrics = self._attack_metrics(first)
                reason = ("调查已有实际修复结果。接下来由你决定怎样验证未来常识。" if first.status == IncidentStatus.REPAIRED else
                          "这条常识已被划掉，但没有查出完整规则。仍可选择未来的验证制度。" if first.status == IncidentStatus.REVOKED else
                          f"公开观察窗口已满 {self.max_attack_turns} 回合，事故仍未修复；这不是成功调查。请选择是否改变流程。")
                self._offer("D3", "部落以后如何验证常识？", reason)
        elif len(incidents) == 1 and "D3" in self.choices and not self.awaiting_choice:
            await self._try_second()
        elif len(incidents) >= 2:
            second = incidents[1]
            if second.status in TERMINAL or self.engine.world.turn - second.injected_turn >= self.max_attack_turns:
                self._finish()
        return self.state_fields()

    def _attack_metrics(self, incident):
        metric = next(item for item in self.engine.metrics.attacks if item.incident_id == incident.id)
        detected = incident.detected_turn if incident.detected_turn is not None else incident.disputed_turn
        memory, swarm = self.engine.belief_engine, self.engine.swarm
        family_ids = (incident.root_belief_id, *swarm.descendants(incident.root_belief_id, memory))
        shared = next((message for message in swarm.messages
                       if message.type == MessageType.SHARE_BELIEF and message.belief_id in family_ids), None)
        ids = shared.belief.evidence_ids if shared else tuple(
            evidence_id for belief_id in family_ids for evidence_id in memory.get(belief_id).evidence_ids)
        cutoff = shared.turn if shared else incident.resolved_turn or self.engine.world.turn
        real_contexts = {(e.region, e.weather) for evidence_id in ids
                         if not self.engine.corruption.is_forged(evidence_id)
                         for e in (memory.evidence_by_id(evidence_id),)
                         if e.kind == EvidenceKind.ACTION_EFFECT and e.turn <= cutoff}
        return {"spread": metric.agents_affected,
                "detect_turns": None if detected is None else detected - incident.injected_turn,
                "repair_turns": metric.turns_until_repair,
                "bad_actions": metric.incorrect_actions_caused,
                "contexts_before_adoption": len(real_contexts),
                "reported_contexts_before_adoption": metric.contexts_checked_before_adoption,
                "status": incident.status.value, "injected_turn": incident.injected_turn,
                "resolved_turn": incident.resolved_turn, "observed_until_turn": self.engine.world.turn,
                "censored": incident.status not in TERMINAL}

    def _finish(self):
        incidents = self.engine.corruption.incidents
        first = self._first_metrics or self._attack_metrics(incidents[0])
        second = self._attack_metrics(incidents[1])
        name = classify_ending(first, second, self.choices, self._verified_before or 0, self._verified_count())
        totem, tagline = ENDINGS[name]
        dispute = DISPUTES[self.choices["D2"]]
        meta = METAS[self.choices["D3"]]
        self.complete = True
        self.phase = "complete"
        rules = [f"异常处理：{LABELS['D2']['ABCD'.index(self.choices['D2'])]}",
                 f"未来验证：{LABELS['D3']['ABCD'.index(self.choices['D3'])]}",
                 "个人记录和采纳记录分开保存，共享知识保留来源"]
        self._paradigm = {
            "name": name, "totem": totem, "tagline": tagline, "choices": dict(self.choices),
            "metrics": {"attack1": first, "attack2": second}, "rules": rules,
            "protocol": {"message_types": ["SHARE_BELIEF", "REQUEST_VERIFICATION", "SUBMIT_EVIDENCE", "RAISE_DISPUTE"],
                         "adoption_rule": "verify_before_adopt" if meta == "verify_before_adopt" else "verified_shared_belief",
                         "dispute_rule": "local_recheck:2" if dispute == "local_recheck" else dispute,
                         "meta_rule": meta,
                         "trust_boundary": "personal and shared beliefs stored separately; lineage required"},
            "applies_to": ["shared knowledge base", "multi-agent research", "reconciliation bots"],
            "cost": {"adoption_delay_turns": (sum(self._adoption_delays) / len(self._adoption_delays)
                                               if self._adoption_delays else None),
                     "token_overhead_pct": None, "note": "本次是离线 mock；无真实模型 token 成本，未发生的采纳延迟不填估算值。"},
            "seed": self.engine.config.seed, "completed_turn": self.engine.world.turn,
            "verified_before_attack1": self._verified_before, "verified_at_end": self._verified_count(),
            "observation_window_turns": self.max_attack_turns,
            "memberCognition": self.engine.cognition.members(),
        }

    def paradigm(self):
        return deepcopy(self._paradigm)

    def state_fields(self):
        return {"choices": dict(self.choices), "awaiting_choice": deepcopy(self.awaiting_choice),
                "paradigm": self.paradigm(),
                "merged_game": {"enabled": True, "phase": self.phase, "complete": self.complete,
                                "broadcast_enabled": self.broadcast_enabled,
                                "observation_window_turns": self.max_attack_turns,
                                "pending_local_checks": len(self._pending_adoptions),
                                "policies": {"dispute": DISPUTES.get(self.choices.get("D2")),
                                             "meta": METAS.get(self.choices.get("D3")),
                                             "verify_threshold": self.verify_threshold}}}
