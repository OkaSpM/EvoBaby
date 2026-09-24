#!/usr/bin/env python3
"""Check four representative B closure paths, or all sixteen with --full."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import sys
from tempfile import TemporaryDirectory
import time
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.api.b_controller import BSimulationController  # noqa: E402
from app.simulation.corruption import IncidentStatus  # noqa: E402


def reject_network(*_args, **_kwargs):
    raise AssertionError("B closure matrix must not open a network connection")


def snapshot(controller):
    review = controller._b_review()
    return {
        "turn": controller.engine.world.turn,
        "closure": review["closure"],
        "cases": [{key: value for key, value in case.items() if key != "evidence"}
                  for case in review["cases"]],
        "card_ids": sorted(controller.cards),
        "active_card_outcome": (controller.game.paradigm() or {}).get("b_outcome"),
    }


def assert_honest_outcome(controller, *, confirmed):
    cases = controller.engine.corruption.incidents
    repaired = len(cases) == 2 and all(case.status == IncidentStatus.REPAIRED for case in cases)
    closure = controller.game.closure()
    assert (closure["status"] == "success") == (repaired and confirmed), closure
    paradigm = controller.game.paradigm()
    if repaired and not confirmed:
        assert closure["status"] == "awaiting_trace", closure
        assert paradigm is None, "Unconfirmed repaired cases must not generate a success card"
    if paradigm:
        assert (paradigm["b_outcome"]["status"] == "success") == (repaired and confirmed)


async def advance_until_complete(controller, choices, limit):
    actions = 0
    while controller.engine.world.turn < limit and not controller.game.observation_complete:
        if controller.game.awaiting_choice:
            point = controller.game.awaiting_choice["point"]
            await controller.choose(point, choices[point])
        else:
            before = controller.engine.world.turn
            await controller.advance(1)
            assert controller.engine.world.turn > before, "Unexpected simulation lock before observation end"
        actions += 1
        assert actions <= limit + 10, "Choice loop failed to advance"
    assert controller.game.observation_complete, f"No observation ending by turn {limit}"
    assert controller.engine.world.turn <= limit


async def check_route(d2, d3, seed):
    choices = {"D1": "D", "D2": d2, "D3": d3, "D4": "A"}
    result = {"route": f"{d2}{d3}", "seed": seed, "choices": choices}
    started = time.perf_counter()
    with TemporaryDirectory(prefix=f"evobaby-b-matrix-{d2}{d3}-") as temporary:
        controller = BSimulationController(card_directory=Path(temporary) / "cards")
        try:
            await controller.start_game(seed=seed)
            await advance_until_complete(controller, choices, 240)
            assert len(controller.engine.corruption.incidents) == 2
            assert_honest_outcome(controller, confirmed=False)
            result["observation"] = snapshot(controller)

            # Internal truth is used only by this QA harness to test the public gate.
            accusations = []
            for case in tuple(controller.engine.corruption.incidents):
                accusation = await controller.accuse_case(case.id, case.target_agent_id, case.root_belief_id)
                assert accusation["correct"] is True
                assert accusation["turn"] == controller.engine.world.turn
                accusations.append({"incident_id": case.id, "correct": True, "turn": accusation["turn"]})
            assert_honest_outcome(controller, confirmed=True)
            result["qa_accusations"] = accusations
            result["after_confirmation"] = snapshot(controller)

            if controller.game.closure()["can_continue"]:
                start = controller.engine.world.turn
                prior = {key: json.dumps(value, sort_keys=True) for key, value in controller.cards.items()}
                await controller.continue_investigation(60)
                assert controller.game.closure()["status"] == "playing"
                assert not controller.game.observation_complete
                assert controller.game.paradigm() is None
                await advance_until_complete(controller, choices, start + 60)
                assert start < controller.engine.world.turn <= start + 60
                for key, frozen in prior.items():
                    assert json.dumps(controller.cards[key], sort_keys=True) == frozen, "Historical card mutated"
                assert_honest_outcome(controller, confirmed=True)
                result["continuation"] = {
                    "budget": 60, "advanced_turns": controller.engine.world.turn - start,
                    "historical_cards_preserved": True, "final": snapshot(controller),
                }
            else:
                result["continuation"] = None
            result["passed"] = True
        except Exception as error:
            result["passed"] = False
            result["error"] = f"{type(error).__name__}: {error}"
            result["failure_state"] = snapshot(controller)
        finally:
            await controller.shutdown()
    result["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    return result


async def main(args):
    started = time.perf_counter()
    selected = [d2 + d3 for d2 in "ABCD" for d3 in "ABCD"] if args.full else ["AA", "AB", "CD", "DD"]
    rows = []
    if args.resume and args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        if previous.get("seed") != args.seed:
            raise ValueError("Cannot resume a different seed")
        rows = [row for row in previous.get("routes", []) if row.get("passed")]

    def save():
        complete = {row["route"] for row in rows}
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "edition": "B-collaboration-v4",
            "method": "Actual D2 x D3 paths; D1=D/D4=A; bounded 240 turns; QA-only true accusations; optional +60 turns",
            "mode": "full" if args.full else "representative",
            "requested_routes": selected,
            "coverage": {"completed_routes": len(complete), "possible_routes": 16,
                         "exhaustive": len(complete) == 16},
            "seed": args.seed, "network": "blocked", "cards": "TemporaryDirectory per route",
            "services_contacted": [], "passed": sum(row["passed"] for row in rows), "total": len(rows),
            "elapsed_seconds": round(time.perf_counter() - started, 3), "routes": rows,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report

    try:
        for route in selected:
            if any(row["route"] == route and row["passed"] for row in rows):
                continue
            d2, d3 = route
            row = await check_route(d2, d3, args.seed)
            rows = [old for old in rows if old["route"] != route]
            rows.append(row)
            save()
            observed = row.get("observation", row.get("failure_state", {}))
            states = "/".join(case["status"] for case in observed.get("cases", []))
            ending = row.get("after_confirmation", observed).get("closure", {}).get("status")
            print(f"{row['route']}: {'PASS' if row['passed'] else 'FAIL'} "
                  f"T{observed.get('turn')} {states} -> {ending}", flush=True)
    finally:
        report = save()
    print(f"{report['passed']}/{report['total']} passed; coverage {report['total']}/16; {args.output}", flush=True)
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--full", action="store_true", help="Check all 16 D2/D3 combinations")
    parser.add_argument("--resume", action="store_true", help="Reuse already-passed routes in the output JSON")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "artifacts/b-clarity-20260924/closure-matrix.json")
    arguments = parser.parse_args()
    with patch.object(socket.socket, "connect", reject_network), \
            patch.object(socket, "create_connection", reject_network):
        raise SystemExit(asyncio.run(main(arguments)))
