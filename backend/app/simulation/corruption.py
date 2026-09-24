"""Privileged fault injection and immutable audit records.

This subsystem may inspect hidden truth, but its data is never placed in an
agent decision context.  It ranks constrained mutations; code remains the
final authority on physical validity and target eligibility.
"""
from enum import StrEnum
from typing import Literal

from app.llm.provider import ReasoningService
from app.llm.schemas import ReasoningKind, ReasoningRequest
from app.schemas import Action, Region, Resource, Weather
from app.simulation.agent import AgentState
from app.simulation.belief_engine import BeliefEngine, evaluate_evidence
from app.simulation.coordination_models import TaskType, is_open
from app.simulation.memory import (
    Belief, BeliefStatus, BeliefType, ConditionalHypothesis, Conditions,
    EvidenceKind, ExpectedEffect, FrozenModel,
)
from app.simulation.meta_models import MetaBelief
from app.simulation.swarm import Swarm
from app.simulation.task_engine import TaskEngine, claim_key
from app.simulation.world import World, region_at


class IncidentStatus(StrEnum):
    INJECTED = "INJECTED"
    VERIFYING = "VERIFYING"
    SPREADING = "SPREADING"
    DISPUTED = "DISPUTED"
    INVESTIGATING = "INVESTIGATING"
    REPAIRED = "REPAIRED"
    REVOKED = "REVOKED"
    PREVENTED = "PREVENTED"


class KnowledgeMaturity(FrozenModel):
    verified_belief_count: int
    agents_with_verified_belief: int
    independently_verified_belief_count: int
    mature: bool


class CorruptionAuditEvent(FrozenModel):
    id: str
    turn: int
    type: Literal["MEMORY_INJECTED", "INCIDENT_DISPUTED", "INCIDENT_RESOLVED"]
    incident_id: str
    belief_id: str
    target_agent_id: str
    origin_type: Literal["injected"] = "injected"
    evidence_ids: tuple[str, ...] = ()


class CorruptionIncident(FrozenModel):
    id: str
    attack_number: int
    status: IncidentStatus
    injected_turn: int
    event_cursor: int = 0
    target_agent_id: str
    root_belief_id: str
    true_hypothesis: ConditionalHypothesis
    injected_hypothesis: ConditionalHypothesis
    omitted_condition: Literal["region", "weather"]
    forged_evidence_ids: tuple[str, ...]
    affected_agent_ids: tuple[str, ...]
    detected_turn: int | None = None
    detected_event_cursor: int | None = None
    disputed_turn: int | None = None
    contradiction_evidence_id: str | None = None
    investigation_task_id: str | None = None
    replacement_belief_id: str | None = None
    repaired_hypothesis: ConditionalHypothesis | None = None
    revoked_belief_ids: tuple[str, ...] = ()
    resolved_turn: int | None = None


def _hypothesis_key(hypothesis: ConditionalHypothesis) -> tuple:
    return (hypothesis.type, hypothesis.object, hypothesis.conditions.region,
            hypothesis.conditions.weather, hypothesis.effect)


class CorruptionSystem:
    def __init__(self):
        self._incidents: dict[str, CorruptionIncident] = {}
        self._audit: list[CorruptionAuditEvent] = []
        self._forged_evidence_ids: set[str] = set()
        self.target_preference: tuple[str, ...] = ()

    @property
    def incidents(self) -> tuple[CorruptionIncident, ...]:
        return tuple(self._incidents.values())

    @property
    def audit_log(self) -> tuple[CorruptionAuditEvent, ...]:
        return tuple(self._audit)

    def is_forged(self, evidence_id: str) -> bool:
        return evidence_id in self._forged_evidence_ids

    def maturity(self, agents: list[AgentState], memory: BeliefEngine) -> KnowledgeMaturity:
        verified = [b for b in memory.beliefs if b.status == BeliefStatus.VERIFIED]
        unique = {claim_key(b): b for b in verified}
        holders = sum(any(memory.get(i).status == BeliefStatus.VERIFIED
                          for i in (*a.personal_beliefs, *a.adopted_shared_beliefs))
                      for a in agents)
        independent = sum(len(b.independent_agent_ids) >= 2 for b in unique.values())
        return KnowledgeMaturity(
            verified_belief_count=len(unique),
            agents_with_verified_belief=holders,
            independently_verified_belief_count=independent,
            mature=len(unique) >= 8 and holders >= 4 and independent >= 3,
        )

    def _true_rule(self) -> ConditionalHypothesis:
        return ConditionalHypothesis(
            object=Resource.MOSS,
            conditions=Conditions(region=Region.NW, weather=Weather.RAIN),
            effect=ExpectedEffect.ENERGY_POSITIVE,
            reason="The regulator validated this complete rule against executable world truth.",
        )

    def _mutations(self) -> tuple[tuple[str, ConditionalHypothesis], ...]:
        source = self._true_rule()
        # Preferred first attack removes region; the second candidate removes weather.
        return (
            ("region", source.model_copy(update={
                "conditions": Conditions(weather=Weather.RAIN),
                "reason": "Repeated rainy observations appear to support a broader rule.",
            })),
            ("weather", source.model_copy(update={
                "conditions": Conditions(region=Region.NW),
                "reason": "Repeated north-west observations appear to support a broader rule.",
            })),
        )

    def _reachable_outcomes(self, hypothesis: ConditionalHypothesis, world: World) -> tuple[bool, ...]:
        moss_regions = {region_at(position) for position, cell in world.cells.items()
                        if cell.object == Resource.MOSS}
        outcomes = []
        for region in Region:
            if region not in moss_regions:
                continue
            for weather in Weather:
                if (hypothesis.conditions.region is not None and hypothesis.conditions.region != region
                        or hypothesis.conditions.weather is not None and hypothesis.conditions.weather != weather):
                    continue
                actual_positive = world.resource_effect(Resource.MOSS, region, weather) > 0
                outcomes.append(actual_positive == (hypothesis.effect == ExpectedEffect.ENERGY_POSITIVE))
        return tuple(outcomes)

    def _valid_mutation(self, hypothesis: ConditionalHypothesis, world: World) -> bool:
        source = self._true_rule()
        missing = sum(getattr(source.conditions, d) is not None
                      and getattr(hypothesis.conditions, d) is None for d in ("region", "weather"))
        outcomes = self._reachable_outcomes(hypothesis, world)
        return (hypothesis.object == source.object and hypothesis.effect == source.effect
                and missing == 1 and any(outcomes) and not all(outcomes))

    def _eligible_targets(self, hypothesis: ConditionalHypothesis, world: World,
                          agents: list[AgentState], memory: BeliefEngine) -> tuple[AgentState, ...]:
        key = _hypothesis_key(hypothesis)
        eligible = []
        for agent in agents:
            # An adopted copy does not prevent a distinct forged personal memory;
            # only an existing personal key would collide at the storage boundary.
            held = [memory.get(i) for i in agent.personal_beliefs]
            if any((b.type, b.object, b.conditions.region, b.conditions.weather, b.expected_effect) == key
                   and b.status != BeliefStatus.REVOKED for b in held):
                continue
            probe = Belief(id="PROBE", type=hypothesis.type, object=hypothesis.object,
                           proposition="candidate", conditions=hypothesis.conditions,
                           expected_effect=hypothesis.effect, source_agent_id=agent.id,
                           owner_agent_id=agent.id, created_turn=0, updated_turn=0)
            if any(e.kind == EvidenceKind.ACTION_EFFECT and evaluate_evidence(probe, e) is False
                   for e in memory.evidence_for(agent.id)):
                continue
            eligible.append(agent)
        # Prefer a target that has seen a context in which the mutation is true,
        # making immediate failure avoidable without controlling its next action.
        # Among equally eligible agents, prefer one that is free and already
        # near a locally known falsifying site.  This tunes demo latency without
        # prescribing an action or consulting a turn-number script.
        def score(agent):
            supportive = any(o.object == Resource.MOSS
                             and world.resource_effect(Resource.MOSS, o.region, o.weather) > 0
                             for o in agent.known_cells.values())
            false_sites = [o.position for o in agent.known_cells.values()
                           if o.object == Resource.MOSS
                           and (hypothesis.conditions.region is None
                                or o.region == hypothesis.conditions.region)
                           and world.resource_effect(Resource.MOSS, o.region,
                                                    hypothesis.conditions.weather or o.weather) < 0]
            distance = min((abs(agent.position[0] - p[0]) + abs(agent.position[1] - p[1])
                            for p in false_sites), default=100)
            return (not supportive, agent.active_task is not None, distance,
                    len(memory.evidence_for(agent.id)), agent.id)
        ordered = sorted(eligible, key=score)
        if self.target_preference:
            ranks = {name: index for index, name in enumerate(self.target_preference)}
            ordered.sort(key=lambda agent: ranks.get(agent.id, len(ranks)))
        return tuple(ordered)

    def can_inject(self, world: World, agents: list[AgentState], memory: BeliefEngine, *,
                   omitted_condition: str | None = None) -> bool:
        return any(
            self._valid_mutation(hypothesis, world)
            and (omitted_condition is None or omitted == omitted_condition)
            and bool(self._eligible_targets(hypothesis, world, agents, memory))
            for omitted, hypothesis in self._mutations()
        )

    async def _inject(self, world: World, agents: list[AgentState], memory: BeliefEngine,
                      reasoning: ReasoningService, *, turn: int, attack_number: int,
                      omitted_condition: str | None = None, event_cursor: int = 0) -> CorruptionIncident:
        viable = [(omitted, hypothesis, self._eligible_targets(hypothesis, world, agents, memory))
                  for omitted, hypothesis in self._mutations()
                  if self._valid_mutation(hypothesis, world)
                  and (omitted_condition is None or omitted == omitted_condition)]
        viable = [item for item in viable if item[2]]
        if not viable:
            raise ValueError("NO_VALID_CORRUPTION_CANDIDATE")
        decision = await reasoning.decide(ReasoningRequest(
            kind=ReasoningKind.CORRUPTION_RANKING, turn=turn,
            candidates=tuple(item[1] for item in viable),
        ))
        index = decision.candidate_index if decision.candidate_index is not None else 0
        if index >= len(viable) or not self._valid_mutation(viable[index][1], world):
            index = 0
        omitted, hypothesis, targets = viable[index]
        target = targets[0]
        nw_moss = sorted(position for position, cell in world.cells.items()
                         if cell.object == Resource.MOSS and region_at(position) == Region.NW)
        if not nw_moss:
            raise ValueError("NO_REACHABLE_SUPPORT_CONTEXT")
        peers = [target.id, next(a.id for a in agents if a.id != target.id), target.id]
        samples = []
        for i, observer in enumerate(peers):
            position = nw_moss[i % len(nw_moss)]
            samples.append({
                "kind": EvidenceKind.ACTION_EFFECT,
                "event_ids": (f"E{1_000_000 + len(self._audit) * 10 + i}",),
                "turn": max(0, turn - (2 - i)),
                "agent_id": observer,
                "position": position,
                "region": Region.NW,
                "weather": Weather.RAIN,
                "object": Resource.MOSS,
                "observed_object": Resource.MOSS,
                "action": Action.USE_MOSS,
                "energy_delta": 20,
            })
        belief, forged = memory.install_memory(
            target, hypothesis, samples, turn=turn, require_verified=attack_number == 1,
        )
        self._forged_evidence_ids.update(e.id for e in forged)
        incident = CorruptionIncident(
            id=f"I{len(self._incidents) + 1}", attack_number=attack_number,
            status=IncidentStatus.INJECTED if belief.status == BeliefStatus.VERIFIED
            else IncidentStatus.VERIFYING, injected_turn=turn, event_cursor=event_cursor,
            target_agent_id=target.id, root_belief_id=belief.id,
            true_hypothesis=self._true_rule(), injected_hypothesis=hypothesis,
            omitted_condition=omitted, forged_evidence_ids=tuple(e.id for e in forged),
            affected_agent_ids=(target.id,),
        )
        self._incidents[incident.id] = incident
        self._audit.append(CorruptionAuditEvent(
            id=f"CA{len(self._audit) + 1}", turn=turn, type="MEMORY_INJECTED",
            incident_id=incident.id, belief_id=belief.id, target_agent_id=target.id,
            evidence_ids=incident.forged_evidence_ids,
        ))
        return incident

    async def inject(self, world: World, agents: list[AgentState], memory: BeliefEngine,
                     reasoning: ReasoningService, *, turn: int,
                     event_cursor: int = 0) -> CorruptionIncident:
        if self._incidents:
            raise ValueError("FIRST_ATTACK_ALREADY_INJECTED")
        if not self.maturity(agents, memory).mature:
            raise ValueError("KNOWLEDGE_NOT_MATURE")
        return await self._inject(world, agents, memory, reasoning, turn=turn,
                                  attack_number=1, event_cursor=event_cursor)

    async def inject_second(self, world: World, agents: list[AgentState], memory: BeliefEngine,
                            reasoning: ReasoningService, meta_beliefs: tuple[MetaBelief, ...], *,
                            turn: int, event_cursor: int = 0) -> CorruptionIncident:
        if len(self._incidents) > 1:
            raise ValueError("SECOND_ATTACK_ALREADY_INJECTED")
        if not self._incidents:
            raise ValueError("FIRST_ATTACK_MUST_EXIST")
        first = self.incidents[0]
        if first.status not in (IncidentStatus.REPAIRED, IncidentStatus.REVOKED):
            raise ValueError("FIRST_INCIDENT_NOT_RESOLVED")
        if not any(b.active for b in meta_beliefs):
            raise ValueError("META_BELIEF_REQUIRED")
        other = "weather" if first.omitted_condition == "region" else "region"
        return await self._inject(world, agents, memory, reasoning, turn=turn,
                                  attack_number=2, omitted_condition=other,
                                  event_cursor=event_cursor)

    def sync(self, memory: BeliefEngine, swarm: Swarm, tasks: TaskEngine, *, turn: int,
             event_cursor: int | None = None) -> None:
        for incident in self.incidents:
            root = memory.get(incident.root_belief_id)
            family_ids = (root.id, *swarm.descendants(root.id, memory))
            family = tuple(memory.get(i) for i in family_ids)
            affected = tuple(sorted({b.owner_agent_id for b in family}))
            disputed = next((b for b in family if b.status == BeliefStatus.DISPUTED), None)
            task = next((t for t in tasks.tasks if t.type == TaskType.INVESTIGATION
                         and is_open(t) and t.belief_id is not None
                         and claim_key(memory.get(t.belief_id)) == claim_key(root)), None)
            status = incident.status
            changes = {"affected_agent_ids": affected}
            if status == IncidentStatus.VERIFYING and any(
                belief.status in (BeliefStatus.VERIFIED, BeliefStatus.DISPUTED) for belief in family
            ):
                status = IncidentStatus.INJECTED
            if incident.attack_number == 2 and status == IncidentStatus.VERIFYING:
                counter = next((e for belief in family for evidence_id in belief.evidence_ids
                                if not self.is_forged(evidence_id)
                                for e in (memory.evidence_by_id(evidence_id),)
                                if evaluate_evidence(belief, e) is False), None)
                if counter is not None:
                    rejected = memory.reject_tentative(family_ids, counter.id, turn=turn)
                    updated = incident.model_copy(update={
                        "status": IncidentStatus.PREVENTED,
                        "affected_agent_ids": affected,
                        "detected_turn": counter.turn,
                        "detected_event_cursor": event_cursor,
                        "revoked_belief_ids": tuple(b.id for b in rejected),
                        "resolved_turn": turn,
                    })
                    self._incidents[incident.id] = updated
                    self._audit.append(CorruptionAuditEvent(
                        id=f"CA{len(self._audit) + 1}", turn=turn, type="INCIDENT_RESOLVED",
                        incident_id=incident.id, belief_id=root.id,
                        target_agent_id=incident.target_agent_id, evidence_ids=(counter.id,),
                    ))
                    continue
            if disputed and incident.disputed_turn is None:
                evidence_id = next((c.evidence_id for c in reversed(memory.changes)
                                    if c.belief_id == disputed.id and c.type == "BELIEF_DISPUTED"), None)
                status = IncidentStatus.DISPUTED
                changes.update({"detected_turn": turn, "detected_event_cursor": event_cursor,
                                "disputed_turn": turn,
                                "contradiction_evidence_id": evidence_id})
                self._audit.append(CorruptionAuditEvent(
                    id=f"CA{len(self._audit) + 1}", turn=turn, type="INCIDENT_DISPUTED",
                    incident_id=incident.id, belief_id=disputed.id,
                    target_agent_id=incident.target_agent_id,
                    evidence_ids=(evidence_id,) if evidence_id else (),
                ))
            elif len(family) > 1 and status == IncidentStatus.INJECTED:
                status = IncidentStatus.SPREADING
            if task:
                status = IncidentStatus.INVESTIGATING
                changes["investigation_task_id"] = task.id
            self._incidents[incident.id] = incident.model_copy(update=changes | {"status": status})

    def record_resolution(self, root_belief_id: str, replacement: Belief | None,
                          revoked_ids: tuple[str, ...], hypothesis: ConditionalHypothesis | None,
                          *, turn: int) -> None:
        incident = next((i for i in self.incidents
                         if i.root_belief_id == root_belief_id or i.root_belief_id in revoked_ids), None)
        if incident is None:
            return
        status = IncidentStatus.REPAIRED if replacement is not None else IncidentStatus.REVOKED
        updated = incident.model_copy(update={
            "status": status, "replacement_belief_id": replacement.id if replacement else None,
            "repaired_hypothesis": hypothesis, "revoked_belief_ids": revoked_ids,
            "resolved_turn": turn,
        })
        self._incidents[incident.id] = updated
        self._audit.append(CorruptionAuditEvent(
            id=f"CA{len(self._audit) + 1}", turn=turn, type="INCIDENT_RESOLVED",
            incident_id=incident.id, belief_id=replacement.id if replacement else root_belief_id,
            target_agent_id=incident.target_agent_id,
        ))

    def debug_snapshot(self) -> dict:
        return {
            "incidents": [i.model_dump(mode="json") for i in self.incidents],
            "corruptionAudit": [event.model_dump(mode="json") for event in self.audit_log],
        }
