"""Run all sixteen player paths, then export observed results without tuning seeds."""
import argparse
import asyncio
from collections import defaultdict
import json
from pathlib import Path

from app.config import WorldConfig
from app.simulation.engine import SimulationEngine
from app.simulation.merged_game import LABELS, MergedGame


HYPOTHESES = {
    "AA": "走远部落", "AB": "敲锣部落", "AC": "慎信部落", "AD": "敲锣部落",
    "BA": "走远部落", "BB": "走远部落", "BC": "慎信部落", "BD": "糊涂部落",
    "CA": "走远部落", "CB": "胆小部落", "CC": "慎信部落", "CD": "糊涂部落",
    "DA": "走远部落", "DB": "健忘部落", "DC": "慎信部落", "DD": "健忘部落",
}


async def run_path(dispute, meta, seed=42, max_turns=240, observation_window=60):
    engine = SimulationEngine(WorldConfig(seed=seed))
    game = MergedGame(engine, max_attack_turns=observation_window)
    while engine.world.turn < max_turns:
        while game.awaiting_choice:
            point = game.awaiting_choice["point"]
            await game.choose(point, dispute if point == "D2" else meta)
        if game.complete:
            paradigm = game.paradigm()
            return {"path": dispute + meta, "choices": paradigm["choices"],
                    "name": paradigm["name"], "expected": HYPOTHESES[dispute + meta],
                    "matches_hypothesis": paradigm["name"] == HYPOTHESES[dispute + meta],
                    "turn": engine.world.turn, "metrics": paradigm["metrics"],
                    "verified_before": paradigm["verified_before_attack1"],
                    "verified_at_end": paradigm["verified_at_end"],
                    "choice_events": game.choice_events, "policy_events": game.policy_events}
        game.before_step()
        await engine.step_async()
        await game.after_step()
    raise RuntimeError(f"Path {dispute}{meta} did not finish by turn {max_turns}: {game.phase}")


async def run_matrix(seed=42, observation_window=60):
    paths = []
    for dispute in "ABCD":
        for meta in "ABCD":
            result = await run_path(dispute, meta, seed, observation_window=observation_window)
            paths.append(result)
            print(f"{result['path']}: {result['name']} @ {result['turn']}", flush=True)
    endings, metrics = defaultdict(list), defaultdict(list)
    for item in paths:
        endings[item["name"]].append(item["path"])
        signature = tuple(tuple(attack[field] for field in (
            "spread", "detect_turns", "repair_turns", "bad_actions", "contexts_before_adoption"
        )) for attack in item["metrics"].values())
        metrics[signature].append(item["path"])
    return {"seed": seed, "mode": "mock", "observation_window_turns": observation_window,
            "optional_choices": False, "paths": paths,
            "same_ending_groups": dict(endings),
            "indistinguishable_metric_groups": [group for group in metrics.values() if len(group) > 1],
            "different_ending_count": len(endings)}


def markdown(data):
    by_path = {item["path"]: item for item in data["paths"]}
    lines = ["# 结局矩阵实测", "", f"默认种子：{data['seed']}。模式：mock，全程本地规则。",
             f"每次攻击观察到终态或 {data['observation_window_turns']} 回合窗口结束；未解决的记录为 censored，时间保留 null，不当作 0 或成功。",
             "可选关口采用默认行为：D1 使用原调节器候选排序；D4 不加码。所有路径共用相同种子、窗口和初始世界。", "",
             "| 关口② / 关口③ | A 换地方再试 | B 三个人才算 | C 自己先试 | D 不定规矩 |",
             "|---|---|---|---|---|"]
    for option, label in zip("ABCD", LABELS["D2"]):
        cells = []
        for meta in "ABCD":
            item = by_path[option + meta]
            cells.append(item["name"] + (" *" if not item["matches_hypothesis"] else ""))
        lines.append(f"| {option} {label} | " + " | ".join(cells) + " |")
    lines += ["", "* 与 PRD 设计假设不同。按原顺序匹配规则，未调整参数追求预设结局。", "",
              "## 真实指标", "", "每组数字依次为：影响人数 / 检测回合 / 处理耗时 / 错误行动 / 采纳前场景数。空缺时间表示未发生。", "",
              "| 路径 | 第一次 | 第二次 | 终局回合 |", "|---|---|---|---|"]
    for item in data["paths"]:
        values = [" / ".join("未发生" if attack[key] is None else str(attack[key]) for key in (
            "spread", "detect_turns", "repair_turns", "bad_actions", "contexts_before_adoption"
        )) for attack in item["metrics"].values()]
        lines.append(f"| {item['path']} | {values[0]} | {values[1]} | {item['turn']} |")
    lines += ["", "## 哪些路分不开", ""]
    for name, paths in data["same_ending_groups"].items():
        lines.append(f"- {name}：{'、'.join(paths)}。这是结局标签相同，不等于底层指标相同。")
    groups = data["indistinguishable_metric_groups"]
    lines.append("- 五项核心指标在两次攻击中都完全相同：" + (
        "；".join("、".join(group) for group in groups) if groups else "无。") )
    lines += ["", "## 口径与限制", "",
              "- PREVENTED 的发现耗时取真实 detected_turn；普通争议取 disputed/detected turn。原引擎的 first_dispute 字段在 PREVENTED 时为空，不能当 0。",
              "- 影响人数含被注入的持有人，因此最少为 1；‘第二次没中招’按未扩散且无错误行动解释。",
              "- 采纳前场景数排除注入伪证，只计算真实行动证据；JSON 另保留 reported_contexts_before_adoption 供对照。",
              "- 处理耗时沿用原引擎 resolved_turn：包括修复、直接撤销和采纳前阻止，状态单独保留；直接删掉不是查清完整规则。",
              "- 错误行动统计到检测时；尚未检测时统计到观察窗口结束。调查人员主动做反证实验不被当作后续盲从错误。",
              "- 关口③在真实修复/直接撤销后触发；选择忽略导致一直未解决时，在公开窗口结束后允许流程复盘，界面明确说明未修复。",
              "- 首轮指标在关口③处冻结，避免第二轮继续运行反向改变第一轮比较值。",
              "- 相同的结局可以有不同数据。离线 mock 没有真实 token 开销，协作卡相应字段为 null。",
              "", "重跑：`PYTHONPATH=backend .venv/bin/python -m app.simulation.ending_matrix`。", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--window", type=int, default=60)
    args = parser.parse_args()
    data = asyncio.run(run_matrix(args.seed, args.window))
    docs = Path(__file__).resolve().parents[3] / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "ending_matrix.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    (docs / "ENDING_MATRIX.md").write_text(markdown(data))


if __name__ == "__main__":
    main()
