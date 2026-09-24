"""Commands only available in the isolated B application."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.schemas import StrictModel


router = APIRouter(prefix="/api/b")


class BAccuseRequest(StrictModel):
    incident_id: str = Field(min_length=1, max_length=40)
    agent_id: str = Field(min_length=1, max_length=20)
    belief_id: str = Field(min_length=1, max_length=80)


class BContinueRequest(StrictModel):
    turns: int = Field(default=60, ge=1, le=100)


@router.post("/trace/accuse")
async def accuse(request: Request, body: BAccuseRequest):
    try:
        return await request.app.state.controller.accuse_case(body.incident_id, body.agent_id, body.belief_id)
    except ValueError as error:
        return JSONResponse(status_code=409, content={"code": str(error), "message": "请核对所选案件与成员记忆。"})


@router.post("/continue")
async def continue_investigation(request: Request, body: BContinueRequest):
    try:
        state = await request.app.state.controller.continue_investigation(body.turns)
        return {"state": state}
    except ValueError as error:
        return JSONResponse(status_code=409, content={"code": str(error), "message": "当前没有可继续的未结调查。"})
