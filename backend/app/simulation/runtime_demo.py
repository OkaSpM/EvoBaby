"""Chinese console view of live simulation state; no scripted simulation events."""
import argparse

from app.config import WorldConfig
from app.schemas import Action, Weather
from app.presentation import describe_belief, describe_task, describe_message
from app.simulation.engine import SimulationEngine
from app.simulation.events import EventType
from app.simulation.memory import BeliefType
from app.simulation.coordination_models import is_open

ACTION_LABELS = {
    Action.MOVE_N: "向北探索", Action.MOVE_S: "向南探索",
    Action.MOVE_E: "向东探索", Action.MOVE_W: "向西探索",
    Action.INSPECT: "观察", Action.COLLECT: "采集资源",
    Action.USE_BERRY: "食用浆果", Action.USE_CRYSTAL: "使用水晶",
    Action.USE_MOSS: "尝试苔藓", Action.SHARE_BELIEF: "分享信念",
    Action.REQUEST_VERIFY: "请求验证", Action.CLAIM_TASK: "认领任务",
}


def main():
    parser = argparse.ArgumentParser(description="EvoBaby · 五智能体探索演示")
    parser.add_argument("--turns", type=int, default=20, help="运行回合数（默认 20）")
    parser.add_argument("--seed", type=int, default=42, help="世界种子（默认 42）")
    args = parser.parse_args()
    if args.turns < 1:
        parser.error("回合数必须大于零")
    engine = SimulationEngine(WorldConfig(seed=args.seed))
    print(f"EvoBaby · 五智能体探索演示｜种子：{args.seed}")
    mode = "在线推理（失败时自动回退）" if engine.reasoning.provider else "离线推理"
    print(f"推理模式：{mode}")
    for _ in range(args.turns):
        events = engine.step()
        explored = set().union(*(set(a.known_cells) for a in engine.agents))
        weather = "晴朗" if engine.world.weather == Weather.SUNNY else "下雨"
        print(f"第 {engine.world.turn} 回合｜{weather}｜已探索 {len(explored)}/64 格")
        for agent in engine.agents:
            label = ACTION_LABELS[agent.current_action] if agent.current_action else "基地休整"
            print(f"  智能体 {agent.id}：{label}｜位置 {agent.position}｜能量 {agent.energy}")
        for event in events:
            if event.type == EventType.RETURNED_TO_BASE:
                print(f"  智能体 {event.agent_id} 能量耗尽，返回基地休整。")
            elif event.type == EventType.REACTIVATED:
                print(f"  智能体 {event.agent_id} 已恢复，可以继续探索。")
    memory = engine.belief_engine
    print(f"累计记录 {len(engine.event_log.events)} 条真实事件，提炼 {len(memory.evidence)} 条证据。")
    for agent in engine.agents:
        personal, shared = memory.memories_for(agent)
        print(f"智能体 {agent.id}：个人信念 {len(personal)} 条，采纳的共享信念 {len(shared)} 条")
        temporal = [b for b in personal if b.type == BeliefType.PERSISTENCE]
        conditional = [b for b in personal if b.type == BeliefType.CONDITIONAL_EFFECT]
        examples = [*temporal[:1], *conditional[:2]] or list(personal[:2])
        for belief in examples:
            print(f"  {describe_belief(belief)}")
    collective = engine.swarm.collective_knowledge(memory)
    print(f"集体知识：{len(collective)} 条")
    for belief in collective:
        print(f"  {describe_belief(belief)}")
    pending = [t for t in engine.task_engine.tasks if is_open(t)]
    print(f"累计任务 {len(engine.task_engine.tasks)} 项，当前待处理 {len(pending)} 项")
    for task in sorted(pending, key=lambda t: -t.priority)[:6]:
        print(f"  {describe_task(task)}")
    print("近期协作消息：")
    for message in engine.swarm.messages[-8:]:
        print(f"  {describe_message(message)}")
    records = engine.reasoning.records
    fallbacks = sum(r.fallback_reason is not None for r in records)
    print(f"累计结构化推理 {len(records)} 次，其中异常或配置缺失回退 {fallbacks} 次。")
    print("当前已接入自然条件假设、成熟度门控、调查修复、元认知演化与第二次攻击评估。")


if __name__ == "__main__":
    main()
