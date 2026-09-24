import type { AgentSummary, BCognitionFeedback, CognitionStage } from "./types";

export const COGNITION_STAGES = [
  { stage: 1, numeral: "I", name: "探索者", principle: "亲自试试看", garment: "单叶短衣 · 采集袋", goal: "在不同条件下亲自实验，留下带来源的记录。" },
  { stage: 2, numeral: "II", name: "记录者", principle: "记得依据是什么", garment: "圆叶兜帽 · 树皮记录册", goal: "贡献自己的实验，与同伴的独立证据一起核验。" },
  { stage: 3, numeral: "III", name: "求证者", principle: "自己的实验，与同伴独立互证", garment: "宽叶帽 · 观察镜与样本", goal: "已贡献亲历证据完成共同核验；下一步参与反证调查，再把修正结论传给同伴。" },
  { stage: 4, numeral: "IV", name: "引路者", principle: "纠错，也帮助同伴", garment: "五叶扇饰 · 长披风与木杖", goal: "继续探索；高阶也可能信错，发现后继续修正。" },
] as const;

export function cognitionStage(value?: number): CognitionStage {
  return value === 2 || value === 3 || value === 4 ? value : 1;
}

export function cognitionLabel(value?: number) {
  return COGNITION_STAGES[cognitionStage(value) - 1];
}

export const COGNITION_FEEDBACK_LABELS: Record<BCognitionFeedback["state"], string> = {
  stable: "暂无待复核记录", review: "待复核", misaligned: "判断失准", rebuilding: "正在重建", recovered: "已复核",
};

export function cognitionFeedback(value?: BCognitionFeedback | null) {
  if (!value || !Object.hasOwn(COGNITION_FEEDBACK_LABELS, value.state)) return null;
  return { ...value, label: COGNITION_FEEDBACK_LABELS[value.state],
    sinceTurn: Number.isInteger(value.since_turn) && value.since_turn >= 0 ? value.since_turn : null };
}

export function resolveCognitionFeedback(agent: Pick<AgentSummary, "cognitionFeedback">) {
  return cognitionFeedback(agent.cognitionFeedback);
}
