from collections import Counter

import pytest
from pydantic import ValidationError

from app.config import WorldConfig
from app.schemas import Action, Resource
from app.simulation.agent import AgentState, ExplorationPolicy
from app.simulation.coordination import CooperativePolicy
from app.simulation.coordination_models import (
    ClaimIntent, MessageIntent, MessageType, TaskStatus, TaskType, is_open,
)
from app.simulation.engine import SimulationEngine
from app.simulation.memory import BeliefStatus, BeliefType
from app.simulation.swarm import Swarm
from app.simulation.task_engine import TaskEngine
from test_beliefs import ExperienceWorld


def setup_verification():
    fixture = ExperienceWorld()
    for _ in range(2):
        fixture.moss(fixture.agents[0])
    belief = fixture.propose(fixture.agents[0])
    tasks, swarm = TaskEngine(), Swarm()
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    swarm.publish_tasks(tasks, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if t.belief_id == belief.id)
    return fixture, tasks, swarm, task, belief


def test_birth_has_no_tasks_messages_or_assigned_roles():
    engine = SimulationEngine()
    assert not engine.task_engine.tasks and not engine.swarm.messages
    engine.step()
    # Moving can reveal a second cell in turn one; opportunities must reflect those samples.
    assert all(engine.belief_engine.get(t.belief_id).evidence_count >= 2 for t in engine.task_engine.tasks)
    assert all(a.active_task is None for a in engine.agents)


@pytest.mark.parametrize("energies", [(39, 39, 39, 39, 39), (24, 24, 60, 60, 60)])
def test_survival_generated_from_each_energy_trigger_without_duplicates(energies):
    engine = SimulationEngine()
    for agent, energy in zip(engine.agents, energies):
        agent.energy = energy
    tasks = engine.task_engine
    tasks.sync(engine.agents, engine.belief_engine, 1)
    tasks.sync(engine.agents, engine.belief_engine, 1)
    assert len(tasks.tasks) == 1
    assert tasks.tasks[0].type == TaskType.SURVIVAL
    assert tasks.tasks[0].status == TaskStatus.OPEN
    assert not tasks.tasks[0].claimant_agent_ids
    for agent in engine.agents:
        agent.energy = 60
    tasks.sync(engine.agents, engine.belief_engine, 2)
    assert tasks.tasks[0].status == TaskStatus.RESOLVED
    assert tasks.tasks[0].resolution == "ENERGY_RECOVERED"


def test_repeated_local_evidence_creates_missing_independent_context_request():
    fixture, tasks, swarm, task, belief = setup_verification()
    assert task.type == TaskType.VERIFICATION
    requirement = task.required_contexts[0]
    assert requirement.object == Resource.MOSS
    assert requirement.conditions.weather == "Rain"
    assert requirement.independent_of == ("A1",)
    assert requirement.conditions.region is None  # No hidden Moss truth.
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert len([t for t in tasks.tasks if t.belief_id == belief.id]) == 1
    request = next(m for m in swarm.messages if m.task_id == task.id)
    assert request.type == MessageType.REQUEST_VERIFICATION
    assert request.belief == belief


def test_no_claim_priority_increases_every_three_turns_and_rebroadcasts_without_assignment():
    fixture, tasks, swarm, task, _ = setup_verification()
    for offset in (1, 2):
        tasks.sync(fixture.agents, fixture.memory, task.created_turn + offset)
    assert tasks.get(task.id).priority == task.priority
    turn = task.created_turn + 3
    tasks.sync(fixture.agents, fixture.memory, turn)
    swarm.publish_tasks(tasks, fixture.memory, turn)
    swarm.publish_tasks(tasks, fixture.memory, turn)
    assert tasks.get(task.id).priority == task.priority + 5
    assert len([m for m in swarm.messages if m.task_id == task.id]) == 2
    assert all(a.active_task is None for a in fixture.agents)
    assert not tasks.get(task.id).claimant_agent_ids


def test_claim_is_voluntary_rejects_source_busy_resting_and_context_collision():
    fixture, tasks, _, task, _ = setup_verification()
    source, claimant = fixture.agents
    intent = ClaimIntent(task_id=task.id, context_id="C1")
    assert not tasks.claim(source, intent, fixture.world.turn)
    claimant.unavailable_until_turn = fixture.world.turn + 3
    assert not tasks.claim(claimant, intent, fixture.world.turn)
    claimant.unavailable_until_turn = None
    assert tasks.claim(claimant, intent, fixture.world.turn)
    assert not tasks.claim(claimant, intent, fixture.world.turn)
    third = AgentState(id="A3", position=(0, 0))
    assert not tasks.claim(third, intent, fixture.world.turn)
    assert tasks.get(task.id).status == TaskStatus.CLAIMED
    assert claimant.active_task == task.id
    claimant.unavailable_until_turn = fixture.world.turn + 4
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert claimant.active_task is None
    assert tasks.get(task.id).status == TaskStatus.OPEN


def test_independent_submission_verifies_then_share_preserves_evidence_and_provenance():
    fixture, tasks, swarm, task, belief = setup_verification()
    source, verifier = fixture.agents
    tasks.claim(verifier, ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    evidence = fixture.moss(verifier)
    submit = MessageIntent(type=MessageType.SUBMIT_EVIDENCE, belief_id=belief.id,
                           evidence_id=evidence.id, task_id=task.id)
    assert swarm.dispatch(verifier, submit, fixture.agents, fixture.memory, tasks, fixture.world.turn)
    assert not swarm.dispatch(verifier, submit, fixture.agents, fixture.memory, tasks, fixture.world.turn)
    verified = fixture.memory.get(belief.id)
    assert verified.status == BeliefStatus.VERIFIED
    assert verified.independent_agent_ids == ("A1", "A2")
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert tasks.get(task.id).status == TaskStatus.RESOLVED
    assert verifier.active_task is None
    share = MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=belief.id)
    assert swarm.dispatch(source, share, fixture.agents, fixture.memory, tasks, fixture.world.turn)
    adopted = fixture.memory.get(verifier.adopted_shared_beliefs[0])
    assert adopted.lineage.message_id == swarm.messages[-1].id
    assert adopted.evidence_ids == verified.evidence_ids
    assert adopted.independent_agent_ids == verified.independent_agent_ids
    assert swarm.collective_knowledge(fixture.memory) == (verified,)


def test_cannot_submit_someone_elses_evidence_or_share_tentative_belief():
    fixture, tasks, swarm, task, belief = setup_verification()
    own = next(e for e in fixture.memory.evidence_for("A1") if e.kind == "ACTION_EFFECT")
    assert not swarm.dispatch(fixture.agents[1], MessageIntent(type=MessageType.SUBMIT_EVIDENCE,
                              belief_id=belief.id, evidence_id=own.id, task_id=task.id),
                              fixture.agents, fixture.memory, tasks, fixture.world.turn)
    assert not swarm.dispatch(fixture.agents[0], MessageIntent(type=MessageType.SHARE_BELIEF,
                              belief_id=belief.id), fixture.agents, fixture.memory, tasks, fixture.world.turn)
    assert not swarm.dispatch(fixture.agents[0], MessageIntent(type=MessageType.SHARE_BELIEF,
                              belief_id="missing"), fixture.agents, fixture.memory, tasks, fixture.world.turn)


def test_investigation_created_on_real_contradiction_and_has_distinct_context_claims():
    fixture = ExperienceWorld()
    belief = fixture.verified()
    fixture.moss(fixture.agents[0], (5, 5))
    tasks = TaskEngine()
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if t.type == TaskType.INVESTIGATION)
    assert task.belief_id == belief.id
    assert {r.conditions.region for r in task.required_contexts} == {"NW", "NE", "SW", "SE"}
    assert all(r.conditions.weather == "Rain" for r in task.required_contexts)
    assert tasks.claim(fixture.agents[0], ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    assert not tasks.claim(fixture.agents[1], ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    assert tasks.claim(fixture.agents[1], ClaimIntent(task_id=task.id, context_id="C2"), fixture.world.turn)
    assert len(tasks.get(task.id).claimant_agent_ids) == 2
    # Investigation cannot pretend an old test was a new independent experiment.
    old = next(e for e in fixture.memory.evidence_for("A1") if e.kind == "ACTION_EFFECT" and e.region == "NW")
    assert not tasks.record_submission(fixture.agents[0], task.id, old, fixture.world.turn)


def test_local_policy_can_decline_and_uses_distance_energy_and_workload():
    fixture, tasks, swarm, task, _ = setup_verification()
    engine = SimulationEngine()
    engine.agents, engine.world = fixture.agents, fixture.world
    engine.task_engine, engine.belief_engine, engine.swarm = tasks, fixture.memory, swarm
    verifier = fixture.agents[1]
    verifier.energy = 10
    context = engine._context(verifier, engine.world.observe(verifier))
    assert CooperativePolicy().choose_task(context) is None
    verifier.energy = 60
    context = engine._context(verifier, engine.world.observe(verifier))
    intent = CooperativePolicy().choose_task(context)
    assert intent is not None
    tasks.claim(verifier, intent, engine.world.turn)
    assert CooperativePolicy().choose_task(engine._context(verifier, engine.world.observe(verifier))) is None


def test_declining_policy_is_never_force_assigned():
    engine = SimulationEngine(policy=ExplorationPolicy())
    for _ in range(15):
        engine.step()
    assert engine.task_engine.tasks
    assert all(not t.claimant_agent_ids for t in engine.task_engine.tasks)
    assert all(a.active_task is None for a in engine.agents)
    assert any(c.type == "TASK_REBROADCAST" for c in engine.task_engine.changes)


def test_forwarded_shared_belief_descendants_are_traceable_and_dispute_does_not_rewrite_them():
    fixture = ExperienceWorld()
    source = fixture.verified()
    tasks, swarm = TaskEngine(), Swarm()
    a, b = fixture.agents
    swarm.dispatch(a, MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=source.id),
                   fixture.agents, fixture.memory, tasks, fixture.world.turn)
    shared = fixture.memory.get(b.adopted_shared_beliefs[0])
    c = AgentState(id="A3", position=(5, 5))
    fixture.agents.append(c)
    assert swarm.dispatch(b, MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=shared.id),
                          fixture.agents, fixture.memory, tasks, fixture.world.turn)
    descendant = fixture.memory.get(c.adopted_shared_beliefs[0])
    assert descendant.lineage.original_source_agent_id == "A1"
    assert descendant.lineage.sender_agent_id == "A2"
    assert descendant.id in swarm.descendants(source.id, fixture.memory)
    fixture.moss(c, (5, 5))
    assert swarm.dispatch(c, MessageIntent(type=MessageType.RAISE_DISPUTE, belief_id=descendant.id),
                          fixture.agents, fixture.memory, tasks, fixture.world.turn)
    assert fixture.memory.get(source.id).status == BeliefStatus.VERIFIED
    assert fixture.memory.get(descendant.id).status == BeliefStatus.DISPUTED
    assert swarm.collective_knowledge(fixture.memory)[0].status == BeliefStatus.DISPUTED


def test_sharing_respects_receivers_personal_counterevidence():
    fixture = ExperienceWorld()
    belief = fixture.verified()
    fixture.moss(fixture.agents[1], (5, 5))
    swarm = Swarm()
    swarm.dispatch(fixture.agents[0], MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=belief.id),
                   fixture.agents, fixture.memory, TaskEngine(), fixture.world.turn)
    assert not fixture.agents[1].adopted_shared_beliefs


def test_frozen_task_and_messages_cannot_mutate_live_state():
    fixture, tasks, swarm, task, _ = setup_verification()
    with pytest.raises(ValidationError):
        task.priority = 999
    with pytest.raises(ValidationError):
        swarm.messages[0].belief.alpha = 999
    with pytest.raises(ValidationError):
        task.required_contexts[0].conditions.region = "SE"


def test_cooperative_runtime_claims_verifies_and_shares_without_llm_or_injected_events():
    engine = SimulationEngine(policy=CooperativePolicy())
    for _ in range(60):
        engine.step()
    messages = Counter(m.type for m in engine.swarm.messages)
    assert messages[MessageType.SUBMIT_EVIDENCE] > 0
    assert messages[MessageType.SHARE_BELIEF] > 0
    assert any(t.status == TaskStatus.RESOLVED for t in engine.task_engine.tasks)
    assert engine.swarm.collective_knowledge(engine.belief_engine)
    assert sum(bool(a.adopted_shared_beliefs) for a in engine.agents) >= 4
    assert all(b.type != BeliefType.CONDITIONAL_EFFECT for b in engine.belief_engine.beliefs)
    evidence = {e.id: e for e in engine.belief_engine.evidence}
    for message in engine.swarm.messages:
        if message.type == MessageType.SUBMIT_EVIDENCE:
            assert evidence[message.evidence_id].agent_id == message.from_agent
    engine.reset()
    assert not engine.swarm.messages and not engine.task_engine.tasks
    assert not engine.task_engine.changes


def test_insufficient_support_does_not_recreate_same_task_every_turn():
    fixture, tasks, swarm, task, belief = setup_verification()
    verifier = fixture.agents[1]
    tasks.claim(verifier, ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    evidence = fixture.moss(verifier, (5, 5))
    swarm.dispatch(verifier, MessageIntent(type=MessageType.SUBMIT_EVIDENCE, belief_id=belief.id,
                   evidence_id=evidence.id, task_id=task.id), fixture.agents, fixture.memory, tasks, fixture.world.turn)
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert tasks.get(task.id).status == TaskStatus.EXPIRED
    count = len(tasks.tasks)
    for turn in range(fixture.world.turn + 1, fixture.world.turn + 4):
        tasks.sync(fixture.agents, fixture.memory, turn)
    assert len(tasks.tasks) == count


def test_single_revisit_requests_enough_additional_samples():
    fixture = ExperienceWorld()
    agent = fixture.agents[0]
    fixture.world.cells[agent.position].object = Resource.BERRY
    for action in (Action.COLLECT, Action.MOVE_S, Action.MOVE_N, Action.MOVE_S, Action.MOVE_N):
        fixture.act(agent, action)
    tasks = TaskEngine()
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if fixture.memory.get(t.belief_id).type == BeliefType.PERSISTENCE)
    assert fixture.memory.get(task.belief_id).evidence_count == 1
    assert len(task.required_contexts) == 2
    assert all(r.independent_of == (agent.id,) for r in task.required_contexts)


def test_new_independent_local_support_can_reopen_a_previously_unsupported_claim():
    fixture, tasks, swarm, task, belief = setup_verification()
    verifier = fixture.agents[1]
    tasks.claim(verifier, ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    negative = fixture.moss(verifier, (5, 5))
    swarm.dispatch(verifier, MessageIntent(type=MessageType.SUBMIT_EVIDENCE, belief_id=belief.id,
                   evidence_id=negative.id, task_id=task.id), fixture.agents, fixture.memory, tasks, fixture.world.turn)
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert tasks.get(task.id).status == TaskStatus.EXPIRED
    for _ in range(6):
        fixture.moss(verifier)
    local = fixture.propose(verifier)
    assert local.status == BeliefStatus.TENTATIVE and local.confidence >= 0.75
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    reopened = [t for t in tasks.tasks if t.belief_id == local.id]
    assert len(reopened) == 1 and reopened[0].status == TaskStatus.OPEN
    assert reopened[0].id != task.id


def test_investigation_tracks_new_tests_but_does_not_pretend_to_repair():
    fixture = ExperienceWorld()
    belief = fixture.verified()
    agent = fixture.agents[0]
    contradiction = fixture.moss(agent, (5, 5))
    tasks = TaskEngine()
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if t.type == TaskType.INVESTIGATION)
    fixture.world.advance()
    southeast = next(r for r in task.required_contexts if r.conditions.region == "SE")
    assert tasks.claim(agent, ClaimIntent(task_id=task.id, context_id=southeast.id), fixture.world.turn)
    assert not tasks.record_submission(agent, task.id, contradiction, fixture.world.turn)
    new_evidence = fixture.moss(agent, (5, 5))
    assert tasks.record_submission(agent, task.id, new_evidence, fixture.world.turn)
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    assert tasks.get(task.id).status == TaskStatus.IN_PROGRESS
    assert tasks.get(task.id).completed_context_ids == (southeast.id,)
    assert fixture.memory.get(belief.id).status == BeliefStatus.DISPUTED
    assert agent.active_task is None


def test_saturated_energy_does_not_trap_a_verifier_repeating_censored_trials():
    import random
    fixture, tasks, swarm, task, _ = setup_verification()
    verifier = fixture.agents[1]
    verifier.energy = 100
    fixture.world.cells[verifier.position].object = Resource.MOSS
    tasks.claim(verifier, ClaimIntent(task_id=task.id, context_id="C1"), fixture.world.turn)
    engine = SimulationEngine()
    engine.world, engine.agents, engine.belief_engine = fixture.world, fixture.agents, fixture.memory
    engine.task_engine, engine.swarm = tasks, swarm
    context = engine._context(verifier, engine.world.observe(verifier))
    assert CooperativePolicy().choose_action(context, random.Random(1)) in (
        Action.MOVE_N, Action.MOVE_S, Action.MOVE_E, Action.MOVE_W)
