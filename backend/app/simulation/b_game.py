"""B-only closure and local feedback gates, without altering legacy game rules."""
from copy import deepcopy

from app.schemas import Action
from app.simulation.b_evidence import checked_effects, narrower
from app.simulation.b_policy import countered, owned
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination_models import TaskType
from app.simulation.corruption import IncidentStatus
from app.simulation.memory import BeliefStatus, ExpectedEffect
from app.simulation.merged_game import LABELS, MergedGame, TERMINAL
from app.simulation.task_engine import claim_key


class BMergedGame(MergedGame):
    def __init__(self, engine, optional_choices=True, max_attack_turns=60):
        self.first_counterexamples = {}
        self.confirmed_incidents = set()
        self.observation_complete = False
        self.continuation_count = 0
        self._observation_deadline = None
        self._snapshot_sequence = 0
        self.review_builder = None
        super().__init__(engine, optional_choices, max_attack_turns)

    def _on_counter(self, prior, updated, evidence, turn):
        if checked_effects((evidence,), self.engine.event_log.events, turn):
            for incident in self.engine.corruption.incidents:
                root = self.engine.belief_engine.get(incident.root_belief_id)
                if (claim_key(root) == claim_key(prior) and evidence.turn >= incident.injected_turn
                        and evaluate_evidence(root, evidence) is False):
                    previous = self.first_counterexamples.get(incident.id)
                    if previous is None or evidence.turn < previous["turn"]:
                        self.first_counterexamples[incident.id] = {
                            "turn": evidence.turn, "noticed_turn": turn, "evidence_id": evidence.id,
                        }
        return super()._on_counter(prior, updated, evidence, turn)

    def _adoption_allowed(self, agent, belief, sender, message_id, turn):
        context = self.engine._context(agent, self.engine.world.observe(agent))
        if countered(context, belief):
            return False
        return super()._adoption_allowed(agent, belief, sender, message_id, turn)

    def filter_action(self, agent, proposed):
        action = super().filter_action(agent, proposed)
        context = self.engine._context(agent, self.engine.world.observe(agent))
        task = context.active_task
        testing = bool(task and task.type in (TaskType.INVESTIGATION, TaskType.VERIFICATION))
        blocked = []
        supported_replacement = False
        if proposed == Action.USE_MOSS and not testing:
            for belief in owned(context):
                if (belief.status != BeliefStatus.REVOKED
                        and belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE
                        and belief.object == context.observation.object
                        and (belief.conditions.region is None or belief.conditions.region == context.observation.region)
                        and (belief.conditions.weather is None or belief.conditions.weather == context.observation.weather)
                        and countered(context, belief)):
                    if self._safe_narrower(context, belief):
                        supported_replacement = True
                        continue
                    blocked.append(belief.id)
            if blocked:
                action = self.engine.policy.explore(context, self.engine._agent_rngs[agent.id])
            elif (supported_replacement and action == Action.INSPECT and self.choices.get("D2") == "A"
                  and not task and not any(owner == agent.id for owner, _ in self._pending_adoptions)):
                action = proposed
        self.engine.method_actions.append({"agent_id": agent.id, "turn": self.engine.world.turn,
                                          "stage": context.cognition_stage, "proposed": proposed.value,
                                          "action": action.value, "testing": testing,
                                          "blocked_rule_ids": blocked})
        return action

    def _safe_narrower(self, context, original):
        current = context.observation
        for belief in owned(context):
            if (belief.status != BeliefStatus.VERIFIED or not narrower(belief, original)
                    or (belief.conditions.region is not None and belief.conditions.region != current.region)
                    or (belief.conditions.weather is not None and belief.conditions.weather != current.weather)
                    or countered(context, belief)):
                continue
            cited = [self.engine.belief_engine.evidence_by_id(evidence_id) for evidence_id in belief.evidence_ids]
            real = checked_effects(cited, self.engine.event_log.events, self.engine.world.turn)
            support = [sample for sample in real.values() if evaluate_evidence(belief, sample) is True]
            if len(support) >= 3 and len({sample.agent_id for sample in support}) >= 2:
                return True
        return False

    async def after_step(self):
        if self.complete or self.awaiting_choice:
            return self.state_fields()
        if len(self.engine.corruption.incidents) < 2:
            await super().after_step()
            self._capture_new_counters()
            self._refresh_feedback()
            return self.state_fields()
        if self._settle_adoptions():
            self.engine.cognition.observe(self.engine.agents, self.engine.belief_engine, self.engine.swarm,
                                          self.engine.investigation, self.engine.event_log.events,
                                          self.engine.world.turn)
        for incident_id, pair in tuple(self._broadcast_pending.items()):
            self._apply_counter(*pair, revoke=self.choices.get("D2") == "C")
            del self._broadcast_pending[incident_id]
        self._capture_new_counters()
        self._refresh_feedback()
        incidents = self.engine.corruption.incidents
        second = incidents[1]
        if self._observation_deadline is None:
            self._observation_deadline = second.injected_turn + self.max_attack_turns
        terminal = (second.status in TERMINAL if self.continuation_count == 0
                    else all(incident.status in TERMINAL for incident in incidents))
        if terminal or self.engine.world.turn >= self._observation_deadline:
            self._finish()
        return self.state_fields()

    def _refresh_feedback(self):
        engine = self.engine
        engine.feedback.observe(engine.agents, engine.belief_engine, engine.swarm, engine.event_log.events,
                                engine.world.turn, engine.cognition, engine.method_actions, engine.task_engine)

    def _capture_new_counters(self):
        engine = self.engine
        real = checked_effects(engine.belief_engine.evidence, engine.event_log.events, engine.world.turn)
        for incident in engine.corruption.incidents:
            root = engine.belief_engine.get(incident.root_belief_id)
            family = (root.id, *engine.swarm.descendants(root.id, engine.belief_engine))
            ids = {evidence_id for belief_id in family
                   for evidence_id in engine.belief_engine.get(belief_id).evidence_ids}
            counters = [real[evidence_id] for evidence_id in ids if evidence_id in real
                        and real[evidence_id].turn >= incident.injected_turn
                        and evaluate_evidence(root, real[evidence_id]) is False]
            if not counters:
                continue
            first = min(counters, key=lambda sample: (sample.turn, sample.id))
            previous = self.first_counterexamples.get(incident.id)
            if previous is None or first.turn < previous["turn"]:
                self.first_counterexamples[incident.id] = {"turn": first.turn,
                    "noticed_turn": engine.world.turn, "evidence_id": first.id}

    def closure(self):
        incidents = self.engine.corruption.incidents
        pending = [incident.id for incident in incidents if incident.id not in self.confirmed_incidents]
        repaired = len(incidents) >= 2 and all(incident.status == IncidentStatus.REPAIRED for incident in incidents)
        open_cases = any(incident.status not in TERMINAL for incident in incidents)
        status, title, reason = "playing", "调查仍在推进", "发现异常、修正规则与玩家追源分别记录。"
        if self.observation_complete:
            if repaired and not pending:
                status, title = "success", "协作破局 · 两案完整查明"
                reason = "两案均完成规则修复，且玩家逐案正确确认了零号记忆。"
            elif repaired:
                status, title = "awaiting_trace", "规则已修复，等待你确认源头"
                reason = "部落完成了两案实验修复；玩家追源尚未齐全，暂不生成成功卡。"
            elif any(incident.status in TERMINAL for incident in incidents):
                status, title = "partial", "阶段留档 · 调查尚未完整闭环"
                reason = "已有止损或修复，但并非两案都已修复并追源；此卡不是完整成功。"
            else:
                status, title = "unresolved", "调查未竟 · 继续寻找证据"
                reason = "观察预算已用完，案件尚未修复；时间结束不等于发现或解决。"
        return {"status": status, "title": title, "reason": reason,
                "can_continue": self.observation_complete and open_cases,
                "observation_complete": self.observation_complete,
                "pending_incident_ids": pending, "continuation_count": self.continuation_count}

    def protocol_review(self):
        choices = self.choices
        incidents = self.engine.corruption.incidents
        summaries = []
        status_labels = {"INJECTED": "尚待发现", "VERIFYING": "采纳前核验", "SPREADING": "说法传播中",
                         "DISPUTED": "公开争议", "INVESTIGATING": "对照调查中", "REPAIRED": "规则已修复",
                         "REVOKED": "旧说法已撤回", "PREVENTED": "采纳前已阻止"}
        for incident in incidents:
            first = self.first_counterexamples.get(incident.id)
            timing = f"T{first['turn']}出现真实反例，" if first else "首条关联反例未记录，"
            if incident.detected_turn is not None and incident.detected_turn >= incident.injected_turn:
                timing += f"T{incident.detected_turn}公开发现，"
            summaries.append(f"第{incident.attack_number}案：{timing}{status_labels[incident.status.value]}。")
        descriptions = {
            "D2": {
                "A": ("反例触发广播与暂停普通误用，调查试验仍可继续。", "传播更快，也可能暂停尚未被推翻的相关使用。"),
                "B": ("同一成员先累计本地反例，再交给公共调查。", "减少过早报警，但可能拉长发现延迟。"),
                "C": ("先撤回旧说法，不把撤回当作完整修复。", "可以止损，却未补出遗漏条件。"),
                "D": ("不新增公共争议流程；个人反例仍保留。", "本地疑点可能长期无法汇合成共同调查。"),
            },
            "D3": {
                "A": ("检查遗漏的地域与天气条件。", "覆盖更广，需要额外移动、等待与实验。"),
                "B": ("验证门槛增加到三位证据贡献者。", "三个人不一定覆盖三个不同场景。"),
                "C": ("采纳前先取得自己的可用实验回证。", "降低盲从，同时增加采纳等待。"),
                "D": ("没有新增验证制度。", "保留速度，也保留原有泛化风险。"),
            },
        }
        cards = []
        for point in ("D2", "D3"):
            option = choices.get(point)
            mechanism, tradeoff = descriptions[point].get(option, ("关口尚未选择。", "选择后记录具体代价。"))
            observed = " ".join(summaries) if point == "D2" else "第二案尚未开始，暂不能评估后续表现。"
            if point == "D3" and len(incidents) >= 2:
                metric = self._attack_metrics(incidents[1])
                observed = (f"第二案实际接触 {metric['spread']} 人，记录 {metric['bad_actions']} 次相关误用；"
                            f"采纳前记录 {metric['contexts_before_adoption']} 种真实条件，"
                            f"当前{status_labels[incidents[1].status.value]}。这些事实不单独证明制度产生了改善。")
            cards.append({"id": point, "title": "异常处理" if point == "D2" else "未来验证",
                          "selected": LABELS[point]["ABCD".index(option)] if option else "尚未选择",
                          "mechanism": mechanism, "tradeoff": tradeoff,
                          "observed": observed or "尚无本案反例与处理结果。",
                          "status": "observed" if option and incidents else "chosen" if option else "pending"})
        return {"summary": "协作价值按实际证据与案件结果评审，不按人数、消息数或造型判定。", "cards": cards}

    def _finish(self):
        self.observation_complete = True
        outcome = self.closure()
        self.complete = True
        self.phase = "awaiting_trace" if outcome["status"] == "awaiting_trace" else "complete"
        if outcome["status"] == "awaiting_trace":
            self._paradigm = None
            return
        self._first_metrics = self._attack_metrics(self.engine.corruption.incidents[0])
        super()._finish()
        self._snapshot_sequence += 1
        review = self.review_builder() if self.review_builder else {}
        self._paradigm.update({"b_outcome": outcome, "memberFeedback": self.engine.feedback.views(),
                               "caseChronology": review.get("cases", []),
                               "protocolReview": self.protocol_review(),
                               "snapshot_sequence": self._snapshot_sequence,
                               "edition": "B-collaboration-v4"})

    def confirm_source(self, incident_id):
        self.confirmed_incidents.add(incident_id)
        if self.observation_complete:
            self._finish()

    def continue_investigation(self, turns=60):
        if not self.closure()["can_continue"]:
            raise ValueError("NO_OPEN_INVESTIGATION_TO_CONTINUE")
        self.continuation_count += 1
        self.observation_complete = False
        self.complete = False
        self._paradigm = None
        self.phase = "attack2"
        self._observation_deadline = self.engine.world.turn + turns

    def state_fields(self):
        fields = super().state_fields()
        review = self.review_builder() if self.review_builder else {
            "version": 1, "closure": self.closure(), "cognition_feedback": self.engine.feedback.views(),
            "cases": [], "protocol_review": self.protocol_review(),
        }
        fields["merged_game"]["b_review"] = deepcopy(review)
        return fields
