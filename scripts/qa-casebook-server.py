"""Serve a completed, isolated two-case run for local B interface verification."""
import argparse
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import uvicorn
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.controller import SimulationController
from app.api.judge import JudgeProvider
from app.api.routes import router
from app.config import LLMConfig, WorldConfig
from app.llm.provider import ReasoningService
from app.simulation.engine import SimulationEngine


async def prepare(controller):
    await controller.start_game(seed=42, optional_choices=True)
    choices = {"D1": "D", "D2": "A", "D3": "A", "D4": "A"}
    first_confirmed = False
    for _ in range(16):
        state = await controller.advance(100)
        point = (state.awaiting_choice or {}).get("point")
        if point:
            if point == "D3":
                first = controller.engine.corruption.incidents[0]
                assert first.status.value == "REPAIRED", "QA path must actually repair the first case"
                result = await controller.accuse(first.target_agent_id, first.root_belief_id)
                assert result["correct"] is True
                first_confirmed = True
            await controller.choose(point, choices[point])
        elif state.paradigm:
            assert first_confirmed, "First case must be accused before the second case starts"
            second = controller.engine.corruption.incidents[-1]
            assert second.attack_number == 2
            assert second.status.value in ("PREVENTED", "REPAIRED", "REVOKED")
            result = await controller.accuse(second.target_agent_id, second.root_belief_id)
            assert result["correct"] is True
            await controller.pause()
            return
    raise RuntimeError("QA route did not complete within the bounded preparation window")


async def summary(controller):
    state = (await controller.state()).model_dump(mode="json")
    rounds = state["trace_game"]["rounds"]
    return {
        "pid": os.getpid(),
        "turn": state["simulation"]["turn"],
        "seed": state["simulation"]["seed"],
        "running": state["simulation"]["running"],
        "choices": state["choices"],
        "ending": state["paradigm"]["name"] if state["paradigm"] else None,
        "cards_directory": str(controller._card_directory),
        "cases": [{
            "id": incident["id"],
            "status": incident["status"],
            "injected_turn": incident["injectedTurn"],
            "resolved_turn": incident["resolvedTurn"],
            "root_belief_id": incident["rootBeliefId"],
            "target_agent_id": incident["targetAgentId"],
            "replacement_belief_id": incident["replacementBeliefId"],
            "evidence_count": len(incident["evidenceByContext"]),
            "lineage_count": len(incident["lineage"]),
            "confirmed": any(item["incident_id"] == incident["id"] and
                             (item["result"] or {}).get("correct") is True for item in rounds),
        } for incident in state["incidents"]],
    }


def create_qa_app(frontend_dist=None):
    dist = Path(frontend_dist).resolve() if frontend_dist else ROOT / "frontend-b" / "dist"
    if not (dist / "index.html").is_file():
        raise RuntimeError("Build B before starting the QA server")

    @asynccontextmanager
    async def lifespan(application):
        with TemporaryDirectory(prefix="evobaby-casebook-qa-") as temporary:
            engine = SimulationEngine(WorldConfig(seed=42), reasoning=ReasoningService(LLMConfig(mode="mock")))
            controller = SimulationController(engine)
            controller._card_directory = Path(temporary) / "cards"
            controller.cards = {}
            controller.judge = JudgeProvider({"JUDGE_MODE": "mock"})
            application.state.controller = controller
            try:
                await prepare(controller)
                print("QA_READY " + json.dumps(await summary(controller), ensure_ascii=False), flush=True)
                yield
            finally:
                await controller.shutdown()

    application = FastAPI(title="Isolated EvoBaby B Casebook QA", lifespan=lifespan)
    application.include_router(router)

    @application.get("/qa/status", include_in_schema=False)
    async def qa_status():
        return await summary(application.state.controller)

    @application.get("/", include_in_schema=False)
    @application.get("/b", include_in_schema=False)
    async def open_b():
        return RedirectResponse("/b/")

    application.mount("/b", StaticFiles(directory=dist, html=True), name="qa-frontend-b")
    return application


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8782)
    parser.add_argument("--frontend-dist", type=Path, help="Isolated B build to verify without replacing the live frontend")
    args = parser.parse_args()
    if args.port == 8781:
        parser.error("Port 8781 is reserved for the user's live game")
    uvicorn.run(create_qa_app(args.frontend_dist), host="127.0.0.1", port=args.port, access_log=False)
