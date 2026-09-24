import asyncio

import httpx

from app.main import create_app
from app.simulation.engine import SimulationEngine
from test_phase6 import reach_maturity
from test_phase7 import resolve_first_incident


async def request_app(operation, engine=None):
    app = create_app(engine)
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await operation(client, app)
    finally:
        await app.state.controller.shutdown()


def test_state_contract_hides_unexplored_resources_and_privileged_incident_fields():
    async def scenario(client, _):
        response = await client.get("/api/state")
        assert response.status_code == 200
        data = response.json()
        assert set(data) == {
            "simulation", "world", "agents", "tasks", "collectiveKnowledge",
            "metaBeliefs", "incidents", "metrics", "recentEvents",
        }
        assert data["simulation"] == {
            "running": False, "speed": 1, "turn": 0, "seed": 42,
            "canInjectFirst": False, "canInjectSecond": False,
        }
        assert len(data["world"]["cells"]) == 64
        assert all(not cell["known"] and cell["object"] is None
                   for cell in data["world"]["cells"])
        assert len(data["agents"]) == 5
        assert data["metrics"]["exploredCellPercent"] == 0

    asyncio.run(request_app(scenario))


def test_step_agent_events_and_complete_normalized_export():
    async def scenario(client, _):
        step = await client.post("/api/simulation/step")
        assert step.status_code == 200
        assert step.json()["state"]["simulation"]["turn"] == 1
        assert step.json()["state"]["metrics"]["exploredCellPercent"] > 0

        agent = await client.get("/api/agents/A1")
        assert agent.status_code == 200
        detail = agent.json()
        assert detail["agent"]["id"] == "A1"
        assert detail["knownCells"] and detail["recentEvents"]

        events = await client.get("/api/events")
        assert events.status_code == 200 and events.json()["events"]
        exported = await client.get("/api/export")
        assert exported.status_code == 200
        body = exported.json()
        assert set(body) == {
            "state", "evidence", "beliefs", "beliefChanges", "taskChanges",
            "messages", "investigations", "corruptionAudit", "reasoning",
            "rawEvents", "groundTruth",
        }
        assert len(body["groundTruth"]["cells"]) == 64
        assert body["groundTruth"]["mossRule"]["positiveWhen"] == {
            "region": "NW", "weather": "Rain",
        }

    asyncio.run(request_app(scenario))


def test_localized_errors_validation_and_openapi_contract():
    async def scenario(client, _):
        missing = await client.get("/api/agents/A99")
        assert missing.status_code == 404
        assert missing.json() == {"code": "AGENT_NOT_FOUND", "message": "未找到指定智能体。"}
        premature = await client.post("/api/corruption/inject")
        assert premature.status_code == 409
        assert premature.json()["code"] == "KNOWLEDGE_NOT_MATURE"
        assert "尚未成熟" in premature.json()["message"]
        invalid_speed = await client.post("/api/simulation/run", json={"speed": 2})
        assert invalid_speed.status_code == 422
        extra = await client.post("/api/simulation/run", json={"speed": 1, "turn": 99})
        assert extra.status_code == 422
        schema = (await client.get("/openapi.json")).json()
        expected = {
            "/api/state", "/api/simulation/step", "/api/simulation/run",
            "/api/simulation/pause", "/api/simulation/reset",
            "/api/simulation/new-seed", "/api/corruption/inject",
            "/api/corruption/inject-second", "/api/agents/{agent_id}",
            "/api/events", "/api/export",
        }
        assert expected <= set(schema["paths"])

    asyncio.run(request_app(scenario))


def test_auto_run_pause_and_resets_are_serialized():
    async def scenario(client, _):
        started = await client.post("/api/simulation/run", json={"speed": 20})
        assert started.status_code == 200
        await asyncio.sleep(0.13)
        paused = await client.post("/api/simulation/pause")
        paused_turn = paused.json()["state"]["simulation"]["turn"]
        assert paused_turn >= 1
        assert not paused.json()["state"]["simulation"]["running"]
        await asyncio.sleep(0.08)
        assert (await client.get("/api/state")).json()["simulation"]["turn"] == paused_turn

        reset = await client.post("/api/simulation/reset")
        assert reset.json()["state"]["simulation"]["turn"] == 0
        assert reset.json()["state"]["simulation"]["seed"] == 42
        changed = await client.post("/api/simulation/new-seed")
        assert changed.json()["state"]["simulation"]["seed"] == 43
        assert changed.json()["state"]["simulation"]["turn"] == 0

        await asyncio.gather(*(client.post("/api/simulation/step") for _ in range(3)))
        assert (await client.get("/api/state")).json()["simulation"]["turn"] == 3

    asyncio.run(request_app(scenario))


def test_first_corruption_endpoint_obeys_maturity_and_returns_sanitized_incident():
    engine = SimulationEngine()
    reach_maturity(engine)

    async def scenario(client, _):
        before = (await client.get("/api/state")).json()
        assert before["simulation"]["canInjectFirst"]
        response = await client.post("/api/corruption/inject")
        assert response.status_code == 200
        incident = response.json()["state"]["incidents"][0]
        assert incident["attackNumber"] == 1
        assert "trueHypothesis" not in incident and "forgedEvidenceIds" not in incident
        duplicate = await client.post("/api/corruption/inject")
        assert duplicate.status_code == 409
        assert duplicate.json()["code"] == "FIRST_ATTACK_ALREADY_INJECTED"

    asyncio.run(request_app(scenario, engine))


def test_second_corruption_endpoint_uses_phase7_gate_and_policy_state():
    engine = SimulationEngine()
    resolve_first_incident(engine, reflect=True)

    async def scenario(client, _):
        before = (await client.get("/api/state")).json()
        assert before["simulation"]["canInjectSecond"]
        assert len(before["metaBeliefs"]) == 1
        response = await client.post("/api/corruption/inject-second")
        assert response.status_code == 200
        state = response.json()["state"]
        assert not state["simulation"]["canInjectSecond"]
        assert state["incidents"][1]["attackNumber"] == 2
        assert state["incidents"][1]["status"] == "VERIFYING"
        assert len(state["metrics"]["attacks"]["attacks"]) == 2

    asyncio.run(request_app(scenario, engine))
