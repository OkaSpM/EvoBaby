"""Evidence-based statistics. No access to World, audit browsing or LLM truth."""
from dataclasses import dataclass
from typing import Iterable, Mapping

from app.schemas import Action, Position, Resource
from app.simulation.agent import AgentState
from app.simulation.events import EventType, RawEvent
from app.simulation.memory import (
    Belief, BeliefChange, BeliefOrigin, BeliefStatus, BeliefType, ConditionalHypothesis,
    Conditions, Evidence, EvidenceKind, ExpectedEffect, Lineage,
)
from app.simulation.meta_models import MetaBelief, MetaBeliefType

# A finite observation window, deliberately independent of resource truth.
PERSISTENCE_OBSERVATION_WINDOW = 4
USE_ACTIONS = (Action.USE_BERRY, Action.USE_CRYSTAL, Action.USE_MOSS)


@dataclass
class CollectionTrace:
    event_id: str
    turn: int
    object: Resource
    departed: bool = False
    absence_recorded: bool = False


def verification_eligible(belief: Belief) -> bool:
    return (belief.confidence >= 0.75 and belief.evidence_count >= 3
            and len(belief.independent_agent_ids) >= 2)


def evaluate_evidence(belief: Belief, evidence: Evidence) -> bool | None:
    """True/False counts one support/counterexample; None is inapplicable/censored."""
    if belief.conditions.region is not None and evidence.region != belief.conditions.region:
        return None
    if belief.conditions.weather is not None and evidence.weather != belief.conditions.weather:
        return None
    if belief.type == BeliefType.DISTRIBUTION:
        if evidence.kind != EvidenceKind.CELL_OBSERVATION:
            return None
        return evidence.observed_object == belief.object
    if evidence.object != belief.object:
        return None
    if belief.type == BeliefType.PERSISTENCE:
        if evidence.kind != EvidenceKind.RESOURCE_REVISIT:
            return None
        returned = evidence.observed_object == belief.object
        if not returned and (evidence.elapsed_turns or 0) < PERSISTENCE_OBSERVATION_WINDOW:
            return None
        return returned if belief.expected_effect == ExpectedEffect.RENEWABLE else not returned
    if evidence.kind != EvidenceKind.ACTION_EFFECT or not evidence.energy_delta:
        # Zero change at the energy ceiling does not refute a positive effect.
        return None
    return (evidence.energy_delta > 0) == (belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE)


class BeliefEngine:
    def __init__(self):
        self._beliefs: dict[str, Belief] = {}
        self._evidence: dict[str, Evidence] = {}
        self._changes: list[BeliefChange] = []
        self._processed_events: set[str] = set()
        self._seen_cells: set[tuple[str, Position]] = set()
        self._collections: dict[tuple[str, Position], CollectionTrace] = {}
        self._personal_keys: dict[tuple, str] = {}
        self._meta_beliefs: tuple[MetaBelief, ...] = ()
        self.dispute_handler = None
        self.verification_policy = None
        self.adoption_policy = None
        self.minimum_independent_agents = 2

    @property
    def beliefs(self) -> tuple[Belief, ...]:
        return tuple(self._beliefs.values())

    @property
    def evidence(self) -> tuple[Evidence, ...]:
        return tuple(self._evidence.values())

    @property
    def changes(self) -> tuple[BeliefChange, ...]:
        return tuple(self._changes)

    def get(self, belief_id: str) -> Belief:
        return self._beliefs[belief_id]

    def evidence_for(self, agent_id: str) -> tuple[Evidence, ...]:
        return tuple(e for e in self._evidence.values() if e.agent_id == agent_id)

    def evidence_by_id(self, evidence_id: str) -> Evidence:
        return self._evidence[evidence_id]

    @property
    def active_meta_beliefs(self) -> tuple[MetaBelief, ...]:
        return tuple(b for b in self._meta_beliefs if b.active)

    def missing_context_dimensions(self, belief: Belief) -> tuple[str, ...]:
        if belief.type != BeliefType.CONDITIONAL_EFFECT:
            return ()
        required = {dimension: 2 for meta in self.active_meta_beliefs
                    if meta.type == MetaBeliefType.REQUIRE_CONTEXT_DIVERSITY
                    for dimension in meta.policy_effect.dimensions}
        missing = []
        for dimension, minimum in required.items():
            if getattr(belief.conditions, dimension) is not None:
                continue
            values = {getattr(self._evidence[i], dimension) for i in belief.evidence_ids
                      if evaluate_evidence(belief, self._evidence[i]) is True}
            if len(values) < minimum:
                missing.append(dimension)
        return tuple(missing)

    def _verification_eligible(self, belief: Belief) -> bool:
        return (verification_eligible(belief) and not self.missing_context_dimensions(belief)
                and (self.verification_policy is None or self.verification_policy(belief)))

    def activate_meta_beliefs(self, beliefs: Iterable[MetaBelief], *, turn: int) -> None:
        """Install real policy state and re-evaluate unsupported generalized claims."""
        self._meta_beliefs = tuple(beliefs)
        for belief in self.beliefs:
            if belief.status != BeliefStatus.VERIFIED or not self.missing_context_dimensions(belief):
                continue
            updated = belief.model_copy(update={"status": BeliefStatus.TENTATIVE, "updated_turn": turn})
            self._beliefs[belief.id] = updated
            self._change(updated, "BELIEF_UPDATED", belief.status)

    def memories_for(self, agent: AgentState) -> tuple[tuple[Belief, ...], tuple[Belief, ...]]:
        def resolve(ids, origin):
            return tuple(self._beliefs[i] for i in ids
                         if self._beliefs[i].owner_agent_id == agent.id and self._beliefs[i].origin == origin)
        return resolve(agent.personal_beliefs, BeliefOrigin.PERSONAL), resolve(
            agent.adopted_shared_beliefs, BeliefOrigin.SHARED)

    def _change(self, belief: Belief, change_type: str, previous=None, evidence_id=None):
        self._changes.append(BeliefChange(id=f"BC{len(self._changes) + 1}", turn=belief.updated_turn,
                                          type=change_type, belief_id=belief.id,
                                          previous_status=previous, status=belief.status,
                                          evidence_id=evidence_id))

    def _create(self, agent: AgentState, belief_type: BeliefType, resource: Resource,
                conditions: Conditions, effect: ExpectedEffect, turn: int) -> Belief:
        key = (agent.id, belief_type, resource, conditions.region, conditions.weather, effect)
        if key in self._personal_keys:
            return self.get(self._personal_keys[key])
        belief = Belief(id=f"B{len(self._beliefs) + 1}", type=belief_type, object=resource,
                        proposition=f"{resource.value}: {effect.value}", conditions=conditions,
                        expected_effect=effect, source_agent_id=agent.id, owner_agent_id=agent.id,
                        created_turn=turn, updated_turn=turn)
        self._beliefs[belief.id] = belief
        self._personal_keys[key] = belief.id
        agent.personal_beliefs.append(belief.id)
        self._change(belief, "BELIEF_CREATED")
        return belief

    def submit_evidence(self, belief_id: str, evidence_id: str, *, turn: int) -> Belief:
        """Explicit delivery boundary for future swarm messages; never pools implicitly."""
        belief, evidence = self.get(belief_id), self._evidence[evidence_id]
        if turn < max(belief.updated_turn, evidence.turn):
            raise ValueError("Evidence cannot be delivered before it exists")
        if belief.status == BeliefStatus.REVOKED or evidence_id in belief.evidence_ids:
            return belief
        support = evaluate_evidence(belief, evidence)
        if support is None:
            return belief
        # Same collection cycle cannot inflate statistics via repeated absent visits.
        if evidence.collection_event_id and any(
            self._evidence[i].collection_event_id == evidence.collection_event_id
            and evaluate_evidence(belief, self._evidence[i]) == support for i in belief.evidence_ids
        ):
            return belief
        updated = belief.model_copy(update={
            "alpha": belief.alpha + int(support), "beta": belief.beta + int(not support),
            "evidence_ids": (*belief.evidence_ids, evidence.id),
            "independent_agent_ids": tuple(sorted(set(belief.independent_agent_ids) | {evidence.agent_id})),
            "updated_turn": turn,
        })
        status = belief.status
        if (status == BeliefStatus.VERIFIED and not support
                and (belief.type == BeliefType.CONDITIONAL_EFFECT
                     or (belief.type == BeliefType.PERSISTENCE
                         and evidence.observed_object == belief.object))):
            status = BeliefStatus.DISPUTED
            if self.dispute_handler is not None:
                status = self.dispute_handler(belief, updated, evidence, turn)
        elif status == BeliefStatus.TENTATIVE and self._verification_eligible(updated):
            status = BeliefStatus.VERIFIED
        # A dispute is sticky until an explicit evidence-based resolution in Phase 6.
        updated = updated.model_copy(update={"status": status})
        self._beliefs[belief_id] = updated
        change_type = ("BELIEF_DISPUTED" if status == BeliefStatus.DISPUTED else "BELIEF_VERIFIED")
        self._change(updated, change_type if status != belief.status else "BELIEF_UPDATED",
                     belief.status, evidence_id)
        return updated

    def _record(self, agent: AgentState, **fields) -> Evidence:
        evidence = Evidence(id=f"EV{len(self._evidence) + 1}", agent_id=agent.id, **fields)
        self._evidence[evidence.id] = evidence
        for belief in (*self.memories_for(agent)[0], *self.memories_for(agent)[1]):
            self.submit_evidence(belief.id, evidence.id, turn=evidence.turn)
        return evidence

    def consume(self, events: Iterable[RawEvent], agents: Iterable[AgentState]):
        owners = {a.id: a for a in agents}
        for event in events:
            if event.event_id in self._processed_events:
                continue
            agent = owners[event.agent_id]
            self._processed_events.add(event.event_id)
            if event.type == EventType.OBSERVATION:
                self._observe(agent, event)
            elif event.type == EventType.ACTION_EXECUTED and event.result and event.result.success:
                result = event.result
                if result.action == Action.COLLECT:
                    self._collections[(agent.id, result.position)] = CollectionTrace(
                        event.event_id, event.turn, result.object)
                elif result.action in USE_ACTIONS:
                    self._record(agent, kind=EvidenceKind.ACTION_EFFECT, event_ids=(event.event_id,),
                                 turn=event.turn, position=result.position, region=result.region,
                                 weather=result.weather, object=result.object, observed_object=result.object,
                                 action=result.action,
                                 energy_delta=result.energy_after - result.energy_before + result.action_cost)

    def _observe(self, agent: AgentState, event: RawEvent):
        observation = event.observation
        position = observation.position
        key = (agent.id, position)
        if key not in self._seen_cells:
            self._seen_cells.add(key)
            for resource in Resource:
                self._create(agent, BeliefType.DISTRIBUTION, resource,
                             Conditions(region=observation.region), ExpectedEffect.OBJECT_PRESENT,
                             event.turn)
            self._record(agent, kind=EvidenceKind.CELL_OBSERVATION,
                                    event_ids=(event.event_id,), turn=event.turn, position=position,
                                    region=observation.region, weather=observation.weather,
                                    object=observation.object, observed_object=observation.object)
            # Existing distributions were updated in _record; no double count.
        for (owner, location), trace in tuple(self._collections.items()):
            if owner != agent.id:
                continue
            if location != position:
                trace.departed = True
                continue
            if not trace.departed or event.turn <= trace.turn:
                continue
            trace.departed = False
            elapsed = event.turn - trace.turn
            returned = observation.object == trace.object
            if not returned and (elapsed < PERSISTENCE_OBSERVATION_WINDOW or trace.absence_recorded):
                continue
            effect = ExpectedEffect.RENEWABLE if returned else ExpectedEffect.NOT_RENEWABLE
            belief = self._create(agent, BeliefType.PERSISTENCE, trace.object, Conditions(), effect, event.turn)
            # Newly formed temporal claims must account for earlier local revisits too.
            for previous in self.evidence_for(agent.id):
                self.submit_evidence(belief.id, previous.id, turn=event.turn)
            self._record(agent, kind=EvidenceKind.RESOURCE_REVISIT,
                         event_ids=(trace.event_id, event.event_id), turn=event.turn, position=position,
                         region=observation.region, weather=observation.weather,
                         object=trace.object, observed_object=observation.object, elapsed_turns=elapsed,
                         collection_event_id=trace.event_id)
            if returned:
                del self._collections[key]
            else:
                trace.absence_recorded = True

    def propose_conditional(self, agent: AgentState, hypothesis: ConditionalHypothesis | dict, *, turn: int) -> Belief:
        """Accept a structured proposal, then compute all statistics from local evidence."""
        # Validate again at this trust boundary; raw dictionaries are accepted safely.
        hypothesis = ConditionalHypothesis.model_validate(
            hypothesis.model_dump(round_trip=True) if isinstance(hypothesis, ConditionalHypothesis) else hypothesis)
        relevant = [e for e in self.evidence_for(agent.id)
                    if e.kind == EvidenceKind.ACTION_EFFECT and e.object == hypothesis.object
                    and (hypothesis.conditions.region is None or e.region == hypothesis.conditions.region)
                    and (hypothesis.conditions.weather is None or e.weather == hypothesis.conditions.weather)
                    and e.energy_delta]
        if len(relevant) < 2:
            raise ValueError("Conditional hypotheses require two relevant local observations")
        if turn < max(e.turn for e in relevant):
            raise ValueError("Hypothesis cannot precede its evidence")
        belief = self._create(agent, hypothesis.type, hypothesis.object, hypothesis.conditions,
                              hypothesis.effect, turn)
        for evidence in relevant:
            self.submit_evidence(belief.id, evidence.id, turn=turn)
        return self.get(belief.id)

    def install_memory(self, agent: AgentState, hypothesis: ConditionalHypothesis | dict,
                       samples: Iterable[Mapping], *, turn: int,
                       require_verified: bool) -> tuple[Belief, tuple[Evidence, ...]]:
        """Privileged storage boundary used only by the regulator.

        The caller supplies ordinary evidence fields.  This method validates the
        same verification threshold as normal learning and stores no corruption
        marker in agent-visible memory.
        """
        hypothesis = ConditionalHypothesis.model_validate(
            hypothesis.model_dump(round_trip=True) if isinstance(hypothesis, ConditionalHypothesis) else hypothesis)
        key = (agent.id, hypothesis.type, hypothesis.object, hypothesis.conditions.region,
               hypothesis.conditions.weather, hypothesis.effect)
        replace_revoked = False
        if key in self._personal_keys:
            existing = self.get(self._personal_keys[key])
            if existing.status != BeliefStatus.REVOKED:
                raise ValueError("Equivalent personal memory already exists")
            replace_revoked = True
        drafts = tuple(Evidence(id=f"EV{len(self._evidence) + i + 1}", **dict(sample))
                       for i, sample in enumerate(samples))
        if len(drafts) < 3 or len({e.agent_id for e in drafts}) < 2:
            raise ValueError("Installed memory must satisfy the normal verification threshold")
        if any(e.turn > turn or e.kind != EvidenceKind.ACTION_EFFECT or e.object != hypothesis.object
               for e in drafts):
            raise ValueError("Installed memory requires prior action-effect evidence")
        probe = Belief(id="PROBE", type=hypothesis.type, object=hypothesis.object,
                       proposition=f"{hypothesis.object.value}: {hypothesis.effect.value}",
                       conditions=hypothesis.conditions, expected_effect=hypothesis.effect,
                       source_agent_id=agent.id, owner_agent_id=agent.id,
                       created_turn=turn, updated_turn=turn)
        if any(e.id in self._evidence or evaluate_evidence(probe, e) is not True for e in drafts):
            raise ValueError("Installed evidence must support the installed memory")
        if require_verified:
            for meta in self.active_meta_beliefs:
                for dimension in meta.policy_effect.dimensions:
                    if (getattr(hypothesis.conditions, dimension) is None
                            and len({getattr(e, dimension) for e in drafts})
                            < meta.policy_effect.minimum_distinct_values):
                        raise ValueError("Installed memory does not satisfy active context-diversity policy")
        if replace_revoked:
            del self._personal_keys[key]
        belief = self._create(agent, hypothesis.type, hypothesis.object, hypothesis.conditions,
                              hypothesis.effect, turn)
        for evidence in drafts:
            self._evidence[evidence.id] = evidence
            self.submit_evidence(belief.id, evidence.id, turn=turn)
        belief = self.get(belief.id)
        if not verification_eligible(belief):
            raise RuntimeError("Installed memory failed the base verification threshold")
        if require_verified and belief.status != BeliefStatus.VERIFIED:
            raise RuntimeError("Installed memory failed verification")
        return belief, drafts

    def install_verified_memory(self, agent: AgentState, hypothesis: ConditionalHypothesis | dict,
                                samples: Iterable[Mapping], *, turn: int) -> tuple[Belief, tuple[Evidence, ...]]:
        return self.install_memory(agent, hypothesis, samples, turn=turn, require_verified=True)

    def reject_tentative(self, belief_ids: Iterable[str], evidence_id: str, *, turn: int) -> tuple[Belief, ...]:
        evidence = self.evidence_by_id(evidence_id)
        updated_beliefs = []
        for belief_id in dict.fromkeys(belief_ids):
            belief = self.get(belief_id)
            if belief.status == BeliefStatus.REVOKED:
                continue
            if belief.status != BeliefStatus.TENTATIVE or evaluate_evidence(belief, evidence) is not False:
                raise ValueError("Policy rejection requires tentative beliefs and direct counterevidence")
            updated = belief.model_copy(update={"status": BeliefStatus.REVOKED, "updated_turn": turn})
            self._beliefs[belief.id] = updated
            self._change(updated, "BELIEF_REVOKED", belief.status, evidence_id)
            updated_beliefs.append(updated)
        return tuple(updated_beliefs)

    def resolve_conditional_lineage(self, root_belief_id: str, descendant_ids: Iterable[str],
                                    evidence_ids: Iterable[str], agents: Iterable[AgentState], *,
                                    turn: int, repaired: ConditionalHypothesis | None) -> Belief | None:
        """Atomically revoke a disputed claim family and optionally install a verified repair."""
        root = self.get(root_belief_id)
        family_ids = tuple(dict.fromkeys((root_belief_id, *descendant_ids)))
        family = tuple(self.get(i) for i in family_ids)
        if root.type != BeliefType.CONDITIONAL_EFFECT or not any(
            b.status == BeliefStatus.DISPUTED for b in family
        ):
            raise ValueError("Repair requires a disputed conditional belief family")
        supplied = tuple(self._evidence[i] for i in dict.fromkeys(evidence_ids))
        family_evidence = tuple(self._evidence[i] for b in family for i in b.evidence_ids)
        all_evidence = tuple({e.id: e for e in (*family_evidence, *supplied)}.values())
        if not any(evaluate_evidence(root, e) is False for e in all_evidence):
            raise ValueError("Repair requires real counterevidence to the disputed claim")

        replacement = None
        if repaired is not None:
            repaired = ConditionalHypothesis.model_validate(repaired.model_dump(round_trip=True))
            if (repaired.object != root.object or repaired.effect != root.expected_effect
                    or repaired.conditions == root.conditions
                    or any(getattr(root.conditions, dimension) is not None
                           and getattr(root.conditions, dimension) != getattr(repaired.conditions, dimension)
                           for dimension in ("region", "weather"))):
                raise ValueError("A repair must strictly narrow the disputed claim")
            probe = root.model_copy(update={"conditions": repaired.conditions})
            relevant = tuple(e for e in supplied if evaluate_evidence(probe, e) is not None)
            support = tuple(e for e in relevant if evaluate_evidence(probe, e) is True)
            if (len(support) < 3 or len({e.agent_id for e in support}) < 2
                    or any(evaluate_evidence(probe, e) is False for e in relevant)):
                raise ValueError("A repair requires three supporting tests from two agents and no counterexample")
            owners = {a.id: a for a in agents}
            owner = owners[root.owner_agent_id]
            replacement = self._create(owner, repaired.type, repaired.object, repaired.conditions,
                                       repaired.effect, turn)
            for evidence in support:
                self.submit_evidence(replacement.id, evidence.id, turn=turn)
            replacement = self.get(replacement.id)
            if replacement.status != BeliefStatus.VERIFIED:
                raise ValueError("Repair did not satisfy the normal verification threshold")
        else:
            counter = tuple(e for e in supplied if evaluate_evidence(root, e) is False)
            if len(counter) < 3 or len({e.agent_id for e in counter}) < 2:
                raise ValueError("Revocation requires three counterexamples from two agents")

        for belief in family:
            if belief.status == BeliefStatus.REVOKED:
                continue
            updated = belief.model_copy(update={"status": BeliefStatus.REVOKED, "updated_turn": turn})
            self._beliefs[belief.id] = updated
            self._change(updated, "BELIEF_REVOKED", belief.status)
        return replacement

    def adopt_shared(self, agent: AgentState, belief_id: str, *, sender_agent_id: str,
                     message_id: str, turn: int) -> Belief | None:
        """Storage boundary only; broadcasting and adoption decisions belong to Phase 4."""
        source = self.get(belief_id)
        if source.owner_agent_id != sender_agent_id or source.status != BeliefStatus.VERIFIED:
            raise ValueError("Only an owner's verified belief can be shared")
        if turn < source.updated_turn:
            raise ValueError("Sharing cannot precede the source belief")
        # A direct action counterexample outweighs a message's confidence.
        if any(e.kind == EvidenceKind.ACTION_EFFECT and evaluate_evidence(source, e) is False
               for e in self.evidence_for(agent.id)):
            return None
        if self.adoption_policy is not None and not self.adoption_policy(
            agent, source, sender_agent_id, message_id, turn
        ):
            return None
        for belief in self.memories_for(agent)[1]:
            if belief.lineage.parent_belief_id == belief_id:
                return belief
        belief = source.model_copy(update={
            "id": f"B{len(self._beliefs) + 1}", "owner_agent_id": agent.id,
            "origin": BeliefOrigin.SHARED, "created_turn": turn, "updated_turn": turn,
            "lineage": Lineage(original_source_agent_id=source.source_agent_id,
                               sender_agent_id=sender_agent_id, receiver_agent_id=agent.id,
                               parent_belief_id=source.id, message_id=message_id),
        })
        self._beliefs[belief.id] = belief
        agent.adopted_shared_beliefs.append(belief.id)
        self._change(belief, "BELIEF_CREATED")
        # Existing recipient evidence remains evidence from its actual source, never
        # a new independent observation simply because this agent adopted a message.
        for evidence in self.evidence_for(agent.id):
            self.submit_evidence(belief.id, evidence.id, turn=turn)
        return self.get(belief.id)

    def revoke_disputed(self, belief_id: str, *, turn: int) -> Belief:
        """Terminal storage transition for the future investigation coordinator.

        Does not run an investigation or infer a replacement rule. A recorded
        dispute and actual counterevidence are required; confidence alone cannot
        silently revoke a belief.
        """
        belief = self.get(belief_id)
        if belief.status != BeliefStatus.DISPUTED or not any(
            evaluate_evidence(belief, self._evidence[i]) is False for i in belief.evidence_ids
        ):
            raise ValueError("Revocation requires a disputed belief with counterevidence")
        if turn < belief.updated_turn:
            raise ValueError("Revocation cannot precede the dispute")
        updated = belief.model_copy(update={"status": BeliefStatus.REVOKED, "updated_turn": turn})
        self._beliefs[belief_id] = updated
        self._change(updated, "BELIEF_REVOKED", belief.status)
        return updated

    def uncertainty_targets(self, agent: AgentState) -> tuple[Position, ...]:
        targets = {position for (owner, position), trace in self._collections.items() if owner == agent.id}
        for belief in sum(self.memories_for(agent), ()):
            if belief.status not in (BeliefStatus.TENTATIVE, BeliefStatus.DISPUTED):
                continue
            if belief.type == BeliefType.CONDITIONAL_EFFECT:
                targets.update(o.position for o in agent.known_cells.values()
                               if o.object == belief.object
                               and (belief.conditions.region is None or o.region == belief.conditions.region))
        return tuple(sorted(targets - {agent.position}))

    def debug_snapshot(self) -> dict:
        return {"beliefs": [b.model_dump(mode="json") for b in self.beliefs],
                "evidence": [e.model_dump(mode="json") for e in self.evidence],
                "beliefChanges": [c.model_dump(mode="json") for c in self.changes]}
