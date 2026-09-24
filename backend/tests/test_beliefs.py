import json
from dataclasses import replace

import pytest
from pydantic import ValidationError

from app.config import WorldConfig
from app.schemas import Action, Resource, Weather
from app.simulation.agent import AgentState, ExplorationPolicy
from app.simulation.belief_engine import BeliefEngine, verification_eligible
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventLog, EventType
from app.simulation.memory import (
    Belief, BeliefOrigin, BeliefStatus, BeliefType, ConditionalHypothesis, Conditions,
    EvidenceKind, ExpectedEffect,
)
from app.simulation.world import World


class ExperienceWorld:
    """Real World outcomes with explicit fixtures, delivered via the production event boundary."""
    def __init__(self):
        self.world = World(WorldConfig(weather_schedule=("Rain",)))
        self.agents = [AgentState(id="A1", position=(1, 1)), AgentState(id="A2", position=(2, 1))]
        self.log = EventLog()
        self.memory = BeliefEngine()

    def observe(self, agent):
        event = self.log.append(EventType.OBSERVATION, self.world.turn, agent.id, self.world.observe(agent))
        self.memory.consume((event,), self.agents)
        return event

    def act(self, agent, action):
        self.world.advance()
        self.observe(agent)
        result = self.world.execute(agent, action)
        event = self.log.append(EventType.ACTION_EXECUTED, self.world.turn, agent.id,
                                self.world.observe(agent), result)
        self.memory.consume((event,), self.agents)
        self.observe(agent)
        return event

    def moss(self, agent, position=(1, 1)):
        agent.position = position
        agent.energy = 50
        self.world.cells[position].object = Resource.MOSS
        self.act(agent, Action.USE_MOSS)
        return self.memory.evidence_for(agent.id)[-1]

    def propose(self, agent):
        return self.memory.propose_conditional(agent, {
            "type": "CONDITIONAL_EFFECT", "object": "Moss",
            "conditions": {"weather": "Rain"}, "effect": "ENERGY_POSITIVE",
            "reason": "Repeated positive local outcomes in rain.",
        }, turn=self.world.turn)

    def verified(self):
        a, b = self.agents
        for _ in range(3):
            self.moss(a)
        belief = self.propose(a)
        evidence = self.moss(b)
        return self.memory.submit_evidence(belief.id, evidence.id, turn=self.world.turn)


def test_beta_prior_and_confidence_is_computed_not_writable():
    belief = Belief(id="B1", type=BeliefType.DISTRIBUTION, proposition="Berry in NW",
                    object=Resource.BERRY, conditions=Conditions(region="NW"),
                    expected_effect=ExpectedEffect.OBJECT_PRESENT, source_agent_id="A1",
                    owner_agent_id="A1", created_turn=0, updated_turn=0)
    assert (belief.alpha, belief.beta, belief.confidence) == (1, 1, 0.5)
    high = belief.model_copy(update={"alpha": 1000})
    assert high.confidence > 0.99 and high.display_confidence == 0.99
    with pytest.raises(ValidationError):
        Belief.model_validate(belief.model_dump(round_trip=True) | {"confidence": 1.0})
    with pytest.raises(ValidationError):
        belief.conditions.weather = Weather.RAIN
    for change in ({"expected_effect": "RENEWABLE"}, {"conditions": {}}, {"origin": "SHARED"}):
        with pytest.raises(ValidationError):
            Belief.model_validate(belief.model_dump(round_trip=True) | change)


def test_distribution_counts_distinct_cells_and_not_self_induced_absence():
    fixture = ExperienceWorld()
    a = fixture.agents[0]
    fixture.world.cells[a.position].object = Resource.BERRY
    event = fixture.act(a, Action.COLLECT)
    belief = next(b for b in fixture.memory.beliefs if b.object == Resource.BERRY)
    assert (belief.alpha, belief.beta, belief.evidence_count) == (2, 1, 1)
    fixture.memory.consume(fixture.log.events, fixture.agents)
    assert fixture.memory.get(belief.id) == belief
    fixture.act(a, Action.INSPECT)
    assert fixture.memory.get(belief.id) == belief
    fixture.world.cells[(1, 2)].object = None
    fixture.act(a, Action.MOVE_S)
    belief = fixture.memory.get(belief.id)
    assert (belief.alpha, belief.beta, belief.confidence) == (2, 2, 0.5)
    assert len(set(belief.evidence_ids)) == 2
    assert event.event_id not in fixture.memory.evidence[0].event_ids


def test_verified_distribution_absence_is_negative_sample_not_dispute():
    fixture = ExperienceWorld()
    a, b = fixture.agents
    for position in ((0, 0), (1, 0), (2, 0)):
        a.position = position
        fixture.world.cells[position].object = Resource.BERRY
        fixture.observe(a)
    belief = next(x for x in fixture.memory.beliefs if x.object == Resource.BERRY)
    b.position = (3, 0)
    fixture.world.cells[b.position].object = Resource.BERRY
    fixture.observe(b)
    evidence = fixture.memory.evidence_for(b.id)[0]
    verified = fixture.memory.submit_evidence(belief.id, evidence.id, turn=fixture.world.turn)
    assert verified.status == BeliefStatus.VERIFIED
    a.position = (0, 1)
    fixture.world.cells[a.position].object = None
    fixture.observe(a)
    updated = fixture.memory.get(belief.id)
    assert updated.beta == verified.beta + 1
    assert updated.status == BeliefStatus.VERIFIED


@pytest.mark.parametrize("resource,effect", [(Resource.BERRY, ExpectedEffect.RENEWABLE),
                                             (Resource.CRYSTAL, ExpectedEffect.NOT_RENEWABLE)])
def test_persistence_requires_leaving_and_revisiting_after_real_collection(resource, effect):
    fixture = ExperienceWorld()
    a = fixture.agents[0]
    fixture.world.cells[a.position].object = resource
    collection = fixture.act(a, Action.COLLECT)
    fixture.act(a, Action.MOVE_S)
    fixture.act(a, Action.MOVE_N)
    assert not any(b.type == BeliefType.PERSISTENCE for b in fixture.memory.beliefs)
    fixture.act(a, Action.MOVE_S)
    revisit = fixture.act(a, Action.MOVE_N)
    belief = next(b for b in fixture.memory.beliefs if b.type == BeliefType.PERSISTENCE)
    assert belief.expected_effect == effect
    assert belief.status == BeliefStatus.TENTATIVE
    evidence = next(e for e in fixture.memory.evidence if e.kind == EvidenceKind.RESOURCE_REVISIT)
    assert evidence.elapsed_turns == 4
    assert evidence.collection_event_id == collection.event_id
    assert evidence.event_ids[0] == collection.event_id
    assert evidence.turn == revisit.turn
    fixture.act(a, Action.INSPECT)
    fixture.act(a, Action.MOVE_S)
    fixture.act(a, Action.MOVE_N)
    assert fixture.memory.get(belief.id).evidence_count == 1


def test_standing_still_is_not_a_temporal_revisit():
    fixture = ExperienceWorld()
    a = fixture.agents[0]
    fixture.world.cells[a.position].object = Resource.CRYSTAL
    fixture.act(a, Action.COLLECT)
    for _ in range(6):
        fixture.act(a, Action.INSPECT)
    assert not any(b.type == BeliefType.PERSISTENCE for b in fixture.memory.beliefs)


def test_later_return_is_counterevidence_to_nonrenewable_and_replayed_for_new_claim():
    fixture = ExperienceWorld()
    a = fixture.agents[0]
    fixture.world.cells[a.position].object = Resource.CRYSTAL
    fixture.act(a, Action.COLLECT)
    fixture.act(a, Action.MOVE_S)
    fixture.act(a, Action.INSPECT)
    fixture.act(a, Action.INSPECT)
    fixture.act(a, Action.MOVE_N)
    old = next(b for b in fixture.memory.beliefs if b.type == BeliefType.PERSISTENCE)
    fixture.act(a, Action.MOVE_S)
    # Counterfactual fixture: memory inference must follow evidence, not Crystal truth.
    fixture.world.cells[(1, 1)].object = Resource.CRYSTAL
    fixture.act(a, Action.MOVE_N)
    assert fixture.memory.get(old.id).beta == 2
    narrowed = next(b for b in fixture.memory.beliefs if b.expected_effect == ExpectedEffect.RENEWABLE)
    assert (narrowed.alpha, narrowed.beta) == (2, 2)


def test_conditional_observations_do_not_magically_reveal_hypothesis():
    fixture = ExperienceWorld()
    a = fixture.agents[0]
    fixture.moss(a)
    with pytest.raises(ValueError, match="two relevant"):
        fixture.propose(a)
    fixture.moss(a)
    assert not any(b.type == BeliefType.CONDITIONAL_EFFECT for b in fixture.memory.beliefs)
    belief = fixture.propose(a)
    assert belief.conditions.region is None  # Deliberate, permitted over-generalization.
    assert (belief.alpha, belief.beta, belief.evidence_count) == (3, 1, 2)
    assert belief.status == BeliefStatus.TENTATIVE
    assert fixture.propose(a) == belief


@pytest.mark.parametrize("overrides", [
    {"alpha": 99}, {"confidence": 0.99}, {"status": "VERIFIED"}, {"effect": "TELEPORT"},
    {"type": "PERSONALITY"}, {"conditions": {"season": "Winter"}},
])
def test_proposals_cannot_set_statistics_status_or_unknown_schema(overrides):
    data = {"object": "Moss", "effect": "ENERGY_POSITIVE", "reason": "Local evidence."}
    with pytest.raises(ValidationError):
        ConditionalHypothesis.model_validate(data | overrides)


def test_verification_requires_all_three_gates_and_explicit_independent_evidence():
    fixture = ExperienceWorld()
    a, b = fixture.agents
    fixture.moss(a)
    fixture.moss(a)
    belief = fixture.propose(a)
    assert belief.confidence == 0.75 and not verification_eligible(belief)
    fixture.moss(a)
    belief = fixture.memory.get(belief.id)
    assert belief.evidence_count == 3 and not verification_eligible(belief)
    evidence = fixture.moss(b)
    assert fixture.memory.get(belief.id) == belief  # No omniscient pooling.
    verified = fixture.memory.submit_evidence(belief.id, evidence.id, turn=fixture.world.turn)
    assert verified.status == BeliefStatus.VERIFIED
    assert verified.independent_agent_ids == ("A1", "A2")
    assert (verified.alpha, verified.beta) == (5, 1)
    assert fixture.memory.submit_evidence(belief.id, evidence.id, turn=fixture.world.turn) == verified
    low = verified.model_copy(update={"beta": 10})
    assert not verification_eligible(low)


def test_strong_contradiction_disputes_and_support_does_not_silently_clear_dispute():
    fixture = ExperienceWorld()
    verified = fixture.verified()
    a = fixture.agents[0]
    fixture.moss(a, (5, 5))
    disputed = fixture.memory.get(verified.id)
    assert disputed.status == BeliefStatus.DISPUTED and disputed.beta == 2
    assert fixture.memory.changes[-1].type == "BELIEF_DISPUTED"
    for _ in range(5):
        fixture.moss(a)
    assert fixture.memory.get(verified.id).status == BeliefStatus.DISPUTED


def test_context_mismatch_and_energy_ceiling_do_not_add_false_counterexamples():
    fixture = ExperienceWorld()
    verified = fixture.verified()
    a = fixture.agents[0]
    fixture.world.config = replace(fixture.world.config, weather_schedule=("Sunny",))
    fixture.world.weather = Weather.SUNNY
    fixture.moss(a)
    assert fixture.memory.get(verified.id) == verified
    fixture.world.config = replace(fixture.world.config, weather_schedule=("Rain",))
    fixture.world.weather = Weather.RAIN
    a.energy = 100
    fixture.act(a, Action.USE_MOSS)
    assert fixture.memory.get(verified.id) == verified


def test_revocation_requires_recorded_dispute_and_retains_evidence():
    fixture = ExperienceWorld()
    verified = fixture.verified()
    with pytest.raises(ValueError, match="disputed"):
        fixture.memory.revoke_disputed(verified.id, turn=fixture.world.turn)
    fixture.moss(fixture.agents[0], (5, 5))
    disputed = fixture.memory.get(verified.id)
    revoked = fixture.memory.revoke_disputed(verified.id, turn=fixture.world.turn)
    assert revoked.status == BeliefStatus.REVOKED
    assert revoked.evidence_ids == disputed.evidence_ids
    assert fixture.memory.changes[-1].type == "BELIEF_REVOKED"
    fixture.moss(fixture.agents[0])
    assert fixture.memory.get(verified.id) == revoked


def test_shared_copy_preserves_lineage_and_does_not_count_recipient_as_verifier():
    fixture = ExperienceWorld()
    source = fixture.verified()
    recipient = AgentState(id="A3", position=(5, 5))
    fixture.agents.append(recipient)
    shared = fixture.memory.adopt_shared(recipient, source.id, sender_agent_id="A1",
                                         message_id="M1", turn=fixture.world.turn)
    assert not recipient.personal_beliefs
    assert recipient.adopted_shared_beliefs == [shared.id]
    assert shared.id != source.id and shared.origin == BeliefOrigin.SHARED
    assert shared.lineage.original_source_agent_id == "A1"
    assert shared.lineage.parent_belief_id == source.id
    assert shared.independent_agent_ids == source.independent_agent_ids
    assert fixture.memory.adopt_shared(recipient, source.id, sender_agent_id="A1",
                                       message_id="M2", turn=fixture.world.turn) == shared
    fixture.moss(recipient, (5, 5))
    assert fixture.memory.get(shared.id).status == BeliefStatus.DISPUTED
    assert fixture.memory.get(source.id) == source
    personal, adopted = fixture.memory.memories_for(recipient)
    assert all(b.origin == BeliefOrigin.PERSONAL for b in personal)
    assert all(b.origin == BeliefOrigin.SHARED for b in adopted)


def test_shared_adoption_respects_direct_personal_counterevidence():
    fixture = ExperienceWorld()
    source = fixture.verified()
    b = fixture.agents[1]
    fixture.moss(b, (5, 5))
    assert fixture.memory.adopt_shared(b, source.id, sender_agent_id="A1",
                                      message_id="M1", turn=fixture.world.turn) is None
    assert not b.adopted_shared_beliefs


def test_memory_record_views_are_immutable_and_audit_is_unchanged():
    fixture = ExperienceWorld()
    source = fixture.verified()
    audit = fixture.log.events
    with pytest.raises(ValidationError):
        source.alpha = 100
    with pytest.raises(ValidationError):
        fixture.memory.evidence[0].agent_id = "A5"
    assert fixture.log.events == audit
    data = fixture.memory.debug_snapshot()
    data["beliefs"][0]["alpha"] = 900
    assert fixture.memory.beliefs[0].alpha != 900


def test_runtime_memory_has_real_provenance_and_resets_with_the_world():
    # Isolate the Phase 3 local-learning contract; cooperative integration is tested separately.
    engine = SimulationEngine(policy=ExplorationPolicy())
    for _ in range(50):
        engine.step()
    memory = engine.belief_engine
    assert memory.beliefs and memory.evidence
    events = {e.event_id: e for e in engine.event_log.events}
    for evidence in memory.evidence:
        assert evidence.event_ids
        assert all(events[i].agent_id == evidence.agent_id for i in evidence.event_ids)
    for belief in memory.beliefs:
        assert belief.origin == BeliefOrigin.PERSONAL
        assert belief.status != BeliefStatus.VERIFIED  # Phase 4 will deliver cross-agent evidence.
        assert belief.independent_agent_ids == (belief.owner_agent_id,)
    assert any(b.type == BeliefType.PERSISTENCE for b in memory.beliefs)
    json.dumps(engine.debug_snapshot())
    engine.reset()
    assert not engine.belief_engine.beliefs and not engine.belief_engine.evidence
    assert not engine.belief_engine.changes


def test_decision_context_contains_only_own_evidence_and_owned_beliefs():
    class CapturingPolicy:
        def __init__(self):
            self.contexts = []
        def choose_action(self, context, rng):
            self.contexts.append(context)
            return Action.INSPECT
    policy = CapturingPolicy()
    engine = SimulationEngine(policy=policy)
    engine.step()
    engine.step()
    for context in policy.contexts[5:]:
        assert context.personal_beliefs
        assert not context.adopted_shared_beliefs
        assert all(b.owner_agent_id == context.agent_id for b in context.personal_beliefs)
        assert all(e.agent_id == context.agent_id for e in context.relevant_evidence)
        assert not any(k in context.model_dump_json() for k in ("respawn_at", "origin_type", "seed"))


@pytest.mark.parametrize("seed", [0, 7, 99])
def test_memory_replays_on_other_seeds(seed):
    first, second = SimulationEngine(WorldConfig(seed=seed)), SimulationEngine(WorldConfig(seed=seed))
    for _ in range(60):
        first.step()
        second.step()
    assert first.debug_snapshot() == second.debug_snapshot()
    assert first.belief_engine.beliefs


def test_unknown_cells_never_become_uncertainty_targets():
    engine = SimulationEngine()
    for _ in range(40):
        engine.step()
        for agent in engine.agents:
            targets = engine.belief_engine.uncertainty_targets(agent)
            assert set(targets) <= set(agent.known_cells)
            assert agent.position not in targets
