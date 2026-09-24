"""B-only receipt checks; provenance comes from public actions, never attack tags."""
from app.simulation.events import EventType
from app.simulation.memory import EvidenceKind


def checked_effects(evidence, events, turn=None):
    actions = {event.event_id: event for event in events}
    result = {}
    for sample in evidence:
        if sample.kind != EvidenceKind.ACTION_EFFECT or not sample.energy_delta:
            continue
        if turn is not None and sample.turn > turn:
            continue
        for event_id in sample.event_ids:
            event = actions.get(event_id)
            action = event.result if event else None
            if (event and event.type == EventType.ACTION_EXECUTED and action and action.success
                    and event.agent_id == sample.agent_id == action.agent_id
                    and event.turn == sample.turn == action.turn
                    and action.action == sample.action and action.position == sample.position
                    and action.object == sample.object == sample.observed_object
                    and action.region == sample.region and action.weather == sample.weather
                    and action.energy_after - action.energy_before + action.action_cost == sample.energy_delta
                    and action.energy_after == max(0, min(100, action.energy_before - action.action_cost
                                                         + action.resource_effect))):
                result[sample.id] = sample
                break
    return result


def claim_signature(belief):
    return (belief.object, belief.conditions.region, belief.conditions.weather, belief.expected_effect)


def narrower(candidate, original):
    return (candidate.object == original.object and candidate.expected_effect == original.expected_effect
            and candidate.conditions != original.conditions
            and all(getattr(original.conditions, key) is None
                    or getattr(candidate.conditions, key) == getattr(original.conditions, key)
                    for key in ("region", "weather")))
