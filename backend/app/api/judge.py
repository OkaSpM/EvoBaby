"""Optional typed judging transport; offline demo never requires credentials."""
import os
from math import isfinite

import httpx


class JudgeProvider:
    def __init__(self, env=None, transport=None):
        env = os.environ if env is None else env
        self.mode = env.get("JUDGE_MODE", "mock")
        self.key = env.get("JEV_API_KEY", "")
        self.url = env.get("JEV_API_URL", "")
        self.transport = transport
        self.online = False

    async def judge(self, question: str, state: dict, options: list[str], fallback: str) -> dict:
        if fallback not in options:
            raise ValueError("Fallback must be one of the typed options")
        default = {"mode": "mock", "choice": fallback, "probabilities": None,
                   "note": "离线规则判断；未发生模型调用"}
        if self.mode != "jev" or not self.key or not self.url.startswith("https://"):
            self.online = False
            return default
        try:
            async with httpx.AsyncClient(timeout=2, transport=self.transport) as client:
                response = await client.post(self.url, headers={"Authorization": f"Bearer {self.key}"},
                                             json={"question": question, "state": state, "options": options})
                response.raise_for_status()
                data = response.json()
            choice, probabilities = data["choice"], data["probabilities"]
            if choice not in options or set(probabilities) != set(options):
                raise ValueError("Invalid typed judgment")
            if not all(isinstance(v, (int, float)) and isfinite(v) and 0 <= v <= 1 for v in probabilities.values()):
                raise ValueError("Invalid probabilities")
            if abs(sum(probabilities.values()) - 1) > 0.02:
                raise ValueError("Unnormalized probabilities")
            self.online = True
            return {"mode": "jev", "choice": choice, "probabilities": probabilities}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            self.online = False
            return default
