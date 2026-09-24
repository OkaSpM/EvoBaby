"""Turn orchestration. Future cognition consumes this real action/evidence stream."""
import random
import asyncio
from dataclasses import replace

from app.config import WorldConfig
from app.schemas import Observation, Resource
from app.llm.provider import ReasoningService
from app.llm.schemas import ReasoningKind, ReasoningRequest, meaningful_action
from app.simulation.memory import EvidenceKind
from app.simulation.agent import AgentState, DecisionPolicy, decision_context
from app.simulation.belief_engine import BeliefEngine
from app.simulation.cognition import CognitionTracker
from app.simulation.coordination import CooperativePolicy
from app.simulation.coordination_models import is_open, matches
from app.simulation.corruption import (
    CorruptionIncident, CorruptionSystem, IncidentStatus, KnowledgeMaturity,
)
from app.simulation.investigation import InvestigationEngine
from app.simulation.meta_engine import MetaBeliefEngine
from app.simulation.metrics import ExperimentMetrics, MetricsEngine
from app.simulation.task_engine import TaskEngine
from app.simulation.swarm import Swarm
from app.simulation.events import EventLog, EventType, RawEvent
from app.simulation.world import World

START_POSITIONS = ((1, 1), (6, 1), (1, 6), (6, 6), (3, 3))


class SimulationEngine:
    def __init__(self, config: WorldConfig | None = None, policy: DecisionPolicy | None = None,
                 reasoning: ReasoningService | None = None):
        self.config = config or WorldConfig()
        self.policy = policy or CooperativePolicy()
        # Explicit legacy policies isolate earlier phases and remain useful in tests.
        self.reasoning = reasoning if reasoning is not None else ReasoningService() if policy is None else None
        self._experimental_reasoning = self.reasoning or ReasoningService()
        self._stepping = False
        self.reset()

    def reset(self, seed: int | None = None):
        if self._stepping:
            raise RuntimeError("Cannot reset during a simulation turn")
        if seed is not None:
            self.config = replace(self.config, seed=seed)
        self.world = World(self.config)
        self.agents = [AgentState(id=f"A{i + 1}", position=p)
                       for i, p in enumerate(START_POSITIONS)]
        self.event_log = EventLog()
        self.belief_engine = BeliefEngine()
        self.task_engine = TaskEngine()
        self.swarm = Swarm()
        self.corruption = CorruptionSystem()
        self.investigation = InvestigationEngine()
        self.meta_belief_engine = MetaBeliefEngine()
        self.metrics_engine = MetricsEngine()
        self.cognition = CognitionTracker(agent.id for agent in self.agents)
        self.merged_game = None
        self._hypothesis_counts = {}
        if self.reasoning is not None:
            self.reasoning.reset()
        if self._experimental_reasoning is not self.reasoning:
            self._experimental_reasoning.reset()
        # Independent streams prevent movement decisions from changing weather RNG.
        self._agent_rngs = {a.id: random.Random(f"{self.config.seed}:{a.id}") for a in self.agents}

    def step(self) -> tuple[RawEvent, ...]:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.step_async())
        raise RuntimeError("Use await step_async() inside an event loop")

    async def step_async(self) -> tuple[RawEvent, ...]:
        if self._stepping:
            raise RuntimeError("A simulation turn is already running")
        self._stepping = True
        try:
            return await self._advance_async()
        finally:
            self._stepping = False

    @property
    def knowledge_maturity(self) -> KnowledgeMaturity:
        return self.corruption.maturity(self.agents, self.belief_engine)

    @property
    def knowledge_mature(self) -> bool:
        return self.knowledge_maturity.mature

    @property
    def first_attack_ready(self) -> bool:
        return (self.knowledge_mature and not self.corruption.incidents
                and self.corruption.can_inject(
                    self.world, self.agents, self.belief_engine,
                ))

    @property
    def second_attack_ready(self) -> bool:
        if not (len(self.corruption.incidents) == 1
                and self.corruption.incidents[0].status in (
                    IncidentStatus.REPAIRED, IncidentStatus.REVOKED,
                )
                and bool(self.meta_belief_engine.active_beliefs)):
            return False
        other = ("weather" if self.corruption.incidents[0].omitted_condition == "region"
                 else "region")
        return self.corruption.can_inject(
            self.world, self.agents, self.belief_engine, omitted_condition=other,
        )

    @property
    def metrics(self) -> ExperimentMetrics:
        return self.metrics_engine.snapshot(
            self.corruption, self.belief_engine, self.swarm, self.event_log,
        )

    def inject_false_memory(self) -> CorruptionIncident:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.inject_false_memory_async())
        raise RuntimeError("Use await inject_false_memory_async() inside an event loop")

    async def inject_false_memory_async(self) -> CorruptionIncident:
        if self._stepping:
            raise RuntimeError("A simulation operation is already running")
        self._stepping = True
        try:
            return await self.corruption.inject(
                self.world, self.agents, self.belief_engine,
                self._experimental_reasoning, turn=self.world.turn,
                event_cursor=len(self.event_log.events),
            )
        finally:
            self._stepping = False

    def inject_second_false_memory(self) -> CorruptionIncident:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.inject_second_false_memory_async())
        raise RuntimeError("Use await inject_second_false_memory_async() inside an event loop")

    async def inject_second_false_memory_async(self) -> CorruptionIncident:
        if self._stepping:
            raise RuntimeError("A simulation operation is already running")
        self._stepping = True
        try:
            return await self.corruption.inject_second(
                self.world, self.agents, self.belief_engine, self._experimental_reasoning,
                self.meta_belief_engine.active_beliefs, turn=self.world.turn,
                event_cursor=len(self.event_log.events),
            )
        finally:
            self._stepping = False

    async def _update_meta_beliefs(self):
        if self.merged_game is not None:
            return None
        learned = await self.meta_belief_engine.advance(
            self.corruption, self.investigation, self.belief_engine,
            self._experimental_reasoning, turn=self.world.turn,
        )
        if learned is not None:
            self.belief_engine.activate_meta_beliefs(
                self.meta_belief_engine.active_beliefs, turn=self.world.turn,
            )
        return learned

    async def _advance_async(self) -> tuple[RawEvent, ...]:
        self.world.advance()
        self.task_engine.sync(self.agents, self.belief_engine, self.world.turn)
        self.swarm.publish_tasks(self.task_engine, self.belief_engine, self.world.turn)
        emitted: list[RawEvent] = []
        decisions = []
        available = []
        claims = []
        claim_requests = []
        # Observe and decide before any agent changes resources this turn.
        for agent in self.agents:
            agent.current_action = None
            resting = agent.unavailable_until_turn is not None
            if not self.world.reactivate(agent):
                continue
            observation = self.world.observe(agent)
            if resting:
                emitted.append(self.event_log.append(EventType.REACTIVATED, self.world.turn,
                                                     agent.id, observation))
            agent.known_cells[agent.position] = observation
            emitted.append(self.event_log.append(EventType.OBSERVATION, self.world.turn,
                                                 agent.id, observation))
            available.append((agent, observation))
            if self.reasoning is not None:
                context = self._context(agent, observation)
                if context.active_task is None and any(
                    agent.id not in r.independent_of and r.id not in t.completed_context_ids
                    and not any(c.context_id == r.id for c in t.claimed_contexts)
                    for t in context.open_tasks for r in t.required_contexts
                ):
                    claim_requests.append(ReasoningRequest(kind=ReasoningKind.TASK_CLAIM_REASONING,
                                                          turn=self.world.turn, agent_id=agent.id, context=context))
            elif hasattr(self.policy, "choose_task"):
                intent = self.policy.choose_task(self._context(agent, observation))
                if intent is not None:
                    claims.append((agent, intent))
        if claim_requests:
            outputs = await self.reasoning.decide_many(claim_requests)
            by_id = {a.id: a for a in self.agents}
            claims.extend((by_id[r.agent_id], o.claim) for r, o in zip(claim_requests, outputs) if o.claim)
        for agent, intent in claims:
            self.task_engine.claim(agent, intent, self.world.turn)
        action_requests = []
        selected = {}
        for agent, observation in available:
            context = self._context(agent, observation)
            if self.reasoning is not None and meaningful_action(context):
                action_requests.append(ReasoningRequest(kind=ReasoningKind.ACTION_REASONING, turn=self.world.turn,
                                                       agent_id=agent.id, context=context))
            else:
                selected[agent.id] = self.policy.choose_action(context, self._agent_rngs[agent.id])
        if action_requests:
            outputs = await self.reasoning.decide_many(action_requests,
                                                       [self._agent_rngs[r.agent_id] for r in action_requests])
            selected.update({r.agent_id: o.action for r, o in zip(action_requests, outputs)})
        decisions = [(agent, selected[agent.id]) for agent, _ in available]
        # Stable A1..A5 ordering resolves simultaneous attempts on one resource.
        for agent, action in decisions:
            if self.merged_game is not None:
                action = self.merged_game.filter_action(agent, action)
            result = self.world.execute(agent, action)
            agent.current_action = result.action
            observation = self.world.observe(agent)
            event = self.event_log.append(EventType.ACTION_EXECUTED, self.world.turn,
                                          agent.id, observation, result)
            emitted.append(event)
            agent.remember(event.event_id, result)
            if result.returned_to_base:
                # Preserve the action-site observation before recording the Base.
                site = Observation(position=result.position, region=result.region,
                                   weather=result.weather,
                                   object=self.world.cells[result.position].object,
                                   energy=result.energy_after)
                agent.known_cells[result.position] = site
                emitted.append(self.event_log.append(EventType.OBSERVATION, self.world.turn,
                                                     agent.id, site))
            agent.known_cells[agent.position] = observation
            emitted.append(self.event_log.append(EventType.OBSERVATION, self.world.turn,
                                                 agent.id, observation))
            if result.returned_to_base:
                emitted.append(self.event_log.append(EventType.RETURNED_TO_BASE, self.world.turn,
                                                     agent.id, observation))
        self.belief_engine.consume(emitted, self.agents)
        if self.reasoning is not None:
            await self._generate_hypotheses()
        self.task_engine.sync(self.agents, self.belief_engine, self.world.turn)
        self.swarm.publish_tasks(self.task_engine, self.belief_engine, self.world.turn)
        if hasattr(self.policy, "choose_messages"):
            for agent in self.agents:
                if agent.unavailable_until_turn is not None:
                    continue
                for intent in self.policy.choose_messages(self._context(agent, self.world.observe(agent))):
                    self.swarm.dispatch(agent, intent, self.agents, self.belief_engine,
                                        self.task_engine, self.world.turn)
        self.task_engine.sync(self.agents, self.belief_engine, self.world.turn)
        self.swarm.publish_tasks(self.task_engine, self.belief_engine, self.world.turn)
        self.corruption.sync(self.belief_engine, self.swarm, self.task_engine, turn=self.world.turn,
                             event_cursor=len(self.event_log.events))
        await self.investigation.advance(
            self.agents, self.belief_engine, self.task_engine, self.swarm,
            self.corruption, self._experimental_reasoning, turn=self.world.turn,
        )
        self.task_engine.sync(self.agents, self.belief_engine, self.world.turn)
        self.swarm.publish_tasks(self.task_engine, self.belief_engine, self.world.turn)
        self.corruption.sync(self.belief_engine, self.swarm, self.task_engine, turn=self.world.turn,
                             event_cursor=len(self.event_log.events))
        learned = await self._update_meta_beliefs()
        if learned is not None:
            self.task_engine.sync(self.agents, self.belief_engine, self.world.turn)
            self.swarm.publish_tasks(self.task_engine, self.belief_engine, self.world.turn)
        self.cognition.observe(self.agents, self.belief_engine, self.swarm,
                               self.investigation, self.event_log.events, self.world.turn)
        return tuple(emitted)

    async def _generate_hypotheses(self):
        requests = []
        for agent in self.agents:
            for resource in Resource:
                evidence = tuple(e for e in self.belief_engine.evidence_for(agent.id)
                                 if e.kind == EvidenceKind.ACTION_EFFECT and e.object == resource and e.energy_delta)
                key = (agent.id, resource)
                if len(evidence) - self._hypothesis_counts.get(key, 0) < 2:
                    continue
                self._hypothesis_counts[key] = len(evidence)
                requests.append(ReasoningRequest(kind=ReasoningKind.HYPOTHESIS_GENERATION, turn=self.world.turn,
                                                  agent_id=agent.id, object=resource, evidence=evidence))
        if requests:
            outputs = await self.reasoning.decide_many(requests)
            owners = {a.id: a for a in self.agents}
            for request, output in zip(requests, outputs):
                if output.hypothesis:
                    self.belief_engine.propose_conditional(owners[request.agent_id], output.hypothesis,
                                                          turn=self.world.turn)

    def _context(self, agent, observation):
        personal, shared = self.belief_engine.memories_for(agent)
        # Forged corroboration exists only inside the target's planted memory.
        # Other named agents must not receive synthetic "own experience" in
        # their local reasoning context.
        target_forged = {evidence_id for incident in self.corruption.incidents
                         if incident.target_agent_id == agent.id
                         for evidence_id in incident.forged_evidence_ids}
        evidence = tuple(e for e in self.belief_engine.evidence_for(agent.id)
                         if not self.corruption.is_forged(e.id) or e.id in target_forged)
        requirements = [r for t in self.task_engine.tasks if is_open(t) for r in t.required_contexts]
        relevant = tuple(e for e in evidence if e in evidence[-24:]
                         or any(matches(r, e) for r in requirements))
        return decision_context(agent, observation, self.belief_engine.uncertainty_targets(agent),
                                personal_beliefs=personal, adopted_shared_beliefs=shared,
                                relevant_evidence=relevant,
                                active_meta_beliefs=self.meta_belief_engine.active_beliefs,
                                open_tasks=tuple(t for t in self.task_engine.tasks if is_open(t)),
                                active_task=self.task_engine.get(agent.active_task) if agent.active_task else None,
                                verification_requests=self.swarm.requests(self.task_engine))

    def debug_snapshot(self) -> dict:
        """Privileged, JSON-compatible export; never a decision input."""
        return {"world": self.world.debug_snapshot(), "memory": self.belief_engine.debug_snapshot(),
                "reasoning": [r.model_dump(mode="json") for r in self.reasoning.records] if self.reasoning else [],
                **self.task_engine.debug_snapshot(), **self.swarm.debug_snapshot(self.belief_engine),
                "knowledgeMaturity": self.knowledge_maturity.model_dump(mode="json"),
                **self.investigation.debug_snapshot(), **self.corruption.debug_snapshot(),
                **self.meta_belief_engine.debug_snapshot(),
                "metrics": self.metrics.model_dump(mode="json"),
                "agents": [a.model_dump(mode="json", exclude={"known_cells"}) |
                           {"known_cells": [a.known_cells[p].model_dump(mode="json")
                                            for p in sorted(a.known_cells)]} for a in self.agents],
                "events": [e.model_dump(mode="json") for e in self.event_log.events]}
