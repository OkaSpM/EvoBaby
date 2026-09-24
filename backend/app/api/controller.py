"""Concurrency-safe lifecycle and public projections around SimulationEngine."""
import asyncio
import hashlib
import json
from pathlib import Path
from contextlib import suppress

from app.config import BASE
from app.api.trace import TraceGame, belief_trace
from app.api.judge import JudgeProvider
from app.schemas import Resource
from app.simulation.coordination_models import is_open
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.engine import SimulationEngine
from app.simulation.memory import BeliefStatus
from app.simulation.world import region_at
from app.api.models import (
    AgentDetail, AgentSummary, EventsResponse, ExportResponse, GlobalMetrics,
    IncidentEvidenceView, IncidentView, LineageEdgeView, SimulationStatus,
    StateResponse, WorldCellView, WorldView,
)


class SimulationController:
    def __init__(self, engine: SimulationEngine | None = None):
        self.engine = engine or SimulationEngine()
        self.running = False
        self.speed = 1
        self._operation_lock = asyncio.Lock()
        self._runner: asyncio.Task | None = None
        self.game = None
        self.trace_game = TraceGame()
        self.judge = JudgeProvider()
        self._history: dict[int, StateResponse] = {}
        self.memorials = []
        self.cards = {}
        self._card_directory = Path(__file__).resolve().parents[3] / "data" / "cards"
        for path in self._card_directory.glob("*.json"):
            try:
                self.cards[path.stem] = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
        self._judged_card = None

    def _blocked(self):
        fields = self.game.state_fields() if self.game else {}
        return bool(fields.get("awaiting_choice") or fields.get("paradigm"))

    async def _step_locked(self):
        if self._blocked():
            self.running = False
            return
        await self.engine.step_async()
        if self.game:
            await self.game.after_step()
            self.trace_game.sync(self.engine)
            if self._blocked():
                self.running = False
            await self._judge_ending()
        self._remember()

    def _remember(self):
        if self.game:
            self._history[self.engine.world.turn] = self._state().model_copy(deep=True)

    async def _judge_ending(self):
        paradigm = self.game.paradigm() if self.game else None
        if not paradigm:
            return
        key = hashlib.sha256(json.dumps(paradigm, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
        if key not in self.cards:
            self.cards[key] = paradigm.copy() | {"id": key}
            self._card_directory.mkdir(parents=True, exist_ok=True)
            (self._card_directory / f"{key}.json").write_text(json.dumps(self.cards[key], ensure_ascii=False, indent=2))
        if self._judged_card is None:
            choices = ["慎信部落", "敲锣部落", "走远部落", "胆小部落", "健忘部落", "糊涂部落"]
            name = paradigm.get("name", "糊涂部落")
            self._judged_card = await self.judge.judge("这组实际指标最符合哪种部落？", paradigm.get("metrics", {}), choices, name)

    async def start_game(self, seed=None, optional_choices=True):
        from app.simulation.merged_game import MergedGame
        self.running = False
        async with self._operation_lock:
            self.engine.reset(seed=self.engine.config.seed if seed is None else seed)
            self.game = MergedGame(self.engine, optional_choices=optional_choices)
            self.trace_game = TraceGame()
            self.memorials = []
            self._history = {}
            self._judged_card = None
            self._remember()
            return self._state()

    async def advance(self, turns):
        self.running = False
        async with self._operation_lock:
            for _ in range(turns):
                if self._blocked():
                    break
                await self._step_locked()
            return self._state()

    async def choose(self, point, option):
        async with self._operation_lock:
            if not self.game:
                raise ValueError("GAME_NOT_STARTED")
            await self.game.choose(point, option)
            self.trace_game.sync(self.engine)
            self._remember()
            return self._state()

    async def replay(self, turn):
        async with self._operation_lock:
            if turn not in self._history:
                raise KeyError(turn)
            result = self._history[turn].model_copy(deep=True)
            result.simulation.running = False
            return result

    async def trace(self, belief_id):
        async with self._operation_lock:
            return belief_trace(self.engine, belief_id)

    async def accuse(self, agent_id, belief_id):
        async with self._operation_lock:
            result = self.trace_game.accuse(self.engine, agent_id, belief_id)
            return result | {"state": self._state()}

    async def paradigm(self):
        async with self._operation_lock:
            if not self.game or not self.game.paradigm():
                return None
            value = self.game.paradigm().copy()
            key = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
            return value | {"id": key, "judge": self._judged_card}

    async def remove_agent(self, agent_id):
        async with self._operation_lock:
            agent = next((item for item in self.engine.agents if item.id == agent_id), None)
            if agent is None:
                raise KeyError(agent_id)
            if not self.game:
                raise ValueError("GAME_NOT_STARTED")
            if any(item["agent_id"] == agent_id for item in self.memorials):
                return self._state()
            taught = {b.id for b in self.engine.belief_engine.beliefs
                      if b.source_agent_id == agent_id and b.origin.value == "PERSONAL"}
            self.memorials.append({"agent_id": agent_id, "turn": self.engine.world.turn,
                                   "taught_count": len(taught), "belief_ids": sorted(taught)})
            agent.unavailable_until_turn = 2_147_483_647
            self.engine.cognition.remove(agent_id)
            self.engine.task_engine.release(agent, self.engine.world.turn)
            agent.active_task = None
            self._remember()
            return self._state()

    async def set_broadcast(self, enabled):
        async with self._operation_lock:
            if not self.game:
                raise ValueError("GAME_NOT_STARTED")
            self.engine.swarm.broadcast_enabled = enabled
            self._remember()
            return self._state()

    async def step(self) -> StateResponse:
        async with self._operation_lock:
            await self._step_locked()
            return self._state()

    async def run(self, speed: int) -> StateResponse:
        self.speed = speed
        self.running = not self._blocked()
        if self._runner is None or self._runner.done():
            self._runner = asyncio.create_task(self._run_loop())
        async with self._operation_lock:
            return self._state()

    async def pause(self) -> StateResponse:
        self.running = False
        async with self._operation_lock:
            return self._state()

    async def reset(self, seed: int | None = None) -> StateResponse:
        self.running = False
        async with self._operation_lock:
            self.engine.reset(seed=seed)
            if self.game:
                from app.simulation.merged_game import MergedGame
                self.game = MergedGame(self.engine, optional_choices=True)
                self.trace_game = TraceGame()
                self.memorials, self._history = [], {}
                self._judged_card = None
                self._remember()
            return self._state()

    async def inject(self, second: bool = False, target_policy=None) -> StateResponse:
        async with self._operation_lock:
            if self.game and (self.game.state_fields().get("awaiting_choice") or {}).get("point") == "D1":
                option = {"most_active": "A", "isolated": "B", "random": "C", "regulator": "D"}.get(target_policy, target_policy or "D")
                await self.game.choose("D1", option)
                self.trace_game.sync(self.engine)
                self._remember()
                return self._state()
            if second:
                await self.engine.inject_second_false_memory_async()
            else:
                await self.engine.inject_false_memory_async()
            return self._state()

    async def state(self, ground_truth=False) -> StateResponse:
        async with self._operation_lock:
            return self._state(ground_truth=ground_truth)

    async def agent(self, agent_id: str) -> AgentDetail:
        async with self._operation_lock:
            agent = next((item for item in self.engine.agents if item.id == agent_id), None)
            if agent is None:
                raise KeyError(agent_id)
            personal, shared = self.engine.belief_engine.memories_for(agent)
            known = tuple(self._cell(position, observation.object)
                          for position, observation in sorted(agent.known_cells.items()))
            events = tuple(event for event in self.engine.event_log.events
                           if event.agent_id == agent.id)
            return AgentDetail(
                agent=self._agent_summary(agent), knownCells=known,
                personalBeliefs=personal, adoptedSharedBeliefs=shared,
                evidence=self.engine.belief_engine.evidence_for(agent.id),
                recentEvents=events[-100:],
            )

    async def events(self) -> EventsResponse:
        async with self._operation_lock:
            return EventsResponse(events=self.engine.event_log.events)

    async def export(self) -> ExportResponse:
        async with self._operation_lock:
            state = self._state()
            memory = self.engine.belief_engine
            truth = self.engine.world.debug_snapshot() | {
                "mossRule": {
                    "object": Resource.MOSS.value,
                    "positiveWhen": {"region": "NW", "weather": "Rain"},
                    "positiveEnergyDelta": 20,
                    "otherEnergyDelta": -8,
                },
                "incidents": [item.model_dump(mode="json")
                              for item in self.engine.corruption.incidents],
            }
            reasoning = tuple(self.engine.reasoning.records) if self.engine.reasoning else ()
            return ExportResponse(
                state=state, evidence=memory.evidence, beliefs=memory.beliefs,
                beliefChanges=memory.changes, taskChanges=self.engine.task_engine.changes,
                messages=self.engine.swarm.messages,
                investigations=self.engine.investigation.cases,
                corruptionAudit=self.engine.corruption.audit_log,
                reasoning=reasoning, rawEvents=self.engine.event_log.events,
                groundTruth=truth,
            )

    async def shutdown(self) -> None:
        self.running = False
        if self._runner is not None and not self._runner.done():
            self._runner.cancel()
            with suppress(asyncio.CancelledError):
                await self._runner

    async def _run_loop(self) -> None:
        try:
            while self.running:
                async with self._operation_lock:
                    if self.running:
                        await self._step_locked()
                await asyncio.sleep(1 / self.speed)
        except asyncio.CancelledError:
            raise
        finally:
            self.running = False

    def _cell(self, position, object_=None, *, known=True):
        return WorldCellView(position=position, region=region_at(position),
                             known=known, object=object_ if known else None)

    def _agent_summary(self, agent) -> AgentSummary:
        beliefs = [self.engine.belief_engine.get(belief_id)
                   for belief_id in (*agent.personal_beliefs, *agent.adopted_shared_beliefs)]
        appearance = None
        if self.game:
            own = [event for event in self.engine.event_log.events if event.agent_id == agent.id and event.result]
            hurt = [event.turn for event in own if event.result.action.value == "USE_MOSS" and (event.result.resource_effect or 0) < 0]
            adopted = {b.owner_agent_id + ":" + b.lineage.parent_belief_id
                       for b in self.engine.belief_engine.beliefs if b.lineage and b.lineage.sender_agent_id == agent.id}
            appearance = {"hasBerry": any(e.result.action.value == "USE_BERRY" or e.result.action.value == "COLLECT" and e.result.object == Resource.BERRY for e in own),
                          "hasCrystal": any(e.result.action.value == "COLLECT" and e.result.object == Resource.CRYSTAL for e in own),
                          "ruffledUntilTurn": max(hurt, default=-10) + 3,
                          "reputation": min(8, len(adopted))}
        return AgentSummary(
            id=agent.id, energy=agent.energy, position=agent.position,
            region=region_at(agent.position), inventory=dict(agent.inventory),
            personalBeliefCount=len(agent.personal_beliefs),
            sharedBeliefCount=len(agent.adopted_shared_beliefs),
            verifiedBeliefCount=sum(item.status == BeliefStatus.VERIFIED for item in beliefs),
            currentAction=agent.current_action, currentTaskId=agent.active_task,
            unavailableUntilTurn=agent.unavailable_until_turn,
            appearance=appearance,
            removed=any(item["agent_id"] == agent.id for item in self.memorials) if self.game else None,
            cognition=self.engine.cognition.view(agent.id),
        )

    def _state(self, ground_truth=False) -> StateResponse:
        engine = self.engine
        known_objects = {}
        for agent in engine.agents:
            for position, observation in agent.known_cells.items():
                known_objects[position] = observation.object
        world = WorldView(
            base=BASE, weather=engine.world.weather,
            cells=tuple(self._cell(position, known_objects.get(position), known=position in known_objects)
                        for position in sorted(engine.world.cells)),
        )
        collective = engine.swarm.collective_knowledge(engine.belief_engine)
        incident_views = []
        for item in engine.corruption.incidents:
            root = engine.belief_engine.get(item.root_belief_id)
            descendants = engine.swarm.descendants(root.id, engine.belief_engine)
            case = next((case for case in engine.investigation.cases
                         if case.root_belief_id == root.id), None)
            task = (engine.task_engine.get(item.investigation_task_id)
                    if item.investigation_task_id else None)
            evidence = tuple(IncidentEvidenceView(
                evidenceId=e.id, agentId=e.agent_id, region=e.region, weather=e.weather,
                outcome="SUPPORT" if evaluate_evidence(root, e) is True else "COUNTEREXAMPLE",
            ) for evidence_id in (case.evidence_ids if case else ())
              for e in (engine.belief_engine.evidence_by_id(evidence_id),)
              if evaluate_evidence(root, e) is not None)
            lineage = tuple(LineageEdgeView(
                parentBeliefId=belief.lineage.parent_belief_id,
                childBeliefId=belief.id, senderAgentId=belief.lineage.sender_agent_id,
                receiverAgentId=belief.lineage.receiver_agent_id,
            ) for belief_id in descendants
              for belief in (engine.belief_engine.get(belief_id),)
              if belief.lineage is not None)
            incident_views.append(IncidentView(
                id=item.id, attackNumber=item.attack_number, status=item.status,
                injectedTurn=item.injected_turn, targetAgentId=item.target_agent_id,
                rootBeliefId=item.root_belief_id, omittedCondition=item.omitted_condition,
                affectedAgentIds=item.affected_agent_ids, detectedTurn=item.detected_turn,
                disputedTurn=item.disputed_turn, investigationTaskId=item.investigation_task_id,
                replacementBeliefId=item.replacement_belief_id,
                revokedBeliefIds=item.revoked_belief_ids, resolvedTurn=item.resolved_turn,
                verificationRequestCount=len(task.required_contexts) if task else 0,
                evidenceByContext=evidence, lineage=lineage,
            ))
        incidents = tuple(incident_views)
        open_tasks = tuple(task for task in engine.task_engine.tasks if is_open(task))
        explored = len(known_objects)
        simulation = SimulationStatus(
            running=self.running, speed=self.speed, turn=engine.world.turn,
            seed=engine.config.seed,
            canInjectFirst=engine.first_attack_ready,
            canInjectSecond=engine.second_attack_ready,
        )
        metrics = GlobalMetrics(
            averageEnergy=sum(agent.energy for agent in engine.agents) / len(engine.agents),
            exploredCellPercent=100 * explored / len(engine.world.cells),
            verifiedCollectiveBeliefs=sum(b.status == BeliefStatus.VERIFIED for b in collective),
            openTasks=len(open_tasks), knowledgeMature=engine.knowledge_mature,
            attacks=engine.metrics,
        )
        extras = {}
        if self.game:
            extras = self.game.state_fields().copy()
            extras = {key: value for key, value in extras.items() if key in StateResponse.model_fields}
            if extras.get("paradigm"):
                card = extras["paradigm"]
                key = hashlib.sha256(json.dumps(card, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
                extras["paradigm"] = card.copy() | {"id": key, "judge": self._judged_card}
            extras.update({"trace_game": self.trace_game.view(engine), "judge_online": self.judge.online,
                           "broadcast_enabled": getattr(engine.swarm, "broadcast_enabled", True),
                           "memorials": self.memorials,
                           "story_events": [{"id": message.id, "turn": message.turn, "kind": message.type.value,
                                             "agent_id": message.from_agent, "belief_id": message.belief_id,
                                             "content": message.belief.proposition if message.belief else message.type.value}
                                            for message in engine.swarm.messages[-60:]]})
            if not ground_truth:
                revealed = {key for key, run in self.trace_game.rounds.items() if (run.get("result") or {}).get("correct")}
                incidents = tuple(item if item.id in revealed else item.model_copy(update={
                    "targetAgentId": None, "rootBeliefId": None, "omittedCondition": None,
                    "affectedAgentIds": (), "lineage": (), "revokedBeliefIds": (),
                    "replacementBeliefId": None,
                }) for item in incidents)
        return StateResponse(
            simulation=simulation, world=world,
            agents=tuple(self._agent_summary(agent) for agent in engine.agents),
            tasks=engine.task_engine.tasks, collectiveKnowledge=collective,
            metaBeliefs=engine.meta_belief_engine.beliefs, incidents=incidents,
            metrics=metrics, recentEvents=engine.event_log.events[-100:],
            **extras,
        )
