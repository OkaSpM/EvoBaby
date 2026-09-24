"""B-only methods, local feedback and public closure contract."""
import asyncio
import random

import httpx
import pytest

from app.api.b_controller import BSimulationController
from app.config import WorldConfig
from app.llm.schemas import ReasoningKind, ReasoningRequest
from app.schemas import Action, Observation, Region, Resource, Weather
from app.simulation.b_engine import BSimulationEngine
from app.simulation.b_evidence import checked_effects
from app.simulation.b_game import BMergedGame
from app.simulation.b_policy import BCooperativePolicy, BDecisionContext, BMockProvider
from app.simulation.coordination_models import (
    RequiredContext, SwarmMessage, Task, TaskClaim, TaskType, MessageType,
)
from app.simulation.corruption import IncidentStatus
from app.simulation.events import EventType
from app.simulation.memory import Belief, BeliefStatus, BeliefType, Conditions, EvidenceKind, ExpectedEffect


def effect(engine, actor=0, turn=1, position=(1, 1), weather=Weather.RAIN):
    agent = engine.agents[actor]
    engine.world.turn, engine.world.weather = turn, weather
    agent.position, agent.energy = position, 60
    engine.world.cells[position].object = Resource.MOSS
    result = engine.world.execute(agent, Action.USE_MOSS)
    event = engine.event_log.append(EventType.ACTION_EXECUTED, turn, agent.id,
                                    engine.world.observe(agent), result)
    engine.belief_engine.consume((event,), engine.agents)
    return engine.belief_engine.evidence[-1]


def claim(owner="A1", id="B1", conditions=None, status=BeliefStatus.VERIFIED):
    return Belief(id=id, type=BeliefType.CONDITIONAL_EFFECT, proposition="rainy moss recovers energy",
                  object=Resource.MOSS, conditions=conditions or Conditions(weather=Weather.RAIN),
                  expected_effect=ExpectedEffect.ENERGY_POSITIVE, alpha=4, beta=1,
                  source_agent_id=owner, owner_agent_id=owner, status=status,
                  created_turn=0, updated_turn=0)


def context(stage=1, **changes):
    fields = {"agent_id": "A1", "observation": Observation(position=(1, 1), region=Region.NW,
               weather=Weather.RAIN, object=Resource.MOSS, energy=60), "inventory": (),
              "known_cells": (), "recent_events": (), "cognition_stage": stage}
    fields.update(changes)
    return BDecisionContext(**fields)


def install(engine, belief):
    engine.belief_engine._beliefs[belief.id] = belief
    actor = next(agent for agent in engine.agents if agent.id == belief.owner_agent_id)
    actor.personal_beliefs.append(belief.id)


def observe_feedback(engine):
    engine.feedback.observe(engine.agents, engine.belief_engine, engine.swarm,
                            engine.event_log.events, engine.world.turn, engine.cognition,
                            engine.method_actions, engine.task_engine)


def test_b_context_and_mock_preserve_real_stage():
    engine = BSimulationEngine()
    engine.cognition._views["A1"] = engine.cognition.view("A1").model_copy(update={"stage": 3})
    c = engine._context(engine.agents[0], engine.world.observe(engine.agents[0]))
    request = ReasoningRequest(kind=ReasoningKind.ACTION_REASONING, turn=1, agent_id="A1", context=c)
    assert request.context.cognition_stage == 3
    assert "B阶段3" in BMockProvider().decide(request).reason
    assert isinstance(engine.policy, BCooperativePolicy)
    assert isinstance(engine.reasoning.mock, BMockProvider)


def test_b_local_context_never_asks_hidden_forgery_registry(monkeypatch):
    engine = BSimulationEngine()
    sample = effect(engine)
    def forbidden(_):
        raise AssertionError("hidden attack registry was consulted")
    monkeypatch.setattr(engine.corruption, "is_forged", forbidden)
    c = engine._context(engine.agents[0], engine.world.observe(engine.agents[0]))
    assert sample.id in {item.id for item in c.relevant_evidence}


def test_stage_two_selects_missing_condition_instead_of_repeating_stage_one_use():
    engine = BSimulationEngine()
    sample = effect(engine)
    rule = claim()
    remote = Observation(position=(1, 5), region=Region.SW, weather=Weather.RAIN,
                         object=Resource.MOSS, energy=60)
    policy = BCooperativePolicy()
    c = context(personal_beliefs=(rule,), known_cells=(remote,), relevant_evidence=(sample,))
    assert policy.choose_action(c, random.Random(0)) == Action.USE_MOSS
    assert policy.choose_action(c.model_copy(update={"cognition_stage": 2}), random.Random(0)) == Action.MOVE_S


def test_stage_two_tests_on_arrival_instead_of_oscillating_between_regions():
    engine = BSimulationEngine()
    agent = engine.agents[0]
    sample = effect(engine, position=(3, 1))
    agent.energy = 60
    engine.world.cells[(4, 1)].object = Resource.MOSS
    known = (engine.world.observe(agent), Observation(position=(4, 1), region=Region.NE,
             weather=Weather.RAIN, object=Resource.MOSS, energy=60))
    c = context(2, observation=engine.world.observe(agent), personal_beliefs=(claim(),),
                known_cells=known, relevant_evidence=(sample,))
    policy = BCooperativePolicy()
    first = policy.choose_action(c, random.Random(0))
    assert first == Action.MOVE_E
    engine.world.execute(agent, first)
    arrived = c.model_copy(update={"observation": engine.world.observe(agent)})
    assert policy.choose_action(arrived, random.Random(0)) == Action.USE_MOSS
    untried = c.model_copy(update={"relevant_evidence": ()})
    assert policy.choose_action(untried, random.Random(0)) == Action.USE_MOSS


def task_fixture():
    requirement = RequiredContext(id="C1", object=Resource.MOSS,
                                  evidence_kind=EvidenceKind.CELL_OBSERVATION)
    own_rule, peer_rule = claim(), claim(owner="A2", id="B2")
    tasks = tuple(Task(id=f"T{i}", type=TaskType.VERIFICATION, priority=priority, created_turn=0,
                       updated_turn=0, last_broadcast_turn=0, description="independent verification",
                       belief_id=belief.id, required_contexts=(requirement,))
                  for i, priority, belief in ((1, 60, own_rule), (2, 50, peer_rule)))
    requests = tuple(SwarmMessage(id=f"M{i}", type=MessageType.REQUEST_VERIFICATION,
                                 turn=0, from_agent=belief.owner_agent_id, belief=belief,
                                 belief_id=belief.id, task_id=task.id)
                     for i, task, belief in ((1, tasks[0], own_rule), (2, tasks[1], peer_rule)))
    return tasks, requests


def test_stage_three_prioritizes_missing_independent_contribution():
    tasks, requests = task_fixture()
    c = context(2, open_tasks=tasks, verification_requests=requests)
    policy = BCooperativePolicy()
    assert policy.choose_task(c).task_id == "T1"
    assert policy.choose_task(c.model_copy(update={"cognition_stage": 3})).task_id == "T2"


def test_stage_four_sends_cross_task_evidence_stage_three_keeps_local():
    engine = BSimulationEngine()
    sample = effect(engine)
    _, requests = task_fixture()
    c = context(3, relevant_evidence=(sample,), verification_requests=(requests[1],))
    policy = BCooperativePolicy()
    assert not any(message.type == MessageType.SUBMIT_EVIDENCE for message in policy.choose_messages(c))
    messages = policy.choose_messages(c.model_copy(update={"cognition_stage": 4}))
    assert any(message.type == MessageType.SUBMIT_EVIDENCE and message.belief_id == "B2"
               and message.evidence_id == sample.id for message in messages)


def test_consuming_energy_does_not_reduce_reliability_or_historical_stage():
    engine = BSimulationEngine()
    agent = engine.agents[0]
    engine.cognition._views[agent.id] = engine.cognition.view(agent.id).model_copy(update={"stage": 3})
    agent.energy = 2
    engine.world.execute(agent, Action.INSPECT)
    observe_feedback(engine)
    assert agent.energy == 1
    assert engine.feedback.view(agent.id)["state"] == "stable"
    assert engine.cognition.view(agent.id).stage == 3


def test_only_linked_real_counterevidence_opens_review():
    engine = BSimulationEngine()
    broad = claim()
    install(engine, broad)
    effect(engine, position=(1, 5))
    observe_feedback(engine)
    view = engine.feedback.view("A1")
    assert view["state"] == "review" and view["ruleIds"] == [broad.id]
    assert engine.feedback.view("A2")["state"] == "stable"
    assert engine.belief_engine.get(broad.id).confidence < broad.confidence


def test_negative_effect_supporting_a_negative_rule_is_not_a_cognition_fault():
    engine = BSimulationEngine()
    negative = claim(conditions=Conditions(region=Region.SW)).model_copy(
        update={"expected_effect": ExpectedEffect.ENERGY_NEGATIVE})
    install(engine, negative)
    effect(engine, position=(1, 5))
    observe_feedback(engine)
    assert engine.feedback.view("A1")["state"] == "stable"


def test_unverifiable_fabricated_sample_is_not_feedback_evidence():
    engine = BSimulationEngine()
    install(engine, claim())
    real = effect(engine, actor=1, position=(1, 5))
    fabricated = real.model_copy(update={"id": "EVfake", "agent_id": "A1"})
    engine.belief_engine._evidence[fabricated.id] = fabricated
    observe_feedback(engine)
    assert fabricated.id not in checked_effects((fabricated,), engine.event_log.events)
    assert engine.feedback.view("A1")["state"] == "stable"


def test_unsafe_publication_blocked_but_investigation_actions_remain_available():
    engine = BSimulationEngine()
    sample = effect(engine, position=(1, 5))
    rule = claim()
    c = context(3, personal_beliefs=(rule,), relevant_evidence=(sample,),
                observation=Observation(position=(1, 5), region=Region.SW, weather=Weather.RAIN,
                                        object=Resource.MOSS, energy=60))
    policy = BCooperativePolicy()
    assert not any(message.type == MessageType.SHARE_BELIEF for message in policy.choose_messages(c))
    requirement = RequiredContext(id="C1", conditions=Conditions(region=Region.SW, weather=Weather.RAIN),
                                  object=Resource.MOSS, evidence_kind=EvidenceKind.ACTION_EFFECT)
    task = Task(id="T1", type=TaskType.INVESTIGATION, priority=95, created_turn=1, updated_turn=1,
                last_broadcast_turn=1, description="fresh countertest", belief_id=rule.id,
                required_contexts=(requirement,), claimant_agent_ids=("A1",),
                claimed_contexts=(TaskClaim(agent_id="A1", context_id="C1", claimed_turn=1),))
    c = c.model_copy(update={"active_task": task, "known_cells": (c.observation,)})
    assert policy.choose_action(c, random.Random(0)) == Action.USE_MOSS


def test_real_counterexample_blocks_re_adoption_of_same_unsafe_claim():
    engine = BSimulationEngine()
    game = BMergedGame(engine)
    effect(engine, position=(1, 5))
    assert game._adoption_allowed(engine.agents[0], claim(owner="A2"), "A2", "M1", 1) is False


def test_attempted_reuse_after_counterexample_becomes_misaligned_and_is_blocked():
    engine = BSimulationEngine()
    install(engine, claim())
    effect(engine, position=(1, 5))
    observe_feedback(engine)
    game = BMergedGame(engine)
    engine.world.turn = 2
    action = game.filter_action(engine.agents[0], Action.USE_MOSS)
    observe_feedback(engine)
    assert action != Action.USE_MOSS
    assert engine.feedback.view("A1")["state"] == "misaligned"
    assert engine.method_actions[-1]["blocked_rule_ids"] == ["B1"]


def test_unrelated_survival_task_does_not_claim_a_rebuilding_contribution():
    engine = BSimulationEngine()
    install(engine, claim())
    effect(engine, position=(1, 5))
    task = Task(id="Ts", type=TaskType.SURVIVAL, priority=99, created_turn=1, updated_turn=1,
                last_broadcast_turn=1, description="find energy", required_contexts=())
    engine.task_engine._tasks[task.id] = task
    engine.agents[0].active_task = task.id
    observe_feedback(engine)
    assert engine.feedback.view("A1")["state"] == "review"


def test_revocation_rebuilds_and_verified_narrower_rule_recovers_without_losing_stage():
    engine = BSimulationEngine()
    broad = claim()
    install(engine, broad)
    effect(engine, turn=1, position=(1, 5))
    observe_feedback(engine)
    engine.belief_engine._beliefs[broad.id] = engine.belief_engine.get(broad.id).model_copy(
        update={"status": BeliefStatus.REVOKED})
    observe_feedback(engine)
    assert engine.feedback.view("A1")["state"] == "rebuilding"
    samples = [effect(engine, actor=actor, turn=turn) for actor, turn in ((0, 2), (1, 3), (0, 4))]
    repaired = claim(id="Bfixed", conditions=Conditions(region=Region.NW, weather=Weather.RAIN)).model_copy(
        update={"evidence_ids": tuple(sample.id for sample in samples), "updated_turn": 4})
    install(engine, repaired)
    observe_feedback(engine)
    assert engine.feedback.view("A1")["state"] == "recovered"
    game = BMergedGame(engine)
    c = engine._context(engine.agents[0], engine.world.observe(engine.agents[0]))
    proposed = engine.policy.choose_action(c, random.Random(0))
    assert proposed == Action.USE_MOSS
    assert game.filter_action(engine.agents[0], proposed) == Action.USE_MOSS
    assert engine.method_actions[-1]["blocked_rule_ids"] == []
    engine.belief_engine._beliefs[broad.id] = engine.belief_engine.get(broad.id).model_copy(
        update={"status": BeliefStatus.DISPUTED})
    game.choices["D2"] = "A"
    assert game.filter_action(engine.agents[0], Action.USE_MOSS) == Action.USE_MOSS
    assert engine.method_actions[-1]["blocked_rule_ids"] == []


async def play_to_observation(controller, choices=None, limit=240):
    choices = choices or {"D1": "D", "D2": "A", "D3": "A", "D4": "A"}
    while controller.engine.world.turn < limit and not controller.game.observation_complete:
        if controller.game.awaiting_choice:
            point = controller.game.awaiting_choice["point"]
            await controller.choose(point, choices[point])
        else:
            await controller.advance(1)
    assert controller.game.observation_complete
    return controller


@pytest.fixture(scope="module")
def observed(tmp_path_factory):
    controller = BSimulationController(card_directory=tmp_path_factory.mktemp("b-cards"))
    return asyncio.run(play_to_observation(controller))


def test_case_receipts_survive_equivalent_root_association_and_replay(observed):
    state = observed._state()
    first = state.incidents[0]
    case = observed._case(observed.engine.corruption.incidents[0])
    assert case.root_belief_id != observed.engine.corruption.incidents[0].root_belief_id
    assert len(first.evidenceByContext) == len(case.evidence_ids) > 0
    facts = state.merged_game["b_review"]["cases"][0]
    assert facts["first_counterexample_turn"] <= facts["detected_turn"]
    assert all(item["receipt_verified"] and item["turn"] <= state.simulation.turn for item in facts["evidence"])
    replay = asyncio.run(observed.replay(state.simulation.turn))
    assert replay.incidents[0].evidenceByContext == first.evidenceByContext
    assert replay.merged_game["b_review"]["cases"] == state.merged_game["b_review"]["cases"]


def test_unconfirmed_public_projection_does_not_reveal_source_or_forgery(observed):
    state = observed._state()
    assert all(incident.rootBeliefId is None and incident.targetAgentId is None for incident in state.incidents)
    payload = str(state.merged_game["b_review"])
    assert "forged" not in payload and "root_belief_id" not in payload and "target_agent_id" not in payload
    assert all(not item["source_confirmed"] for item in state.merged_game["b_review"]["cases"])


def test_prevented_is_not_mislabeled_full_repair_success(observed):
    engine = BSimulationEngine()
    first, second = observed.engine.corruption.incidents
    engine.corruption._incidents = {first.id: first, second.id: second.model_copy(
        update={"status": IncidentStatus.PREVENTED})}
    game = BMergedGame(engine)
    game.observation_complete = True
    game.confirmed_incidents = {first.id, second.id}
    assert game.closure()["status"] == "partial"
    assert game.closure()["can_continue"] is False


def test_first_counterexample_is_recorded_during_tentative_verification(observed):
    engine = BSimulationEngine()
    game = BMergedGame(engine)
    root = claim(id="Btentative", status=BeliefStatus.TENTATIVE)
    install(engine, root)
    incident = observed.engine.corruption.incidents[1].model_copy(update={
        "root_belief_id": root.id, "target_agent_id": "A1", "injected_turn": 0,
        "status": IncidentStatus.VERIFYING})
    engine.corruption._incidents = {incident.id: incident}
    sample = effect(engine, turn=1, position=(1, 5))
    assert game.first_counterexamples == {}
    game._capture_new_counters()
    assert game.first_counterexamples[incident.id]["evidence_id"] == sample.id
    assert game.first_counterexamples[incident.id]["turn"] == 1


def test_source_confirmation_can_revisit_first_case_after_second_exists(observed):
    async def verify():
        first = observed.engine.corruption.incidents[0]
        result = await observed.accuse_case(first.id, first.target_agent_id, first.root_belief_id)
        assert result["correct"] is True
        assert result["state"].incidents[0].rootBeliefId == first.root_belief_id
        assert result["state"].incidents[1].rootBeliefId is None
        count = len(observed.cards)
        await observed.accuse_case(first.id, first.target_agent_id, first.root_belief_id)
        assert len(observed.cards) == count
    asyncio.run(verify())


def test_b_routes_and_card_directory_are_separate(tmp_path):
    from app.b_main import create_b_app
    controller = BSimulationController(card_directory=tmp_path / "b-cards")
    application = create_b_app(controller, frontend_dist=tmp_path / "dist")
    async def verify():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://b.test") as client:
            response = await client.get("/api/state")
            assert response.status_code == 200
            assert response.json()["merged_game"]["b_review"]["version"] == 1
            assert (await client.post("/api/b/continue", json={})).status_code == 409
            assert (await client.post("/api/b/continue", json={"turns": 0})).status_code == 422
            assert (await client.post("/api/b/trace/accuse", json={"incident_id": "none", "agent_id": "A1", "belief_id": "B1"})).status_code == 409
    asyncio.run(verify())
    assert controller._card_directory == tmp_path / "b-cards"
    assert not controller.cards


def test_timeout_continuation_and_two_case_confirmation_form_one_honest_closure(tmp_path):
    async def verify():
        controller = BSimulationController(card_directory=tmp_path / "cards")
        choices = {"D1": "D", "D2": "A", "D3": "D", "D4": "A"}
        while controller.engine.world.turn < 160 and not controller.game.observation_complete:
            if controller.game.awaiting_choice:
                point = controller.game.awaiting_choice["point"]
                if point == "D3":
                    controller.game.max_attack_turns = 1
                await controller.choose(point, choices[point])
            else:
                await controller.advance(1)
        assert controller.game.observation_complete
        assert controller.game.closure()["status"] == "partial"
        assert controller.game.closure()["can_continue"] is True
        old_card = controller.game.paradigm()
        old_card_ids = set(controller.cards)
        assert len(old_card_ids) == 1
        assert old_card["b_outcome"]["status"] != "success"
        frozen = controller.engine.world.turn
        await controller.advance(5)
        assert controller.engine.world.turn == frozen
        await controller.continue_investigation(60)
        assert controller.game.paradigm() is None
        assert controller.game.closure()["status"] == "playing"
        assert old_card_ids <= set(controller.cards)
        await play_to_observation(controller, choices, limit=frozen + 60)
        assert all(incident.status == IncidentStatus.REPAIRED for incident in controller.engine.corruption.incidents)
        assert controller.game.closure()["status"] == "awaiting_trace"
        assert controller.game.paradigm() is None
        first, second = controller.engine.corruption.incidents
        wrong = await controller.accuse_case(first.id, second.target_agent_id, second.root_belief_id)
        assert wrong["correct"] is False and wrong["penalty_seconds"] == 30
        await controller.accuse_case(first.id, first.target_agent_id, first.root_belief_id)
        assert controller.game.closure()["status"] == "awaiting_trace"
        assert controller.game.paradigm() is None
        result = await controller.accuse_case(second.id, second.target_agent_id, second.root_belief_id)
        assert result["correct"] is True and result["turn"] == controller.engine.world.turn
        assert controller.game.closure()["status"] == "success"
        card = controller.game.paradigm()
        assert card["b_outcome"]["status"] == "success"
        assert all(item["source_confirmed"] and item["status"] == "REPAIRED" for item in card["caseChronology"])
        assert len(controller.cards) == 2 and old_card_ids < set(controller.cards)
        assert next(controller.cards[id] for id in old_card_ids)["b_outcome"]["status"] == "partial"
        with pytest.raises(ValueError, match="NO_OPEN_INVESTIGATION"):
            await controller.continue_investigation()
        await controller.shutdown()
    asyncio.run(verify())
