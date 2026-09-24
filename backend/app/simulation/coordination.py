"""Identical local heuristics for voluntary task decisions and structured messages."""
from app.schemas import Action, Resource
from app.simulation.agent import DecisionContext, ExplorationPolicy, MOVES
from app.simulation.coordination_models import ClaimIntent, MessageIntent, MessageType, TaskType, is_open, matches
from app.simulation.memory import BeliefOrigin, BeliefStatus, EvidenceKind


def region_positions(region):
    # Grid geography is public; this does not inspect resource placement.
    return [(x, y) for y in range(8) for x in range(8)
            if region is None or (("N" if y < 4 else "S") + ("W" if x < 4 else "E")) == region]


def destinations(context, requirement):
    geographic = region_positions(requirement.conditions.region)
    if requirement.evidence_kind == EvidenceKind.CELL_OBSERVATION:
        known = {o.position for o in context.known_cells}
        return [p for p in geographic if p not in known]
    known = [o.position for o in context.known_cells if o.position in geographic
             and (requirement.object is None or o.object == requirement.object)]
    if requirement.evidence_kind == EvidenceKind.RESOURCE_REVISIT:
        known.extend(e.result.position for e in context.recent_events
                     if e.result.action == Action.COLLECT and e.result.object == requirement.object)
    return sorted(set(known)) or geographic


class CooperativePolicy(ExplorationPolicy):
    def choose_task(self, context: DecisionContext) -> ClaimIntent | None:
        if context.active_task is not None:
            return None
        candidates = []
        x, y = context.observation.position
        for task in context.open_tasks:
            if not is_open(task) or (context.observation.energy < 25 and task.type != TaskType.SURVIVAL):
                continue
            for requirement in task.required_contexts:
                if (context.agent_id in requirement.independent_of or requirement.id in task.completed_context_ids
                        or any(c.context_id == requirement.id for c in task.claimed_contexts)):
                    continue
                available = destinations(context, requirement)
                evidence_ready = task.type != TaskType.INVESTIGATION and any(
                    matches(requirement, e) for e in context.relevant_evidence)
                if not available and not evidence_ready:
                    continue
                known_site = any(
                    observation.position in region_positions(requirement.conditions.region)
                    and (requirement.object is None or observation.object == requirement.object)
                    for observation in context.known_cells
                )
                distance = min((abs(x - p[0]) + abs(y - p[1]) for p in available), default=0)
                relevant = any(b.object == requirement.object for b in
                               (*context.personal_beliefs, *context.adopted_shared_beliefs))
                score = (task.priority - distance * 3 + 20 * evidence_ready + 5 * relevant
                         + 30 * (task.type == TaskType.INVESTIGATION and known_site))
                if score > 20:
                    candidates.append((-score, task.id, requirement.id))
        if not candidates:
            return None
        _, task_id, context_id = min(candidates)
        return ClaimIntent(task_id=task_id, context_id=context_id)

    def choose_action(self, context, rng):
        if context.observation.energy < 40 and any(count for _, count in context.inventory):
            return super().choose_action(context, rng)
        task = context.active_task
        if task is None or task.type == TaskType.SURVIVAL:
            return super().choose_action(context, rng)
        claim = next((c for c in task.claimed_contexts if c.agent_id == context.agent_id), None)
        if claim is None:
            return super().choose_action(context, rng)
        requirement = next(c for c in task.required_contexts if c.id == claim.context_id)
        if (task.type != TaskType.INVESTIGATION
                and requirement.evidence_kind == EvidenceKind.ACTION_EFFECT
                and context.observation.energy == 100):
            return self.explore(context, rng)
        if (task.type != TaskType.INVESTIGATION and requirement.conditions.weather
                and requirement.conditions.weather != context.observation.weather):
            return self.explore(context, rng)
        positions = destinations(context, requirement)
        if not positions:
            return self.explore(context, rng)
        x, y = context.observation.position
        target = min(positions, key=lambda p: (abs(x - p[0]) + abs(y - p[1]), p))
        if target != (x, y):
            options = [(a, (x + dx, y + dy)) for a, (dx, dy) in MOVES
                       if 0 <= x + dx < 8 and 0 <= y + dy < 8]
            return min(options, key=lambda item: abs(item[1][0] - target[0]) + abs(item[1][1] - target[1]))[0]
        if (task.type == TaskType.INVESTIGATION
                and requirement.evidence_kind == EvidenceKind.ACTION_EFFECT
                and (context.observation.energy == 100
                     or (requirement.conditions.weather
                         and requirement.conditions.weather != context.observation.weather))):
            return Action.INSPECT
        resource = context.observation.object
        if requirement.evidence_kind == EvidenceKind.ACTION_EFFECT:
            if resource == Resource.MOSS:
                return Action.USE_MOSS
            inventory = dict(context.inventory)
            if inventory.get(requirement.object, 0):
                return Action.USE_BERRY if requirement.object == Resource.BERRY else Action.USE_CRYSTAL
        if resource in (Resource.BERRY, Resource.CRYSTAL):
            return Action.COLLECT
        # Leaving an empty collection site creates a genuine later revisit.
        return self.explore(context, rng)

    def choose_messages(self, context) -> tuple[MessageIntent, ...]:
        intents = []
        for belief in (*context.personal_beliefs, *context.adopted_shared_beliefs):
            if belief.status == BeliefStatus.VERIFIED and belief.origin == BeliefOrigin.PERSONAL:
                intents.append(MessageIntent(type=MessageType.SHARE_BELIEF, belief_id=belief.id))
            elif belief.status == BeliefStatus.DISPUTED:
                intents.append(MessageIntent(type=MessageType.RAISE_DISPUTE, belief_id=belief.id))
        task = context.active_task
        if task:
            claim = next(c for c in task.claimed_contexts if c.agent_id == context.agent_id)
            requirement = next(c for c in task.required_contexts if c.id == claim.context_id)
            request = next((m for m in context.verification_requests if m.task_id == task.id), None)
            submitted = False
            for evidence in context.relevant_evidence:
                if request and request.belief and evidence.id in request.belief.evidence_ids:
                    continue
                if matches(requirement, evidence) and evidence.id not in task.evidence_ids:
                    if task.type == TaskType.INVESTIGATION and evidence.turn < claim.claimed_turn:
                        continue
                    if task.type == TaskType.SURVIVAL and (evidence.energy_delta or 0) <= 0:
                        continue
                    if evidence.kind == EvidenceKind.ACTION_EFFECT and not evidence.energy_delta:
                        continue
                    if submitted and task.belief_id is None:
                        break
                    intents.append(MessageIntent(type=MessageType.SUBMIT_EVIDENCE,
                                                 task_id=task.id if not submitted else None,
                                                 belief_id=task.belief_id, evidence_id=evidence.id))
                    submitted = True
        return tuple(intents)
