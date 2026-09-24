"""Evidence-first investigation and lineage-wide belief repair."""
from enum import StrEnum

from app.llm.provider import ReasoningService
from app.llm.schemas import ReasoningKind, ReasoningRequest
from app.simulation.agent import AgentState
from app.simulation.belief_engine import BeliefEngine, evaluate_evidence
from app.simulation.coordination_models import MessageIntent, MessageType, TaskType, is_open
from app.simulation.corruption import CorruptionSystem
from app.simulation.memory import (
    Belief, BeliefStatus, BeliefType, ConditionalHypothesis, FrozenModel,
)
from app.simulation.swarm import Swarm
from app.simulation.task_engine import TaskEngine, claim_key


class InvestigationStatus(StrEnum):
    COLLECTING = "COLLECTING"
    REPAIRED = "REPAIRED"
    REVOKED = "REVOKED"


class InvestigationCase(FrozenModel):
    id: str
    task_id: str
    root_belief_id: str
    disputed_belief_id: str
    status: InvestigationStatus = InvestigationStatus.COLLECTING
    opened_turn: int
    updated_turn: int
    evidence_ids: tuple[str, ...] = ()
    replacement_belief_id: str | None = None
    repaired_hypothesis: ConditionalHypothesis | None = None
    revoked_belief_ids: tuple[str, ...] = ()
    resolution: str | None = None


class InvestigationEngine:
    def __init__(self):
        self._cases: dict[str, InvestigationCase] = {}

    @property
    def cases(self) -> tuple[InvestigationCase, ...]:
        return tuple(self._cases.values())

    def _open_cases(self, tasks: TaskEngine, memory: BeliefEngine, swarm: Swarm, turn: int) -> None:
        for task in tasks.tasks:
            if task.type != TaskType.INVESTIGATION or not is_open(task) or task.id in self._cases:
                continue
            disputed = memory.get(task.belief_id)
            root_id = swarm.root_ancestor(disputed.id, memory)
            self._cases[task.id] = InvestigationCase(
                id=f"INV{len(self._cases) + 1}", task_id=task.id,
                root_belief_id=root_id, disputed_belief_id=disputed.id,
                opened_turn=turn, updated_turn=turn,
            )

    async def advance(self, agents: list[AgentState], memory: BeliefEngine, tasks: TaskEngine,
                      swarm: Swarm, corruption: CorruptionSystem, reasoning: ReasoningService,
                      *, turn: int) -> None:
        self._open_cases(tasks, memory, swarm, turn)
        owners = {agent.id: agent for agent in agents}
        for case in self.cases:
            if case.status != InvestigationStatus.COLLECTING:
                continue
            task = tasks.get(case.task_id)
            if not is_open(task):
                continue
            root = memory.get(case.root_belief_id)
            if root.type != BeliefType.CONDITIONAL_EFFECT:
                continue
            # Equivalent erroneous claims can have multiple natural or injected
            # roots.  One shared investigation repairs every held copy of the
            # proposition, while lineage remains available for provenance.
            descendants = tuple(b.id for b in memory.beliefs
                                if b.id != root.id and claim_key(b) == claim_key(root)
                                and b.status != BeliefStatus.REVOKED)
            # A repair is based on experiments performed after the investigation
            # was claimed.  Earlier family evidence explains the dispute but
            # cannot by itself resolve it in the same turn.
            evidence_ids = tuple(i for i in dict.fromkeys(task.evidence_ids)
                                 if not corruption.is_forged(i))
            if evidence_ids == case.evidence_ids:
                continue
            evidence = tuple(memory.evidence_by_id(i) for i in evidence_ids)
            original = ConditionalHypothesis(
                object=root.object, conditions=root.conditions, effect=root.expected_effect,
                reason="This previously verified claim received direct counterevidence.",
            )
            updated = case.model_copy(update={
                "evidence_ids": evidence_ids, "updated_turn": turn,
            })
            self._cases[case.task_id] = updated
            support = tuple(e for e in evidence if evaluate_evidence(root, e) is True)
            counter = tuple(e for e in evidence if evaluate_evidence(root, e) is False)
            all_contexts_tested = set(task.completed_context_ids) == {
                requirement.id for requirement in task.required_contexts
            }
            ready_to_repair = (len(evidence) >= 4 and len({e.agent_id for e in evidence}) >= 2
                               and bool(support) and bool(counter))
            ready_to_revoke = (all_contexts_tested and len(counter) >= 3
                               and len({e.agent_id for e in counter}) >= 2)
            if not ready_to_repair and not ready_to_revoke:
                continue
            decision = await reasoning.decide(ReasoningRequest(
                kind=ReasoningKind.INVESTIGATION_HYPOTHESIS, turn=turn,
                object=root.object, evidence=evidence, hypothesis=original,
            ))
            repaired = decision.hypothesis
            replacement: Belief | None = None
            if repaired is not None:
                probe = root.model_copy(update={"conditions": repaired.conditions})
                repair_support = tuple(e for e in evidence if evaluate_evidence(probe, e) is True)
                repair_counter = tuple(e for e in evidence if evaluate_evidence(probe, e) is False)
                if (len(repair_support) < 3 or len({e.agent_id for e in repair_support}) < 2
                        or repair_counter):
                    continue
                proposed = probe.model_copy(update={
                    "alpha": 1 + len(repair_support), "beta": 1,
                    "evidence_ids": tuple(e.id for e in repair_support),
                    "independent_agent_ids": tuple(sorted({e.agent_id for e in repair_support})),
                })
                if not memory._verification_eligible(proposed):
                    continue
                replacement = memory.resolve_conditional_lineage(
                    root.id, descendants, evidence_ids, agents, turn=turn, repaired=repaired,
                )
            else:
                if not ready_to_revoke:
                    continue
                memory.resolve_conditional_lineage(
                    root.id, descendants, evidence_ids, agents, turn=turn, repaired=None,
                )

            revoked_ids = (root.id, *descendants)
            resolution = "BELIEF_REPAIRED" if replacement else "BELIEF_REVOKED"
            tasks.resolve_investigation(task.id, agents, turn, resolution)
            if replacement is not None:
                sender = owners[replacement.owner_agent_id]
                if not swarm.dispatch(sender, MessageIntent(
                    type=MessageType.SHARE_BELIEF, belief_id=replacement.id,
                ), agents, memory, tasks, turn):
                    raise RuntimeError("Verified repair could not be shared")
            status = InvestigationStatus.REPAIRED if replacement else InvestigationStatus.REVOKED
            self._cases[case.task_id] = self._cases[case.task_id].model_copy(update={
                "status": status,
                "updated_turn": turn,
                "replacement_belief_id": replacement.id if replacement else None,
                "repaired_hypothesis": repaired,
                "revoked_belief_ids": revoked_ids,
                "resolution": resolution,
            })
            corruption.record_resolution(root.id, replacement, revoked_ids, repaired, turn=turn)

    def debug_snapshot(self) -> dict:
        return {"investigations": [case.model_dump(mode="json") for case in self.cases]}
