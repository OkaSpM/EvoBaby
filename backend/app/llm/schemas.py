"""Explicit reasoning inputs/outputs with no writable truth or belief statistics."""
from enum import StrEnum
from typing import Literal
from pydantic import Field, model_validator

from app.schemas import Action, Resource
from app.simulation.agent import DecisionContext, MOVES
from app.simulation.coordination_models import ClaimIntent
from app.simulation.memory import ConditionalHypothesis, Evidence, FrozenModel


class ReasoningKind(StrEnum):
    ACTION_REASONING = "ACTION_REASONING"
    TASK_CLAIM_REASONING = "TASK_CLAIM_REASONING"
    HYPOTHESIS_GENERATION = "HYPOTHESIS_GENERATION"
    INVESTIGATION_HYPOTHESIS = "INVESTIGATION_HYPOTHESIS"
    META_REFLECTION = "META_REFLECTION"
    CORRUPTION_RANKING = "CORRUPTION_RANKING"


class ActionDecision(FrozenModel):
    action: Action
    task_id: str | None = None
    reason: str = Field(min_length=1, max_length=1000)


class ClaimDecision(FrozenModel):
    claim: ClaimIntent | None = None
    reason: str = Field(min_length=1, max_length=1000)


class HypothesisDecision(FrozenModel):
    hypothesis: ConditionalHypothesis | None = None


class MetaPrinciple(FrozenModel):
    type: Literal["REQUIRE_CONTEXT_DIVERSITY"] = "REQUIRE_CONTEXT_DIVERSITY"
    principle: str = Field(min_length=1, max_length=1000)
    dimensions: tuple[Literal["region", "weather"], ...] = Field(min_length=1, max_length=2)


class RankingDecision(FrozenModel):
    candidate_index: int | None = Field(default=None, ge=0, strict=True)
    reason: str = Field(min_length=1, max_length=1000)


class IncidentSummary(FrozenModel):
    incident_id: str
    previously_verified: bool
    resolved: bool
    hypothesis: ConditionalHypothesis
    evidence: tuple[Evidence, ...]
    independent_agent_ids: tuple[str, ...]


class ReasoningRequest(FrozenModel):
    kind: ReasoningKind
    turn: int
    agent_id: str | None = None
    context: DecisionContext | None = None
    object: Resource | None = None
    evidence: tuple[Evidence, ...] = ()
    hypothesis: ConditionalHypothesis | None = None
    incident: IncidentSummary | None = None
    candidates: tuple[ConditionalHypothesis, ...] = ()

    @model_validator(mode="after")
    def validate_request_scope(self):
        local = self.kind in (ReasoningKind.ACTION_REASONING, ReasoningKind.TASK_CLAIM_REASONING)
        if local and (self.context is None or self.agent_id != self.context.agent_id):
            raise ValueError("Local reasoning requires the matching agent context")
        if not local and self.context is not None:
            raise ValueError("Do not mix agent context with other reasoning scopes")
        if self.candidates and self.kind != ReasoningKind.CORRUPTION_RANKING:
            raise ValueError("Candidate ranking is isolated from normal reasoning")
        if self.incident and self.kind != ReasoningKind.META_REFLECTION:
            raise ValueError("Incident reflection requires a dedicated request")
        if self.kind in (ReasoningKind.HYPOTHESIS_GENERATION, ReasoningKind.INVESTIGATION_HYPOTHESIS):
            if self.object is None:
                raise ValueError("Hypothesis requests require an object")
        if self.kind == ReasoningKind.HYPOTHESIS_GENERATION:
            if self.agent_id is None or any(e.agent_id != self.agent_id for e in self.evidence):
                raise ValueError("Natural hypotheses must use the requesting agent's own evidence")
        if self.kind == ReasoningKind.INVESTIGATION_HYPOTHESIS and self.hypothesis is None:
            raise ValueError("Repair requires the disputed hypothesis")
        if self.kind == ReasoningKind.META_REFLECTION and (
            self.incident is None or not self.incident.previously_verified or not self.incident.resolved
        ):
            raise ValueError("Reflection requires a resolved, previously verified incident")
        return self


class DecisionRecord(FrozenModel):
    id: str
    turn: int
    agent_id: str | None
    kind: ReasoningKind
    mode: Literal["mock", "api"]
    fallback_reason: str | None = None


OUTPUT_MODELS = {
    ReasoningKind.ACTION_REASONING: ActionDecision,
    ReasoningKind.TASK_CLAIM_REASONING: ClaimDecision,
    ReasoningKind.HYPOTHESIS_GENERATION: HypothesisDecision,
    ReasoningKind.INVESTIGATION_HYPOTHESIS: HypothesisDecision,
    ReasoningKind.META_REFLECTION: MetaPrinciple,
    ReasoningKind.CORRUPTION_RANKING: RankingDecision,
}


def available_actions(context: DecisionContext) -> tuple[Action, ...]:
    x, y = context.observation.position
    actions = [a for a, (dx, dy) in MOVES if 0 <= x + dx < 8 and 0 <= y + dy < 8]
    actions.append(Action.INSPECT)
    if context.observation.object in (Resource.BERRY, Resource.CRYSTAL):
        actions.append(Action.COLLECT)
    if context.observation.object == Resource.MOSS:
        actions.append(Action.USE_MOSS)
    for resource, count in context.inventory:
        if count:
            actions.append(Action.USE_BERRY if resource == Resource.BERRY else Action.USE_CRYSTAL)
    return tuple(actions)


def meaningful_action(context: DecisionContext) -> bool:
    return context.observation.object is not None or context.observation.energy < 40 or context.active_task is not None


def request_payload(request: ReasoningRequest) -> dict:
    """Allowlist serialization: never serialize the engine or arbitrary caller dictionaries."""
    if request.context is not None:
        c = request.context
        return {"identity": c.agent_id, "current_observation": c.observation.model_dump(mode="json"),
                "energy": c.observation.energy, "inventory": dict(c.inventory),
                "known_cells": [o.model_dump(mode="json") for o in c.known_cells],
                "personal_beliefs": [b.model_dump(mode="json") for b in c.personal_beliefs],
                "adopted_shared_beliefs": [b.model_dump(mode="json") for b in c.adopted_shared_beliefs],
                "relevant_evidence": [e.model_dump(mode="json") for e in c.relevant_evidence],
                "active_meta_beliefs": [b.model_dump(mode="json") for b in c.active_meta_beliefs],
                "open_tasks": [t.model_dump(mode="json") for t in c.open_tasks],
                "active_task": c.active_task.model_dump(mode="json") if c.active_task else None,
                "available_actions": list(available_actions(c))}
    if request.kind == ReasoningKind.CORRUPTION_RANKING:
        return {"candidates": [c.model_dump(mode="json") for c in request.candidates]}
    if request.kind == ReasoningKind.META_REFLECTION:
        return {"incident": request.incident.model_dump(mode="json")}
    return {"object": request.object,
            "evidence": [e.model_dump(mode="json") for e in request.evidence],
            "hypothesis": request.hypothesis.model_dump(mode="json") if request.hypothesis else None}
