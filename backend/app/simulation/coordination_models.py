"""Frozen task and communication contracts, independent of runtime implementations."""
from enum import StrEnum
from pydantic import Field

from app.schemas import Resource
from app.simulation.memory import Belief, Conditions, Evidence, EvidenceKind, FrozenModel


class TaskType(StrEnum):
    SURVIVAL = "SURVIVAL"
    VERIFICATION = "VERIFICATION"
    INVESTIGATION = "INVESTIGATION"


class TaskStatus(StrEnum):
    OPEN = "OPEN"
    CLAIMED = "CLAIMED"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED = "RESOLVED"
    EXPIRED = "EXPIRED"


class RequiredContext(FrozenModel):
    id: str
    conditions: Conditions = Field(default_factory=Conditions)
    object: Resource | None = None
    evidence_kind: EvidenceKind
    independent_of: tuple[str, ...] = ()


class TaskClaim(FrozenModel):
    agent_id: str
    context_id: str
    claimed_turn: int


class Task(FrozenModel):
    id: str
    type: TaskType
    status: TaskStatus = TaskStatus.OPEN
    priority: int
    created_turn: int
    updated_turn: int
    last_broadcast_turn: int
    description: str
    belief_id: str | None = None
    required_contexts: tuple[RequiredContext, ...]
    claimed_contexts: tuple[TaskClaim, ...] = ()
    claimant_agent_ids: tuple[str, ...] = ()
    completed_context_ids: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    resolution: str | None = None


class TaskChange(FrozenModel):
    id: str
    type: str
    turn: int
    task_id: str
    agent_id: str | None = None


class ClaimIntent(FrozenModel):
    task_id: str
    context_id: str


class MessageType(StrEnum):
    TASK_AVAILABLE = "TASK_AVAILABLE"
    SHARE_BELIEF = "SHARE_BELIEF"
    REQUEST_VERIFICATION = "REQUEST_VERIFICATION"
    SUBMIT_EVIDENCE = "SUBMIT_EVIDENCE"
    RAISE_DISPUTE = "RAISE_DISPUTE"


class MessageIntent(FrozenModel):
    type: MessageType
    belief_id: str | None = None
    evidence_id: str | None = None
    task_id: str | None = None


class SwarmMessage(FrozenModel):
    id: str
    type: MessageType
    turn: int
    from_agent: str
    belief_id: str | None = None
    task_id: str | None = None
    evidence_id: str | None = None
    belief: Belief | None = None
    evidence: Evidence | None = None
    needed_contexts: tuple[RequiredContext, ...] = ()


def is_open(task: Task) -> bool:
    return task.status not in (TaskStatus.RESOLVED, TaskStatus.EXPIRED)


def matches(requirement: RequiredContext, evidence: Evidence) -> bool:
    return (evidence.agent_id not in requirement.independent_of
            and evidence.kind == requirement.evidence_kind
            and (requirement.object is None or evidence.object == requirement.object
                 or evidence.kind == EvidenceKind.CELL_OBSERVATION)
            and (requirement.conditions.region is None or evidence.region == requirement.conditions.region)
            and (requirement.conditions.weather is None or evidence.weather == requirement.conditions.weather))
