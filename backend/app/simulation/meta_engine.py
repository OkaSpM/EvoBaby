"""One-time reflection that converts a resolved incident into policy state."""
from app.llm.provider import ReasoningService
from app.llm.schemas import IncidentSummary, ReasoningKind, ReasoningRequest
from app.simulation.belief_engine import BeliefEngine
from app.simulation.corruption import CorruptionSystem, IncidentStatus
from app.simulation.investigation import InvestigationEngine, InvestigationStatus
from app.simulation.meta_models import MetaBelief, VerificationPolicyEffect


class MetaBeliefEngine:
    def __init__(self):
        self._beliefs: dict[str, MetaBelief] = {}

    @property
    def beliefs(self) -> tuple[MetaBelief, ...]:
        return tuple(self._beliefs.values())

    @property
    def active_beliefs(self) -> tuple[MetaBelief, ...]:
        return tuple(belief for belief in self.beliefs if belief.active)

    async def advance(self, corruption: CorruptionSystem, investigation: InvestigationEngine,
                      memory: BeliefEngine, reasoning: ReasoningService, *,
                      turn: int) -> MetaBelief | None:
        if self._beliefs:
            return None
        incident = next((item for item in corruption.incidents
                         if item.attack_number == 1
                         and item.disputed_turn is not None
                         and item.status in (IncidentStatus.REPAIRED, IncidentStatus.REVOKED)), None)
        if incident is None:
            return None
        case = next((item for item in investigation.cases
                     if item.status in (InvestigationStatus.REPAIRED, InvestigationStatus.REVOKED)
                     and incident.root_belief_id in item.revoked_belief_ids), None)
        if case is None:
            return None
        root = memory.get(incident.root_belief_id)
        evidence_ids = tuple(dict.fromkeys((*root.evidence_ids, *case.evidence_ids)))
        summary = IncidentSummary(
            incident_id=incident.id, previously_verified=True, resolved=True,
            hypothesis=incident.injected_hypothesis,
            evidence=tuple(memory.evidence_by_id(i) for i in evidence_ids),
            independent_agent_ids=root.independent_agent_ids,
        )
        decision = await reasoning.decide(ReasoningRequest(
            kind=ReasoningKind.META_REFLECTION, turn=turn, incident=summary,
        ))
        belief = MetaBelief(
            id=f"MB{len(self._beliefs) + 1}", principle=decision.principle,
            learned_from_incident_id=incident.id, created_turn=turn,
            policy_effect=VerificationPolicyEffect(dimensions=decision.dimensions),
        )
        self._beliefs[belief.id] = belief
        return belief

    def debug_snapshot(self) -> dict:
        return {"metaBeliefs": [belief.model_dump(mode="json") for belief in self.beliefs]}
