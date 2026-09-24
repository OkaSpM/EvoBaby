from dataclasses import dataclass, field


@dataclass(frozen=True)
class WorldConfig:
    seed: int = 42
    demo_mode: bool = True
    # Each entry lasts four turns; None uses seeded weather transitions.
    weather_schedule: tuple[str, ...] | None = None

    def __post_init__(self):
        if self.weather_schedule is not None and (
            not self.weather_schedule
            or any(value not in ("Sunny", "Rain") for value in self.weather_schedule)
        ):
            raise ValueError("weather_schedule must contain Sunny or Rain")


GRID_SIZE = 8
BASE = (3, 3)
SPAWN_PROBABILITIES = {
    "NW": (0.30, 0.05, 0.20),
    "NE": (0.10, 0.30, 0.05),
    "SW": (0.15, 0.10, 0.30),
    "SE": (0.05, 0.25, 0.10),
}


@dataclass(frozen=True)
class LLMConfig:
    mode: str = "mock"
    api_key: str = field(default="", repr=False)
    base_url: str = ""
    model_name: str = ""
    timeout_seconds: float = 10.0
    max_concurrency: int = 5

    def __post_init__(self):
        import math
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0 or self.max_concurrency < 1:
            raise ValueError("Timeout and concurrency must be positive")

    @property
    def effective_mode(self) -> str:
        from urllib.parse import urlsplit
        try:
            parsed = urlsplit(self.base_url)
        except ValueError:
            return "mock"
        valid_url = parsed.scheme in ("http", "https") and parsed.netloc and not (
            parsed.username or parsed.password or parsed.query or parsed.fragment)
        return "api" if self.mode == "api" and self.api_key.strip() and self.model_name.strip() and valid_url else "mock"

    @classmethod
    def from_env(cls, environ=None):
        import os
        import math
        env = os.environ if environ is None else environ
        try:
            timeout = float(env.get("LLM_TIMEOUT_SECONDS", "10"))
            if not math.isfinite(timeout) or timeout <= 0:
                timeout = 10.0
        except ValueError:
            timeout = 10.0
        try:
            concurrency = max(1, int(env.get("LLM_MAX_CONCURRENCY", "5")))
        except ValueError:
            concurrency = 5
        return cls(mode=env.get("LLM_MODE", "mock").strip().lower(),
                   api_key=env.get("OPENAI_API_KEY", "").strip(),
                   base_url=env.get("OPENAI_BASE_URL", "").strip().rstrip("/"),
                   model_name=env.get("MODEL_NAME", "").strip(),
                   timeout_seconds=timeout, max_concurrency=concurrency)
