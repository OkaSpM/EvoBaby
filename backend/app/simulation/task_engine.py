"""State-driven opportunities, claim validation and lifecycle; never assigns agents."""
from app.schemas import Region, Weather
from app.simulation.agent import AgentState
from app.simulation.belief_engine import BeliefEngine
from app.simulation.coordination_models import (
    ClaimIntent, RequiredContext, Task, TaskChange, TaskClaim, TaskStatus, TaskType, is_open, matches,
)
from app.simulation.memory import Belief, BeliefStatus, BeliefType, Conditions, Evidence, EvidenceKind


def claim_key(belief: Belief) -> tuple:
    return (belief.type, belief.object, belief.conditions.region, belief.conditions.weather, belief.expected_effect)


def energy_danger(agents: list[AgentState], turn: int) -> bool:
    return (sum(a.energy for a in agents) / len(agents) < 40
            or sum(a.energy < 25 and (a.unavailable_until_turn is None or a.unavailable_until_turn <= turn)
                   for a in agents) >= 2)


class TaskEngine:
    def __init__(self):
        self._tasks: dict[str, Task] = {}
        self._keys: dict[tuple, str] = {}
        self._changes: list[TaskChange] = []

    @property
    def tasks(self) -> tuple[Task, ...]:
        return tuple(self._tasks.values())

    @property
    def changes(self) -> tuple[TaskChange, ...]:
        return tuple(self._changes)

    def get(self, task_id: str) -> Task:
        return self._tasks[task_id]

    def _change(self, task: Task, event_type: str, agent_id=None):
        self._changes.append(TaskChange(id=f"TC{len(self._changes) + 1}", type=event_type,
                                        turn=task.updated_turn, task_id=task.id, agent_id=agent_id))

    def _create(self, key, task_type, turn, priority, requirements, belief_id=None):
        task = Task(id=f"T{len(self._tasks) + 1}", type=task_type, priority=priority,
                    created_turn=turn, updated_turn=turn, last_broadcast_turn=turn,
                    description={TaskType.SURVIVAL: "Find a reliable energy source.",
                                 TaskType.VERIFICATION: "Collect the missing independent evidence.",
                                 TaskType.INVESTIGATION: "Test missing contexts to determine the supported rule."}[task_type],
                    belief_id=belief_id, required_contexts=tuple(requirements))
        self._tasks[task.id] = task
        self._keys[key] = task.id
        self._change(task, "TASK_CREATED")
        return task

    def _requirements(self, belief: Belief, investigation: bool, memory: BeliefEngine):
        kind = {BeliefType.DISTRIBUTION: EvidenceKind.CELL_OBSERVATION,
                BeliefType.PERSISTENCE: EvidenceKind.RESOURCE_REVISIT,
                BeliefType.CONDITIONAL_EFFECT: EvidenceKind.ACTION_EFFECT}[belief.type]
        if investigation and belief.type == BeliefType.CONDITIONAL_EFFECT:
            regions = (belief.conditions.region,) if belief.conditions.region else tuple(Region)
            weathers = (belief.conditions.weather,) if belief.conditions.weather else tuple(Weather)
            # Three fresh trials per reachable context let a repair meet the same
            # evidence threshold as every other verified belief.
            conditions = [Conditions(region=r, weather=w)
                          for r in regions for w in weathers for _ in range(3)]
        elif belief.type == BeliefType.CONDITIONAL_EFFECT and memory.missing_context_dimensions(belief):
            missing = set(memory.missing_context_dimensions(belief))
            observed = {(memory.evidence_by_id(i).region, memory.evidence_by_id(i).weather)
                        for i in belief.evidence_ids
                        if memory.evidence_by_id(i).kind == EvidenceKind.ACTION_EFFECT}
            regions = tuple(Region) if "region" in missing else (belief.conditions.region,)
            weathers = tuple(Weather) if "weather" in missing else (belief.conditions.weather,)
            conditions = [Conditions(region=region, weather=weather)
                          for region in regions for weather in weathers
                          if (region, weather) not in observed]
            if not conditions:
                conditions = [belief.conditions]
        else:
            conditions = [belief.conditions] * max(1, 3 - belief.evidence_count)
        return tuple(RequiredContext(id=f"C{i + 1}", conditions=c, object=belief.object,
                                     evidence_kind=kind,
                                     independent_of=belief.independent_agent_ids if not investigation
                                     and len(belief.independent_agent_ids) < memory.minimum_independent_agents else ())
                     for i, c in enumerate(conditions))

    def sync(self, agents: list[AgentState], memory: BeliefEngine, turn: int):
        dangerous = energy_danger(agents, turn)
        for task in self.tasks:
            if not is_open(task):
                continue
            resolution = None
            status = TaskStatus.RESOLVED
            if task.type == TaskType.SURVIVAL and not dangerous:
                resolution = "ENERGY_RECOVERED"
            elif task.belief_id:
                belief = memory.get(task.belief_id)
                if belief.status == BeliefStatus.REVOKED:
                    resolution = "BELIEF_REVOKED"
                elif belief.status == BeliefStatus.VERIFIED:
                    resolution = "BELIEF_VERIFIED"
                elif task.type == TaskType.VERIFICATION and belief.status == BeliefStatus.DISPUTED:
                    resolution, status = "INVESTIGATION_REQUIRED", TaskStatus.EXPIRED
                elif (task.type == TaskType.VERIFICATION and len(belief.independent_agent_ids) >= 2
                      and belief.evidence_count >= 3 and belief.confidence < 0.75):
                    resolution, status = "INSUFFICIENT_SUPPORT", TaskStatus.EXPIRED
            if resolution:
                self._finish(task, agents, turn, status, resolution)
                continue
            # Exhaustion releases a voluntary claim, making it available again.
            for claim in task.claimed_contexts:
                agent = next(a for a in agents if a.id == claim.agent_id)
                if agent.unavailable_until_turn is not None and agent.unavailable_until_turn > turn:
                    self.release(agent, turn)
            task = self.get(task.id)
            if not task.claimant_agent_ids and turn - task.last_broadcast_turn >= 3:
                task = task.model_copy(update={"priority": min(100, task.priority + 5),
                                               "last_broadcast_turn": turn, "updated_turn": turn})
                self._tasks[task.id] = task
                self._change(task, "TASK_REBROADCAST")
        survival_key = (TaskType.SURVIVAL,)
        prior = self._keys.get(survival_key)
        if dangerous and (prior is None or not is_open(self.get(prior))):
            self._create(survival_key, TaskType.SURVIVAL, turn, 90,
                         [RequiredContext(id=f"C{i + 1}", evidence_kind=EvidenceKind.ACTION_EFFECT) for i in range(2)])
        for belief in memory.beliefs:
            investigation = belief.status == BeliefStatus.DISPUTED
            if not investigation and not (belief.status == BeliefStatus.TENTATIVE and (
                belief.evidence_count >= 2 or (belief.type == BeliefType.PERSISTENCE and belief.evidence_count >= 1)
            )):
                continue
            family = TaskType.INVESTIGATION if investigation else TaskType.VERIFICATION
            key = (family, *claim_key(belief))
            # Equivalent claims share an opportunity; terminal tasks are not recreated each turn.
            prior = self.get(self._keys[key]) if key in self._keys else None
            retry = (prior is not None and prior.status == TaskStatus.EXPIRED
                     and prior.resolution == "INSUFFICIENT_SUPPORT" and belief.confidence >= 0.75
                     and belief.updated_turn > prior.updated_turn)
            policy_retry = (prior is not None and not is_open(prior)
                            and bool(memory.missing_context_dimensions(belief))
                            and belief.updated_turn > prior.updated_turn)
            if prior is None or retry or policy_retry:
                self._create(key, family, turn, 95 if investigation else 30 + int(40 * belief.confidence),
                             self._requirements(belief, investigation, memory), belief.id)

    def _finish(self, task, agents, turn, status, resolution):
        for agent in agents:
            if agent.active_task == task.id:
                agent.active_task = None
        task = task.model_copy(update={"status": status, "resolution": resolution,
                                       "claimed_contexts": (), "claimant_agent_ids": (), "updated_turn": turn})
        self._tasks[task.id] = task
        self._change(task, "TASK_RESOLVED" if status == TaskStatus.RESOLVED else "TASK_EXPIRED")

    def resolve_investigation(self, task_id: str, agents: list[AgentState], turn: int,
                              resolution: str) -> Task:
        task = self.get(task_id)
        if task.type != TaskType.INVESTIGATION or not is_open(task):
            raise ValueError("Only an open investigation can be resolved")
        self._finish(task, agents, turn, TaskStatus.RESOLVED, resolution)
        return self.get(task_id)

    def claim(self, agent: AgentState, intent: ClaimIntent, turn: int) -> bool:
        task = self._tasks.get(intent.task_id)
        if task is None or not is_open(task) or agent.active_task is not None:
            return False
        if agent.unavailable_until_turn is not None and agent.unavailable_until_turn > turn:
            return False
        requirement = next((c for c in task.required_contexts if c.id == intent.context_id), None)
        if (requirement is None or agent.id in requirement.independent_of
                or intent.context_id in task.completed_context_ids
                or any(c.context_id == intent.context_id for c in task.claimed_contexts)):
            return False
        claim = TaskClaim(agent_id=agent.id, context_id=intent.context_id, claimed_turn=turn)
        task = task.model_copy(update={"status": TaskStatus.CLAIMED if task.status == TaskStatus.OPEN else task.status,
                                       "claimed_contexts": (*task.claimed_contexts, claim),
                                       "claimant_agent_ids": (*task.claimant_agent_ids, agent.id), "updated_turn": turn})
        self._tasks[task.id] = task
        agent.active_task = task.id
        self._change(task, "TASK_CLAIMED", agent.id)
        return True

    def release(self, agent: AgentState, turn: int):
        if agent.active_task is None:
            return
        task = self.get(agent.active_task)
        claims = tuple(c for c in task.claimed_contexts if c.agent_id != agent.id)
        task = task.model_copy(update={"claimed_contexts": claims, "claimant_agent_ids": tuple(c.agent_id for c in claims),
                                       "status": TaskStatus.IN_PROGRESS if task.evidence_ids else
                                       TaskStatus.CLAIMED if claims else TaskStatus.OPEN, "updated_turn": turn})
        self._tasks[task.id] = task
        agent.active_task = None
        self._change(task, "TASK_RELEASED", agent.id)

    def record_submission(self, agent: AgentState, task_id: str, evidence: Evidence, turn: int) -> bool:
        task = self._tasks.get(task_id)
        if task is None or not is_open(task) or evidence.agent_id != agent.id or evidence.id in task.evidence_ids:
            return False
        claim = next((c for c in task.claimed_contexts if c.agent_id == agent.id), None)
        if claim is None:
            return False
        requirement = next(c for c in task.required_contexts if c.id == claim.context_id)
        if not matches(requirement, evidence):
            return False
        if task.type == TaskType.SURVIVAL and (evidence.energy_delta or 0) <= 0:
            return False
        # Investigation needs new tests after the incident; old evidence can aid normal verification.
        if task.type == TaskType.INVESTIGATION and evidence.turn < claim.claimed_turn:
            return False
        requirements = task.required_contexts
        if task.type == TaskType.INVESTIGATION:
            submitters = tuple(change.agent_id for change in self._changes
                               if change.task_id == task.id
                               and change.type == "TASK_EVIDENCE_RECEIVED")
            prior_same_context = sum(
                submitter_id == agent.id
                and next(item for item in task.required_contexts if item.id == context_id).conditions
                == requirement.conditions
                for context_id, submitter_id in zip(task.completed_context_ids, submitters)
            )
            if prior_same_context >= 1:
                requirements = tuple(
                    item.model_copy(update={
                        "independent_of": tuple(dict.fromkeys((*item.independent_of, agent.id)))
                    }) if item.id not in task.completed_context_ids
                    and item.id != requirement.id and item.conditions == requirement.conditions else item
                    for item in requirements
                )
        task = task.model_copy(update={"status": TaskStatus.IN_PROGRESS,
                                       "required_contexts": requirements,
                                       "completed_context_ids": (*task.completed_context_ids, requirement.id),
                                       "evidence_ids": (*task.evidence_ids, evidence.id), "updated_turn": turn})
        self._tasks[task.id] = task
        self._change(task, "TASK_EVIDENCE_RECEIVED", agent.id)
        self.release(agent, turn)
        return True

    def debug_snapshot(self):
        return {"tasks": [t.model_dump(mode="json") for t in self.tasks],
                "taskChanges": [c.model_dump(mode="json") for c in self.changes]}
