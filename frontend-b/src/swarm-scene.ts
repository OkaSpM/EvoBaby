import type { Incident, Region, Resource, StateResponse, Task, TaskStatus, TaskType, Weather } from "./types";

export interface SwarmEvidenceView {
  evidenceId: string; agentId: string; region: Region; weather: Weather;
  outcome: "SUPPORT" | "COUNTEREXAMPLE"; label: string;
}
export interface SwarmContextView {
  id: string; object: Resource | null; region: Region | null; weather: Weather | null;
  label: string; completed: boolean; claimantAgentIds: string[];
}
export interface SwarmStepView {
  id: "initiate" | "verify" | "evidence" | "result"; label: string;
  state: "pending" | "active" | "done" | "attention"; detail: string; turn: number | null;
}
export interface SwarmResult {
  kind: "pending" | "repaired" | "revoked" | "verified" | "prevented" | "recovered" | "expired" | "resolved" | "unconfirmed";
  label: string; tone: "neutral" | "success" | "warning"; turn: number | null;
}
export interface SwarmTaskView {
  id: string; type: TaskType; status: TaskStatus; priority: number; title: string; description: string;
  beliefId: string | null; createdTurn: number; updatedTurn: number; isOpen: boolean; statusLabel: string;
  claimantAgentIds: string[]; contexts: SwarmContextView[]; completedCount: number; totalContexts: number;
  evidenceCount: number | null; steps: SwarmStepView[]; result: SwarmResult; evidence: SwarmEvidenceView[];
}
export interface SwarmMemberView {
  agentId: string; mode: "removed" | "resting" | "task" | "exploring";
  taskId: string | null; roleLabel: string; detail: string; contextIds: string[];
}
export interface SwarmMessageView {
  id: string; turn: number; kind: string; agentId: string; beliefId: string | null; actionLabel: string; content: string;
}
export interface SwarmSceneView {
  turn: number; tasks: SwarmTaskView[]; focusTask: SwarmTaskView | null; latestResult: SwarmTaskView | null;
  members: SwarmMemberView[]; messages: SwarmMessageView[]; evidence: SwarmEvidenceView[];
  activeTaskCount: number; claimedAgentCount: number; broadcastEnabled: boolean | null;
}

type TaskWithEvidence = Task & {
  claimed_contexts?: { agent_id: string; context_id: string; claimed_turn: number }[];
  evidence_ids?: string[];
};
const taskNames: Record<TaskType, string> = { INVESTIGATION: "跨情境调查", VERIFICATION: "独立互证", SURVIVAL: "寻找补给" };
const taskOrder: Record<TaskType, number> = { INVESTIGATION: 0, VERIFICATION: 1, SURVIVAL: 2 };
const statusNames: Record<TaskStatus, string> = { OPEN: "等待认领", CLAIMED: "已认领", IN_PROGRESS: "正在收证", RESOLVED: "已结案", EXPIRED: "已中止" };
const resourceNames: Record<Resource, string> = { Berry: "浆果", Crystal: "晶石", Moss: "苔藓" };
const regionNames: Record<Region, string> = { NW: "西北", NE: "东北", SW: "西南", SE: "东南" };
const weatherNames: Record<Weather, string> = { Sunny: "晴天", Rain: "雨天" };
const messageNames: Record<string, string> = {
  TASK_AVAILABLE: "发布协作任务", SHARE_BELIEF: "分享观察结论", REQUEST_VERIFICATION: "请求独立核验",
  SUBMIT_EVIDENCE: "提交证据", RAISE_DISPUTE: "提出异议",
};
const unique = (values: string[]) => [...new Set(values)];
const isTurn = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOpen = (task: Task) => task.status !== "RESOLVED" && task.status !== "EXPIRED";

function resultFor(task: Task, incident: Incident | undefined, now: number): SwarmResult {
  if (isOpen(task)) return { kind: "pending", label: "等待核验结果", tone: "neutral", turn: null };
  if (task.status === "EXPIRED") {
    const label = task.resolution === "INVESTIGATION_REQUIRED" ? "核验中止，转入调查"
      : task.resolution === "INSUFFICIENT_SUPPORT" ? "证据不足，暂未通过" : "任务已中止";
    return { kind: "expired", label, tone: "warning", turn: task.updated_turn };
  }
  const resolved = incident && isTurn(incident.resolvedTurn) && incident.resolvedTurn <= now;
  if (resolved && incident.status === "REPAIRED") return { kind: "repaired", label: "知识已修正", tone: "success", turn: incident.resolvedTurn };
  if (task.resolution === "BELIEF_REVOKED" || (resolved && incident.status === "REVOKED")) {
    return { kind: "revoked", label: "旧结论已撤回", tone: "warning", turn: resolved ? incident.resolvedTurn : task.updated_turn };
  }
  if (resolved && incident.status === "PREVENTED") return { kind: "prevented", label: "采纳前已阻止", tone: "success", turn: incident.resolvedTurn };
  if (task.resolution === "BELIEF_VERIFIED") return { kind: "verified", label: "结论已通过互证", tone: "success", turn: task.updated_turn };
  if (task.resolution === "ENERGY_RECOVERED") return { kind: "recovered", label: "体力已回稳", tone: "success", turn: task.updated_turn };
  if (task.resolution === "BELIEF_REPAIRED") return { kind: "unconfirmed", label: "任务已结束，修正待确认", tone: "neutral", turn: task.updated_turn };
  return { kind: "resolved", label: "任务已结束", tone: "neutral", turn: task.updated_turn };
}

export function resolveSwarmScene(state: StateResponse): SwarmSceneView {
  const now = isTurn(state.simulation?.turn) ? state.simulation.turn : 0;
  const agents = state.agents ?? [];
  const removed = new Set(state.removed_agents ?? []);
  const canWork = (id: string, taskId: string) => {
    const agent = agents.find(item => item.id === id);
    return !!agent && !agent.removed && !removed.has(id)
      && !(isTurn(agent.unavailableUntilTurn) && agent.unavailableUntilTurn > now)
      && (!agent.currentTaskId || agent.currentTaskId === taskId);
  };
  // A future-updated task cannot be reconstructed from its final fields; real replay supplies its own snapshot.
  const sourceTasks = (state.tasks ?? []).filter(task => isTurn(task.created_turn) && task.created_turn <= now
    && isTurn(task.updated_turn) && task.updated_turn <= now);
  const taskViews = sourceTasks.map((task: TaskWithEvidence): SwarmTaskView => {
    const open = isOpen(task);
    const requirements = task.required_contexts ?? [];
    const requirementIds = new Set(requirements.map(item => item.id));
    const claims = (task.claimed_contexts ?? []).filter(claim => isTurn(claim.claimed_turn) && claim.claimed_turn <= now
      && requirementIds.has(claim.context_id) && canWork(claim.agent_id, task.id));
    const claimantAgentIds = open ? unique(task.claimed_contexts === undefined
      ? (task.claimant_agent_ids ?? []).filter(id => canWork(id, task.id)) : claims.map(claim => claim.agent_id)) : [];
    const completedIds = new Set((task.completed_context_ids ?? []).filter(id => requirementIds.has(id)));
    const contexts = requirements.map(requirement => {
      const region = requirement.conditions?.region ?? null;
      const weather = requirement.conditions?.weather ?? null;
      const object = requirement.object ?? null;
      return {
        id: requirement.id, object, region, weather, completed: completedIds.has(requirement.id),
        label: [object ? resourceNames[object] : "资源不限", region ? regionNames[region] : "区域不限", weather ? weatherNames[weather] : "天气不限"].join(" · "),
        claimantAgentIds: open ? unique(claims.filter(claim => claim.context_id === requirement.id).map(claim => claim.agent_id)) : [],
      };
    });
    const incident = (state.incidents ?? []).find(item => item.investigationTaskId === task.id
      && isTurn(item.injectedTurn) && item.injectedTurn <= now
      && [item.detectedTurn, item.disputedTurn, item.resolvedTurn].every(turn => !isTurn(turn) || turn <= now));
    const evidence: SwarmEvidenceView[] = [];
    const evidenceIds = new Set<string>();
    for (const item of incident?.evidenceByContext ?? []) {
      if (evidenceIds.has(item.evidenceId) || !["SUPPORT", "COUNTEREXAMPLE"].includes(item.outcome)) continue;
      evidenceIds.add(item.evidenceId);
      evidence.push({ evidenceId: item.evidenceId, agentId: item.agentId, region: item.region, weather: item.weather,
        outcome: item.outcome, label: item.outcome === "COUNTEREXAMPLE" ? "反例" : "支持样本" });
    }
    evidence.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.region.localeCompare(b.region)
      || a.weather.localeCompare(b.weather) || a.outcome.localeCompare(b.outcome) || a.evidenceId.localeCompare(b.evidenceId));
    const count = task.evidence_ids === undefined ? null : unique(task.evidence_ids).length;
    const hasEvidence = (count ?? 0) > 0 || evidence.length > 0 || completedIds.size > 0;
    const result = resultFor(task, incident, now);
    const firstClaim = claims.length ? Math.min(...claims.map(claim => claim.claimed_turn)) : null;
    const steps: SwarmStepView[] = [
      { id: "initiate", label: "发起", state: "done", detail: taskNames[task.type], turn: task.created_turn },
      { id: "verify", label: "认领核验", state: hasEvidence ? "done" : claimantAgentIds.length ? "active" : "pending",
        detail: claimantAgentIds.length ? `${claimantAgentIds.length} 位成员已认领` : hasEvidence ? "已有核验提交" : open ? "等待成员认领" : "认领记录未保留", turn: firstClaim },
      { id: "evidence", label: "收证", state: hasEvidence ? open ? "active" : "done" : "pending",
        detail: `${completedIds.size}/${contexts.length} 个情境${count === null ? " · 证据数未记录" : ` · ${count} 条证据`}`, turn: null },
      { id: "result", label: "结果", state: result.kind === "pending" ? "pending" : result.tone === "warning" ? "attention" : result.tone === "success" ? "done" : "attention",
        detail: result.label, turn: result.turn },
    ];
    const objects = unique(contexts.flatMap(context => context.object ? [resourceNames[context.object]] : []));
    return { id: task.id, type: task.type, status: task.status, priority: task.priority,
      title: [taskNames[task.type], ...objects].join(" · "), description: task.description ?? "", beliefId: task.belief_id ?? null,
      createdTurn: task.created_turn, updatedTurn: task.updated_turn, isOpen: open, statusLabel: statusNames[task.status],
      claimantAgentIds, contexts, completedCount: completedIds.size, totalContexts: contexts.length,
      evidenceCount: count, steps, result, evidence };
  });
  const active = taskViews.filter(task => task.isOpen).sort((a, b) => taskOrder[a.type] - taskOrder[b.type]
    || b.priority - a.priority || a.createdTurn - b.createdTurn || a.id.localeCompare(b.id));
  const closed = taskViews.filter(task => !task.isOpen).sort((a, b) => b.updatedTurn - a.updatedTurn || b.createdTurn - a.createdTurn || a.id.localeCompare(b.id));
  const tasks = active.length ? active : closed.slice(0, 1);
  const members: SwarmMemberView[] = agents.map(agent => {
    if (agent.removed || removed.has(agent.id)) return { agentId: agent.id, mode: "removed", taskId: null, roleLabel: "已离队", detail: "本轮不再参与协作", contextIds: [] };
    if (isTurn(agent.unavailableUntilTurn) && agent.unavailableUntilTurn > now) return { agentId: agent.id, mode: "resting", taskId: null, roleLabel: "营地休整", detail: `休整至第 ${agent.unavailableUntilTurn} 回合`, contextIds: [] };
    const task = active.find(item => item.id === agent.currentTaskId);
    if (!task) return { agentId: agent.id, mode: "exploring", taskId: null, roleLabel: "自主探索", detail: agent.currentAction || "观察周围环境", contextIds: [] };
    const contexts = task.contexts.filter(context => context.claimantAgentIds.includes(agent.id));
    return { agentId: agent.id, mode: "task", taskId: task.id, roleLabel: taskNames[task.type],
      detail: contexts.length ? contexts.map(context => context.label).join("；") : "具体情境未记录", contextIds: contexts.map(context => context.id) };
  });
  const messages: SwarmMessageView[] = [];
  const messageIds = new Set<string>();
  const publicMessages = [...(state.story_events ?? [])].filter(event => isTurn(event.turn) && event.turn <= now && messageNames[event.kind])
    .sort((a, b) => b.turn - a.turn || a.id.localeCompare(b.id));
  for (const event of publicMessages) {
    if (messageIds.has(event.id)) continue;
    messageIds.add(event.id);
    messages.push({ id: event.id, turn: event.turn, kind: event.kind, agentId: event.agent_id,
      beliefId: event.belief_id ?? null, actionLabel: messageNames[event.kind], content: event.content ?? "" });
    if (messages.length === 6) break;
  }
  const focusTask = tasks[0] ?? null;
  return { turn: now, tasks, focusTask, latestResult: closed[0] ?? null, members, messages,
    evidence: focusTask?.evidence ?? [], activeTaskCount: active.length,
    claimedAgentCount: members.filter(member => member.mode === "task").length,
    broadcastEnabled: typeof state.broadcast_enabled === "boolean" ? state.broadcast_enabled : null };
}
