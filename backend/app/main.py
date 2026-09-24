"""FastAPI application entrypoint."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from app.api.controller import SimulationController
from app.api.routes import router
from app.simulation.engine import SimulationEngine


def create_app(engine: SimulationEngine | None = None) -> FastAPI:
    controller = SimulationController(engine)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await controller.shutdown()

    application = FastAPI(
        title="EvoBaby Wild World API", version="0.8.0", lifespan=lifespan,
    )
    application.state.controller = controller
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["*"],
    )
    application.include_router(router)
    frontend_b_dist = Path(__file__).resolve().parents[2] / "frontend-b" / "dist"
    if frontend_b_dist.is_dir():
        @application.get("/b", include_in_schema=False)
        async def version_b_redirect():
            return RedirectResponse("/b/")

        application.mount("/b", StaticFiles(directory=frontend_b_dist, html=True), name="frontend-b")
    frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if frontend_dist.is_dir():
        # API routes are registered first; the built SPA handles every other path.
        application.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    return application


app = create_app()
