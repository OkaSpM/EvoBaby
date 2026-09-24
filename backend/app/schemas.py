from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class Resource(StrEnum):
    BERRY = "Berry"
    CRYSTAL = "Crystal"
    MOSS = "Moss"


class Weather(StrEnum):
    SUNNY = "Sunny"
    RAIN = "Rain"


class Region(StrEnum):
    NW = "NW"
    NE = "NE"
    SW = "SW"
    SE = "SE"


class Action(StrEnum):
    MOVE_N = "MOVE_N"
    MOVE_S = "MOVE_S"
    MOVE_E = "MOVE_E"
    MOVE_W = "MOVE_W"
    INSPECT = "INSPECT"
    COLLECT = "COLLECT"
    USE_BERRY = "USE_BERRY"
    USE_CRYSTAL = "USE_CRYSTAL"
    USE_MOSS = "USE_MOSS"
    SHARE_BELIEF = "SHARE_BELIEF"
    REQUEST_VERIFY = "REQUEST_VERIFY"
    CLAIM_TASK = "CLAIM_TASK"


Coordinate = Annotated[int, Field(strict=True, ge=0, lt=8)]
Position = tuple[Coordinate, Coordinate]
InventoryResource = Literal[Resource.BERRY, Resource.CRYSTAL]
InventoryCount = Annotated[int, Field(strict=True, ge=0)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class BodyState(StrictModel):
    """Physical state only. Agent cognition is added by the runtime."""

    id: str
    position: Position
    energy: int = Field(default=60, ge=0, le=100)
    inventory: dict[InventoryResource, InventoryCount] = Field(
        default_factory=lambda: {Resource.BERRY: 0, Resource.CRYSTAL: 0}
    )
    unavailable_until_turn: Annotated[int, Field(strict=True, ge=0)] | None = None


class Observation(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    position: Position
    region: Region
    weather: Weather
    object: Resource | None
    energy: int


class ActionResult(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    turn: int
    agent_id: str
    action: Action
    position: Position
    region: Region
    weather: Weather
    object: Resource | None
    success: bool
    reason: str
    energy_before: int
    energy_after: int
    action_cost: int = 0
    resource_effect: int = 0
    returned_to_base: bool = False
