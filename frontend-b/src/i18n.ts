import type { Belief, Conditions, IncidentStatus, Resource, TaskStatus, TaskType, Weather } from "./types";

export const resourceLabel: Record<Resource, string> = { Berry: "浆果", Crystal: "水晶", Moss: "苔藓" };
export const resourceIcon: Record<Resource, string> = { Berry: "●", Crystal: "◆", Moss: "✦" };
export const weatherLabel: Record<Weather, string> = { Sunny: "晴朗", Rain: "降雨" };
export const regionLabel = { NW: "西北区", NE: "东北区", SW: "西南区", SE: "东南区" } as const;
export const beliefStatusLabel = { TENTATIVE: "尚待验证", VERIFIED: "已验证", DISPUTED: "存在争议", REVOKED: "已撤销" } as const;
export const taskTypeLabel: Record<TaskType, string> = { SURVIVAL: "生存补给", VERIFICATION: "独立验证", INVESTIGATION: "协同调查" };
export const taskStatusLabel: Record<TaskStatus, string> = { OPEN: "待认领", CLAIMED: "已认领", IN_PROGRESS: "进行中", RESOLVED: "已完成", EXPIRED: "已结束" };
export const incidentStatusLabel: Record<IncidentStatus, string> = {
  INJECTED: "已注入", VERIFYING: "验证拦截中", SPREADING: "正在传播", DISPUTED: "发现矛盾",
  INVESTIGATING: "协同调查中", REPAIRED: "已修复", REVOKED: "已撤销", PREVENTED: "扩散已阻止"
};
export const actionLabel: Record<string, string> = {
  MOVE_N: "向北探索", MOVE_S: "向南探索", MOVE_E: "向东探索", MOVE_W: "向西探索",
  INSPECT: "观察环境", COLLECT: "采集资源", USE_BERRY: "食用浆果", USE_CRYSTAL: "使用水晶",
  USE_MOSS: "尝试苔藓", SHARE_BELIEF: "分享信念", REQUEST_VERIFY: "请求验证", CLAIM_TASK: "认领任务"
};
export const effectLabel: Record<string, string> = {
  OBJECT_PRESENT: "可能出现", RENEWABLE: "可以再生", NOT_RENEWABLE: "不会再生",
  ENERGY_POSITIVE: "恢复能量", ENERGY_NEGATIVE: "消耗能量"
};

export function conditionsLabel(c: Conditions): string {
  const parts = [c.region ? regionLabel[c.region] : null, c.weather ? weatherLabel[c.weather] : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "所有场景";
}

export function beliefTitle(belief: Belief): string {
  if (belief.type === "DISTRIBUTION") return `${resourceLabel[belief.object]}在${belief.conditions.region ? regionLabel[belief.conditions.region] : "各区域"}的分布`;
  if (belief.type === "PERSISTENCE") return `${resourceLabel[belief.object]}${effectLabel[belief.expected_effect] ?? belief.expected_effect}`;
  return `${resourceLabel[belief.object]} · ${conditionsLabel(belief.conditions)} → ${effectLabel[belief.expected_effect] ?? belief.expected_effect}`;
}

export function taskResolutionLabel(value: string | null): string {
  const labels: Record<string, string> = { ENERGY_RECOVERED: "能量风险解除", BELIEF_REVOKED: "信念已撤销", BELIEF_VERIFIED: "信念已验证", INVESTIGATION_REQUIRED: "需要进一步调查", INSUFFICIENT_SUPPORT: "证据支持不足", BELIEF_REPAIRED: "规则已修复" };
  return value ? labels[value] ?? value : "";
}
