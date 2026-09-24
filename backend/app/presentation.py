"""Chinese presentation adapters; protocol fields and values remain English."""
from app.schemas import Region, Resource, Weather
from app.simulation.memory import Belief, BeliefStatus, BeliefType, ExpectedEffect

RESOURCE_LABELS = {Resource.BERRY: "浆果", Resource.CRYSTAL: "水晶", Resource.MOSS: "苔藓"}
REGION_LABELS = {Region.NW: "西北区", Region.NE: "东北区", Region.SW: "西南区", Region.SE: "东南区"}
WEATHER_LABELS = {Weather.SUNNY: "晴天", Weather.RAIN: "雨天"}
BELIEF_STATUS_LABELS = {
    BeliefStatus.TENTATIVE: "尚待验证", BeliefStatus.VERIFIED: "已验证",
    BeliefStatus.DISPUTED: "存在争议", BeliefStatus.REVOKED: "已撤销",
}


def describe_belief(belief: Belief) -> str:
    resource = RESOURCE_LABELS[belief.object]
    if belief.type == BeliefType.DISTRIBUTION:
        claim = f"{resource}在{REGION_LABELS[belief.conditions.region]}的出现概率估计"
        estimate = f"{belief.display_confidence:.0%}"
    elif belief.type == BeliefType.PERSISTENCE:
        claim = f"{resource}可能再生" if belief.expected_effect == ExpectedEffect.RENEWABLE else f"{resource}可能不再生（有限等待样本）"
        estimate = f"置信度 {belief.display_confidence:.0%}"
    else:
        conditions = []
        if belief.conditions.region:
            conditions.append(REGION_LABELS[belief.conditions.region])
        if belief.conditions.weather:
            conditions.append(WEATHER_LABELS[belief.conditions.weather])
        context = "、".join(conditions) or "所有场景"
        effect = "恢复能量" if belief.expected_effect == ExpectedEffect.ENERGY_POSITIVE else "损失能量"
        claim = f"{resource}在{context}下可能{effect}"
        estimate = f"置信度 {belief.display_confidence:.0%}"
    return f"{claim}｜{estimate}｜{BELIEF_STATUS_LABELS[belief.status]}｜证据 {belief.evidence_count} 条"


TASK_TYPE_LABELS = {"SURVIVAL": "生存补给", "VERIFICATION": "独立验证", "INVESTIGATION": "集体调查"}
TASK_STATUS_LABELS = {"OPEN": "待认领", "CLAIMED": "已认领", "IN_PROGRESS": "进行中",
                      "RESOLVED": "已完成", "EXPIRED": "已结束"}
MESSAGE_TYPE_LABELS = {"TASK_AVAILABLE": "发布任务", "REQUEST_VERIFICATION": "请求验证",
                       "SUBMIT_EVIDENCE": "提交证据", "SHARE_BELIEF": "分享信念", "RAISE_DISPUTE": "提出争议"}


def describe_task(task) -> str:
    contexts = []
    for required in task.required_contexts:
        parts = []
        if required.object:
            parts.append(RESOURCE_LABELS[required.object])
        if required.conditions.region:
            parts.append(REGION_LABELS[required.conditions.region])
        if required.conditions.weather:
            parts.append(WEATHER_LABELS[required.conditions.weather])
        contexts.append("、".join(parts) or "寻找可用的能量来源")
    claimants = "、".join(task.claimant_agent_ids) or "暂无"
    return (f"{task.id} {TASK_TYPE_LABELS[task.type]}｜{TASK_STATUS_LABELS[task.status]}｜优先级 {task.priority}"
            f"｜所需场景：{'；'.join(contexts)}｜认领者：{claimants}")


def describe_message(message) -> str:
    sender = "系统" if message.from_agent == "SYSTEM" else f"智能体 {message.from_agent}"
    target = "、".join(value for value in (message.task_id, message.belief_id, message.evidence_id) if value)
    return f"第 {message.turn} 回合：{sender}{MESSAGE_TYPE_LABELS[message.type]}（{target}）"
