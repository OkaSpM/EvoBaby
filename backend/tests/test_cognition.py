import asyncio
from copy import deepcopy

import pytest

from app.api.controller import SimulationController
from app.api.models import AgentSummary
from app.schemas import Action, ActionResult, Observation, Region, Resource, Weather
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.cognition import CognitionTracker
from app.simulation.coordination_models import MessageIntent, MessageType
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventType
from app.simulation.memory import Conditions, ConditionalHypothesis, ExpectedEffect
from app.simulation.merged_game import MergedGame


def effect(engine, actor=0, turn=1, weather=Weather.RAIN, resource=Resource.BERRY):
    agent = engine.agents[actor]
    action = Action.USE_BERRY if resource == Resource.BERRY else Action.USE_MOSS
    delta = 10 if resource == Resource.BERRY else 20
    result = ActionResult(turn=turn, agent_id=agent.id, action=action, position=(1, 1),
                          region=Region.NW, weather=weather, object=resource, success=True,
                          reason="test experiment", energy_before=60, energy_after=60 + delta - 1,
                          action_cost=1, resource_effect=delta)
    observation = Observation(position=(1, 1), region=Region.NW, weather=weather,
                              object=resource, energy=result.energy_after)
    event = engine.event_log.append(EventType.ACTION_EXECUTED, turn, agent.id, observation, result)
    engine.belief_engine.consume((event,), engine.agents)
    return engine.belief_engine.evidence[-1]


def hypothesis(engine, actor=0, turn=2):
    return engine.belief_engine.propose_conditional(engine.agents[actor], ConditionalHypothesis(
        object=Resource.BERRY, conditions=Conditions(region=Region.NW),
        effect=ExpectedEffect.ENERGY_POSITIVE, reason="Two attributable berry experiments."), turn=turn)


def observe(engine, turn):
    engine.cognition.observe(engine.agents, engine.belief_engine, engine.swarm,
                             engine.investigation, engine.event_log.events, turn)


def submit(engine, actor, claim, evidence, turn):
    engine.task_engine.sync(engine.agents, engine.belief_engine, turn)
    engine.swarm.publish_tasks(engine.task_engine, engine.belief_engine, turn)
    assert engine.swarm.dispatch(engine.agents[actor], MessageIntent(
        type=MessageType.SUBMIT_EVIDENCE, belief_id=claim.id, evidence_id=evidence.id),
        engine.agents, engine.belief_engine, engine.task_engine, turn)


@pytest.fixture(scope="module")
def completed():
    async def play():
        engine = SimulationEngine()
        game = MergedGame(engine)
        history = {0: engine.cognition.members()}
        while engine.world.turn < 240 and not game.complete:
            while game.awaiting_choice:
                await game.choose(game.awaiting_choice["point"], "A")
            if game.complete:
                break
            await engine.step_async()
            await game.after_step()
            history[engine.world.turn] = engine.cognition.members()
        assert game.complete
        return engine, game, history
    return asyncio.run(play())


def test_initial_and_legacy_summary_are_safe():
    controller = SimulationController()
    view = controller._agent_summary(controller.engine.agents[0])
    assert view.cognition.stage == 1
    assert view.cognition.earnedTurn == 0
    assert len(view.cognition.milestones) == 1
    legacy = view.model_dump()
    del legacy["cognition"]
    parsed = AgentSummary.model_validate(legacy)
    assert parsed.cognition is None
    assert "cognition" not in parsed.model_dump()


def test_controller_card_storage_is_isolated_and_legacy_cards_stay_unknown(tmp_path):
    controller = SimulationController()
    assert controller._card_directory == tmp_path / "data" / "cards"
    assert controller.cards == {}
    controller._card_directory.mkdir(parents=True)
    (controller._card_directory / "legacy.json").write_text('{"name":"Legacy"}')
    reopened = SimulationController()
    assert reopened.cards["legacy"]["name"] == "Legacy"
    assert "memberCognition" not in reopened.cards["legacy"]


def test_repeating_the_same_experiment_does_not_unlock_recording():
    engine = SimulationEngine()
    effect(engine, turn=1)
    effect(engine, turn=2)
    hypothesis(engine)
    observe(engine, 2)
    assert engine.cognition.view("A1").stage == 1
    assert engine.cognition.view("A1").progress.current == 1
    effect(engine, turn=3, weather=Weather.SUNNY)
    observe(engine, 3)
    view = engine.cognition.view("A1")
    assert view.stage == 2 and view.earnedTurn == 3
    assert len(view.milestones[-1].evidenceIds) >= 2


def test_different_trials_without_personal_hypothesis_are_not_recording():
    engine = SimulationEngine()
    effect(engine, turn=1)
    effect(engine, turn=2, weather=Weather.SUNNY)
    observe(engine, 2)
    assert engine.cognition.view("A1").stage == 1
    assert "个人条件假设" in engine.cognition.view("A1").nextGoal


def test_verified_receipt_is_not_personal_contribution():
    engine = SimulationEngine()
    effect(engine, turn=1)
    effect(engine, turn=2, weather=Weather.SUNNY)
    claim = hypothesis(engine)
    independent = effect(engine, actor=1, turn=3)
    submit(engine, 1, claim, independent, 3)
    engine.swarm.dispatch(engine.agents[0], MessageIntent(
        type=MessageType.SHARE_BELIEF, belief_id=claim.id), engine.agents,
        engine.belief_engine, engine.task_engine, 3)
    observe(engine, 3)
    assert engine.cognition.view("A1").stage == 3
    assert all(engine.cognition.view(actor).stage == 1 for actor in ("A2", "A3", "A4", "A5"))
    assert engine.agents[2].adopted_shared_beliefs


def test_verified_owner_without_an_actual_exchange_is_not_cross_verification():
    engine = SimulationEngine()
    effect(engine, turn=1)
    effect(engine, turn=2, weather=Weather.SUNNY)
    claim = hypothesis(engine)
    independent = effect(engine, actor=1, turn=3)
    # Merely finding real records inside a belief does not prove collaboration.
    engine.belief_engine.submit_evidence(claim.id, independent.id, turn=3)
    assert engine.belief_engine.get(claim.id).status.value == "VERIFIED"
    observe(engine, 3)
    assert engine.cognition.view("A1").stage == 2


def test_unattributable_evidence_cannot_upgrade_even_if_memory_is_verified():
    engine = SimulationEngine()
    first = effect(engine, turn=1)
    effect(engine, turn=2, weather=Weather.SUNNY)
    claim = hypothesis(engine)
    forged = first.model_copy(update={"id": "EV-unsupported", "agent_id": "A2"})
    engine.belief_engine._evidence[forged.id] = forged
    submit(engine, 1, claim, forged, 3)
    assert engine.belief_engine.get(claim.id).status.value == "VERIFIED"
    observe(engine, 3)
    assert engine.cognition.view("A1").stage == 2
    assert forged.id not in engine.cognition._real_effects


def test_duplicate_citations_do_not_turn_one_experiment_into_three():
    engine = SimulationEngine()
    first = effect(engine, turn=1)
    effect(engine, turn=2, resource=Resource.MOSS)
    effect(engine, turn=3, weather=Weather.SUNNY, resource=Resource.MOSS)
    engine.belief_engine.propose_conditional(engine.agents[0], ConditionalHypothesis(
        object=Resource.MOSS, conditions=Conditions(region=Region.NW),
        effect=ExpectedEffect.ENERGY_POSITIVE, reason="Different observed conditions."), turn=3)
    duplicate = first.model_copy(update={"id": "EV-duplicate"})
    engine.belief_engine._evidence[duplicate.id] = duplicate
    claim = hypothesis(engine, turn=3)
    independent = effect(engine, actor=1, turn=4)
    submit(engine, 1, claim, independent, 4)
    assert engine.belief_engine.get(claim.id).status.value == "VERIFIED"
    observe(engine, 4)
    assert engine.cognition.view("A1").stage == 2


def test_default_path_reaches_four_stages_independently(completed):
    engine, game, history = completed
    assert engine.world.turn == 79
    assert history[0] == [{"agentId": f"A{i}", "stage": 1, "name": "探索者"} for i in range(1, 6)]
    assert history[14][-1]["stage"] == 2
    assert history[20][-1]["stage"] == 3
    assert history[71][3]["stage"] == 3
    assert history[72][3]["stage"] == 4
    assert [item["stage"] for item in game.paradigm()["memberCognition"]] == [3, 3, 3, 4, 3]
    for agent in engine.agents:
        view = engine.cognition.view(agent.id)
        assert [milestone.stage for milestone in view.milestones] == list(range(1, view.stage + 1))
        assert [milestone.turn for milestone in view.milestones] == sorted(m.turn for m in view.milestones)
        for milestone in view.milestones[1:]:
            assert milestone.evidenceIds
            assert all(i in engine.cognition._real_effects for i in milestone.evidenceIds)
            assert all(engine.belief_engine.evidence_by_id(i).turn <= milestone.turn for i in milestone.evidenceIds)
    assert game.paradigm()["metrics"]["attack1"]["repair_turns"] == 39


def test_fourth_stage_requires_own_counterexample_repair_and_actual_delivery(completed):
    source, _, _ = completed
    engine = deepcopy(source)
    engine.cognition = CognitionTracker(agent.id for agent in engine.agents)
    repaired = next(case for case in engine.investigation.cases
                    if engine.belief_engine.get(case.root_belief_id).owner_agent_id == "A4")
    assert any(engine.belief_engine.evidence_by_id(i).agent_id == "A4"
               and evaluate_evidence(engine.belief_engine.get(repaired.root_belief_id),
                                     engine.belief_engine.evidence_by_id(i)) is False for i in repaired.evidence_ids)
    # A message with no recipient receipt is not enough to claim teaching.
    engine.belief_engine._beliefs = {key: value for key, value in engine.belief_engine._beliefs.items()
                                    if not value.lineage or value.lineage.parent_belief_id != repaired.replacement_belief_id}
    observe(engine, 79)
    assert engine.cognition.view("A4").stage == 3
    assert engine.cognition.view("A4").progress.current == 2


def test_removed_member_is_frozen_and_reset_clears_growth():
    engine = SimulationEngine()
    effect(engine, turn=1)
    effect(engine, turn=2, weather=Weather.SUNNY)
    hypothesis(engine)
    observe(engine, 2)
    before = engine.cognition.view("A1")
    engine.cognition.remove("A1")
    independent = effect(engine, actor=1, turn=3)
    submit(engine, 1, engine.belief_engine.beliefs[0], independent, 3)
    observe(engine, 3)
    assert engine.cognition.view("A1") == before
    engine.reset()
    assert engine.cognition.view("A1").stage == 1
    assert engine.cognition.view("A1").earnedTurn == 0


def test_removal_api_freezes_the_member_without_advancing_its_history(tmp_path):
    async def scenario():
        controller = SimulationController()
        controller._card_directory = tmp_path
        await controller.start_game(seed=42)
        await controller.advance(14)
        before = (await controller.state()).agents[-1].cognition
        removed = await controller.remove_agent("A5")
        assert removed.agents[-1].removed
        await controller.advance(10)
        assert (await controller.state()).agents[-1].cognition == before
    asyncio.run(scenario())


def test_replay_and_ending_member_cognition_are_frozen(tmp_path):
    async def scenario():
        controller = SimulationController()
        controller._card_directory = tmp_path
        controller.cards = {}
        await controller.start_game(seed=42)
        await controller.advance(14)
        past = await controller.replay(14)
        assert past.agents[-1].cognition.stage == 2
        await controller.advance(6)
        assert (await controller.state()).agents[-1].cognition.stage == 3
        assert (await controller.replay(14)).agents[-1].cognition.stage == 2
        assert (await controller.replay(0)).agents[-1].cognition.stage == 1
        while not controller.game.complete:
            pending = controller.game.awaiting_choice
            if pending:
                await controller.choose(pending["point"], "D" if pending["point"] == "D1" else "A")
            else:
                await controller.advance(100)
        card = await controller.paradigm()
        stages = card["memberCognition"]
        assert stages == controller.engine.cognition.members()
        frozen = controller.game.paradigm()
        controller.engine.cognition = CognitionTracker(agent.id for agent in controller.engine.agents)
        assert controller.game.paradigm() == frozen
        assert next(iter(tmp_path.glob("*.json"))).read_text().find("memberCognition") >= 0
        await controller.start_game(seed=42)
        assert all(item.cognition.stage == 1 for item in (await controller.state()).agents)
    asyncio.run(scenario())
