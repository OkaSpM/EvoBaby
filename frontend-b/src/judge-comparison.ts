import type { Incident } from "./types";

const terminalStatuses = new Set(["REPAIRED", "REVOKED", "PREVENTED"]);

export function judgeIncidentOutcome(incident?: Incident) {
  if (!incident) return "状态未记录";
  if (incident.status === "REPAIRED") return "已修复";
  if (incident.status === "REVOKED") return "已撤回";
  if (incident.status === "PREVENTED") return "采纳前阻止";
  return "观察中";
}

export function judgeComparisonComplete(first?: Incident, second?: Incident) {
  return !!first && !!second && terminalStatuses.has(first.status) && terminalStatuses.has(second.status);
}

export function judgeUsesHistoricalDiscovery(value: number | null | undefined, incident?: Incident) {
  return value != null && Number.isFinite(value) && value < 0 && incident?.status === "PREVENTED";
}

export function judgeMetricValue(value: number | null | undefined, eventTime: boolean | "closure" = false, incident?: Incident): string | number {
  if (value != null && Number.isFinite(value)) {
    if (eventTime && value < 0) return eventTime !== "closure" && judgeUsesHistoricalDiscovery(value, incident) ? "历史证据时间*" : "时间记录异常";
    return value;
  }
  return eventTime && incident && !terminalStatuses.has(incident.status) ? "未发生" : "未记录";
}
