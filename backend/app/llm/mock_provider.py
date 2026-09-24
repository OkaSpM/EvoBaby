"""Deterministic, evidence-only reasoning. This module must never import World."""
import random
from itertools import combinations, product

from app.llm.schemas import (
    ActionDecision, ClaimDecision, HypothesisDecision, MetaPrinciple, RankingDecision, ReasoningKind,
)
from app.simulation.coordination import CooperativePolicy
from app.simulation.memory import BeliefStatus, BeliefType, ConditionalHypothesis, Conditions, EvidenceKind, ExpectedEffect
from app.schemas import Action


def applicable(conditions, evidence):
    return ((conditions.region is None or evidence.region == conditions.region)
            and (conditions.weather is None or evidence.weather == conditions.weather))


def outcome_matches(effect, evidence):
    return bool(evidence.energy_delta) and ((evidence.energy_delta > 0) == (effect == ExpectedEffect.ENERGY_POSITIVE))


def propose_from_evidence(evidence, resource, original=None):
    samples = list({e.id: e for e in evidence if e.kind == EvidenceKind.ACTION_EFFECT
                    and e.object == resource and e.energy_delta}.values())
    if len(samples) < 2:
        return None
    if original:
        # Exhaust the small hypothesis space of additions to the original claim.
        missing = [d for d in ("region", "weather") if getattr(original.conditions, d) is None]
        for size in range(1, len(missing) + 1):
            for dimensions in combinations(missing, size):
                values = [sorted({getattr(e, d) for e in samples}) for d in dimensions]
                for choices in product(*values):
                    conditions = original.conditions.model_copy(update=dict(zip(dimensions, choices)))
                    matching = [e for e in samples if applicable(conditions, e)]
                    if len(matching) >= 2 and all(outcome_matches(original.effect, e) for e in matching):
                        return ConditionalHypothesis(object=resource, conditions=conditions, effect=original.effect,
                                                     reason="A narrower observed context accounts for the supplied outcomes.")
        return None
    anchor = samples[-1]
    effect = ExpectedEffect.ENERGY_POSITIVE if anchor.energy_delta > 0 else ExpectedEffect.ENERGY_NEGATIVE
    # Prefer a simple observed dimension. This intentionally permits natural
    # over-generalization when the data do not distinguish omitted dimensions.
    candidates = [Conditions(weather=anchor.weather), Conditions(region=anchor.region),
                  Conditions(region=anchor.region, weather=anchor.weather)]
    if len({e.weather for e in samples}) >= 2 and len({e.region for e in samples}) >= 2:
        candidates.insert(0, Conditions())
    for conditions in candidates:
        matching = [e for e in samples if applicable(conditions, e)]
        if len(matching) >= 2 and all(outcome_matches(effect, e) for e in matching):
            return ConditionalHypothesis(object=resource, conditions=conditions, effect=effect,
                                         reason="Repeated matching observations suggest this conditional effect.")
    return None


class MockProvider:
    def __init__(self):
        self.policy = CooperativePolicy()

    def decide(self, request, rng=None):
        rng = rng if rng is not None else random.Random(0)
        c = request.context
        if request.kind == ReasoningKind.ACTION_REASONING:
            action = None
            # Apply a held conditional belief, including an over-generalized one.
            # New verification tasks take precedence over normal exploitation.
            if c.active_task is None and c.observation.energy < 90:
                beliefs = sorted((*c.personal_beliefs, *c.adopted_shared_beliefs),
                                 key=lambda b: (-int(b.status == BeliefStatus.VERIFIED), -b.confidence, b.id))
                for belief in beliefs:
                    if (belief.type == BeliefType.CONDITIONAL_EFFECT
                            and belief.status in (BeliefStatus.TENTATIVE, BeliefStatus.VERIFIED)
                            and belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE
                            and belief.object == c.observation.object
                            and applicable(belief.conditions, c.observation)):
                        # Inventory resources still need collecting before using.
                        if c.observation.object.value == "Moss":
                            action = Action.USE_MOSS
                        break
            action = action or self.policy.choose_action(c, rng)
            return ActionDecision(action=action, task_id=c.active_task.id if c.active_task else None,
                                  reason="Use local observations, held beliefs and the active task to balance energy and uncertainty.")
        if request.kind == ReasoningKind.TASK_CLAIM_REASONING:
            return ClaimDecision(claim=self.policy.choose_task(c), reason="Consider energy, distance, evidence and workload.")
        if request.kind in (ReasoningKind.HYPOTHESIS_GENERATION, ReasoningKind.INVESTIGATION_HYPOTHESIS):
            return HypothesisDecision(hypothesis=propose_from_evidence(
                request.evidence, request.object,
                request.hypothesis if request.kind == ReasoningKind.INVESTIGATION_HYPOTHESIS else None))
        if request.kind == ReasoningKind.META_REFLECTION:
            return MetaPrinciple(dimensions=("region", "weather"),
                                 principle="Independent agents are not independent contexts. General claims require evidence across omitted context dimensions.")
        return RankingDecision(candidate_index=0 if request.candidates else None,
                               reason="Prefer the first supplied plausible mutation; code must validate it independently.")
