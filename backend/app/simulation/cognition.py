"""Observable personal growth, derived only from attributable public action records.

This observer never changes decisions, memories, confidence, or the world's rules.
The append-only milestone history survives later disputes and snapshot replay.
"""
from typing import Literal

from pydantic import Field

from app.schemas import StrictModel
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination_models import MessageType
from app.simulation.events import EventType
from app.simulation.investigation import InvestigationStatus
from app.simulation.memory import BeliefOrigin, BeliefStatus, BeliefType, EvidenceKind


Stage = Literal[1, 2, 3, 4]
STAGE_NAMES = {1: "探索者", 2: "记录者", 3: "求证者", 4: "引路者"}


class CognitionMilestone(StrictModel):
    stage: Stage
    turn: int = Field(ge=0)
    reason: str
    evidenceIds: tuple[str, ...] = ()


class CognitionProgress(StrictModel):
    current: int = Field(ge=0)
    target: int = Field(ge=1)
    label: str


class CognitionView(StrictModel):
    stage: Stage = 1
    name: str = STAGE_NAMES[1]
    earnedTurn: int = 0
    milestones: tuple[CognitionMilestone, ...] = ()
    nextGoal: str | None = "亲自尝试两种资源或条件，并整理成有来源的个人假设"
    progress: CognitionProgress = Field(default_factory=lambda: CognitionProgress(
        current=0, target=2, label="不同资源或条件的亲历实验"))


def _claim_key(belief):
    return (belief.type, belief.object, belief.conditions, belief.expected_effect)


def _experiment_key(evidence):
    # Repeating a move or the same trial at another square is not a new method.
    return evidence.action, evidence.object, evidence.region, evidence.weather


class CognitionTracker:
    def __init__(self, agent_ids):
        self._views = {agent_id: CognitionView(milestones=(CognitionMilestone(
            stage=1, turn=0, reason="开始亲历探索"),)) for agent_id in agent_ids}
        self._removed = set()
        self._events = {}
        self._event_cursor = 0
        self._checked_evidence = set()
        self._real_effects = {}
        self._effect_events = {}
        self._verification_proofs = {}

    def view(self, agent_id: str) -> CognitionView:
        return self._views[agent_id].model_copy(deep=True)

    def remove(self, agent_id: str):
        self._removed.add(agent_id)

    def members(self):
        return [{"agentId": agent_id, "stage": view.stage, "name": view.name}
                for agent_id, view in self._views.items()]

    def _collect_real_effects(self, memory, events):
        self._events.update((event.event_id, event) for event in events[self._event_cursor:])
        self._event_cursor = len(events)
        for evidence in memory.evidence:
            if evidence.id in self._checked_evidence:
                continue
            self._checked_evidence.add(evidence.id)
            if evidence.kind != EvidenceKind.ACTION_EFFECT or not evidence.energy_delta:
                continue
            # Checking the source action is sufficient; infection metadata is neither
            # consulted nor exposed, even when a memory cites a real-looking event ID.
            for event_id in evidence.event_ids:
                event = self._events.get(event_id)
                if event is None or event.type != EventType.ACTION_EXECUTED or not event.result:
                    continue
                result = event.result
                if (result.success and event.agent_id == evidence.agent_id == result.agent_id
                        and event.turn == evidence.turn == result.turn
                        and result.action == evidence.action
                        and result.position == evidence.position
                        and result.region == evidence.region and result.weather == evidence.weather
                        and result.object == evidence.object == evidence.observed_object
                        and result.energy_after - result.energy_before + result.action_cost
                        == evidence.energy_delta):
                    self._real_effects[evidence.id] = evidence
                    self._effect_events[evidence.id] = event_id
                    break

    def _distinct_effects(self, evidence_ids):
        unique = {}
        for evidence_id in evidence_ids:
            if evidence_id in self._real_effects:
                unique.setdefault(self._effect_events[evidence_id], self._real_effects[evidence_id])
        return tuple(unique.values())

    def _recording_proof(self, agent_id, memory, own):
        distinct = {}
        for evidence in own:
            distinct.setdefault(_experiment_key(evidence), evidence)
        hypotheses = [belief for belief in memory.beliefs
                      if belief.owner_agent_id == agent_id and belief.origin == BeliefOrigin.PERSONAL
                      and belief.type == BeliefType.CONDITIONAL_EFFECT
                      and len([e for e in self._distinct_effects(belief.evidence_ids)
                               if e.agent_id == agent_id]) >= 2]
        if len(distinct) < 2 or not hypotheses:
            return None, min(len(distinct), 2)
        own_sources = [e.id for e in self._distinct_effects(hypotheses[0].evidence_ids)
                       if e.agent_id == agent_id]
        sources = tuple(dict.fromkeys([e.id for e in list(distinct.values())[:2]] + own_sources[:2]))
        return sources, 2

    def _observe_verification(self, memory, messages, turn):
        submissions = {(message.from_agent, message.belief_id, message.evidence_id)
                       for message in messages if message.type == MessageType.SUBMIT_EVIDENCE}
        for belief in memory.beliefs:
            if belief.type != BeliefType.CONDITIONAL_EFFECT or belief.status != BeliefStatus.VERIFIED:
                continue
            evidence = [e for e in self._distinct_effects(belief.evidence_ids)
                        if evaluate_evidence(belief, e) is True]
            if len(evidence) < 3 or len({e.agent_id for e in evidence}) < 2:
                continue
            for actor in {e.agent_id for e in evidence}:
                if actor in self._removed or actor in self._verification_proofs:
                    continue
                received_independent = any((e.agent_id, belief.id, e.id) in submissions
                                           for e in evidence if e.agent_id != actor)
                contributed = ((belief.origin == BeliefOrigin.PERSONAL and belief.owner_agent_id == actor
                                and received_independent)
                               or any((actor, belief.id, e.id) in submissions for e in evidence
                                      if e.agent_id == actor))
                if contributed:
                    own = next(e.id for e in evidence if e.agent_id == actor)
                    other = next(e.id for e in evidence if e.agent_id != actor)
                    sources = tuple(dict.fromkeys((own, other, *(e.id for e in evidence))))
                    self._verification_proofs[actor] = (turn, sources)

    def _guidance_proof(self, agent_id, memory, cases, messages):
        progress = 0
        for case in cases:
            original = memory.get(case.root_belief_id)
            counter = [self._real_effects[i] for i in case.evidence_ids
                       if i in self._real_effects and self._real_effects[i].agent_id == agent_id
                       and evaluate_evidence(original, self._real_effects[i]) is False]
            if not counter:
                continue
            progress = max(progress, 1)
            if case.status != InvestigationStatus.REPAIRED or not case.replacement_belief_id:
                continue
            progress = max(progress, 2)
            replacement = memory.get(case.replacement_belief_id)
            for message in messages:
                if (message.type != MessageType.SHARE_BELIEF or message.from_agent != agent_id
                        or message.turn < case.updated_turn or not message.belief
                        or _claim_key(message.belief) != _claim_key(replacement)):
                    continue
                support = [e for e in self._distinct_effects(message.belief.evidence_ids)
                           if evaluate_evidence(message.belief, e) is True]
                delivered = any(belief.lineage and belief.lineage.message_id == message.id
                                and belief.lineage.sender_agent_id == agent_id
                                and belief.owner_agent_id != agent_id for belief in memory.beliefs)
                if len(support) >= 3 and len({e.agent_id for e in support}) >= 2 and delivered:
                    return tuple(dict.fromkeys([counter[0].id, *(e.id for e in support)])), 3
        return None, progress

    def _promote(self, agent_id, stage, turn, reason, evidence_ids):
        previous = self._views[agent_id]
        self._views[agent_id] = previous.model_copy(update={
            "stage": stage, "name": STAGE_NAMES[stage], "earnedTurn": turn,
            "milestones": (*previous.milestones, CognitionMilestone(
                stage=stage, turn=turn, reason=reason, evidenceIds=evidence_ids)),
        })

    def observe(self, agents, memory, swarm, investigation, events, turn):
        self._collect_real_effects(memory, events)
        self._observe_verification(memory, swarm.messages, turn)
        for agent in agents:
            if agent.id in self._removed:
                continue
            own = [e for e in self._real_effects.values() if e.agent_id == agent.id]
            recording, experiments = self._recording_proof(agent.id, memory, own)
            verification = self._verification_proofs.get(agent.id)
            guidance, guide_progress = self._guidance_proof(
                agent.id, memory, investigation.cases, swarm.messages)
            if self._views[agent.id].stage == 1 and recording:
                self._promote(agent.id, 2, turn, "亲历不同资源或条件的实验，并形成有来源的个人假设", recording)
            if self._views[agent.id].stage == 2 and verification:
                self._promote(agent.id, 3, turn, "自己的实验与另一位成员的独立证据共同完成核验", verification[1])
            if self._views[agent.id].stage == 3 and guidance:
                self._promote(agent.id, 4, turn, "提供反证完成调查，并将有来源的修正结论传给同伴", guidance)
            view = self._views[agent.id]
            if view.stage == 1:
                goal = ("将亲历实验整理成有来源的个人条件假设" if experiments == 2 else
                        "亲自尝试两种资源或条件，并整理成有来源的个人假设")
                progress = CognitionProgress(current=experiments, target=2, label="不同资源或条件的亲历实验")
            elif view.stage == 2:
                goal = "贡献自己的实验，与另一位成员的独立证据完成一次核验"
                progress = CognitionProgress(current=int(bool(own)), target=2, label="亲历实验与独立互证")
            elif view.stage == 3:
                goal = ("为争议调查提供亲历反证", "与同伴完成有反证支持的调查修复",
                        "将修正结论连同来源传给同伴，并获得实际采纳")[min(guide_progress, 2)]
                progress = CognitionProgress(current=guide_progress, target=3, label="反证、修复与传知")
            else:
                goal = None
                progress = CognitionProgress(current=3, target=3, label="反证、修复与传知闭环")
            self._views[agent.id] = view.model_copy(update={"nextGoal": goal, "progress": progress})
