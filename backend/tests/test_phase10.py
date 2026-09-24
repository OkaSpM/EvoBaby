from app.simulation.corruption import IncidentStatus
from app.simulation.full_demo import run


def test_default_demo_completes_real_two_attack_evolution_and_replays(capsys):
    first = run()
    first_output = capsys.readouterr().out

    assert first.world.turn <= 90
    assert first.knowledge_mature
    assert len(first.corruption.incidents) == 2
    attack_one, attack_two = first.corruption.incidents
    assert attack_one.status == IncidentStatus.REPAIRED
    assert attack_one.disputed_turn is not None
    assert attack_one.resolved_turn - attack_one.injected_turn <= 50
    assert attack_two.status == IncidentStatus.PREVENTED
    assert attack_two.resolved_turn - attack_two.injected_turn <= 20
    assert len(first.meta_belief_engine.active_beliefs) == 1

    case = first.investigation.cases[0]
    investigators = {first.belief_engine.evidence_by_id(i).agent_id for i in case.evidence_ids}
    assert len(investigators) >= 2
    assert all(not first.corruption.is_forged(i) for i in case.evidence_ids)

    comparison = first.metrics.comparison
    assert comparison is not None
    assert comparison.spread_reduction > 0
    assert comparison.incorrect_action_reduction > 0
    assert comparison.additional_contexts_before_adoption > 0
    assert "演示完成" in first_output

    second = run()
    second_output = capsys.readouterr().out
    assert second.world.turn == first.world.turn
    assert second.metrics == first.metrics
    assert second.debug_snapshot() == first.debug_snapshot()
    assert second_output == first_output
