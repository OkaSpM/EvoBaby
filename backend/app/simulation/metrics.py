"""Metrics derived from events, evidence, messages and lineage."""
from app.schemas import Action
from app.simulation.belief_engine import BeliefEngine
from app.simulation.coordination_models import MessageType
from app.simulation.corruption import CorruptionIncident, CorruptionSystem
from app.simulation.events import EventLog, EventType
from app.simulation.memory import EvidenceKind, FrozenModel
from app.simulation.swarm import Swarm


class AttackMetrics(FrozenModel):
    incident_id: str
    attack_number: int
    agents_affected: int
    injected_turn: int
    first_dispute_turn: int | None
    resolved_turn: int | None
    turns_until_first_dispute: int | None
    turns_until_repair: int | None
    incorrect_actions_caused: int
    contexts_checked_before_adoption: int
    adopted: bool


class EvolutionComparison(FrozenModel):
    first_attack: AttackMetrics
    second_attack: AttackMetrics
    spread_reduction: int
    incorrect_action_reduction: int
    additional_contexts_before_adoption: int


class ExperimentMetrics(FrozenModel):
    attacks: tuple[AttackMetrics, ...]
    comparison: EvolutionComparison | None = None


class MetricsEngine:
    def _attack(self, incident: CorruptionIncident, memory: BeliefEngine,
                swarm: Swarm, event_log: EventLog) -> AttackMetrics:
        family_ids = (incident.root_belief_id, *swarm.descendants(incident.root_belief_id, memory))
        family = tuple(memory.get(i) for i in family_ids)
        holdings = {belief.owner_agent_id: belief.created_turn for belief in family}
        share_messages = [message for message in swarm.messages
                          if message.type == MessageType.SHARE_BELIEF
                          and message.belief_id in family_ids]
        adopted = bool(share_messages)
        cutoff = min(message.turn for message in share_messages) if share_messages else incident.resolved_turn
        if cutoff is None:
            cutoff = max((event.turn for event in event_log.events), default=incident.injected_turn)
        context_evidence_ids = (share_messages[0].belief.evidence_ids if share_messages
                                else tuple(evidence_id for belief in family
                                           for evidence_id in belief.evidence_ids))
        contexts = {
            (evidence.region, evidence.weather)
            for evidence_id in context_evidence_ids
            for evidence in (memory.evidence_by_id(evidence_id),)
            if evidence.kind == EvidenceKind.ACTION_EFFECT and evidence.turn <= cutoff
        }
        detection = incident.detected_turn or incident.disputed_turn
        action_cutoff = detection if detection is not None else (
            incident.resolved_turn if incident.resolved_turn is not None else
            max((event.turn for event in event_log.events), default=incident.injected_turn)
        )
        incorrect = 0
        hypothesis = incident.injected_hypothesis
        action_events = event_log.events[incident.event_cursor:incident.detected_event_cursor]
        if incident.detected_event_cursor is None:
            action_events = event_log.events[incident.event_cursor:]
        for event in action_events:
            result = event.result
            held_turn = holdings.get(event.agent_id)
            if (event.type != EventType.ACTION_EXECUTED or result is None or not result.success
                    or result.action != Action.USE_MOSS or held_turn is None
                    or event.turn < held_turn or event.turn > action_cutoff
                    or result.object != hypothesis.object
                    or (hypothesis.conditions.region is not None
                        and result.region != hypothesis.conditions.region)
                    or (hypothesis.conditions.weather is not None
                        and result.weather != hypothesis.conditions.weather)):
                continue
            predicted_positive = hypothesis.effect == "ENERGY_POSITIVE"
            actual_positive = (result.resource_effect or 0) > 0
            incorrect += int(predicted_positive != actual_positive)
        return AttackMetrics(
            incident_id=incident.id, attack_number=incident.attack_number,
            agents_affected=len(holdings), injected_turn=incident.injected_turn,
            first_dispute_turn=incident.disputed_turn, resolved_turn=incident.resolved_turn,
            turns_until_first_dispute=None if incident.disputed_turn is None
            else incident.disputed_turn - incident.injected_turn,
            turns_until_repair=None if incident.resolved_turn is None
            else incident.resolved_turn - incident.injected_turn,
            incorrect_actions_caused=incorrect,
            contexts_checked_before_adoption=len(contexts), adopted=adopted,
        )

    def snapshot(self, corruption: CorruptionSystem, memory: BeliefEngine,
                 swarm: Swarm, event_log: EventLog) -> ExperimentMetrics:
        attacks = tuple(self._attack(incident, memory, swarm, event_log)
                        for incident in corruption.incidents)
        comparison = None
        if len(attacks) >= 2:
            first, second = attacks[0], attacks[1]
            comparison = EvolutionComparison(
                first_attack=first, second_attack=second,
                spread_reduction=first.agents_affected - second.agents_affected,
                incorrect_action_reduction=first.incorrect_actions_caused - second.incorrect_actions_caused,
                additional_contexts_before_adoption=(second.contexts_checked_before_adoption
                                                     - first.contexts_checked_before_adoption),
            )
        return ExperimentMetrics(attacks=attacks, comparison=comparison)
