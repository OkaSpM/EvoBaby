"""Public API contracts. Internal field names and enum values remain English."""
from typing import Literal

from pydantic import Field, model_serializer

from app.llm.schemas import DecisionRecord
from app.schemas import Action, Position, Region, Resource, StrictModel, Weather
from app.simulation.coordination_models import SwarmMessage, Task, TaskChange
from app.simulation.cognition import CognitionView
from app.simulation.corruption import CorruptionAuditEvent, IncidentStatus
from app.simulation.events import RawEvent
from app.simulation.investigation import InvestigationCase
from app.simulation.memory import Belief, BeliefChange, Evidence
from app.simulation.meta_models import MetaBelief
from app.simulation.metrics import ExperimentMetrics


class RunRequest(StrictModel):
    speed: Literal[1, 5, 20] = 1


class ErrorResponse(StrictModel):
    code: str
    message: str


class SimulationStatus(StrictModel):
    running: bool
    speed: Literal[1, 5, 20]
    turn: int
    seed: int
    canInjectFirst: bool
    canInjectSecond: bool


class WorldCellView(StrictModel):
    position: Position
    region: Region
    known: bool
    object: Resource | None = None


class WorldView(StrictModel):
    size: int = 8
    base: Position
    weather: Weather
    cells: tuple[WorldCellView, ...]


class AgentSummary(StrictModel):
    id: str
    energy: int
    position: Position
    region: Region
    inventory: dict[Resource, int]
    personalBeliefCount: int
    sharedBeliefCount: int
    verifiedBeliefCount: int
    currentAction: Action | None
    currentTaskId: str | None
    unavailableUntilTurn: int | None
    appearance: dict | None = None
    removed: bool | None = None
    cognition: CognitionView | None = None

    @model_serializer(mode="wrap")
    def serialize(self, handler):
        result = handler(self)
        return {key: value for key, value in result.items()
                if key not in ("appearance", "removed", "cognition") or value is not None}


class IncidentEvidenceView(StrictModel):
    evidenceId: str
    agentId: str
    region: Region
    weather: Weather
    outcome: Literal["SUPPORT", "COUNTEREXAMPLE"]


class LineageEdgeView(StrictModel):
    parentBeliefId: str
    childBeliefId: str
    senderAgentId: str
    receiverAgentId: str


class IncidentView(StrictModel):
    id: str
    attackNumber: int
    status: IncidentStatus
    injectedTurn: int
    targetAgentId: str | None
    rootBeliefId: str | None
    omittedCondition: Literal["region", "weather"] | None
    affectedAgentIds: tuple[str, ...]
    detectedTurn: int | None
    disputedTurn: int | None
    investigationTaskId: str | None
    replacementBeliefId: str | None
    revokedBeliefIds: tuple[str, ...]
    resolvedTurn: int | None
    verificationRequestCount: int
    evidenceByContext: tuple[IncidentEvidenceView, ...]
    lineage: tuple[LineageEdgeView, ...]


class GlobalMetrics(StrictModel):
    averageEnergy: float = Field(ge=0, le=100)
    exploredCellPercent: float = Field(ge=0, le=100)
    verifiedCollectiveBeliefs: int = Field(ge=0)
    openTasks: int = Field(ge=0)
    knowledgeMature: bool
    attacks: ExperimentMetrics


class StateResponse(StrictModel):
    simulation: SimulationStatus
    world: WorldView
    agents: tuple[AgentSummary, ...]
    tasks: tuple[Task, ...]
    collectiveKnowledge: tuple[Belief, ...]
    metaBeliefs: tuple[MetaBelief, ...]
    incidents: tuple[IncidentView, ...]
    metrics: GlobalMetrics
    recentEvents: tuple[RawEvent, ...]
    choices: dict | None = None
    awaiting_choice: dict | None = None
    paradigm: dict | None = None
    merged_game: dict | None = None
    trace_game: dict | None = None
    judge_online: bool | None = None
    broadcast_enabled: bool | None = None
    memorials: list[dict] | None = None
    story_events: list[dict] | None = None

    @model_serializer(mode="wrap")
    def serialize(self, handler):
        result = handler(self)
        extras = {"choices", "awaiting_choice", "paradigm", "merged_game", "trace_game",
                  "judge_online", "broadcast_enabled", "memorials", "story_events"}
        if self.merged_game is None:
            return {key: value for key, value in result.items() if key not in extras}
        return result


class GameStartRequest(StrictModel):
    seed: int | None = None
    optional_choices: bool = True


class ChoiceRequest(StrictModel):
    point: Literal["D1", "D2", "D3", "D4"]
    option: Literal["A", "B", "C", "D"]


class AdvanceRequest(StrictModel):
    turns: int = Field(default=50, ge=1, le=100)


class AccuseRequest(StrictModel):
    agent_id: str = Field(min_length=1, max_length=20)
    belief_id: str = Field(min_length=1, max_length=80)


class BroadcastRequest(StrictModel):
    enabled: bool


class InjectRequest(StrictModel):
    target_policy: Literal["most_active", "isolated", "random", "regulator", "A", "B", "C", "D"] | None = None


class AgentDetail(StrictModel):
    agent: AgentSummary
    knownCells: tuple[WorldCellView, ...]
    personalBeliefs: tuple[Belief, ...]
    adoptedSharedBeliefs: tuple[Belief, ...]
    evidence: tuple[Evidence, ...]
    recentEvents: tuple[RawEvent, ...]


class EventsResponse(StrictModel):
    events: tuple[RawEvent, ...]


class ExportResponse(StrictModel):
    state: StateResponse
    evidence: tuple[Evidence, ...]
    beliefs: tuple[Belief, ...]
    beliefChanges: tuple[BeliefChange, ...]
    taskChanges: tuple[TaskChange, ...]
    messages: tuple[SwarmMessage, ...]
    investigations: tuple[InvestigationCase, ...]
    corruptionAudit: tuple[CorruptionAuditEvent, ...]
    reasoning: tuple[DecisionRecord, ...]
    rawEvents: tuple[RawEvent, ...]
    groundTruth: dict


class MutationResponse(StrictModel):
    state: StateResponse
