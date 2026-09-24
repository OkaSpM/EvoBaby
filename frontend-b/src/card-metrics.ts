import type { CardMetric } from "./types";

const duration = (value: number | null | undefined, absent: string) => value == null ? absent
  : !Number.isFinite(value) || value < 0 ? "时间记录异常" : `${value} 回合`;

export function cardMetricLabels(metric: CardMetric) {
  const historical = typeof metric.detect_turns === "number" && metric.detect_turns < 0 && metric.status === "PREVENTED";
  return {
    detection: historical ? "历史证据时间 *" : duration(metric.detect_turns, "发现时间未记录"),
    resolution: duration(metric.repair_turns, "观察期内未结案"),
    note: historical ? `* 发现耗时未可靠记录；原始值 ${metric.detect_turns}，不计作负耗时。`
      : typeof metric.detect_turns === "number" && metric.detect_turns < 0 ? `发现时间异常，保留原始值 ${metric.detect_turns} 待核验。` : null,
  };
}
