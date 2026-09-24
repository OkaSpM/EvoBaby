"""OpenAI-compatible JSON transport, output validation and per-decision fallback."""
import asyncio
import json
from typing import Protocol

import httpx
from pydantic import ValidationError

from app.config import LLMConfig
from app.llm import prompts
from app.llm.mock_provider import MockProvider, applicable, outcome_matches
from app.llm.schemas import (
    ActionDecision, ClaimDecision, DecisionRecord, HypothesisDecision, MetaPrinciple, OUTPUT_MODELS,
    RankingDecision, ReasoningKind, available_actions, request_payload,
)
from app.simulation.coordination_models import is_open
from app.simulation.memory import EvidenceKind


class ProviderFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class JSONProvider(Protocol):
    async def complete(self, request) -> dict: ...


class APIProvider:
    def __init__(self, config: LLMConfig, transport: httpx.AsyncBaseTransport | None = None):
        self.config = config
        self.transport = transport

    async def complete(self, request) -> dict:
        model = OUTPUT_MODELS[request.kind]
        # The regulator prompt is isolated from normal agent calls.
        system = getattr(prompts, request.kind.value)
        if request.kind != ReasoningKind.CORRUPTION_RANKING:
            system = prompts.BASE_SYSTEM_PROMPT + "\n" + system
        system += "\nReturn only JSON matching this schema:\n" + json.dumps(model.model_json_schema())
        payload = {"model": self.config.model_name, "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(request_payload(request), ensure_ascii=True)}],
            "response_format": {"type": "json_object"}, "stream": False}
        # Per-request clients also make the synchronous step wrapper safe across event loops.
        async with httpx.AsyncClient(timeout=self.config.timeout_seconds, transport=self.transport,
                                     follow_redirects=False) as client:
            response = await client.post(self.config.base_url.rstrip("/") + "/chat/completions",
                                         headers={"Authorization": f"Bearer {self.config.api_key}"}, json=payload)
        if response.status_code == 429:
            raise ProviderFailure("RATE_LIMIT")
        if response.is_error or response.is_redirect:
            raise ProviderFailure("PROVIDER_ERROR")
        if len(response.content) > 131072:
            raise ProviderFailure("RESPONSE_TOO_LARGE")
        data = response.json()
        choice = data["choices"][0]
        message = choice["message"]
        if message.get("refusal"):
            raise ProviderFailure("REFUSAL")
        if choice.get("finish_reason") != "stop":
            raise ProviderFailure("INCOMPLETE_RESPONSE")
        content = message["content"]
        if not isinstance(content, str):
            raise ProviderFailure("INVALID_JSON")
        # Reject non-standard NaN/Infinity values and never eval generated content.
        def reject_constant(value):
            raise ValueError("Non-finite JSON value")
        return json.loads(content, parse_constant=reject_constant)


def validate_decision(request, output):
    context = request.context
    if isinstance(output, ActionDecision):
        if output.action not in available_actions(context):
            raise ValueError("Action is not available")
        expected_task = context.active_task.id if context.active_task else None
        if output.task_id != expected_task:
            raise ValueError("Action cannot change task state")
    elif isinstance(output, ClaimDecision) and output.claim:
        if context.active_task:
            raise ValueError("Agent already has an active task")
        task = next((t for t in context.open_tasks if t.id == output.claim.task_id), None)
        if task is None or not is_open(task):
            raise ValueError("Unknown or closed task")
        requirement = next((r for r in task.required_contexts if r.id == output.claim.context_id), None)
        if (requirement is None or context.agent_id in requirement.independent_of
                or requirement.id in task.completed_context_ids
                or any(c.context_id == requirement.id for c in task.claimed_contexts)):
            raise ValueError("Context is not eligible for this agent")
    elif isinstance(output, HypothesisDecision) and output.hypothesis:
        h = output.hypothesis
        if h.object != request.object:
            raise ValueError("Hypothesis object must match the evidence request")
        samples = {e.id: e for e in request.evidence if e.kind == EvidenceKind.ACTION_EFFECT
                   and e.object == h.object and e.energy_delta and applicable(h.conditions, e)}
        if len(samples) < 2:
            raise ValueError("Hypothesis needs two relevant observations")
        if request.kind == ReasoningKind.INVESTIGATION_HYPOTHESIS:
            original = request.hypothesis
            if h.effect != original.effect or any(getattr(original.conditions, d) is not None
                and getattr(original.conditions, d) != getattr(h.conditions, d) for d in ("region", "weather")):
                raise ValueError("Repair must preserve the existing claim and narrow its conditions")
            if h.conditions == original.conditions or not all(outcome_matches(h.effect, e) for e in samples.values()):
                raise ValueError("Repair needs a narrower condition with no matching counterexample")
    elif isinstance(output, MetaPrinciple):
        if set(output.dimensions) != {"region", "weather"}:
            raise ValueError("Context-diversity policy must cover region and weather")
    elif isinstance(output, RankingDecision):
        if output.candidate_index is not None and output.candidate_index >= len(request.candidates):
            raise ValueError("Ranking must choose a supplied candidate")
    return output


class ReasoningService:
    def __init__(self, config: LLMConfig | None = None, provider: JSONProvider | None = None):
        self.config = config or LLMConfig.from_env()
        self.mock = MockProvider()
        self.provider = provider if provider is not None else (
            APIProvider(self.config) if self.config.effective_mode == "api" else None)
        self._records: dict[int, DecisionRecord] = {}
        self._sequence = 0

    @property
    def records(self):
        return tuple(self._records[i] for i in sorted(self._records))

    def reset(self):
        self._records.clear()
        self._sequence = 0

    async def decide(self, request, rng=None):
        self._sequence += 1
        sequence = self._sequence
        model = OUTPUT_MODELS[request.kind]
        fallback = validate_decision(request, self.mock.decide(request, rng))
        mode, error = "mock", None
        output = fallback
        if self.provider is not None:
            try:
                data = await asyncio.wait_for(self.provider.complete(request), self.config.timeout_seconds)
                if not isinstance(data, dict):
                    raise ValueError("Expected one JSON object")
                output = validate_decision(request, model.model_validate(data))
                mode = "api"
            except ProviderFailure as exc:
                error = exc.code
            except (TimeoutError, httpx.TimeoutException):
                error = "TIMEOUT"
            except (ValidationError, ValueError, TypeError, KeyError, IndexError):
                error = "INVALID_OUTPUT"
            except Exception:
                # Never log raw exception text: provider bodies/URLs may contain secrets.
                error = "PROVIDER_ERROR"
        elif self.config.mode != "mock":
            error = "CONFIGURATION_INCOMPLETE"
        self._records[sequence] = DecisionRecord(id=f"D{sequence}", turn=request.turn, agent_id=request.agent_id,
                                                 kind=request.kind, mode=mode, fallback_reason=error)
        return output

    async def decide_many(self, requests, rngs=None):
        semaphore = asyncio.Semaphore(self.config.max_concurrency)
        rngs = rngs if rngs is not None else [None] * len(requests)
        async def run(request, rng):
            async with semaphore:
                return await self.decide(request, rng)
        return await asyncio.gather(*(run(request, rng) for request, rng in zip(requests, rngs, strict=True)))
