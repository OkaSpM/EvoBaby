import asyncio

import pytest
from pydantic import ValidationError

from app.llm.schemas import ReasoningKind, ReasoningRequest, request_payload
from app.config import WorldConfig
from app.schemas import Action, Region, Resource, Weather
from app.simulation.agent import AgentState
from app.simulation.belief_engine import BeliefEngine, verification_eligible
from app.simulation.coordination_models import ClaimIntent, MessageIntent, MessageType, TaskType, is_open
from app.simulation.corruption import IncidentStatus
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventLog, EventType
from app.simulation.memory import (
    BeliefStatus, ConditionalHypothesis, Conditions, EvidenceKind, ExpectedEffect,
)
from app.simulation.meta_models import MetaBelief, MetaBeliefType, VerificationPolicyEffect
from app.simulation.task_engine import claim_key
from app.simulation.world import World
from test_phase6 import execute_moss, reach_maturity


POSITIONS = {Region.NW: (1, 1), Region.NE: (5, 1),
             Region.SW: (1, 5), Region.SE: (5, 5)}


def resolve_first_incident(engine: SimulationEngine, *, reflect: bool):
    reach_maturity(engine)
    incident = engine.inject_false_memory()
    target = next(agent for agent in engine.agents if agent.id == incident.target_agent_id)
    assert engine.swarm.dispatch(
        target, MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=incident.root_belief_id),
        engine.agents, engine.belief_engine, engine.task_engine, engine.world.turn,
    )
    family = (incident.root_belief_id,
              *engine.swarm.descendants(incident.root_belief_id, engine.belief_engine))
    affected = []
    for belief_id in family:
        owner = engine.belief_engine.get(belief_id).owner_agent_id
        if owner not in affected:
            affected.append(owner)
    if incident.injected_hypothesis.conditions.weather is not None:
        false_position, false_weather = POSITIONS[Region.SE], Weather.RAIN
    else:
        false_position, false_weather = POSITIONS[Region.NW], Weather.SUNNY
    for agent_id in affected[:2]:
        agent = next(item for item in engine.agents if item.id == agent_id)
        execute_moss(engine, agent, false_position, false_weather)

    engine.task_engine.sync(engine.agents, engine.belief_engine, engine.world.turn)
    engine.swarm.publish_tasks(engine.task_engine, engine.belief_engine, engine.world.turn)
    engine.corruption.sync(engine.belief_engine, engine.swarm, engine.task_engine,
                           turn=engine.world.turn, event_cursor=len(engine.event_log.events))
    task = engine.task_engine.get(engine.corruption.incidents[0].investigation_task_id)
    positive = [requirement for requirement in task.required_contexts
                if requirement.conditions == Conditions(region=Region.NW, weather=Weather.RAIN)][:3]
    negative = next(requirement for requirement in task.required_contexts
                    if requirement.conditions != Conditions(region=Region.NW, weather=Weather.RAIN))
    for agent, requirement in zip(
        (engine.agents[0], engine.agents[1], engine.agents[0], engine.agents[2]),
        (*positive, negative), strict=True,
    ):
        if agent.active_task:
            engine.task_engine.release(agent, engine.world.turn)
        assert engine.task_engine.claim(
            agent, ClaimIntent(task_id=task.id, context_id=requirement.id), engine.world.turn,
        )
        evidence_before = len(engine.belief_engine.evidence_for(agent.id))
        execute_moss(engine, agent, POSITIONS[requirement.conditions.region],
                     requirement.conditions.weather)
        evidence = engine.belief_engine.evidence_for(agent.id)[-1]
        assert len(engine.belief_engine.evidence_for(agent.id)) == evidence_before + 1
        assert engine.task_engine.record_submission(agent, task.id, evidence, engine.world.turn)
    asyncio.run(engine.investigation.advance(
        engine.agents, engine.belief_engine, engine.task_engine, engine.swarm,
        engine.corruption, engine._experimental_reasoning, turn=engine.world.turn,
    ))
    assert engine.corruption.incidents[0].status == IncidentStatus.REPAIRED
    if reflect:
        assert asyncio.run(engine._update_meta_beliefs()) is not None
        engine.task_engine.sync(engine.agents, engine.belief_engine, engine.world.turn)
        engine.swarm.publish_tasks(engine.task_engine, engine.belief_engine, engine.world.turn)
    return incident


def test_first_resolved_incident_creates_one_persistent_meta_belief_and_updates_contexts():
    engine = SimulationEngine()
    first = resolve_first_incident(engine, reflect=False)
    assert not engine.meta_belief_engine.beliefs
    before = sum(record.kind == ReasoningKind.META_REFLECTION for record in engine.reasoning.records)
    engine.step()  # Normal turn orchestration performs the one-time reflection.
    learned = engine.meta_belief_engine.beliefs[0]
    assert learned.type == MetaBeliefType.REQUIRE_CONTEXT_DIVERSITY
    assert learned.learned_from_incident_id == first.id
    assert learned.active and learned.policy_effect.dimensions == ("region", "weather")
    assert learned.policy_effect.minimum_distinct_values == 2
    assert engine.belief_engine.active_meta_beliefs == (learned,)
    assert asyncio.run(engine._update_meta_beliefs()) is None
    after = sum(record.kind == ReasoningKind.META_REFLECTION for record in engine.reasoning.records)
    assert after == before + 1 == 1
    with pytest.raises(ValidationError):
        learned.active = False

    contexts = [engine._context(agent, engine.world.observe(agent)) for agent in engine.agents]
    assert all(context.active_meta_beliefs == (learned,) for context in contexts)
    payload = request_payload(ReasoningRequest(
        kind=ReasoningKind.ACTION_REASONING, turn=engine.world.turn,
        agent_id=engine.agents[0].id, context=contexts[0],
    ))
    assert payload["active_meta_beliefs"][0]["learned_from_incident_id"] == first.id
    assert "origin_type" not in str(payload) and "corruptionAudit" not in str(payload)
    assert any(change.previous_status == BeliefStatus.VERIFIED
               and change.status == BeliefStatus.TENTATIVE
               for change in engine.belief_engine.changes)


def test_second_attack_is_gated_uses_other_dimension_and_is_prevented_before_spread():
    engine = SimulationEngine()
    with pytest.raises(ValueError, match="FIRST_ATTACK_MUST_EXIST"):
        engine.inject_second_false_memory()
    first = resolve_first_incident(engine, reflect=False)
    assert not engine.second_attack_ready
    with pytest.raises(ValueError, match="META_BELIEF_REQUIRED"):
        engine.inject_second_false_memory()
    asyncio.run(engine._update_meta_beliefs())
    engine.task_engine.sync(engine.agents, engine.belief_engine, engine.world.turn)
    engine.swarm.publish_tasks(engine.task_engine, engine.belief_engine, engine.world.turn)
    assert engine.second_attack_ready

    second = engine.inject_second_false_memory()
    assert second.attack_number == 2
    assert second.omitted_condition != first.omitted_condition
    assert second.status == IncidentStatus.VERIFYING
    root = engine.belief_engine.get(second.root_belief_id)
    assert root.status == BeliefStatus.TENTATIVE
    assert verification_eligible(root)  # Old policy would have accepted it.
    assert engine.belief_engine.missing_context_dimensions(root) == (second.omitted_condition,)
    target = next(agent for agent in engine.agents if agent.id == second.target_agent_id)
    assert not engine.swarm.dispatch(
        target, MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=root.id),
        engine.agents, engine.belief_engine, engine.task_engine, engine.world.turn,
    )

    engine.task_engine.sync(engine.agents, engine.belief_engine, engine.world.turn)
    verification = next(task for task in engine.task_engine.tasks
                        if is_open(task) and task.type == TaskType.VERIFICATION
                        and claim_key(engine.belief_engine.get(task.belief_id)) == claim_key(root))
    if second.omitted_condition == "weather":
        assert any(requirement.conditions.weather == Weather.SUNNY
                   for requirement in verification.required_contexts)
        false_position, false_weather = POSITIONS[Region.NW], Weather.SUNNY
    else:
        assert any(requirement.conditions.region != Region.NW
                   for requirement in verification.required_contexts)
        false_position, false_weather = POSITIONS[Region.SE], Weather.RAIN
    result = execute_moss(engine, target, false_position, false_weather)
    assert result.resource_effect == -8
    engine.corruption.sync(engine.belief_engine, engine.swarm, engine.task_engine,
                           turn=engine.world.turn, event_cursor=len(engine.event_log.events))
    prevented = engine.corruption.incidents[1]
    assert prevented.status == IncidentStatus.PREVENTED
    assert prevented.detected_turn == engine.world.turn
    assert engine.belief_engine.get(root.id).status == BeliefStatus.REVOKED
    assert prevented.disputed_turn is None and prevented.resolved_turn == engine.world.turn
    assert asyncio.run(engine._update_meta_beliefs()) is None
    assert sum(record.kind == ReasoningKind.META_REFLECTION
               for record in engine.reasoning.records) == 1

    first_metrics, second_metrics = engine.metrics.attacks
    assert first_metrics.agents_affected > second_metrics.agents_affected == 1
    assert first_metrics.incorrect_actions_caused > second_metrics.incorrect_actions_caused == 1
    assert first_metrics.contexts_checked_before_adoption == 1
    assert second_metrics.contexts_checked_before_adoption == 2
    assert first_metrics.adopted and not second_metrics.adopted
    assert engine.metrics.comparison.spread_reduction > 0
    assert engine.metrics.comparison.incorrect_action_reduction > 0
    assert engine.metrics.comparison.additional_contexts_before_adoption > 0


def test_context_diversity_policy_can_verify_a_supported_generalized_claim():
    memory = BeliefEngine()
    meta = MetaBelief(
        id="MB1", principle="General claims require diverse contexts.",
        learned_from_incident_id="I1", created_turn=1,
        policy_effect=VerificationPolicyEffect(dimensions=("region", "weather")),
    )
    memory.activate_meta_beliefs((meta,), turn=1)
    owner = AgentState(id="A1", position=POSITIONS[Region.NW])
    peer = AgentState(id="A2", position=POSITIONS[Region.NW])
    hypothesis = ConditionalHypothesis(
        object=Resource.BERRY, conditions=Conditions(weather=Weather.RAIN),
        effect=ExpectedEffect.ENERGY_POSITIVE,
        reason="Rainy berry uses have been positive so far.",
    )
    samples = ({
        "kind": EvidenceKind.ACTION_EFFECT, "event_ids": (f"E80{i}",), "turn": 0,
        "agent_id": agent_id, "position": POSITIONS[Region.NW], "region": Region.NW,
        "weather": Weather.RAIN, "object": Resource.BERRY, "observed_object": Resource.BERRY,
        "action": Action.USE_BERRY, "energy_delta": 10,
    } for i, agent_id in enumerate(("A1", "A2", "A1")))
    belief, _ = memory.install_memory(owner, hypothesis, samples, turn=1, require_verified=False)
    assert verification_eligible(belief) and belief.status == BeliefStatus.TENTATIVE
    assert memory.missing_context_dimensions(belief) == ("region",)

    world = World(WorldConfig(weather_schedule=("Rain",)))
    world.advance()
    owner.position = POSITIONS[Region.SE]
    owner.energy = 50
    owner.inventory[Resource.BERRY] = 1
    result = world.execute(owner, Action.USE_BERRY)
    event = EventLog().append(EventType.ACTION_EXECUTED, world.turn, owner.id,
                              world.observe(owner), result)
    memory.consume((event,), (owner, peer))
    updated = memory.get(belief.id)
    assert updated.status == BeliefStatus.VERIFIED
    assert memory.missing_context_dimensions(updated) == ()


def test_reset_clears_meta_beliefs_second_attack_and_derived_metrics():
    engine = SimulationEngine()
    resolve_first_incident(engine, reflect=True)
    engine.inject_second_false_memory()
    assert engine.meta_belief_engine.beliefs and len(engine.metrics.attacks) == 2
    engine.reset()
    assert not engine.meta_belief_engine.beliefs
    assert not engine.belief_engine.active_meta_beliefs
    assert not engine.corruption.incidents
    assert engine.metrics.attacks == () and engine.metrics.comparison is None
    assert not engine.second_attack_ready
