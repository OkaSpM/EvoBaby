import asyncio

import pytest

from app.schemas import Action
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.corruption import IncidentStatus
from app.simulation.engine import SimulationEngine
from app.simulation.ending_matrix import run_path
from app.simulation.memory import BeliefStatus
from app.simulation.merged_game import ENDINGS, MergedGame, classify_ending


async def to_dispute(optional=False):
    engine = SimulationEngine()
    game = MergedGame(engine, optional_choices=optional)
    for _ in range(120):
        await engine.step_async()
        await game.after_step()
        if game.awaiting_choice:
            if game.awaiting_choice["point"] == "D1":
                await game.choose("D1", "D")
            else:
                return engine, game
    raise AssertionError("Real contradiction did not reach D2")


def test_d2_is_triggered_by_a_real_local_counterexample_and_stops_for_choice():
    async def scenario():
        engine, game = await to_dispute()
        choice = game.awaiting_choice
        assert choice["point"] == "D2"
        evidence = engine.belief_engine.evidence_by_id(choice["evidence_ids"][0])
        assert evidence.energy_delta == -8
        assert not engine.corruption.is_forged(evidence.id)
        assert any(event.event_id in evidence.event_ids and event.result.resource_effect == -8
                   for event in engine.event_log.events if event.result)
        with pytest.raises(ValueError, match="CHOICE_REQUIRED"):
            game.before_step()
        with pytest.raises(ValueError):
            await game.choose("D3", "A")
    asyncio.run(scenario())


def test_broadcast_freeze_changes_held_beliefs_and_blocks_uncontrolled_use():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "A")
        root = engine.belief_engine.get(engine.corruption.incidents[0].root_belief_id)
        assert all(b.status == BeliefStatus.DISPUTED for b in game._family(root))
        actor = next(agent for agent in engine.agents if agent.id == "A1")
        engine.task_engine.release(actor, engine.world.turn)
        assert game.filter_action(actor, Action.USE_MOSS) == Action.INSPECT
        assert game.policy_events[-1]["type"] == "BROADCAST_FREEZE"
    asyncio.run(scenario())


def test_local_recheck_executes_two_more_real_actions_before_broadcasting():
    async def scenario():
        engine, game = await to_dispute()
        initial = engine.world.turn
        await game.choose("D2", "B")
        assert engine.corruption.incidents[0].disputed_turn is None
        for _ in range(20):
            await engine.step_async()
            await game.after_step()
            if engine.corruption.incidents[0].disputed_turn is not None:
                break
        assert engine.corruption.incidents[0].disputed_turn > initial
        assert any(len(ids) >= 3 for ids in game._counters.values())
        ids = next(ids for ids in game._counters.values() if len(ids) >= 3)
        records = [engine.belief_engine.evidence_by_id(i) for i in ids]
        assert len({record.turn for record in records}) >= 3
        assert all(record.energy_delta == -8 for record in records)
    asyncio.run(scenario())


def test_revoke_only_has_no_investigation_and_does_not_claim_rule_repair():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "C")
        incident = engine.corruption.incidents[0]
        assert incident.status == IncidentStatus.REVOKED
        assert incident.repaired_hypothesis is None
        assert not engine.investigation.cases
        assert game.awaiting_choice["point"] == "D3"
        assert "没有查出" in game.awaiting_choice["reason"]
    asyncio.run(scenario())


def test_ignore_counts_actual_errors_and_marks_unresolved_window_honestly():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "D")
        for _ in range(100):
            await engine.step_async()
            await game.after_step()
            if game.awaiting_choice:
                break
        assert game.awaiting_choice["point"] == "D3"
        assert "未修复" in game.awaiting_choice["reason"]
        assert game._first_metrics["bad_actions"] >= 3
        assert game._first_metrics["detect_turns"] is None
        assert game._first_metrics["repair_turns"] is None
        assert game._first_metrics["censored"]
    asyncio.run(scenario())


def test_source_diversity_is_real_verification_policy_not_just_a_label():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "C")
        await game.choose("D3", "B")
        assert engine.belief_engine.minimum_independent_agents == 3
        incident = engine.corruption.incidents[1]
        belief = engine.belief_engine.get(incident.root_belief_id)
        assert len(belief.independent_agent_ids) == 2
        assert not engine.belief_engine._verification_eligible(belief)
        assert belief.status == BeliefStatus.TENTATIVE
        metrics = game._attack_metrics(incident)
        assert metrics["contexts_before_adoption"] == 0
        assert metrics["reported_contexts_before_adoption"] == 1
    asyncio.run(scenario())


def test_verify_before_adopt_rejects_a_claim_without_local_support():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "C")
        await game.choose("D3", "C")
        root = engine.belief_engine.get(engine.corruption.incidents[1].root_belief_id)
        recipient = next(agent for agent in engine.agents if agent.id != root.owner_agent_id
                         and not any(evaluate_evidence(root, e) is True
                                     for e in engine.belief_engine.evidence_for(agent.id)))
        assert not game._adoption_allowed(recipient, root, root.owner_agent_id, "test-receipt", engine.world.turn)
        assert (recipient.id, root.id) in game._pending_adoptions
    asyncio.run(scenario())


def test_none_still_runs_second_attack_without_inventing_a_meta_belief():
    async def scenario():
        engine, game = await to_dispute()
        await game.choose("D2", "C")
        await game.choose("D3", "D")
        assert len(engine.corruption.incidents) == 2
        assert not engine.meta_belief_engine.active_beliefs
    asyncio.run(scenario())


def test_optional_choices_control_real_threshold_and_injection():
    async def scenario():
        engine, game = await to_dispute(optional=True)
        assert game.choices["D1"] == "D"
        await game.choose("D2", "C")
        await game.choose("D3", "D")
        assert game.awaiting_choice["point"] == "D4"
        assert len(engine.corruption.incidents) == 1
        await game.choose("D4", "B")
        assert game.verify_threshold == 0.9
        assert len(engine.corruption.incidents) == 2
        assert engine.belief_engine.get(engine.corruption.incidents[1].root_belief_id).status == BeliefStatus.TENTATIVE
    asyncio.run(scenario())


def test_broadcast_off_stops_messages_and_adoption_without_stopping_world():
    async def scenario():
        engine, game = await to_dispute()
        game.broadcast_enabled = False
        before = len(engine.swarm.messages), sum(len(agent.adopted_shared_beliefs) for agent in engine.agents)
        turn = engine.world.turn
        for _ in range(3):
            await engine.step_async()
        assert engine.world.turn == turn + 3
        assert before == (len(engine.swarm.messages), sum(len(agent.adopted_shared_beliefs) for agent in engine.agents))
    asyncio.run(scenario())


def test_ordered_endings_do_not_interpret_missing_detection_as_zero():
    first = {"spread": 3, "detect_turns": 10, "repair_turns": 40, "bad_actions": 3, "contexts_before_adoption": 0}
    second = {"spread": 1, "detect_turns": None, "repair_turns": None, "bad_actions": 0, "contexts_before_adoption": 0}
    assert classify_ending(first, second, {"D2": "A", "D3": "D"}, 8, 8) == "糊涂部落"
    second.update(detect_turns=2, repair_turns=2)
    assert classify_ending(first, second, {"D2": "A", "D3": "A"}, 8, 8) == "慎信部落"


def test_completed_path_exports_measured_metrics_with_prevented_detection():
    result = asyncio.run(run_path("A", "A"))
    assert result["name"] in ENDINGS
    assert result["metrics"]["attack1"]["contexts_before_adoption"] == 1
    assert result["metrics"]["attack1"]["reported_contexts_before_adoption"] == 1
    assert result["metrics"]["attack2"]["detect_turns"] is not None
    assert result["metrics"]["attack2"]["status"] == "PREVENTED"
