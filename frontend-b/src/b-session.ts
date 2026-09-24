import type { StateResponse } from "./types";

export function withBFeedback(state: StateResponse): StateResponse {
  const feedback = state.merged_game?.b_review?.cognition_feedback;
  if (!feedback) return state;
  return { ...state, agents: state.agents.map(agent => ({ ...agent, cognitionFeedback: feedback[agent.id] ?? null })) };
}

export type MissionAction = "begin" | "choose" | "investigate" | "continue" | "review" | "advance";
export interface Mission { title: string; detail: string; action: MissionAction; label: string }

export function currentMission(state: StateResponse): Mission {
  const review = state.merged_game?.b_review;
  const closure = review?.closure;
  if (state.awaiting_choice) return { title: "部落正等你定下规矩", detail: "这次决定会改变接下来的验证方式。", action: "choose", label: "部落决定" };
  if (closure?.status === "success") return { title: "两条伪记忆均已查明", detail: "部落完成规则修复，你也确认了两次源头。", action: "review", label: "回看协作过程" };
  if (closure?.can_continue) return { title: closure.title, detail: closure.reason, action: "continue", label: "继续调查" };
  if (closure?.status === "awaiting_trace") return { title: "规则已修复，源头还待确认", detail: `还有 ${closure.pending_incident_ids.length} 起事件没有完成源头指认。`, action: "investigate", label: "追查源头" };
  if (closure?.observation_complete) return { title: closure.title, detail: closure.reason,
    action: closure.pending_incident_ids.length ? "investigate" : "review",
    label: closure.pending_incident_ids.length ? "追查源头" : "回看调查结果" };
  if (!state.merged_game?.enabled) return { title: "找出混进部落的错误记忆", detail: "五名成员各自探索、交换经历；你决定他们如何核验。", action: "begin", label: "开始旅程" };
  const incident = state.incidents.at(-1);
  if (!incident) return { title: "先积累可以相互验证的经历", detail: "部落正在探索 8×8 荒野，留下各自的行动记录。", action: "advance", label: "推进到下一关口" };
  if (incident.detectedTurn == null) return { title: `第 ${incident.attackNumber} 起事件：还没有发现矛盾`, detail: "各自经历与流传的说法可能不同。调查依据原始记录，不按赞同人数定真假。", action: "investigate", label: "查看记忆来源" };
  if (incident.status === "REPAIRED") return { title: `第 ${incident.attackNumber} 起事件：部落已修正规则`, detail: "查明错误条件与找到最初那条记忆分别记录。", action: "investigate", label: "核对源头" };
  return { title: `第 ${incident.attackNumber} 起事件：正在分头补证`, detail: `第 ${incident.detectedTurn} 回合提出矛盾。还需用真实实验判断旧说法适用于哪些条件。`, action: "review", label: "查看分工与证据" };
}
