"""Append-only audit storage owned by the simulation, never by decision policies."""
from enum import StrEnum

from pydantic import ConfigDict

from app.schemas import ActionResult, Observation, StrictModel


class EventType(StrEnum):
    OBSERVATION = "OBSERVATION"
    ACTION_EXECUTED = "ACTION_EXECUTED"
    RETURNED_TO_BASE = "RETURNED_TO_BASE"
    REACTIVATED = "REACTIVATED"


class RawEvent(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    event_id: str
    type: EventType
    turn: int
    agent_id: str
    observation: Observation
    result: ActionResult | None = None


class EventLog:
    def __init__(self):
        self.__events: list[RawEvent] = []

    @property
    def events(self) -> tuple[RawEvent, ...]:
        return tuple(self.__events)

    def append(self, event_type: EventType, turn: int, agent_id: str,
               observation: Observation, result: ActionResult | None = None) -> RawEvent:
        event = RawEvent(event_id=f"E{len(self.__events) + 1}", type=event_type,
                         turn=turn, agent_id=agent_id, observation=observation, result=result)
        self.__events.append(event)
        return event
