"""Persistent cognitive policy state, separate from beliefs about the world."""
from enum import StrEnum
from typing import Literal

from pydantic import Field

from app.simulation.memory import FrozenModel


class MetaBeliefType(StrEnum):
    REQUIRE_CONTEXT_DIVERSITY = "REQUIRE_CONTEXT_DIVERSITY"


class VerificationPolicyEffect(FrozenModel):
    applies_to: Literal["GENERALIZED_CONDITIONAL_EFFECT"] = "GENERALIZED_CONDITIONAL_EFFECT"
    dimensions: tuple[Literal["region", "weather"], ...]
    minimum_distinct_values: int = Field(default=2, ge=2, le=4)


class MetaBelief(FrozenModel):
    id: str
    type: Literal[MetaBeliefType.REQUIRE_CONTEXT_DIVERSITY] = MetaBeliefType.REQUIRE_CONTEXT_DIVERSITY
    principle: str = Field(min_length=1, max_length=1000)
    learned_from_incident_id: str
    created_turn: int
    active: bool = True
    policy_effect: VerificationPolicyEffect
