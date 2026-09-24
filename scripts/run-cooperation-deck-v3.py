"""Reproduce the 16 local D2 x D3 routes without starting an API or card store."""
from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import LLMConfig, WorldConfig
from app.llm.provider import ReasoningService
from app.simulation.engine import SimulationEngine
from app.simulation.merged_game import LABELS, MergedGame


ROUTES = tuple(a + b for a in "ABCD" for b in "ABCD")
CORE_FIELDS = ("spread", "detect_turns", "repair_turns", "bad_actions", "contexts_before_adoption")
ROUTE_COPY = {
    "AA": {"title": "敲锣之后，走到别处", "strategy": "先广播争议，再让泛化结论接受跨场景检验。"},
    "AB": {"title": "敲锣之后，三人作证", "strategy": "先广播争议，再要求至少三位独立成员提供依据。"},
    "AC": {"title": "敲锣之后，亲手再试", "strategy": "先广播争议；之后收到常识，先由自己验证再采纳。"},
    "AD": {"title": "敲锣之后，规则照旧", "strategy": "这次广播争议，下一次不另设新的验证门槛。"},
    "BA": {"title": "重复检查，再换场景", "strategy": "先等同一人的反例累积，再要求跨场景验证。"},
    "BB": {"title": "重复检查，再请三人", "strategy": "先等本地反例累积，再把独立来源门槛提高到三人。"},
    "BC": {"title": "重复检查，各自试过", "strategy": "这次先本地重试，之后每个人采纳前都要自己试。"},
    "BD": {"title": "重复检查，不添规矩", "strategy": "等本地反例累积后处理，不新增未来验证制度。"},
    "CA": {"title": "划掉旧句，走向别处", "strategy": "先撤销问题常识，再要求未来结论接受跨场景验证。"},
    "CB": {"title": "划掉旧句，再请三人", "strategy": "先撤销问题常识，再提高独立来源人数门槛。"},
    "CC": {"title": "划掉旧句，亲手试过", "strategy": "先撤销问题常识，之后把亲自验证放在采纳之前。"},
    "CD": {"title": "划掉旧句，仍循旧规", "strategy": "只撤销这条问题常识，不为未来增加新规矩。"},
    "DA": {"title": "这次略过，下次走远", "strategy": "暂不处理这次反例；窗口结束后，改用跨场景验证。"},
    "DB": {"title": "这次略过，下次三人", "strategy": "暂不处理这次反例；窗口结束后，提高独立来源门槛。"},
    "DC": {"title": "这次略过，下次亲试", "strategy": "暂不处理这次反例；窗口结束后，采纳前先亲自验证。"},
    "DD": {"title": "这次略过，下次照旧", "strategy": "不处理这次反例，也不新增未来验证制度。"},
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def card_fingerprint():
    return {path.name: sha256(path) for path in sorted((ROOT / "data" / "cards").glob("*.json"))}


def incident_timing(incident, observed_turn):
    # Only timestamps and public status are retained, never hidden source/target IDs.
    return {
        "id": incident.id,
        "attackNumber": incident.attack_number,
        "status": incident.status.value,
        "injectedTurn": incident.injected_turn,
        "detectedTurn": incident.detected_turn,
        "disputedTurn": incident.disputed_turn,
        "resolvedTurn": incident.resolved_turn,
        "observedUntilTurn": observed_turn,
    }


async def run_once(route, seed, observation_window, max_turns):
    engine = SimulationEngine(
        WorldConfig(seed=seed), reasoning=ReasoningService(LLMConfig(mode="mock")))
    game = MergedGame(engine, optional_choices=True, max_attack_turns=observation_window)
    decisions = {"D1": "D", "D2": route[0], "D3": route[1], "D4": "A"}
    prompts = []
    first_timing = None
    while engine.world.turn <= max_turns:
        while game.awaiting_choice:
            prompt = game.awaiting_choice
            prompts.append({key: prompt[key] for key in ("point", "turn", "title", "reason", "evidence_ids")})
            if prompt["point"] == "D3":
                first_timing = incident_timing(engine.corruption.incidents[0], engine.world.turn)
            await game.choose(prompt["point"], decisions[prompt["point"]])
        if game.complete:
            paradigm = game.paradigm()
            if paradigm["choices"] != decisions:
                raise AssertionError("Not all four requested choices were applied")
            if engine.reasoning.config.effective_mode != "mock":
                raise AssertionError("This runner must never use a remote reasoning service")
            return {
                "path": route,
                "routeId": f"D1D-D2{route[0]}-D3{route[1]}-D4A",
                "choices": decisions,
                "choiceLabels": {point: LABELS[point]["ABCD".index(option)] for point, option in decisions.items()},
                "shortCopy": ROUTE_COPY[route],
                "paradigm": paradigm,
                "choiceEvents": game.choice_events,
                "choicePrompts": prompts,
                "policyEvents": game.policy_events,
                "incidentTimings": [first_timing, incident_timing(engine.corruption.incidents[1], engine.world.turn)],
            }
        if engine.world.turn == max_turns:
            break
        game.before_step()
        await engine.step_async()
        await game.after_step()
    raise RuntimeError(f"{route} did not complete by T{max_turns}; phase={game.phase}")


def worker(args):
    route, seed, window, max_turns, repeats = args
    started = time.monotonic()
    result = asyncio.run(run_once(route, seed, window, max_turns))
    reference = json.dumps(result, ensure_ascii=False, sort_keys=True)
    for attempt in range(1, repeats):
        rerun = asyncio.run(run_once(route, seed, window, max_turns))
        if json.dumps(rerun, ensure_ascii=False, sort_keys=True) != reference:
            raise AssertionError(f"Route {route} differs on repeat {attempt + 1}")
    result["verification"] = {"freshRuns": repeats, "identical": True, "comparison": "full recorded route payload"}
    print(f"{route}: {result['paradigm']['name']} @ T{result['paradigm']['completed_turn']}"
          f" ({time.monotonic() - started:.1f}s; fresh runs={repeats})", flush=True)
    return result


def assemble(paths, args, unchanged):
    endings = defaultdict(list)
    signatures = defaultdict(list)
    for item in paths:
        card = item["paradigm"]
        endings[card["name"]].append(item["path"])
        signature = tuple(tuple(card["metrics"][attack][key] for key in CORE_FIELDS)
                          for attack in ("attack1", "attack2"))
        signatures[signature].append(item["path"])
    return {
        "schemaVersion": 1,
        "scope": "Fixed-seed D2 x D3 strategy deck; not all D1-D4 combinations or random worlds.",
        "config": {"seed": args.seed, "mode": "mock", "fixedChoices": {"D1": "D", "D4": "A"},
                   "optionalChoices": True, "observationWindowTurns": args.window,
                   "maxTurns": args.max_turns, "freshRunsPerRoute": args.repeats},
        "engineFilesSha256": {str(path.relative_to(ROOT)): sha256(path) for path in (
            ROOT / "backend/app/simulation/merged_game.py", ROOT / "backend/app/simulation/engine.py",
            ROOT / "backend/app/simulation/corruption.py", ROOT / "backend/app/simulation/world.py",
            ROOT / "backend/app/simulation/cognition.py")},
        "productionCardStoreUnchanged": unchanged,
        "paths": paths,
        "sameEndingGroups": dict(endings),
        "indistinguishableMetricGroups": [group for group in signatures.values() if len(group) > 1],
        "metricSignatureFields": list(CORE_FIELDS),
        "differentEndingCount": len(endings),
        "limits": [
            "16 strategy routes do not mean 16 distinct endings; the current engine has six ordered ending labels.",
            "No world rules, thresholds, seeds, or observations are changed to force a desired ending.",
            "PREVENTED, REVOKED, REPAIRED, and unresolved observations retain separate raw statuses.",
            "Negative detect_turns reference earlier evidence and must not be drawn as a negative discovery duration.",
            "Detection, public first-anomaly prompt, and dispute timestamps are not interchangeable.",
            "First-attack metrics and incident timings are frozen at D3, before the second attack.",
            "Cards retain the engine's original tagline as raw data; it is not an independently proven causal claim.",
            "Offline mock has no measured real-model token cost; no claim of cloud-agent execution is made.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--window", type=int, default=60)
    parser.add_argument("--max-turns", type=int, default=240)
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--routes", nargs="+", choices=ROUTES, default=list(ROUTES))
    parser.add_argument("--output", type=Path, default=ROOT / "docs/cooperation-deck-v3/runs.json")
    args = parser.parse_args()
    if args.jobs < 1 or args.repeats < 1 or len(set(args.routes)) != len(args.routes):
        parser.error("jobs/repeats must be positive and routes must be unique")
    output = args.output.resolve()
    if output == (ROOT / "data/cards").resolve() or (ROOT / "data/cards").resolve() in output.parents:
        parser.error("Output must not be the production card store")
    before = card_fingerprint()
    tasks = [(route, args.seed, args.window, args.max_turns, args.repeats) for route in args.routes]
    if args.jobs == 1:
        paths = [worker(task) for task in tasks]
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            paths = list(pool.map(worker, tasks))
    if "app.api.controller" in sys.modules:
        raise AssertionError("The isolated runner must not load the production controller")
    unchanged = before == card_fingerprint()
    if not unchanged:
        raise AssertionError("Production card files changed during this run; no files were restored")
    data = assemble(paths, args, unchanged)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"Saved {len(paths)} routes / {len(data['sameEndingGroups'])} endings to {output}", flush=True)


if __name__ == "__main__":
    main()
