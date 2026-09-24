import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from pydantic import ValidationError

from app.config import LLMConfig
from app.llm import prompts
from app.llm.mock_provider import MockProvider, propose_from_evidence
from app.llm.provider import APIProvider, ReasoningService
from app.llm.schemas import (
    ActionDecision, IncidentSummary, ReasoningKind, ReasoningRequest, request_payload,
)
from app.schemas import Action, Resource
from app.simulation.agent import AgentState, decision_context
from app.simulation.engine import SimulationEngine
from app.simulation.memory import BeliefType, ConditionalHypothesis, Conditions, EvidenceKind
from app.simulation.world import World
from test_beliefs import ExperienceWorld


def config(**changes):
    return replace(LLMConfig(mode="api", api_key="test-key", base_url="https://example.invalid/v1",
                             model_name="user-configured-model", timeout_seconds=0.2), **changes)


def action_request(agent_id="A1"):
    agent = AgentState(id=agent_id, position=(0, 0))
    world = World()
    context = decision_context(agent, world.observe(agent))
    return ReasoningRequest(kind=ReasoningKind.ACTION_REASONING, turn=1, agent_id=agent_id, context=context)


def response(content, *, finish_reason="stop", refusal=None):
    return {"choices": [{"finish_reason": finish_reason, "message": {"content": content, "refusal": refusal}}]}


def call_with_response(body, status=200):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    settings = config()
    service = ReasoningService(settings, APIProvider(settings, transport))
    output = asyncio.run(service.decide(action_request()))
    return service, output


def test_configuration_defaults_and_missing_credentials_use_mock_without_network(monkeypatch):
    for key in ("LLM_MODE", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_NAME"):
        monkeypatch.delenv(key, raising=False)
    assert LLMConfig.from_env().effective_mode == "mock"
    settings = LLMConfig.from_env({"LLM_MODE": "api", "MODEL_NAME": "test"})
    service = ReasoningService(settings)
    assert service.provider is None
    asyncio.run(service.decide(action_request()))
    assert service.records[0].fallback_reason == "CONFIGURATION_INCOMPLETE"
    assert "test-key" not in repr(config())


@pytest.mark.parametrize("base", ["", "ftp://host", "https://user:password@host/v1", "https://host/v1?key=secret", "https://["])
def test_invalid_endpoint_configuration_falls_back_without_guessing_vendor(base):
    assert config(base_url=base).effective_mode == "mock"


def test_compatible_http_request_uses_json_and_explicit_model_and_sanitized_input():
    captured = []
    def handler(request):
        captured.append(request)
        return httpx.Response(200, json=response(json.dumps({"action": "INSPECT", "task_id": None, "reason": "Observe locally."})))
    settings = config(base_url="https://example.invalid/custom/v1/")
    service = ReasoningService(settings, APIProvider(settings, httpx.MockTransport(handler)))
    result = asyncio.run(service.decide(action_request()))
    assert result.action == Action.INSPECT and service.records[0].mode == "api"
    request = captured[0]
    assert str(request.url) == "https://example.invalid/custom/v1/chat/completions"
    payload = json.loads(request.content)
    assert payload["model"] == "user-configured-model"
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["messages"][0]["content"].startswith(prompts.BASE_SYSTEM_PROMPT)
    local = json.loads(payload["messages"][1]["content"])
    assert local["identity"] == "A1"
    assert not {"world", "seed", "audit", "recent_events", "candidates", "origin_type"} & local.keys()
    assert "respawn_at" not in payload["messages"][1]["content"]


@pytest.mark.parametrize("body,status,reason", [
    ({}, 429, "RATE_LIMIT"), ({}, 503, "PROVIDER_ERROR"), ({}, 400, "PROVIDER_ERROR"),
    ({}, 200, "INVALID_OUTPUT"),
    (response("not JSON"), 200, "INVALID_OUTPUT"),
    (response("{}"), 200, "INVALID_OUTPUT"),
    (response('[]'), 200, "INVALID_OUTPUT"),
    (response('{"action":"INSPECT","reason":"ok","alpha":99}'), 200, "INVALID_OUTPUT"),
    (response('{"action":"MOVE_N","reason":"out of bounds"}'), 200, "INVALID_OUTPUT"),
    (response('{"action":"INSPECT","task_id":"fake","reason":"ok"}'), 200, "INVALID_OUTPUT"),
    (response('{"action":"INSPECT","reason":"ok"}', finish_reason="length"), 200, "INCOMPLETE_RESPONSE"),
    (response(None, refusal="refused"), 200, "REFUSAL"),
])
def test_http_and_output_failures_fall_back_for_only_that_decision(body, status, reason):
    service, actual = call_with_response(body, status)
    assert actual == MockProvider().decide(action_request())
    assert service.records[0].mode == "mock" and service.records[0].fallback_reason == reason


def test_timeout_and_transport_error_do_not_expose_exception_text():
    class HangingProvider:
        async def complete(self, request):
            await asyncio.Event().wait()
    service = ReasoningService(config(timeout_seconds=0.005), HangingProvider())
    assert isinstance(asyncio.run(service.decide(action_request())), ActionDecision)
    assert service.records[0].fallback_reason == "TIMEOUT"
    class FailedProvider:
        async def complete(self, request):
            raise RuntimeError("secret-credential-provider-body")
    service = ReasoningService(config(), FailedProvider())
    asyncio.run(service.decide(action_request()))
    assert service.records[0].fallback_reason == "PROVIDER_ERROR"
    assert "secret-credential" not in str(service.records)


def test_concurrent_decisions_are_bounded_and_return_in_request_order():
    class ConcurrentProvider:
        active = 0
        peak = 0
        async def complete(self, request):
            self.active += 1
            self.peak = max(self.peak, self.active)
            await asyncio.sleep(0.002)
            self.active -= 1
            return {"action": "INSPECT", "task_id": None, "reason": request.agent_id}
    provider = ConcurrentProvider()
    service = ReasoningService(config(max_concurrency=2), provider)
    requests = [action_request(f"A{i}") for i in range(5)]
    outputs = asyncio.run(service.decide_many(requests))
    assert provider.peak == 2
    assert [o.reason for o in outputs] == [r.agent_id for r in requests]
    assert [r.id for r in service.records] == [f"D{i + 1}" for i in range(5)]


def hypothesis_fixture():
    fixture = ExperienceWorld()
    agent = fixture.agents[0]
    fixture.moss(agent)
    fixture.moss(agent)
    evidence = tuple(e for e in fixture.memory.evidence_for(agent.id) if e.kind == EvidenceKind.ACTION_EFFECT)
    request = ReasoningRequest(kind=ReasoningKind.HYPOTHESIS_GENERATION, turn=fixture.world.turn,
                               agent_id=agent.id, object=Resource.MOSS, evidence=evidence)
    return fixture, request


def test_mock_naturally_omits_unresolved_condition_from_real_evidence():
    fixture, request = hypothesis_fixture()
    service = ReasoningService(LLMConfig())
    hypothesis = asyncio.run(service.decide(request)).hypothesis
    assert hypothesis.conditions.weather == "Rain" and hypothesis.conditions.region is None
    belief = fixture.memory.propose_conditional(fixture.agents[0], hypothesis, turn=fixture.world.turn)
    assert belief.alpha == 3 and belief.beta == 1
    fixture.moss(fixture.agents[0], (5, 5))
    assert fixture.memory.get(belief.id).beta == 2  # The omitted condition is actually consequential.


def test_hypotheses_are_determined_by_samples_not_resource_specific_hidden_truth():
    _, request = hypothesis_fixture()
    samples = tuple(e.model_copy(update={"region": "SE", "position": (5, 5)}) for e in request.evidence)
    hypothesis = propose_from_evidence(samples, Resource.MOSS)
    assert hypothesis.conditions.weather == "Rain"
    assert hypothesis.conditions.region is None
    assert propose_from_evidence((samples[0], samples[0]), Resource.MOSS) is None
    assert propose_from_evidence(samples[:1], Resource.MOSS) is None


def test_repair_is_computed_from_cross_context_evidence_and_can_abstain():
    fixture, request = hypothesis_fixture()
    original = MockProvider().decide(request).hypothesis
    fixture.moss(fixture.agents[0], (5, 5))
    samples = tuple(e for e in fixture.memory.evidence_for("A1") if e.kind == EvidenceKind.ACTION_EFFECT)
    repair_request = ReasoningRequest(kind=ReasoningKind.INVESTIGATION_HYPOTHESIS, turn=fixture.world.turn,
                                     object=Resource.MOSS, hypothesis=original, evidence=samples)
    repaired = asyncio.run(ReasoningService(LLMConfig()).decide(repair_request)).hypothesis
    assert repaired.conditions == Conditions(region="NW", weather="Rain")
    swapped = tuple(e.model_copy(update={"region": "SE" if e.region == "NW" else "NW"}) for e in samples)
    assert propose_from_evidence(swapped, Resource.MOSS, original).conditions.region == "SE"
    contradictory = (*samples, samples[0].model_copy(update={"id": "EV-counter", "energy_delta": -8}))
    assert propose_from_evidence(contradictory, Resource.MOSS, original) is None


def test_api_hypothesis_cannot_write_stats_and_semantically_invalid_repair_falls_back():
    fixture, request = hypothesis_fixture()
    class IllegalStats:
        async def complete(self, request):
            return {"hypothesis": {"type": "CONDITIONAL_EFFECT", "object": "Moss", "conditions": {},
                                    "effect": "ENERGY_POSITIVE", "reason": "Trust me", "alpha": 999}}
    service = ReasoningService(config(), IllegalStats())
    output = asyncio.run(service.decide(request))
    assert output.hypothesis == MockProvider().decide(request).hypothesis
    assert service.records[0].fallback_reason == "INVALID_OUTPUT"
    class Ungrounded:
        async def complete(self, request):
            return {"hypothesis": {"object": "Moss", "conditions": {"weather": "Sunny"},
                                    "effect": "ENERGY_POSITIVE", "reason": "Unsupported"}}
    service = ReasoningService(config(), Ungrounded())
    assert asyncio.run(service.decide(request)).hypothesis == output.hypothesis
    assert not any(b.type == BeliefType.CONDITIONAL_EFFECT for b in fixture.memory.beliefs)


def test_meta_reflection_and_candidate_ranking_are_scoped_outputs_not_state_changes():
    fixture, request = hypothesis_fixture()
    h = MockProvider().decide(request).hypothesis
    incident = IncidentSummary(incident_id="I1", previously_verified=True, resolved=True, hypothesis=h,
                               evidence=request.evidence, independent_agent_ids=("A1", "A2"))
    service = ReasoningService(LLMConfig())
    meta = asyncio.run(service.decide(ReasoningRequest(kind=ReasoningKind.META_REFLECTION,
                                                     turn=3, incident=incident)))
    assert meta.type == "REQUIRE_CONTEXT_DIVERSITY" and meta.dimensions == ("region", "weather")
    ranked = asyncio.run(service.decide(ReasoningRequest(kind=ReasoningKind.CORRUPTION_RANKING,
                                                        turn=3, candidates=(h,))))
    assert ranked.candidate_index == 0
    assert not any(b.type == BeliefType.CONDITIONAL_EFFECT for b in fixture.memory.beliefs)
    with pytest.raises(ValidationError):
        ReasoningRequest(kind=ReasoningKind.META_REFLECTION, turn=3,
                         incident=incident.model_copy(update={"resolved": False}))
    with pytest.raises(ValidationError):
        ReasoningRequest(kind=ReasoningKind.ACTION_REASONING, turn=3, agent_id="A1",
                         context=action_request().context, candidates=(h,))


def test_all_six_prompts_are_english_and_nonempty():
    for kind in ReasoningKind:
        text = getattr(prompts, kind.value)
        assert "JSON" in text and text.isascii()
        assert "Energy +20" not in text and "respawn" not in text


def test_plain_uninformed_walking_does_not_call_a_provider():
    service = ReasoningService(LLMConfig())
    engine = SimulationEngine(reasoning=service)
    for cell in engine.world.cells.values():
        cell.object = None
    engine.step()
    assert not service.records


def test_full_mock_runtime_generates_real_conditional_beliefs_without_reflecting_or_ranking():
    engine = SimulationEngine(reasoning=ReasoningService(LLMConfig()))
    for _ in range(40):
        engine.step()
    conditional = [b for b in engine.belief_engine.beliefs if b.type == BeliefType.CONDITIONAL_EFFECT]
    assert conditional
    by_id = {e.id: e for e in engine.belief_engine.evidence}
    for belief in conditional:
        assert len(belief.evidence_ids) >= 2
        assert all(by_id[i].kind == EvidenceKind.ACTION_EFFECT for i in belief.evidence_ids)
    assert any(r.kind == ReasoningKind.HYPOTHESIS_GENERATION for r in engine.reasoning.records)
    assert all(r.kind not in (ReasoningKind.META_REFLECTION, ReasoningKind.CORRUPTION_RANKING)
               for r in engine.reasoning.records)
    engine.reset()
    assert not engine.reasoning.records and not engine.belief_engine.beliefs


def test_failed_api_runtime_matches_mock_physics_and_memory():
    class Failing:
        async def complete(self, request):
            raise RuntimeError("failure")
    mock = SimulationEngine(reasoning=ReasoningService(LLMConfig()))
    failed = SimulationEngine(reasoning=ReasoningService(config(), Failing()))
    for _ in range(25):
        assert mock.step() == failed.step()
    left, right = mock.debug_snapshot(), failed.debug_snapshot()
    left.pop("reasoning")
    right.pop("reasoning")
    assert left == right
    assert failed.reasoning.records and all(r.fallback_reason == "PROVIDER_ERROR" for r in failed.reasoning.records)


def test_async_turn_rejects_overlap_reset_and_sync_wrapper_without_corrupting_turn():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        class Blocking:
            async def complete(self, request):
                started.set()
                await release.wait()
                return {"action": "INSPECT", "task_id": None, "reason": "Observe"}
        engine = SimulationEngine(reasoning=ReasoningService(config(timeout_seconds=2), Blocking()))
        turn = asyncio.create_task(engine.step_async())
        await started.wait()
        with pytest.raises(RuntimeError, match="already running"):
            await engine.step_async()
        with pytest.raises(RuntimeError, match="reset"):
            engine.reset()
        with pytest.raises(RuntimeError, match="step_async"):
            engine.step()
        release.set()
        await turn
        assert engine.world.turn == 1
        engine.reset()
        assert engine.world.turn == 0
    asyncio.run(run())


def test_timeout_and_concurrency_environment_settings_are_bounded():
    settings = LLMConfig.from_env({"LLM_TIMEOUT_SECONDS": "0.02", "LLM_MAX_CONCURRENCY": "2"})
    assert settings.timeout_seconds == 0.02 and settings.max_concurrency == 2
    assert LLMConfig.from_env({"LLM_TIMEOUT_SECONDS": "nan"}).timeout_seconds == 10
    assert LLMConfig.from_env({"LLM_MAX_CONCURRENCY": "bad"}).max_concurrency == 5


def test_valid_api_hypothesis_is_accepted_without_changing_belief_statistics():
    fixture, request = hypothesis_fixture()
    proposed = {"hypothesis": {"object": "Moss", "conditions": {"region": "NW", "weather": "Rain"},
                               "effect": "ENERGY_POSITIVE", "reason": "Describe the observed context."}}
    settings = config()
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=response(json.dumps(proposed))))
    service = ReasoningService(settings, APIProvider(settings, transport))
    before = fixture.memory.debug_snapshot()
    result = asyncio.run(service.decide(request))
    assert result.hypothesis.conditions.region == "NW"
    assert service.records[0].mode == "api"
    assert fixture.memory.debug_snapshot() == before


def test_invalid_task_claim_falls_back_without_assigning_a_task():
    from app.simulation.coordination import CooperativePolicy
    engine = SimulationEngine(policy=CooperativePolicy())
    engine.step()
    agent = engine.agents[0]
    request = ReasoningRequest(kind=ReasoningKind.TASK_CLAIM_REASONING, turn=engine.world.turn,
                               agent_id=agent.id, context=engine._context(agent, engine.world.observe(agent)))
    class UnknownTask:
        async def complete(self, request):
            return {"claim": {"task_id": "nonexistent", "context_id": "C1"}, "reason": "Choose task"}
    service = ReasoningService(config(), UnknownTask())
    assert asyncio.run(service.decide(request)) == MockProvider().decide(request)
    assert service.records[0].fallback_reason == "INVALID_OUTPUT"
    assert agent.active_task is None


def test_invalid_repair_policy_and_ranking_outputs_use_typed_fallbacks():
    fixture, request = hypothesis_fixture()
    original = MockProvider().decide(request).hypothesis
    fixture.moss(fixture.agents[0], (5, 5))
    samples = tuple(e for e in fixture.memory.evidence_for("A1") if e.kind == EvidenceKind.ACTION_EFFECT)
    incident = IncidentSummary(incident_id="I1", previously_verified=True, resolved=True, hypothesis=original,
                               evidence=samples, independent_agent_ids=("A1", "A2"))
    requests = [
        ReasoningRequest(kind=ReasoningKind.INVESTIGATION_HYPOTHESIS, turn=3, object=Resource.MOSS,
                         evidence=samples, hypothesis=original),
        ReasoningRequest(kind=ReasoningKind.META_REFLECTION, turn=3, incident=incident),
        ReasoningRequest(kind=ReasoningKind.CORRUPTION_RANKING, turn=3, candidates=(original,)),
    ]
    class Invalid:
        async def complete(self, request):
            if request.kind == ReasoningKind.INVESTIGATION_HYPOTHESIS:
                return {"hypothesis": original.model_dump(mode="json")}  # No narrowing; contradicted.
            if request.kind == ReasoningKind.META_REFLECTION:
                return {"type": "REQUIRE_CONTEXT_DIVERSITY", "principle": "Check contexts", "dimensions": ["region", "region"]}
            return {"candidate_index": 99, "reason": "Invent an index"}
    service = ReasoningService(config(), Invalid())
    results = asyncio.run(service.decide_many(requests))
    assert results[0].hypothesis.conditions.region == "NW"
    assert results[1].dimensions == ("region", "weather")
    assert results[2].candidate_index == 0
    assert all(r.fallback_reason == "INVALID_OUTPUT" for r in service.records)
