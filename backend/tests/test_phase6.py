import asyncio

import pytest
from pydantic import ValidationError

from app.config import LLMConfig
from app.llm.provider import ReasoningService
from app.llm.schemas import ReasoningKind
from app.schemas import Action, Region, Resource, Weather
from app.simulation.agent import AgentState
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination_models import (
    ClaimIntent, MessageIntent, MessageType, TaskStatus, TaskType,
)
from app.simulation.corruption import CorruptionSystem, IncidentStatus
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventType
from app.simulation.investigation import InvestigationEngine, InvestigationStatus
from app.simulation.memory import (
    BeliefOrigin, BeliefStatus, ConditionalHypothesis, Conditions, EvidenceKind,
    ExpectedEffect,
)
from app.simulation.swarm import Swarm
from app.simulation.task_engine import TaskEngine
from test_beliefs import ExperienceWorld


def reach_maturity(engine, limit=60):
    for _ in range(limit):
        if engine.knowledge_maturity.mature:
            return
        engine.step()
    raise AssertionError("The deterministic demo did not reach knowledge maturity")


def execute_moss(engine, agent, position, weather):
    agent.position = position
    agent.energy = 50
    engine.world.weather = weather
    engine.world.cells[position].object = Resource.MOSS
    result = engine.world.execute(agent, Action.USE_MOSS)
    event = engine.event_log.append(EventType.ACTION_EXECUTED, engine.world.turn,
                                    agent.id, engine.world.observe(agent), result)
    engine.belief_engine.consume((event,), engine.agents)
    return result


def test_maturity_gates_constrained_injection_and_keeps_privileged_metadata_hidden():
    engine = SimulationEngine()
    with pytest.raises(ValueError, match="KNOWLEDGE_NOT_MATURE"):
        engine.inject_false_memory()
    reach_maturity(engine)
    maturity = engine.knowledge_maturity
    assert maturity.verified_belief_count >= 8
    assert maturity.agents_with_verified_belief >= 4
    assert maturity.independently_verified_belief_count >= 3

    incident = engine.inject_false_memory()
    source, injected = incident.true_hypothesis, incident.injected_hypothesis
    removed = [dimension for dimension in ("region", "weather")
               if getattr(source.conditions, dimension) is not None
               and getattr(injected.conditions, dimension) is None]
    assert removed == [incident.omitted_condition]
    assert injected.object == source.object == Resource.MOSS
    assert injected.effect == source.effect == ExpectedEffect.ENERGY_POSITIVE
    outcomes = []
    for region in Region:
        for weather in Weather:
            if (injected.conditions.region is not None and injected.conditions.region != region
                    or injected.conditions.weather is not None and injected.conditions.weather != weather):
                continue
            outcomes.append(region == Region.NW and weather == Weather.RAIN)
    assert any(outcomes) and not all(outcomes)

    target = next(a for a in engine.agents if a.id == incident.target_agent_id)
    belief = engine.belief_engine.get(incident.root_belief_id)
    assert belief.status == BeliefStatus.VERIFIED and belief.origin == BeliefOrigin.PERSONAL
    assert belief.id in target.personal_beliefs and belief.evidence_count == 3
    assert len(belief.independent_agent_ids) == 2
    assert all(evaluate_evidence(belief, e) is not False
               for e in engine.belief_engine.evidence_for(target.id)
               if e.id not in incident.forged_evidence_ids)
    assert "origin_type" not in engine._context(target, engine.world.observe(target)).model_dump_json()
    for peer in engine.agents:
        if peer.id != target.id:
            assert not (set(incident.forged_evidence_ids)
                        & {e.id for e in engine._context(peer, engine.world.observe(peer)).relevant_evidence})
    assert engine.corruption.audit_log[0].origin_type == "injected"
    assert engine.corruption.audit_log[0].evidence_ids == incident.forged_evidence_ids
    with pytest.raises(ValidationError):
        engine.corruption.audit_log[0].origin_type = "personal"
    with pytest.raises(AttributeError):
        engine.corruption.audit_log.append(engine.corruption.audit_log[0])
    assert any(record.kind == ReasoningKind.CORRUPTION_RANKING
               for record in engine.reasoning.records)
    with pytest.raises(ValueError, match="FIRST_ATTACK_ALREADY_INJECTED"):
        engine.inject_false_memory()


def test_injected_memory_spreads_normally_and_real_action_opens_investigation():
    engine = SimulationEngine()
    reach_maturity(engine)
    incident = engine.inject_false_memory()
    target = next(a for a in engine.agents if a.id == incident.target_agent_id)
    assert engine.swarm.dispatch(
        target, MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=incident.root_belief_id),
        engine.agents, engine.belief_engine, engine.task_engine, engine.world.turn,
    )
    descendants = engine.swarm.descendants(incident.root_belief_id, engine.belief_engine)
    assert descendants
    assert all(engine.belief_engine.get(i).origin == BeliefOrigin.SHARED for i in descendants)

    if incident.injected_hypothesis.conditions.weather is not None:
        false_position, false_weather = (5, 5), Weather.RAIN
    else:
        false_position, false_weather = (1, 1), Weather.SUNNY
    result = execute_moss(engine, target, false_position, false_weather)
    assert result.success and result.resource_effect == -8
    assert engine.belief_engine.get(incident.root_belief_id).status == BeliefStatus.DISPUTED

    engine.task_engine.sync(engine.agents, engine.belief_engine, engine.world.turn)
    engine.swarm.publish_tasks(engine.task_engine, engine.belief_engine, engine.world.turn)
    assert engine.swarm.dispatch(
        target, MessageIntent(type=MessageType.RAISE_DISPUTE, belief_id=incident.root_belief_id),
        engine.agents, engine.belief_engine, engine.task_engine, engine.world.turn,
    )
    engine.corruption.sync(engine.belief_engine, engine.swarm, engine.task_engine,
                           turn=engine.world.turn)
    tracked = engine.corruption.incidents[0]
    assert tracked.status == IncidentStatus.INVESTIGATING
    assert tracked.contradiction_evidence_id is not None
    task = engine.task_engine.get(tracked.investigation_task_id)
    assert task.type == TaskType.INVESTIGATION and task.status == TaskStatus.OPEN
    assert len(task.required_contexts) >= 3
    assert all(change.type != "BELIEF_REVOKED" for change in engine.belief_engine.changes
               if change.belief_id == incident.root_belief_id)
    assert [event.type for event in engine.corruption.audit_log] == [
        "MEMORY_INJECTED", "INCIDENT_DISPUTED",
    ]

    positive = [r for r in task.required_contexts
                if r.conditions.region == Region.NW and r.conditions.weather == Weather.RAIN][:3]
    negative = next(r for r in task.required_contexts
                    if not (r.conditions.region == Region.NW and r.conditions.weather == Weather.RAIN))
    assert len(positive) == 3
    positions = {Region.NW: (1, 1), Region.NE: (5, 1),
                 Region.SW: (1, 5), Region.SE: (5, 5)}
    experiments = zip((engine.agents[0], engine.agents[1], engine.agents[0], engine.agents[2]),
                      (*positive, negative), strict=True)
    submitted = []
    for agent, requirement in experiments:
        if agent.active_task:
            engine.task_engine.release(agent, engine.world.turn)
        assert engine.task_engine.claim(
            agent, ClaimIntent(task_id=task.id, context_id=requirement.id), engine.world.turn,
        )
        position = positions[requirement.conditions.region]
        execute_moss(engine, agent, position, requirement.conditions.weather)
        evidence = engine.belief_engine.evidence_for(agent.id)[-1]
        assert engine.task_engine.record_submission(agent, task.id, evidence, engine.world.turn)
        submitted.append(evidence.id)
    asyncio.run(engine.investigation.advance(
        engine.agents, engine.belief_engine, engine.task_engine, engine.swarm,
        engine.corruption, engine._experimental_reasoning, turn=engine.world.turn,
    ))
    resolved = engine.corruption.incidents[0]
    assert resolved.status == IncidentStatus.REPAIRED
    assert resolved.repaired_hypothesis.conditions == Conditions(
        region=Region.NW, weather=Weather.RAIN,
    )
    assert incident.root_belief_id in resolved.revoked_belief_ids
    assert engine.belief_engine.get(incident.root_belief_id).status == BeliefStatus.REVOKED
    assert engine.investigation.cases[0].evidence_ids == tuple(submitted)
    assert [event.type for event in engine.corruption.audit_log] == [
        "MEMORY_INJECTED", "INCIDENT_DISPUTED", "INCIDENT_RESOLVED",
    ]


def test_fresh_multi_agent_investigation_narrows_and_repairs_every_equivalent_copy():
    fixture = ExperienceWorld()
    root = fixture.verified()
    third = AgentState(id="A3", position=(5, 5))
    fixture.agents.append(third)
    tasks, swarm = TaskEngine(), Swarm()
    assert swarm.dispatch(
        fixture.agents[0], MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=root.id),
        fixture.agents, fixture.memory, tasks, fixture.world.turn,
    )
    old_descendants = swarm.descendants(root.id, fixture.memory)
    third_copy = next(fixture.memory.get(i) for i in third.adopted_shared_beliefs)
    fixture.moss(third, (5, 5))
    assert fixture.memory.get(third_copy.id).status == BeliefStatus.DISPUTED
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if t.type == TaskType.INVESTIGATION)

    submitted = []
    experiments = ((fixture.agents[0], "C1", (1, 1)),
                   (fixture.agents[1], "C2", (2, 1)),
                   (fixture.agents[0], "C3", (1, 1)),
                   (third, "C10", (5, 5)))
    for agent, context_id, position in experiments:
        assert tasks.claim(agent, ClaimIntent(task_id=task.id, context_id=context_id), fixture.world.turn)
        evidence = fixture.moss(agent, position)
        assert tasks.record_submission(agent, task.id, evidence, fixture.world.turn)
        submitted.append(evidence.id)

    investigation = InvestigationEngine()
    corruption = CorruptionSystem()
    reasoning = ReasoningService(LLMConfig())
    asyncio.run(investigation.advance(
        fixture.agents, fixture.memory, tasks, swarm, corruption, reasoning,
        turn=fixture.world.turn,
    ))
    case = investigation.cases[0]
    assert case.status == InvestigationStatus.REPAIRED
    assert case.evidence_ids == tuple(submitted)
    assert case.repaired_hypothesis.conditions == Conditions(region=Region.NW, weather=Weather.RAIN)
    assert tasks.get(task.id).status == TaskStatus.RESOLVED
    assert tasks.get(task.id).resolution == "BELIEF_REPAIRED"
    assert all(fixture.memory.get(i).status == BeliefStatus.REVOKED
               for i in (root.id, *old_descendants))
    replacement = fixture.memory.get(case.replacement_belief_id)
    assert replacement.status == BeliefStatus.VERIFIED
    assert replacement.evidence_ids == tuple(submitted[:3])
    assert replacement.independent_agent_ids == ("A1", "A2")
    repaired_descendants = swarm.descendants(replacement.id, fixture.memory)
    assert {fixture.memory.get(i).owner_agent_id for i in repaired_descendants} == {"A2", "A3"}
    collective = swarm.collective_knowledge(fixture.memory)
    assert replacement in collective and all(b.status != BeliefStatus.REVOKED for b in collective)
    assert any(record.kind == ReasoningKind.INVESTIGATION_HYPOTHESIS
               for record in reasoning.records)
    assert not corruption.incidents  # Natural and injected errors share this repair engine.


def test_investigation_revokes_when_no_supported_narrower_rule_exists():
    fixture = ExperienceWorld()
    third = AgentState(id="A3", position=(5, 5))
    fixture.agents.append(third)
    hypothesis = ConditionalHypothesis(
        object=Resource.MOSS,
        conditions=Conditions(region=Region.SE, weather=Weather.RAIN),
        effect=ExpectedEffect.ENERGY_POSITIVE,
        reason="A plausible but fully specified remembered effect.",
    )
    samples = ({
        "kind": EvidenceKind.ACTION_EFFECT, "event_ids": (f"E900{i}",), "turn": 0,
        "agent_id": agent_id, "position": (5, 5), "region": Region.SE,
        "weather": Weather.RAIN, "object": Resource.MOSS, "observed_object": Resource.MOSS,
        "action": Action.USE_MOSS, "energy_delta": 20,
    } for i, agent_id in enumerate(("A1", "A2", "A1")))
    belief, _ = fixture.memory.install_verified_memory(
        fixture.agents[0], hypothesis, samples, turn=fixture.world.turn,
    )
    fixture.moss(fixture.agents[0], (5, 5))
    assert fixture.memory.get(belief.id).status == BeliefStatus.DISPUTED
    tasks, swarm = TaskEngine(), Swarm()
    tasks.sync(fixture.agents, fixture.memory, fixture.world.turn)
    task = next(t for t in tasks.tasks if t.type == TaskType.INVESTIGATION)
    for agent, context_id in zip(fixture.agents, ("C1", "C2", "C3")):
        assert tasks.claim(agent, ClaimIntent(task_id=task.id, context_id=context_id), fixture.world.turn)
        evidence = fixture.moss(agent, (5, 5))
        assert tasks.record_submission(agent, task.id, evidence, fixture.world.turn)
    investigation = InvestigationEngine()
    asyncio.run(investigation.advance(
        fixture.agents, fixture.memory, tasks, swarm, CorruptionSystem(),
        ReasoningService(LLMConfig()), turn=fixture.world.turn,
    ))
    assert investigation.cases[0].status == InvestigationStatus.REVOKED
    assert fixture.memory.get(belief.id).status == BeliefStatus.REVOKED
    assert tasks.get(task.id).resolution == "BELIEF_REVOKED"


def test_corruption_is_explicit_deterministic_and_resettable():
    engine = SimulationEngine()
    reach_maturity(engine)
    mature_turn = engine.world.turn
    assert not engine.corruption.incidents
    first = engine.inject_false_memory()
    engine.reset()
    assert not engine.corruption.incidents and not engine.corruption.audit_log
    assert not engine.investigation.cases
    reach_maturity(engine)
    second = engine.inject_false_memory()
    assert engine.world.turn == mature_turn
    assert second == first
