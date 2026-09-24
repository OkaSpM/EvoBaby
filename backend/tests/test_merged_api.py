import asyncio

import httpx

from app.api.judge import JudgeProvider
from app.api.trace import TraceGame, belief_trace
from app.main import create_app
from app.simulation.engine import SimulationEngine
from test_phase6 import reach_maturity


def test_three_provenance_relations_keep_forged_claim_separate_from_observed_parent():
    engine = SimulationEngine()
    reach_maturity(engine)
    engine.inject_false_memory()
    incident = engine.corruption.incidents[0]
    result = belief_trace(engine, incident.root_belief_id)
    root = result["records"][0]
    assert root["parentIds"] == []
    assert root["declaredRefs"]
    assert result["lines"]["transmitted"] == []
    assert result["lines"]["declared"]
    assert result["missingParentIds"]
    assert "origin_type" not in str(result)
    assert "forged" not in str(result)


def test_trace_limit_and_missing_target_are_explicit():
    engine = SimulationEngine()
    reach_maturity(engine)
    target = engine.belief_engine.beliefs[0].id
    trace = belief_trace(engine, target, max_records=1)
    assert len(trace["records"]) == 1
    if trace["records"][0]["declaredRefs"]:
        assert trace["truncated"]
    try:
        belief_trace(engine, "absent")
    except KeyError:
        pass
    else:
        raise AssertionError("Unknown belief must not return an invented trace")


def test_accusation_adds_penalty_and_is_idempotent_after_success():
    engine = SimulationEngine()
    reach_maturity(engine)
    engine.inject_false_memory()
    game = TraceGame()
    incident = engine.corruption.incidents[0]
    other = next(b for b in engine.belief_engine.beliefs if b.id != incident.root_belief_id)
    wrong = game.accuse(engine, other.owner_agent_id, other.id)
    assert wrong["correct"] is False and wrong["penalty_seconds"] == 30
    correct = game.accuse(engine, incident.target_agent_id, incident.root_belief_id)
    assert correct["correct"] and correct["winner"] == "player"
    assert game.accuse(engine, other.owner_agent_id, other.id) == correct


def test_jev_without_credentials_is_offline_and_not_online():
    provider = JudgeProvider({"JUDGE_MODE": "jev"})
    result = asyncio.run(provider.judge("choice", {}, ["A", "B"], "B"))
    assert result["choice"] == "B" and result["mode"] == "mock"
    assert provider.online is False


def test_jev_typed_adapter_validates_response_and_falls_back():
    env = {"JUDGE_MODE": "jev", "JEV_API_KEY": "test-not-real", "JEV_API_URL": "https://judge.invalid/typed"}
    valid = JudgeProvider(env, transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"choice": "A", "probabilities": {"A": 0.8, "B": 0.2}})))
    result = asyncio.run(valid.judge("choice", {}, ["A", "B"], "B"))
    assert result["mode"] == "jev" and valid.online
    invalid = JudgeProvider(env, transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"choice": "C", "probabilities": {"C": 1}})))
    result = asyncio.run(invalid.judge("choice", {}, ["A", "B"], "B"))
    assert result["mode"] == "mock" and result["choice"] == "B" and not invalid.online


async def with_client(scenario):
    app = create_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        try:
            await scenario(client, app.state.controller)
        finally:
            await app.state.controller.shutdown()


def test_merged_game_pauses_at_actual_choice_and_replays_real_snapshot():
    async def scenario(client, controller):
        started = await client.post("/api/game/start")
        assert started.status_code == 200, started.text
        state = started.json()["state"]
        assert state["merged_game"]["enabled"] and state["judge_online"] is False
        response = await client.post("/api/simulation/advance", json={"turns": 100})
        state = response.json()["state"]
        assert state["awaiting_choice"]["point"] == "D1"
        assert state["metrics"]["knowledgeMature"]
        turn = state["simulation"]["turn"]
        paused = (await client.post("/api/simulation/step")).json()["state"]
        assert paused["simulation"]["turn"] == turn
        replay = await client.get("/api/replay/1")
        assert replay.status_code == 200
        assert replay.json()["simulation"]["turn"] == 1
        assert not replay.json()["simulation"]["running"]
        assert (await client.get("/api/replay/999999")).status_code == 404
    asyncio.run(with_client(scenario))


def test_merged_injection_redacts_origin_until_explicit_ground_truth():
    async def scenario(client, controller):
        await client.post("/api/game/start")
        await client.post("/api/simulation/advance", json={"turns": 100})
        response = await client.post("/api/choice", json={"point": "D1", "option": "D"})
        assert response.status_code == 200, response.text
        state = response.json()["state"]
        incident = state["incidents"][0]
        assert incident["targetAgentId"] is None and incident["rootBeliefId"] is None
        assert incident["affectedAgentIds"] == []
        assert state["trace_game"]["active"]
        await client.post("/api/simulation/advance", json={"turns": 5})
        hidden = (await client.get("/api/state")).json()["incidents"][0]
        assert hidden["lineage"] == [] and hidden["revokedBeliefIds"] == []
        truth = (await client.get("/api/state?ground_truth=true")).json()
        assert truth["incidents"][0]["targetAgentId"]
    asyncio.run(with_client(scenario))


def test_remove_preserves_memories_and_broadcast_off_stops_new_messages():
    async def scenario(client, controller):
        await client.post("/api/game/start")
        await client.post("/api/simulation/advance", json={"turns": 12})
        before = controller.engine.belief_engine.beliefs
        removed = await client.post("/api/agents/A1/remove")
        assert removed.status_code == 200, removed.text
        state = removed.json()["state"]
        assert state["agents"][0]["removed"]
        assert state["memorials"][0]["agent_id"] == "A1"
        assert controller.engine.belief_engine.beliefs == before
        await client.post("/api/swarm/broadcast", json={"enabled": False})
        count = len(controller.engine.swarm.messages)
        await client.post("/api/simulation/advance", json={"turns": 4})
        assert len(controller.engine.swarm.messages) == count
    asyncio.run(with_client(scenario))


def test_complete_four_choices_produces_stable_card_and_qr():
    async def scenario(client, controller):
        await client.post("/api/game/start")
        chosen = []
        for _ in range(12):
            response = await client.post("/api/simulation/advance", json={"turns": 100})
            assert response.status_code == 200, response.text
            state = response.json()["state"]
            if state["paradigm"]:
                break
            point = (state["awaiting_choice"] or {}).get("point")
            if point:
                chosen.append(point)
                option = "D" if point == "D1" else "A"
                response = await client.post("/api/choice", json={"point": point, "option": option})
                assert response.status_code == 200, response.text
        assert chosen == ["D1", "D2", "D3", "D4"]
        card = (await client.get("/api/paradigm")).json()
        assert card is not None and card["metrics"]["attack2"]
        saved = (await client.get(f'/api/paradigm/cards/{card["id"]}')).json()
        assert saved["metrics"] == card["metrics"] and saved["choices"] == card["choices"]
        qr = await client.get(f'/api/paradigm/cards/{card["id"]}/qr')
        assert qr.status_code == 200 and "<svg" in qr.text
        await client.post("/api/game/start")
        assert (await client.get(f'/api/paradigm/cards/{card["id"]}')).json()["id"] == card["id"]
    asyncio.run(with_client(scenario))
