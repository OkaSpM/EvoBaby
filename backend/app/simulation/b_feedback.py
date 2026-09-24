"""Current local reliability, separate from the append-only growth milestones."""
from copy import deepcopy

from app.simulation.b_evidence import checked_effects, claim_signature, narrower
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination_models import MessageType
from app.simulation.memory import BeliefStatus, BeliefType


METHOD_LABELS = {1: "亲历探索", 2: "带条件记录", 3: "独立反证核验", 4: "协调修正传知"}
LABELS = {"stable": "持续观察", "review": "待复核", "misaligned": "判断失准",
          "rebuilding": "正在重建", "recovered": "复核恢复"}


class BFeedbackTracker:
    def __init__(self, agent_ids):
        self._views = {agent_id: self._initial() for agent_id in agent_ids}
        self._episodes = {}

    @staticmethod
    def _initial():
        return {"state": "stable", "label": LABELS["stable"], "reason": "尚无关联反例需要复核。",
                "since_turn": 0, "ruleIds": [], "methodLabel": METHOD_LABELS[1], "stage": 1}

    def view(self, agent_id):
        return deepcopy(self._views.get(agent_id, self._initial()))

    def views(self):
        return deepcopy(self._views)

    def observe(self, agents, memory, swarm, events, turn, cognition, action_log=(), tasks=None):
        real = checked_effects(memory.evidence, events, turn)
        for agent in agents:
            personal, shared = memory.memories_for(agent)
            held = (*personal, *shared)
            reachable = {key: sample for key, sample in real.items() if sample.agent_id == agent.id}
            for belief in held:
                for evidence_id in belief.evidence_ids:
                    if evidence_id in real:
                        reachable[evidence_id] = real[evidence_id]
            for message in swarm.messages:
                if (message.type == MessageType.SUBMIT_EVIDENCE and message.evidence_id in real
                        and message.belief_id in {belief.id for belief in held}):
                    reachable[message.evidence_id] = real[message.evidence_id]
            for belief in held:
                if belief.type != BeliefType.CONDITIONAL_EFFECT or belief.status == BeliefStatus.REVOKED:
                    continue
                counters = [sample for sample in reachable.values()
                            if evaluate_evidence(belief, sample) is False]
                if counters:
                    key = (agent.id, belief.id)
                    self._episodes.setdefault(key, {"belief_id": belief.id, "turn": turn})
            episodes = [episode for (owner, _), episode in self._episodes.items() if owner == agent.id]
            unresolved, rebuilt, recovered = [], [], []
            for episode in episodes:
                old = memory.get(episode["belief_id"])
                replacements = []
                for belief in held:
                    if (belief.status != BeliefStatus.VERIFIED or not narrower(belief, old)
                            or belief.updated_turn < episode["turn"]):
                        continue
                    support = [real[evidence_id] for evidence_id in belief.evidence_ids if evidence_id in real
                               and evaluate_evidence(belief, real[evidence_id]) is True]
                    if (len(support) >= 3 and len({sample.agent_id for sample in support}) >= 2
                            and not any(evaluate_evidence(belief, sample) is False for sample in reachable.values())):
                        replacements.append(belief)
                if old.status == BeliefStatus.REVOKED and replacements:
                    recovered.append(episode)
                elif old.status == BeliefStatus.REVOKED:
                    rebuilt.append(episode)
                else:
                    unresolved.append(episode)
            state, reason = "stable", "尚无关联反例需要复核。"
            pending = unresolved + rebuilt
            rule_ids = [episode["belief_id"] for episode in pending]
            if pending:
                state, reason = "review", "已有亲历或实际送达的反例；相关说法暂停无条件使用与发布。"
                if rebuilt:
                    state, reason = "rebuilding", "旧说法已撤回，正在等待可验证的新条件规则。"
                task = tasks.get(agent.active_task) if tasks and agent.active_task else None
                related_task = bool(task and task.belief_id and any(
                    claim_signature(memory.get(task.belief_id)) == claim_signature(memory.get(episode["belief_id"]))
                    for episode in pending))
                if related_task:
                    state, reason = "rebuilding", "带着反例继续认领核验；求证行动保留，尚不宣称恢复。"
                attempts = [item for item in action_log if item["agent_id"] == agent.id
                            and item.get("blocked_rule_ids") and item["turn"] >= min(e["turn"] for e in pending)]
                if attempts and attempts[-1]["turn"] == turn and not related_task:
                    state, reason = "misaligned", "仍尝试使用待复核说法；本次已拦下，需先补证再采纳。"
            elif recovered:
                state, reason = "recovered", "已撤回旧说法，并持有可验证的更窄规则；历史成长保留。"
            previous = self._views[agent.id]
            stage = cognition.view(agent.id).stage
            self._views[agent.id] = {
                "state": state, "label": LABELS[state], "reason": reason,
                "since_turn": previous["since_turn"] if previous["state"] == state else turn,
                "ruleIds": sorted(set(rule_ids)), "methodLabel": METHOD_LABELS[stage], "stage": stage,
            }
