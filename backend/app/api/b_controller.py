"""Isolated B controller, snapshots and cards; the A controller is unchanged."""
import asyncio
import json
import os
from pathlib import Path

from app.api.b_trace import BTraceGame
from app.api.controller import SimulationController
from app.api.judge import JudgeProvider
from app.api.models import IncidentEvidenceView
from app.simulation.b_engine import BSimulationEngine
from app.simulation.b_evidence import checked_effects
from app.simulation.b_game import BMergedGame
from app.simulation.belief_engine import evaluate_evidence
from app.simulation.task_engine import claim_key


class BSimulationController(SimulationController):
    def __init__(self, engine=None, card_directory=None):
        self.engine = engine or BSimulationEngine()
        self.running, self.speed = False, 1
        self._operation_lock = asyncio.Lock()
        self._runner = None
        self.game = None
        self._history, self.memorials = {}, []
        self._judged_card = None
        default = Path(__file__).resolve().parents[3] / "data" / "cards-b"
        self._card_directory = Path(card_directory or os.environ.get("EVOBABY_B_CARDS_DIR", default))
        self.cards = {}
        for path in self._card_directory.glob("*.json"):
            try:
                self.cards[path.stem] = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
        self.judge = JudgeProvider({"JUDGE_MODE": "mock"})
        self.trace_game = BTraceGame()
        self._install_game(True)
        self._remember()

    def _install_game(self, optional_choices):
        self.game = BMergedGame(self.engine, optional_choices=optional_choices)
        self.game.review_builder = self._b_review

    def _blocked(self):
        return bool(self.game and (self.game.awaiting_choice or self.game.observation_complete))

    async def start_game(self, seed=None, optional_choices=True):
        self.running = False
        async with self._operation_lock:
            self.engine.reset(seed=self.engine.config.seed if seed is None else seed)
            self.trace_game = BTraceGame()
            self.memorials, self._history, self._judged_card = [], {}, None
            self._install_game(optional_choices)
            self._remember()
            return self._state()

    async def reset(self, seed=None):
        return await self.start_game(seed=seed, optional_choices=True)

    async def choose(self, point, option):
        async with self._operation_lock:
            await self.game.choose(point, option)
            self.trace_game.sync(self.engine)
            if self._blocked():
                self.running = False
            await self._judge_ending()
            self._remember()
            return self._state()

    async def accuse_case(self, incident_id, agent_id, belief_id):
        async with self._operation_lock:
            result = self.trace_game.accuse_case(self.engine, incident_id, agent_id, belief_id)
            if result["correct"] and incident_id not in self.game.confirmed_incidents:
                self.game.confirm_source(incident_id)
                self._judged_card = None
                await self._judge_ending()
            self._remember()
            return result | {"state": self._state()}

    async def accuse(self, agent_id, belief_id):
        if not self.engine.corruption.incidents:
            raise ValueError("NO_ACTIVE_TRACE")
        return await self.accuse_case(self.engine.corruption.incidents[-1].id, agent_id, belief_id)

    async def continue_investigation(self, turns=60):
        if not 1 <= turns <= 100:
            raise ValueError("INVALID_CONTINUATION_BUDGET")
        async with self._operation_lock:
            await self._judge_ending()
            self.game.continue_investigation(turns)
            self.running = False
            self._judged_card = None
            self._remember()
            return self._state()

    def _case(self, incident):
        if not incident.investigation_task_id:
            return None
        root = self.engine.belief_engine.get(incident.root_belief_id)
        for case in self.engine.investigation.cases:
            if case.task_id != incident.investigation_task_id:
                continue
            case_root = self.engine.belief_engine.get(case.root_belief_id)
            task = self.engine.task_engine.get(case.task_id)
            if (root.id == case.root_belief_id or root.id in case.revoked_belief_ids
                    or (task.belief_id == case.disputed_belief_id and claim_key(root) == claim_key(case_root))):
                return case
        return None

    def _b_review(self):
        engine, game = self.engine, self.game
        real = checked_effects(engine.belief_engine.evidence, engine.event_log.events, engine.world.turn)
        cases = []
        for incident in engine.corruption.incidents:
            root = engine.belief_engine.get(incident.root_belief_id)
            case = self._case(incident)
            first = game.first_counterexamples.get(incident.id)
            evidence_ids = tuple(dict.fromkeys((*(case.evidence_ids if case else ()),
                                               *((first["evidence_id"],) if first else ()))))
            samples = []
            for evidence_id in evidence_ids:
                sample = real.get(evidence_id)
                if not sample or evaluate_evidence(root, sample) is None:
                    continue
                samples.append({"id": sample.id, "agent_id": sample.agent_id, "turn": sample.turn,
                                "region": sample.region.value, "weather": sample.weather.value,
                                "outcome": "SUPPORT" if evaluate_evidence(root, sample) else "COUNTEREXAMPLE",
                                "energy_delta": sample.energy_delta, "receipt_verified": True,
                                "event_ids": list(sample.event_ids),
                                "basis": "first-counterexample" if first and evidence_id == first["evidence_id"] else "investigation"})
            cases.append({"incident_id": incident.id, "attack_number": incident.attack_number,
                          "injected_turn": incident.injected_turn,
                          "first_counterexample_turn": first["turn"] if first else None,
                          "detected_turn": incident.detected_turn, "resolved_turn": incident.resolved_turn,
                          "status": incident.status.value, "source_confirmed": incident.id in game.confirmed_incidents,
                          "source_confirmed_turn": (self.trace_game.rounds.get(incident.id, {}).get("result") or {}).get("turn"),
                          "investigation_task_id": incident.investigation_task_id,
                          "evidence": sorted(samples, key=lambda item: (item["turn"], item["id"]))})
        return {"version": 1, "closure": game.closure(), "cognition_feedback": engine.feedback.views(),
                "cases": cases, "protocol_review": game.protocol_review()}

    def _state(self, ground_truth=False):
        state = super()._state(ground_truth)
        real = checked_effects(self.engine.belief_engine.evidence, self.engine.event_log.events,
                               self.engine.world.turn)
        incidents = []
        for view in state.incidents:
            incident = next(item for item in self.engine.corruption.incidents if item.id == view.id)
            case = self._case(incident)
            root = self.engine.belief_engine.get(incident.root_belief_id)
            samples = []
            for evidence_id in case.evidence_ids if case else ():
                sample = real.get(evidence_id)
                if sample and evaluate_evidence(root, sample) is not None:
                    samples.append(IncidentEvidenceView(evidenceId=sample.id, agentId=sample.agent_id,
                                                       region=sample.region, weather=sample.weather,
                                                       outcome="SUPPORT" if evaluate_evidence(root, sample) else "COUNTEREXAMPLE"))
            incidents.append(view.model_copy(update={"evidenceByContext": tuple(samples)}))
        return state.model_copy(update={"incidents": tuple(incidents)})
