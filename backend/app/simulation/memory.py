"""Typed immutable memory records; no hidden truth or corruption metadata."""
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, computed_field, model_validator

from app.schemas import Action, Position, Region, Resource, StrictModel, Weather


class FrozenModel(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BeliefType(StrEnum):
    DISTRIBUTION = "DISTRIBUTION"
    PERSISTENCE = "PERSISTENCE"
    CONDITIONAL_EFFECT = "CONDITIONAL_EFFECT"


class BeliefStatus(StrEnum):
    TENTATIVE = "TENTATIVE"
    VERIFIED = "VERIFIED"
    DISPUTED = "DISPUTED"
    REVOKED = "REVOKED"


class BeliefOrigin(StrEnum):
    PERSONAL = "PERSONAL"
    SHARED = "SHARED"


class ExpectedEffect(StrEnum):
    OBJECT_PRESENT = "OBJECT_PRESENT"
    RENEWABLE = "RENEWABLE"
    NOT_RENEWABLE = "NOT_RENEWABLE"
    ENERGY_POSITIVE = "ENERGY_POSITIVE"
    ENERGY_NEGATIVE = "ENERGY_NEGATIVE"


class Conditions(FrozenModel):
    region: Region | None = None
    weather: Weather | None = None


class EvidenceKind(StrEnum):
    CELL_OBSERVATION = "CELL_OBSERVATION"
    RESOURCE_REVISIT = "RESOURCE_REVISIT"
    ACTION_EFFECT = "ACTION_EFFECT"


class Evidence(FrozenModel):
    id: str
    kind: EvidenceKind
    event_ids: tuple[str, ...]
    turn: int
    agent_id: str
    position: Position
    region: Region
    weather: Weather
    object: Resource | None
    observed_object: Resource | None
    action: Action | None = None
    energy_delta: int | None = None
    # Collection-to-revisit interval: evidence, not a hidden respawn timer.
    elapsed_turns: int | None = None
    collection_event_id: str | None = None


class ConditionalHypothesis(FrozenModel):
    type: Literal[BeliefType.CONDITIONAL_EFFECT] = BeliefType.CONDITIONAL_EFFECT
    object: Resource
    conditions: Conditions = Field(default_factory=Conditions)
    effect: Literal[ExpectedEffect.ENERGY_POSITIVE, ExpectedEffect.ENERGY_NEGATIVE]
    reason: str = Field(min_length=1, max_length=1000)


class Lineage(FrozenModel):
    original_source_agent_id: str
    sender_agent_id: str
    receiver_agent_id: str
    parent_belief_id: str
    message_id: str


class Belief(FrozenModel):
    id: str
    type: BeliefType
    proposition: str
    object: Resource
    conditions: Conditions
    expected_effect: ExpectedEffect
    alpha: Annotated[int, Field(strict=True, ge=1)] = 1
    beta: Annotated[int, Field(strict=True, ge=1)] = 1
    evidence_ids: tuple[str, ...] = ()
    independent_agent_ids: tuple[str, ...] = ()
    source_agent_id: str
    owner_agent_id: str
    origin: BeliefOrigin = BeliefOrigin.PERSONAL
    status: BeliefStatus = BeliefStatus.TENTATIVE
    created_turn: int
    updated_turn: int
    lineage: Lineage | None = None

    @model_validator(mode="after")
    def validate_claim_shape(self):
        effects = {
            BeliefType.DISTRIBUTION: (ExpectedEffect.OBJECT_PRESENT,),
            BeliefType.PERSISTENCE: (ExpectedEffect.RENEWABLE, ExpectedEffect.NOT_RENEWABLE),
            BeliefType.CONDITIONAL_EFFECT: (ExpectedEffect.ENERGY_POSITIVE, ExpectedEffect.ENERGY_NEGATIVE),
        }
        if self.expected_effect not in effects[self.type]:
            raise ValueError("Effect must match the belief type")
        if self.type == BeliefType.DISTRIBUTION and (
            self.conditions.region is None or self.conditions.weather is not None
        ):
            raise ValueError("Distribution claims require a region and no weather condition")
        if self.origin == BeliefOrigin.SHARED and self.lineage is None:
            raise ValueError("Shared beliefs require provenance")
        return self

    @computed_field
    @property
    def confidence(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    @computed_field
    @property
    def display_confidence(self) -> float:
        return min(0.99, self.confidence)

    @computed_field
    @property
    def evidence_count(self) -> int:
        return len(self.evidence_ids)


class BeliefChange(FrozenModel):
    id: str
    turn: int
    type: Literal["BELIEF_CREATED", "BELIEF_UPDATED", "BELIEF_VERIFIED", "BELIEF_DISPUTED", "BELIEF_REVOKED"]
    belief_id: str
    evidence_id: str | None = None
    previous_status: BeliefStatus | None = None
    status: BeliefStatus
