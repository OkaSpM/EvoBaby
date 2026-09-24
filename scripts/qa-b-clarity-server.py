"""Serve an isolated B investigation with disposable cards for browser checks."""
import argparse
import asyncio
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import uvicorn
from app.api.b_controller import BSimulationController
from app.b_main import create_b_app


async def run(port, phase):
    with TemporaryDirectory(prefix="evobaby-b-clarity-") as directory:
        controller = BSimulationController(card_directory=Path(directory) / "cards")
        choices = {"D1": "D", "D2": "A", "D3": "D", "D4": "A"}
        while phase != "start" and not controller.game.observation_complete:
            if controller.engine.world.turn > 240:
                raise RuntimeError("Bounded QA preparation did not reach an observation boundary")
            if controller.game.awaiting_choice:
                point = controller.game.awaiting_choice["point"]
                if phase == "unfinished" and point == "D3":
                    controller.game.max_attack_turns = 1
                await controller.choose(point, choices[point])
            else:
                await controller.advance(1)
        if phase == "success":
            for incident in controller.engine.corruption.incidents:
                await controller.accuse_case(incident.id, incident.target_agent_id, incident.root_belief_id)
        print(json.dumps({"port": port, "turn": controller.engine.world.turn,
                          "closure": controller.game.closure(), "cards_directory": directory}, ensure_ascii=False), flush=True)
        application = create_b_app(controller, frontend_dist=ROOT / "frontend-b" / "dist-next")
        await uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", port=port, log_level="warning")).serve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8782)
    parser.add_argument("--phase", choices=("start", "awaiting_trace", "success", "unfinished"), default="awaiting_trace")
    args = parser.parse_args()
    if args.port != 8782:
        parser.error("QA is restricted to port 8782; never mutate the live A or B demo")
    asyncio.run(run(args.port, args.phase))
