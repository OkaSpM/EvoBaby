import asyncio
import re
from pathlib import Path

import httpx
import pytest

from app.main import create_app


DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@pytest.mark.skipif(not (DIST / "index.html").exists(), reason="Run npm build before frontend integration test")
def test_built_dashboard_is_served_with_api_from_one_application():
    async def scenario():
        app = create_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            root = await client.get("/")
            assert root.status_code == 200
            assert "EvoBaby · 荒野认知演化实验" in root.text
            asset_path = re.search(r'src="([^"]+\.js)"', root.text).group(1)
            asset = await client.get(asset_path)
            assert asset.status_code == 200
            assert asset.headers["content-type"].startswith("text/javascript")
            assert "荒野认知演化实验" in asset.text
            state = await client.get("/api/state")
            assert state.status_code == 200
            assert len(state.json()["world"]["cells"]) == 64

    asyncio.run(scenario())
