"""Isolated local B entrypoint. Never mounts or mutates the A front end."""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.b_controller import BSimulationController
from app.api.b_routes import router as b_router
from app.api.routes import router


def create_b_app(controller=None, *, frontend_dist=None, card_directory=None):
    controller = controller or BSimulationController(card_directory=card_directory)

    @asynccontextmanager
    async def lifespan(_):
        yield
        await controller.shutdown()

    application = FastAPI(title="EvoBaby B Collaboration", version="1.0-b", lifespan=lifespan)
    application.state.controller = controller
    application.include_router(router)
    application.include_router(b_router)

    @application.get("/", include_in_schema=False)
    @application.get("/b", include_in_schema=False)
    async def open_b():
        return RedirectResponse("/b/")

    default = Path(__file__).resolve().parents[2] / "frontend-b" / "dist-next"
    dist = Path(frontend_dist or os.environ.get("EVOBABY_B_FRONTEND_DIST", default))
    if dist.is_dir():
        application.mount("/b", StaticFiles(directory=dist, html=True), name="frontend-b")
    return application


app = create_b_app()
