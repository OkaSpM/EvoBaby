"""Local agent state and a world-independent, replaceable decision policy."""
import random
from typing import Protocol

from pydantic import ConfigDict, Field

from app.config import GRID_SIZE
from app.schemas import Action, ActionResult, BodyState, Observation, Position, Resource, StrictModel
from app.simulation.memory import Belief, Evidence
from app.simulation.meta_models import MetaBelief
from app.simulation.coordination_models import Task, SwarmMessage

MOVES = ((Action.MOVE_N, (0, -1)), (Action.MOVE_S, (0, 1)),
         (Action.MOVE_E, (1, 0)), (Action.MOVE_W, (-1, 0)))
RECENT_EVENT_LIMIT = 24


class LocalExperience(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    event_id: str
    result: ActionResult


class AgentState(BodyState):
    # References resolve through the future belief/task stores, never the audit log.
    personal_beliefs: list[str] = Field(default_factory=list)
    adopted_shared_beliefs: list[str] = Field(default_factory=list)
    known_cells: dict[Position, Observation] = Field(default_factory=dict)
    recent_events: tuple[LocalExperience, ...] = ()
    active_task: str | None = None
    current_action: Action | None = None

    def remember(self, event_id: str, result: ActionResult):
        self.recent_events = (*self.recent_events, LocalExperience(
            event_id=event_id, result=result))[-RECENT_EVENT_LIMIT:]


class DecisionContext(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    agent_id: str
    observation: Observation
    inventory: tuple[tuple[Resource, int], ...]
    known_cells: tuple[Observation, ...]
    recent_events: tuple[LocalExperience, ...]
    personal_beliefs: tuple[Belief, ...] = ()
    adopted_shared_beliefs: tuple[Belief, ...] = ()
    relevant_evidence: tuple[Evidence, ...] = ()
    active_meta_beliefs: tuple[MetaBelief, ...] = ()
    open_tasks: tuple[Task, ...] = ()
    active_task: Task | None = None
    verification_requests: tuple[SwarmMessage, ...] = ()
    # Ephemeral targets derived from unresolved beliefs by Phase 3, not a personality.
    uncertainty_targets: tuple[Position, ...] = ()


class DecisionPolicy(Protocol):
    def choose_action(self, context: DecisionContext, rng: random.Random) -> Action: ...


def decision_context(agent: AgentState, observation: Observation,
                     uncertainty_targets: tuple[Position, ...] = (), *,
                     personal_beliefs: tuple[Belief, ...] = (),
                     adopted_shared_beliefs: tuple[Belief, ...] = (),
                     relevant_evidence: tuple[Evidence, ...] = (),
                     active_meta_beliefs: tuple[MetaBelief, ...] = (),
                     open_tasks: tuple[Task, ...] = (), active_task: Task | None = None,
                     verification_requests: tuple[SwarmMessage, ...] = ()) -> DecisionContext:
    return DecisionContext(agent_id=agent.id, observation=observation,
                           inventory=tuple(sorted(agent.inventory.items())),
                           known_cells=tuple(agent.known_cells[p] for p in sorted(agent.known_cells)),
                           recent_events=agent.recent_events,
                           personal_beliefs=personal_beliefs,
                           adopted_shared_beliefs=adopted_shared_beliefs,
                           relevant_evidence=relevant_evidence,
                           active_meta_beliefs=active_meta_beliefs,
                           open_tasks=open_tasks, active_task=active_task,
                           verification_requests=verification_requests,
                           uncertainty_targets=uncertainty_targets)


class ExplorationPolicy:
    """No resource effect, respawn rule, region preference or world access."""

    def choose_action(self, context: DecisionContext, rng: random.Random) -> Action:
        observation = context.observation
        # Trial inventory items when energy is low, without knowing their effects.
        if observation.energy < 40:
            for resource, count in context.inventory:
                if count:
                    return Action.USE_BERRY if resource == Resource.BERRY else Action.USE_CRYSTAL
        if observation.object in (Resource.BERRY, Resource.CRYSTAL):
            return Action.COLLECT
        # Try a stationary resource once in the current local context. Later belief
        # reasoning can revisit it; this policy does not encode the hidden Moss rule.
        tried_here = any(e.result.action == Action.USE_MOSS and
                         e.result.position == observation.position and
                         e.result.weather == observation.weather and e.result.success
                         for e in context.recent_events)
        if observation.object == Resource.MOSS and not tried_here:
            return Action.USE_MOSS
        return self.explore(context, rng)

    def explore(self, context: DecisionContext, rng: random.Random) -> Action:
        x, y = context.observation.position
        neighbors = [(action, (x + dx, y + dy)) for action, (dx, dy) in MOVES
                     if 0 <= x + dx < GRID_SIZE and 0 <= y + dy < GRID_SIZE]
        known = {observation.position for observation in context.known_cells}
        unexplored = [item for item in neighbors if item[1] not in known]
        roll = rng.random()
        if context.uncertainty_targets:
            if roll < 0.60 and unexplored:
                return rng.choice(unexplored)[0]
            if 0.60 <= roll < 0.90:
                distances = [(min(abs(p[0] - t[0]) + abs(p[1] - t[1])
                                  for t in context.uncertainty_targets), a) for a, p in neighbors]
                best = min(d for d, _ in distances)
                return rng.choice([a for d, a in distances if d == best])
        elif roll < 0.70 and unexplored:
            return rng.choice(unexplored)[0]
        return rng.choice(neighbors)[0]
