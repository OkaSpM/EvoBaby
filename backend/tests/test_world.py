import random

import pytest
from pydantic import ValidationError

from app.config import BASE, SPAWN_PROBABILITIES, WorldConfig
from app.schemas import Action, BodyState, Resource, Weather
from app.simulation.world import World, region_at


def body(position=(0, 0), energy=60):
    return BodyState(id="A1", position=position, energy=energy)


def test_seeded_generation_and_long_replay():
    left, right = World(), World()
    assert left.debug_snapshot() == right.debug_snapshot()
    assert left.debug_snapshot() != World(WorldConfig(seed=43)).debug_snapshot()
    agents = [body(), body()]
    actions = [Action.INSPECT, Action.MOVE_E, Action.COLLECT, Action.USE_BERRY,
               Action.MOVE_S, Action.USE_MOSS, Action.USE_CRYSTAL]
    for turn in range(100):
        for world in (left, right):
            world.advance()
        results = [w.execute(a, actions[turn % len(actions)])
                   for w, a in zip((left, right), agents)]
        assert results[0] == results[1]
        assert agents[0] == agents[1]
        assert left.debug_snapshot() == right.debug_snapshot()


def test_demo_minimums_over_many_seeds():
    for seed in range(300):
        world = World(WorldConfig(seed=seed))
        cells = list(world.cells.values())
        assert len(cells) == 64
        assert sum(c.object == Resource.BERRY for c in cells) >= 3
        assert sum(c.object == Resource.CRYSTAL for c in cells) >= 2
        for northwest in (True, False):
            assert sum(c.object == Resource.MOSS and
                       (region_at(c.position) == "NW") == northwest for c in cells) >= 2


def test_generation_uses_specified_probability_intervals_without_demo_repair():
    world = World(WorldConfig(seed=19, demo_mode=False))
    rng = random.Random(19)
    for position, cell in world.cells.items():
        sample = rng.random()
        berry, crystal, moss = SPAWN_PROBABILITIES[region_at(position)]
        expected = (Resource.BERRY if sample < berry else Resource.CRYSTAL
                    if sample < berry + crystal else Resource.MOSS
                    if sample < berry + crystal + moss else None)
        assert cell.object == expected


def test_berry_respawns_exactly_three_turns_after_collection():
    world, agent = World(), body()
    world.advance()
    world.cells[(0, 0)].object = Resource.BERRY
    result = world.execute(agent, Action.COLLECT)
    assert result.success and agent.energy == 59
    assert agent.inventory[Resource.BERRY] == 1
    for _ in range(2):
        world.advance()
        assert world.cells[(0, 0)].object is None
    world.advance()
    assert world.cells[(0, 0)].object == Resource.BERRY
    assert world.cells[(0, 0)].respawn_at is None


def test_crystal_never_respawns():
    world, agent = World(), body()
    world.cells[(0, 0)].object = Resource.CRYSTAL
    world.execute(agent, Action.COLLECT)
    for _ in range(100):
        world.advance()
    assert world.cells[(0, 0)].object is None
    assert world.cells[(0, 0)].respawn_at is None
    result = world.execute(agent, Action.USE_CRYSTAL)
    assert result.resource_effect == 18 and agent.energy == 77


@pytest.mark.parametrize("position", [(0, 0), (4, 0), (0, 4), (4, 4)])
@pytest.mark.parametrize("weather", list(Weather))
def test_moss_all_eight_contexts(position, weather):
    world, agent = World(), body(position)
    world.weather = weather
    world.cells[position].object = Resource.MOSS
    expected = 20 if weather == Weather.RAIN and position == (0, 0) else -8
    result = world.execute(agent, Action.USE_MOSS)
    assert result.success and result.resource_effect == expected
    assert agent.energy == 60 + expected
    assert world.cells[position].object == Resource.MOSS
    assert not world.execute(agent, Action.COLLECT).success


def test_inventory_consumption_and_energy_cap():
    world, agent = World(), body(energy=96)
    assert not world.execute(agent, Action.USE_BERRY).success
    agent.inventory[Resource.BERRY] = 1
    result = world.execute(agent, Action.USE_BERRY)
    assert result.resource_effect == 10 and agent.energy == 100
    assert agent.inventory[Resource.BERRY] == 0
    assert not world.execute(agent, Action.USE_BERRY).success


def test_movement_cost_bounds_and_inspection():
    world, agent = World(), body()
    for action in (Action.MOVE_N, Action.MOVE_W):
        assert world.execute(agent, action).reason == "OUT_OF_BOUNDS"
    assert agent.energy == 60
    world.execute(agent, Action.MOVE_E)
    world.execute(agent, Action.MOVE_S)
    world.execute(agent, Action.INSPECT)
    assert agent.position == (1, 1) and agent.energy == 57
    agent.position = (7, 7)
    for action in (Action.MOVE_E, Action.MOVE_S):
        assert not world.execute(agent, action).success


def test_exhaustion_returns_to_base_and_three_full_turns_of_rest():
    world, agent = World(), body(energy=1)
    result = world.execute(agent, Action.INSPECT)
    assert result.returned_to_base and result.position == (0, 0)
    assert agent.position == BASE and agent.energy == 0
    for _ in range(3):
        world.advance()
        assert world.execute(agent, Action.INSPECT).reason == "UNAVAILABLE"
        assert agent.energy == 0
    world.advance()
    assert world.reactivate(agent)
    assert agent.energy == 40 and agent.unavailable_until_turn is None


def test_moss_damage_clamps_energy_at_zero():
    world, agent = World(), body(energy=3)
    world.cells[(0, 0)].object = Resource.MOSS
    result = world.execute(agent, Action.USE_MOSS)
    assert result.resource_effect == -8 and result.energy_after == 0
    assert result.returned_to_base


def test_weather_changes_only_every_four_turns_and_schedule_is_repeatable():
    world = World(WorldConfig(weather_schedule=("Sunny", "Rain")))
    for turn in range(1, 33):
        world.advance()
        assert world.weather == (Weather.SUNNY if (turn // 4) % 2 == 0 else Weather.RAIN)
    world = World()
    for turn in range(1, 101):
        previous = world.weather
        world.advance()
        if turn % 4:
            assert world.weather == previous


def test_weather_transition_threshold():
    class StubRandom:
        def __init__(self):
            self.samples = iter((0.69, 0.70, 0.99))

        def random(self):
            return next(self.samples)

    world = World()
    world._rng = StubRandom()
    observed = []
    for _ in range(3):
        for _ in range(4):
            world.advance()
        observed.append(world.weather)
    assert observed == [Weather.SUNNY, Weather.RAIN, Weather.SUNNY]


def test_observation_is_local_immutable_and_has_no_privileged_fields():
    world, agent = World(), body()
    observation = world.observe(agent)
    assert set(observation.model_dump()) == {"position", "region", "weather", "object", "energy"}
    with pytest.raises(ValidationError):
        observation.energy = 1
    assert "seed" in world.debug_snapshot()


def test_invalid_configuration_and_coordinates_rejected():
    with pytest.raises(ValueError):
        WorldConfig(weather_schedule=())
    with pytest.raises(ValueError):
        WorldConfig(weather_schedule=("Snow",))
    with pytest.raises(ValidationError):
        body((8, 0))
    with pytest.raises(ValueError):
        region_at((-1, 0))


def test_two_agents_cannot_collect_the_same_resource():
    world = World()
    world.cells[(0, 0)].object = Resource.BERRY
    first, second = body(), BodyState(id="A2", position=(0, 0))
    assert world.execute(first, Action.COLLECT).success
    assert not world.execute(second, Action.COLLECT).success
    assert second.inventory[Resource.BERRY] == 0


@pytest.mark.parametrize("inventory", [
    {"Berry": -1}, {"Berry": 1.5}, {"Berry": True}, {"Moss": 1},
])
def test_invalid_inventory_rejected_at_state_boundary(inventory):
    with pytest.raises(ValidationError):
        BodyState(id="A1", position=(0, 0), inventory=inventory)


def test_body_state_json_roundtrip_preserves_english_contract():
    agent = BodyState(id="A1", position=(0, 0), inventory={"Berry": 2, "Crystal": 1})
    payload = agent.model_dump_json()
    restored = BodyState.model_validate_json(payload)
    assert restored == agent
    world = World()
    assert world.execute(restored, Action.USE_BERRY).success
    assert restored.inventory[Resource.BERRY] == 1
    assert restored.energy == 70
    with pytest.raises(ValidationError):
        restored.unavailable_until_turn = -1
