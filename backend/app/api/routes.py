"""Phase 8 REST routes with stable English contracts and localized errors."""
import json
from io import BytesIO
from pathlib import Path
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response

from app.api.controller import SimulationController
from app.api.models import (
    AgentDetail, ErrorResponse, EventsResponse, ExportResponse, MutationResponse,
    RunRequest, StateResponse,
    GameStartRequest, ChoiceRequest, AdvanceRequest, AccuseRequest, BroadcastRequest, InjectRequest,
)

router = APIRouter(prefix="/api")

ERROR_MESSAGES = {
    "KNOWLEDGE_NOT_MATURE": "集体知识尚未成熟，暂时不能注入错误记忆。",
    "FIRST_ATTACK_ALREADY_INJECTED": "第一次错误记忆已经注入。",
    "FIRST_ATTACK_MUST_EXIST": "必须先完成第一次攻击。",
    "FIRST_INCIDENT_NOT_RESOLVED": "第一次事故尚未完成修复或撤销。",
    "META_BELIEF_REQUIRED": "必须先形成有效的元认知原则。",
    "SECOND_ATTACK_ALREADY_INJECTED": "第二次错误记忆已经注入。",
    "NO_VALID_CORRUPTION_CANDIDATE": "当前没有满足实验约束的攻击候选。",
    "NO_REACHABLE_SUPPORT_CONTEXT": "当前世界没有可用的支持场景。",
    "GAME_NOT_STARTED": "请先开始部落旅程。",
    "NO_ACTIVE_TRACE": "尚未发生谣言事件。",
    "BELIEF_OWNER_MISMATCH": "这条常识不属于所选成员。",
}


def controller(request: Request) -> SimulationController:
    return request.app.state.controller


def operation_error(error: ValueError) -> JSONResponse:
    code = str(error)
    message = ERROR_MESSAGES.get(code, "当前操作无法完成。")
    return JSONResponse(status_code=409,
                        content=ErrorResponse(code=code, message=message).model_dump())


@router.get("/state", response_model=StateResponse)
async def get_state(request: Request, ground_truth: bool = False):
    return await controller(request).state(ground_truth=ground_truth)


@router.post("/simulation/step", response_model=MutationResponse)
async def step(request: Request):
    return MutationResponse(state=await controller(request).step())


@router.post("/simulation/run", response_model=MutationResponse)
async def run(request: Request, body: RunRequest = Body(default_factory=RunRequest)):
    return MutationResponse(state=await controller(request).run(body.speed))


@router.post("/simulation/pause", response_model=MutationResponse)
async def pause(request: Request):
    return MutationResponse(state=await controller(request).pause())


@router.post("/simulation/reset", response_model=MutationResponse)
async def reset(request: Request):
    current = controller(request)
    return MutationResponse(state=await current.reset(current.engine.config.seed))


@router.post("/simulation/new-seed", response_model=MutationResponse)
async def new_seed(request: Request):
    current = controller(request)
    return MutationResponse(state=await current.reset(current.engine.config.seed + 1))


@router.post("/corruption/inject", response_model=MutationResponse,
             responses={409: {"model": ErrorResponse}})
async def inject(request: Request, body: InjectRequest = Body(default_factory=InjectRequest)):
    try:
        return MutationResponse(state=await controller(request).inject(target_policy=body.target_policy))
    except ValueError as error:
        return operation_error(error)


@router.post("/corruption/inject-second", response_model=MutationResponse,
             responses={409: {"model": ErrorResponse}})
async def inject_second(request: Request):
    try:
        return MutationResponse(state=await controller(request).inject(second=True))
    except ValueError as error:
        return operation_error(error)


@router.get("/agents/{agent_id}", response_model=AgentDetail,
            responses={404: {"model": ErrorResponse}})
async def get_agent(agent_id: str, request: Request):
    try:
        return await controller(request).agent(agent_id)
    except KeyError:
        detail = ErrorResponse(code="AGENT_NOT_FOUND", message="未找到指定智能体。")
        return JSONResponse(status_code=404, content=detail.model_dump())


@router.get("/events", response_model=EventsResponse)
async def get_events(request: Request):
    return await controller(request).events()


@router.get("/export", response_model=ExportResponse)
async def export(request: Request):
    return await controller(request).export()


@router.post("/game/start", response_model=MutationResponse)
async def start_game(request: Request, body: GameStartRequest = Body(default_factory=GameStartRequest)):
    return MutationResponse(state=await controller(request).start_game(body.seed, body.optional_choices))


@router.post("/simulation/advance", response_model=MutationResponse)
async def advance(request: Request, body: AdvanceRequest = Body(default_factory=AdvanceRequest)):
    return MutationResponse(state=await controller(request).advance(body.turns))


@router.post("/choice", response_model=MutationResponse)
async def choose(request: Request, body: ChoiceRequest):
    try:
        return MutationResponse(state=await controller(request).choose(body.point, body.option))
    except ValueError as error:
        return operation_error(error)


@router.get("/replay/{turn}", response_model=StateResponse)
async def replay(turn: int, request: Request):
    try:
        return await controller(request).replay(turn)
    except KeyError:
        return JSONResponse(status_code=404, content={"code": "TURN_NOT_RECORDED", "message": "该回合没有已记录的快照。"})


@router.get("/beliefs/{belief_id}/trace")
async def trace(belief_id: str, request: Request):
    try:
        return await controller(request).trace(belief_id)
    except KeyError:
        return JSONResponse(status_code=404, content={"code": "BELIEF_NOT_FOUND", "message": "未找到这条常识。"})


@router.post("/trace/accuse")
async def accuse(request: Request, body: AccuseRequest):
    try:
        return await controller(request).accuse(body.agent_id, body.belief_id)
    except ValueError as error:
        return operation_error(error)


@router.post("/agents/{agent_id}/remove", response_model=MutationResponse)
async def remove_agent(agent_id: str, request: Request):
    try:
        return MutationResponse(state=await controller(request).remove_agent(agent_id))
    except KeyError:
        return JSONResponse(status_code=404, content={"code": "AGENT_NOT_FOUND", "message": "未找到指定成员。"})
    except ValueError as error:
        return operation_error(error)


@router.post("/swarm/broadcast", response_model=MutationResponse)
async def broadcast(request: Request, body: BroadcastRequest):
    try:
        return MutationResponse(state=await controller(request).set_broadcast(body.enabled))
    except ValueError as error:
        return operation_error(error)


@router.get("/paradigm")
async def paradigm(request: Request):
    return await controller(request).paradigm()


@router.get("/paradigm/matrix")
async def ending_matrix():
    path = Path(__file__).resolve().parents[3] / "docs" / "ending_matrix.json"
    if not path.exists():
        return {"status": "not_measured", "rows": []}
    return json.loads(path.read_text())


@router.get("/paradigm/cards/{card_id}")
async def saved_card(card_id: str, request: Request):
    card = controller(request).cards.get(card_id)
    if card is None:
        return JSONResponse(status_code=404, content={"code": "CARD_NOT_FOUND", "message": "这张部落卡不在本次展位记录中。"})
    return card


@router.get("/paradigm/cards/{card_id}/qr")
async def card_qr(card_id: str, request: Request):
    if card_id not in controller(request).cards:
        return JSONResponse(status_code=404, content={"code": "CARD_NOT_FOUND", "message": "未找到部落卡。"})
    import qrcode
    from qrcode.image.svg import SvgPathImage
    url = str(request.base_url).rstrip("/") + f"/api/paradigm/cards/{card_id}"
    output = BytesIO()
    qrcode.make(url, image_factory=SvgPathImage).save(output)
    return Response(output.getvalue(), media_type="image/svg+xml")
