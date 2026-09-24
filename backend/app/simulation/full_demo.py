"""Condition-driven, deterministic walkthrough of the complete experiment."""
import argparse

from app.config import WorldConfig
from app.simulation.corruption import IncidentStatus
from app.simulation.engine import SimulationEngine


TERMINAL = {IncidentStatus.REPAIRED, IncidentStatus.REVOKED, IncidentStatus.PREVENTED}


def run(seed: int = 42, max_turns: int = 120) -> SimulationEngine:
    engine = SimulationEngine(WorldConfig(seed=seed))
    print(f"EvoBaby 完整演示启动 · 种子 {seed}")
    first_injected = second_injected = False
    observed_statuses: dict[str, IncidentStatus] = {}

    while engine.world.turn < max_turns:
        engine.step()
        maturity = engine.knowledge_maturity
        if engine.first_attack_ready and not first_injected:
            incident = engine.inject_false_memory()
            first_injected = True
            print(f"回合 {engine.world.turn}：知识成熟，首次错误记忆已注入 {incident.target_agent_id}。")

        for incident in engine.corruption.incidents:
            previous = observed_statuses.get(incident.id)
            if incident.status != previous:
                observed_statuses[incident.id] = incident.status
                print(f"回合 {engine.world.turn}：事故 {incident.id} → {incident.status.value}")

        if engine.second_attack_ready and not second_injected:
            incident = engine.inject_second_false_memory()
            second_injected = True
            print(f"回合 {engine.world.turn}：元认知已生效，第二次错误记忆注入 {incident.target_agent_id}。")

        if (second_injected and len(engine.corruption.incidents) == 2
                and engine.corruption.incidents[1].status in TERMINAL):
            comparison = engine.metrics.comparison
            if comparison is None:
                raise RuntimeError("第二次攻击结束后未生成对比指标")
            print(
                f"回合 {engine.world.turn}：演示完成。传播减少 {comparison.spread_reduction} 人，"
                f"错误行动减少 {comparison.incorrect_action_reduction} 次，"
                f"采纳前新增 {comparison.additional_contexts_before_adoption} 个验证场景。"
            )
            return engine

    raise RuntimeError(f"完整演示未能在 {max_turns} 回合内结束")


def main() -> None:
    parser = argparse.ArgumentParser(description="运行 EvoBaby 两轮认知攻击完整演示")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-turns", type=int, default=120)
    args = parser.parse_args()
    run(seed=args.seed, max_turns=args.max_turns)


if __name__ == "__main__":
    main()
