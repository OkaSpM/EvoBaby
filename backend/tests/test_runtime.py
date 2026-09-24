import json

import pytest
from pydantic import ValidationError

from app.config import BASE, WorldConfig
from app.schemas import Action, Resource
from app.simulation.agent import ExplorationPolicy, decision_context
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventType


class FixedPolicy:
    def __init__(self, action):
        self.action = action
        self.contexts = []

    def choose_action(self, context, rng):
        self.contexts.append(context)
        return self.action


def actions(events):
    return [e for e in events if e.type == EventType.ACTION_EXECUTED]


def test_five_identical_empty_agents_and_no_initial_knowledge():
    engine = SimulationEngine()
    assert len(engine.agents) == 5
    assert not engine.event_log.events
    for agent in engine.agents:
        assert agent.energy == 60
        assert not agent.personal_beliefs and not agent.adopted_shared_beliefs
        assert not agent.known_cells and not agent.recent_events
        assert agent.active_task is None
        assert not {"role", "personality", "interest", "skill"} & type(agent).model_fields.keys()
    assert len({a.position for a in engine.agents}) == 5


def test_full_replay_reset_and_new_seed():
    first, second = SimulationEngine(), SimulationEngine()
    initial = first.debug_snapshot()
    for _ in range(150):
        assert first.step() == second.step()
        for agent in first.agents:
            assert 0 <= agent.energy <= 100
            assert len(agent.recent_events) <= 24
    expected = first.debug_snapshot()
    assert expected == second.debug_snapshot()
    json.dumps(expected)
    first.reset()
    assert first.debug_snapshot() == initial
    for _ in range(150):
        first.step()
    assert first.debug_snapshot() == expected
    first.reset(seed=43)
    assert first.debug_snapshot()["world"]["cells"] != initial["world"]["cells"]


def test_one_action_per_active_agent_and_observation_provenance():
    engine = SimulationEngine()
    for _ in range(40):
        events = engine.step()
        executed = actions(events)
        assert len({e.agent_id for e in executed}) == len(executed)
        for event in executed:
            assert event.result.agent_id == event.agent_id
            assert event.result.turn == event.turn == engine.world.turn
        for agent in engine.agents:
            observed = {e.observation.position for e in engine.event_log.events
                        if e.agent_id == agent.id and e.type == EventType.OBSERVATION}
            assert set(agent.known_cells) == observed
            assert all(e.result.agent_id == agent.id for e in agent.recent_events)
    assert len({tuple(sorted(a.known_cells)) for a in engine.agents}) > 1


def test_local_context_has_no_audit_or_world_access_and_is_deeply_immutable():
    policy = FixedPolicy(Action.INSPECT)
    engine = SimulationEngine(policy=policy)
    engine.step()
    context = policy.contexts[0]
    assert set(type(context).model_fields) == {"agent_id", "observation", "inventory", "known_cells",
                                         "recent_events", "uncertainty_targets", "personal_beliefs",
                                         "adopted_shared_beliefs", "relevant_evidence", "active_meta_beliefs", "open_tasks",
                                         "active_task", "verification_requests"}
    assert len(context.known_cells) == 1
    assert not context.recent_events
    with pytest.raises(ValidationError):
        context.observation.energy = 0
    with pytest.raises(TypeError):
        context.inventory[0] = (Resource.BERRY, 100)
    engine.agents[0].inventory[Resource.BERRY] = 5
    assert dict(context.inventory)[Resource.BERRY] == 0


def test_audit_and_nested_action_results_are_immutable():
    engine = SimulationEngine()
    event = actions(engine.step())[0]
    snapshot = engine.event_log.events
    with pytest.raises(ValidationError):
        event.turn = 999
    with pytest.raises(ValidationError):
        event.result.energy_after = 100
    with pytest.raises(AttributeError):
        snapshot.append(event)
    engine.step()
    assert len(engine.event_log.events) > len(snapshot)
    assert [e.event_id for e in engine.event_log.events] == [
        f"E{i + 1}" for i in range(len(engine.event_log.events))]


def test_recovery_skips_three_complete_turns_and_logs_transition():
    engine = SimulationEngine(policy=FixedPolicy(Action.INSPECT))
    agent = engine.agents[0]
    agent.energy = 1
    origin = agent.position
    event = actions(engine.step())[0]
    assert event.result.position == origin
    assert event.observation.position == agent.position == BASE
    assert agent.energy == 0
    for _ in range(3):
        assert not any(e.agent_id == agent.id for e in engine.step())
        assert agent.current_action is None
    events = engine.step()
    recovered = [e for e in events if e.type == EventType.REACTIVATED]
    assert len(recovered) == 1 and recovered[0].observation.energy == 40
    assert agent.energy == 39


def test_resource_competition_uses_world_outcomes_not_decision_assumptions():
    policy = FixedPolicy(Action.COLLECT)
    engine = SimulationEngine(policy=policy)
    for agent in engine.agents:
        agent.position = (0, 0)
    engine.world.cells[(0, 0)].object = Resource.BERRY
    executed = actions(engine.step())
    assert all(c.observation.object == Resource.BERRY for c in policy.contexts)
    assert [e.result.success for e in executed] == [True, False, False, False, False]
    assert engine.agents[0].inventory[Resource.BERRY] == 1
    assert sum(a.inventory[Resource.BERRY] for a in engine.agents) == 1


class BranchRandom:
    def __init__(self, roll):
        self.roll = roll
        self.candidates = None

    def random(self):
        return self.roll

    def choice(self, candidates):
        self.candidates = candidates
        return candidates[0]


def exploration_context():
    engine = SimulationEngine()
    agent = engine.agents[0]
    agent.position = (1, 1)
    for p in ((1, 1), (1, 0), (1, 2), (0, 1)):
        agent.position = p
        agent.known_cells[p] = engine.world.observe(agent)
    agent.position = (1, 1)
    return agent, engine.world.observe(agent)


@pytest.mark.parametrize("roll,expected_count", [(0.0, 1), (0.699, 1), (0.70, 4), (0.99, 4)])
def test_birth_exploration_probability_branches(roll, expected_count):
    agent, observation = exploration_context()
    rng = BranchRandom(roll)
    ExplorationPolicy().explore(decision_context(agent, observation), rng)
    assert len(rng.candidates) == expected_count


@pytest.mark.parametrize("roll,expected", [(0.59, Action.MOVE_E), (0.60, Action.MOVE_W),
                                          (0.89, Action.MOVE_W), (0.90, Action.MOVE_N)])
def test_ephemeral_uncertainty_movement(roll, expected):
    agent, observation = exploration_context()
    context = decision_context(agent, observation, uncertainty_targets=((0, 1),))
    assert ExplorationPolicy().explore(context, BranchRandom(roll)) == expected


def test_decision_rng_does_not_change_weather_or_world_generation():
    class NoisyPolicy(FixedPolicy):
        def choose_action(self, context, rng):
            for _ in range(50):
                rng.random()
            return self.action
    first = SimulationEngine(policy=FixedPolicy(Action.INSPECT))
    second = SimulationEngine(policy=NoisyPolicy(Action.INSPECT))
    for _ in range(100):
        first.step()
        second.step()
        assert first.world.debug_snapshot() == second.world.debug_snapshot()


def test_moss_trial_is_based_on_local_experience_not_hidden_rule():
    engine = SimulationEngine(WorldConfig(weather_schedule=("Sunny",)))
    agent = engine.agents[0]
    engine.world.cells[agent.position].object = Resource.MOSS
    first = actions(engine.step())[0]
    assert first.result.action == Action.USE_MOSS
    assert first.result.resource_effect == -8
    second = actions(engine.step())[0]
    assert second.result.action in (Action.MOVE_N, Action.MOVE_S, Action.MOVE_E, Action.MOVE_W)
