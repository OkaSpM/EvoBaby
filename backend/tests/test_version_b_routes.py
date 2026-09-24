import asyncio
import json
from html.parser import HTMLParser
from pathlib import Path

import httpx
import pytest

import app.main as main_module


DIST_B = Path(__file__).resolve().parents[2] / "frontend-b" / "dist"
PUBLIC_MODELS_B = Path(__file__).resolve().parents[2] / "frontend-b" / "public" / "models"
REQUIRED_MODELS_B = ("wildling", "campfire", "totem", "village", "event-memory", "event-dispute",
                     "world-8x8", "cognition-1", "cognition-2", "cognition-3", "cognition-4")
STORY_SCENES_B = ("departure", "hearth", "anomaly", "verification", "repair", "second-trial")


class BuildAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "script" and attributes.get("src"):
            self.paths.append(attributes["src"])
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.paths.append(attributes["href"])


@pytest.fixture
def version_app(tmp_path, monkeypatch):
    """Exercise mount order without requiring either production build."""
    monkeypatch.setattr(main_module, "__file__", str(tmp_path / "backend" / "app" / "main.py"))

    def create(with_b=True):
        a_dist = tmp_path / "frontend" / "dist"
        a_dist.mkdir(parents=True)
        (a_dist / "index.html").write_text("<title>Version A</title>", encoding="utf-8")
        (a_dist / "models").mkdir()
        (a_dist / "models" / "wildling.glb").write_bytes(b"glTF-A-only")
        (a_dist / "api").mkdir()
        (a_dist / "api" / "state").write_text("not the API", encoding="utf-8")
        if with_b:
            b_dist = tmp_path / "frontend-b" / "dist"
            b_dist.mkdir(parents=True)
            (b_dist / "index.html").write_text(
                '<title>Version B</title><script src="/b/assets/b.js"></script>', encoding="utf-8"
            )
            (b_dist / "assets").mkdir()
            (b_dist / "assets" / "b.js").write_text("const version = 'B';", encoding="utf-8")
            (b_dist / "models").mkdir()
            (b_dist / "models" / "wildling.glb").write_bytes(b"glTF-B-only")
        return main_module.create_app()

    return create


async def request_version_app(app, operation):
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            await operation(client)
    finally:
        await app.state.controller.shutdown()


def test_version_b_short_url_redirects_before_root_static_mount(version_app):
    async def scenario(client):
        response = await client.get("/b", follow_redirects=False)
        assert response.status_code in (307, 308)
        assert response.headers["location"] == "/b/"
        followed = await client.get("/b", follow_redirects=True)
        assert followed.status_code == 200
        assert "Version B" in followed.text

    asyncio.run(request_version_app(version_app(), scenario))


def test_version_a_root_and_version_b_index_remain_distinct(version_app):
    async def scenario(client):
        a = await client.get("/")
        b = await client.get("/b/")
        assert a.status_code == b.status_code == 200
        assert a.text == "<title>Version A</title>"
        assert "Version B" in b.text and "Version A" not in b.text
        script = await client.get("/b/assets/b.js")
        assert script.status_code == 200
        assert script.headers["content-type"].startswith("text/javascript")
        assert script.text == "const version = 'B';"

    asyncio.run(request_version_app(version_app(), scenario))


def test_version_b_models_are_local_and_do_not_fall_through_to_a(version_app):
    async def scenario(client):
        a = await client.get("/models/wildling.glb")
        b = await client.get("/b/models/wildling.glb")
        assert a.status_code == b.status_code == 200
        assert a.content == b"glTF-A-only"
        assert b.content == b"glTF-B-only"
        missing = await client.get("/b/models/missing.glb")
        assert missing.status_code == 404
        assert "Version A" not in missing.text and "Version B" not in missing.text

    asyncio.run(request_version_app(version_app(), scenario))


def test_api_routes_take_priority_over_both_static_frontends(version_app):
    async def scenario(client):
        state = await client.get("/api/state")
        assert state.status_code == 200
        assert state.headers["content-type"].startswith("application/json")
        assert len(state.json()["world"]["cells"]) == 64
        assert state.json()["simulation"]["turn"] == 0
        step = await client.post("/api/simulation/step")
        assert step.status_code == 200
        assert step.json()["state"]["simulation"]["turn"] == 1
        schema = await client.get("/openapi.json")
        assert schema.status_code == 200
        assert "/api/state" in schema.json()["paths"]
        assert "/b" not in schema.json()["paths"]

    asyncio.run(request_version_app(version_app(), scenario))


def test_version_a_still_runs_when_b_has_not_been_built(version_app):
    async def scenario(client):
        root = await client.get("/")
        assert root.status_code == 200 and "Version A" in root.text
        assert (await client.get("/api/state")).status_code == 200
        assert (await client.get("/b/")).status_code == 404

    asyncio.run(request_version_app(version_app(with_b=False), scenario))


@pytest.mark.skipif(not (DIST_B / "index.html").exists(), reason="Build frontend-b before its artifact smoke test")
def test_real_version_b_build_resolves_assets_under_its_own_mount():
    async def scenario(client):
        page = await client.get("/b/")
        assert page.status_code == 200
        assets = BuildAssets()
        assets.feed(page.text)
        assert assets.paths
        for path in assets.paths:
            assert path.startswith("/b/"), f"B build must not load A assets: {path}"
            response = await client.get(path)
            assert response.status_code == 200, path
            assert not response.headers["content-type"].startswith("text/html"), path

    asyncio.run(request_version_app(main_module.create_app(), scenario))


@pytest.mark.skipif(not (DIST_B / "index.html").exists(), reason="Build frontend-b before its model smoke test")
def test_real_version_b_models_are_self_contained_glb_files():
    async def scenario(client):
        for name in REQUIRED_MODELS_B:
            response = await client.get(f"/b/models/{name}.glb")
            assert response.status_code == 200, name
            body = response.content
            assert body == (PUBLIC_MODELS_B / f"{name}.glb").read_bytes(), f"Stale B build asset: {name}"
            assert body[:4] == b"glTF", name
            assert int.from_bytes(body[4:8], "little") == 2, name
            assert int.from_bytes(body[8:12], "little") == len(body), name
            json_length = int.from_bytes(body[12:16], "little")
            document = json.loads(body[20:20 + json_length])
            assert document.get("meshes"), name
            for item in [*document.get("buffers", []), *document.get("images", [])]:
                uri = item.get("uri")
                assert not uri or uri.startswith("data:"), f"{name} requires external resource {uri}"

    asyncio.run(request_version_app(main_module.create_app(), scenario))


@pytest.mark.skipif(not (DIST_B / "index.html").exists(), reason="Build frontend-b before its story art smoke test")
def test_real_version_b_story_art_is_local_png_and_matches_the_source_assets():
    async def scenario(client):
        for name in STORY_SCENES_B:
            response = await client.get(f"/b/art/story/{name}.png")
            assert response.status_code == 200, name
            assert response.headers["content-type"].startswith("image/png"), name
            body = response.content
            assert body[:8] == b"\x89PNG\r\n\x1a\n", name
            assert body[12:16] == b"IHDR", name
            width = int.from_bytes(body[16:20], "big")
            height = int.from_bytes(body[20:24], "big")
            assert width >= 768 and height >= 512, f"Story art is too small: {name} ({width}x{height})"
            source = PUBLIC_MODELS_B.parent / "art" / "story" / f"{name}.png"
            assert body == source.read_bytes(), f"Stale B story image: {name}"

    asyncio.run(request_version_app(main_module.create_app(), scenario))
