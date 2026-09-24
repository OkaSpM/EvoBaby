"""Four B methods operating on owned observations and public task requests only."""
from pydantic import Field

from app.llm.mock_provider import MockProvider, applicable
from app.llm.schemas import ActionDecision, ClaimDecision, ReasoningKind
from app.schemas import Action, Resource
from app.simulation.agent import DecisionContext, MOVES
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.coordination import CooperativePolicy
from app.simulation.coordination_models import MessageIntent, MessageType, TaskType
from app.simulation.memory import BeliefOrigin, BeliefStatus, BeliefType, EvidenceKind, ExpectedEffect


class BDecisionContext(DecisionContext):
    cognition_stage: int = Field(default=1, ge=1, le=4)
    cognition_feedback: dict = Field(default_factory=dict)


def countered(context, belief):
    quarantined = getattr(context, "cognition_feedback", {}).get("ruleIds", [])
    held = (*context.personal_beliefs, *context.adopted_shared_beliefs)
    same_quarantine = any(item.id in quarantined and item.object == belief.object
                          and item.conditions == belief.conditions and item.expected_effect == belief.expected_effect
                          for item in held)
    return same_quarantine or any(evaluate_evidence(belief, evidence) is False
                                 for evidence in context.relevant_evidence)


def owned(context):
    return (*context.personal_beliefs, *context.adopted_shared_beliefs)


class BCooperativePolicy(CooperativePolicy):
    def choose_task(self, context):
        if context.active_task is not None or context.observation.energy < 25:
            return super().choose_task(context)
        stage = getattr(context, "cognition_stage", 1)
        if stage < 3:
            return super().choose_task(context)
        requested = {message.task_id: message.belief for message in context.verification_requests
                     if message.belief}
        priorities = []
        for task in context.open_tasks:
            belief = requested.get(task.id)
            external = bool(belief and belief.owner_agent_id != context.agent_id)
            missing_person = bool(belief and context.agent_id not in belief.independent_agent_ids)
            bonus = 30 * (external and missing_person)
            if stage >= 4:
                bonus += 35 * (external and not task.claimant_agent_ids)
            priorities.append(task.model_copy(update={"priority": min(100, task.priority + bonus)}))
        return super().choose_task(context.model_copy(update={"open_tasks": tuple(priorities)}))

    def choose_action(self, context, rng):
        if context.active_task is not None or context.observation.energy < 40:
            return super().choose_action(context, rng)
        current = context.observation
        beliefs = sorted(owned(context), key=lambda belief: (-int(belief.status == BeliefStatus.VERIFIED),
                                                            -belief.confidence, belief.id))
        positive = next((belief for belief in beliefs
                         if belief.type == BeliefType.CONDITIONAL_EFFECT
                         and belief.status in (BeliefStatus.TENTATIVE, BeliefStatus.VERIFIED)
                         and belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE
                         and belief.object == current.object and applicable(belief.conditions, current)
                         and not countered(context, belief)), None)
        stage = getattr(context, "cognition_stage", 1)
        if positive and current.object == Resource.MOSS and current.energy < 90:
            if stage >= 2 and positive.conditions.region is None:
                observed = {(sample.object, sample.region, sample.weather) for sample in context.relevant_evidence
                            if sample.kind == EvidenceKind.ACTION_EFFECT and sample.energy_delta}
                candidates = [cell for cell in context.known_cells if cell.object == Resource.MOSS
                              and cell.region != current.region
                              and (Resource.MOSS, cell.region, current.weather) not in observed]
                if candidates and (Resource.MOSS, current.region, current.weather) in observed:
                    x, y = current.position
                    target = min(candidates, key=lambda cell: (abs(x - cell.position[0]) + abs(y - cell.position[1]), cell.position))
                    moves = [(action, (x + dx, y + dy)) for action, (dx, dy) in MOVES
                             if 0 <= x + dx < 8 and 0 <= y + dy < 8]
                    return min(moves, key=lambda item: abs(item[1][0] - target.position[0])
                               + abs(item[1][1] - target.position[1]))[0]
            return Action.USE_MOSS
        if current.object == Resource.MOSS and any(
                belief.status != BeliefStatus.REVOKED
                and belief.object == current.object and applicable(belief.conditions, current)
                and countered(context, belief) and belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE
                for belief in beliefs):
            return self.explore(context, rng)
        return super().choose_action(context, rng)

    def choose_messages(self, context):
        intents = [intent for intent in super().choose_messages(context)
                   if intent.type != MessageType.SHARE_BELIEF or not any(
                       belief.id == intent.belief_id and countered(context, belief) for belief in owned(context))]
        stage = getattr(context, "cognition_stage", 1)
        if stage >= 2:
            intents.extend(MessageIntent(type=MessageType.REQUEST_VERIFICATION, belief_id=belief.id)
                           for belief in context.personal_beliefs
                           if belief.origin == BeliefOrigin.PERSONAL and belief.status == BeliefStatus.TENTATIVE)
        if stage >= 4:
            for request in context.verification_requests:
                belief = request.belief
                if not belief or belief.owner_agent_id == context.agent_id:
                    continue
                for evidence in context.relevant_evidence:
                    if evidence.id not in belief.evidence_ids and evaluate_evidence(belief, evidence) is not None:
                        intents.append(MessageIntent(type=MessageType.SUBMIT_EVIDENCE,
                                                     belief_id=belief.id, evidence_id=evidence.id))
        unique = {}
        for intent in intents:
            unique.setdefault((intent.type, intent.belief_id, intent.task_id, intent.evidence_id), intent)
        return tuple(unique.values())


class BMockProvider(MockProvider):
    def __init__(self):
        self.policy = BCooperativePolicy()

    def decide(self, request, rng=None):
        if request.kind == ReasoningKind.ACTION_REASONING:
            import random
            context = request.context
            action = self.policy.choose_action(context, rng or random.Random(0))
            return ActionDecision(action=action, task_id=context.active_task.id if context.active_task else None,
                                  reason=f"B阶段{getattr(context, 'cognition_stage', 1)}：按个人证据与当前核验任务选择行动。")
        if request.kind == ReasoningKind.TASK_CLAIM_REASONING:
            return ClaimDecision(claim=self.policy.choose_task(request.context),
                                 reason="结合独立证据缺口与同伴待办认领，不把人数当作事实。")
        return super().decide(request, rng)
