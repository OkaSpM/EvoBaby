import type { StateResponse } from "./types";

export interface SwarmValueItem {
  id: "experience" | "knowledge" | "evidence" | "metacognition";
  title: string;
  summary: string;
  detail: string;
  members?: { agentId: string; label: string }[];
}
export interface SwarmValueView { turn: number; items: SwarmValueItem[] }

const count = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const ids = (values: unknown) => Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))] : [];

export function resolveSwarmValues(state: StateResponse): SwarmValueView {
  const now = count(state.simulation?.turn) ?? 0;
  const reached = (turn: unknown) => count(turn) !== null && Number(turn) <= now;
  const agents = [...new Map((state.agents ?? []).map(agent => [agent.id, agent])).values()];
  const knownAgentIds = new Set(agents.map(agent => agent.id));
  const personal = agents.flatMap(agent => count(agent.personalBeliefCount) === null ? [] : [agent.personalBeliefCount]);
  const verified = agents.flatMap(agent => count(agent.verifiedBeliefCount) === null ? [] : [agent.verifiedBeliefCount]);
  const personalRange = personal.length ? Math.min(...personal) === Math.max(...personal)
    ? `已记录成员各 ${personal[0]} 条个人结论` : `${Math.min(...personal)}–${Math.max(...personal)} 条个人结论` : "个人结论条数未记录";
  const verifiedBeliefs = [...new Map((state.collectiveKnowledge ?? []).filter(belief => belief.status === "VERIFIED"
    && reached(belief.created_turn) && reached(belief.updated_turn)).map(belief => [belief.id, belief])).values()];
  const knowledgeKnown = Array.isArray(state.collectiveKnowledge);
  const tasks = [...new Map((state.tasks ?? []).filter(task => reached(task.created_turn) && reached(task.updated_turn)).map(task => [task.id, task])).values()];
  const taskIds = new Set(tasks.map(task => task.id));
  const taskBeliefIds = new Set(tasks.flatMap(task => task.belief_id ? [task.belief_id] : []));
  const linkedRules = verifiedBeliefs.filter(belief => taskBeliefIds.has(belief.id));
  const ruleSources = new Set(linkedRules.flatMap(belief => ids(belief.independent_agent_ids).filter(id => knownAgentIds.has(id))));
  const samples = new Set(tasks.flatMap(task => ids(task.evidence_ids)));
  const sampleMembers = new Set<string>();
  // Public sample authors and rule sources are different scopes; neither is inferred from task claims.
  for (const incident of state.incidents ?? []) {
    if (!incident.investigationTaskId || !taskIds.has(incident.investigationTaskId) || !reached(incident.injectedTurn)
      || [incident.detectedTurn, incident.disputedTurn, incident.resolvedTurn].some(turn => turn != null && !reached(turn))) continue;
    for (const sample of incident.evidenceByContext ?? []) {
      if (!sample.evidenceId || !["SUPPORT", "COUNTEREXAMPLE"].includes(sample.outcome)
        || !["NW", "NE", "SW", "SE"].includes(sample.region) || !["Sunny", "Rain"].includes(sample.weather)) continue;
      samples.add(sample.evidenceId);
      if (knownAgentIds.has(sample.agentId)) sampleMembers.add(sample.agentId);
    }
  }
  const unrecordedTasks = tasks.filter(task => !Array.isArray(task.evidence_ids)).length;
  const sampleListKnown = Array.isArray(state.tasks) && (!tasks.length || unrecordedTasks < tasks.length || samples.size > 0);
  const activeMeta = [...new Map((state.metaBeliefs ?? []).filter(rule => rule.active === true && reached(rule.created_turn)).map(rule => [rule.id, rule])).values()];
  const dimensions = [...new Set(activeMeta.flatMap(rule => rule.policy_effect?.dimensions ?? []))]
    .filter(dimension => dimension === "region" || dimension === "weather").map(dimension => dimension === "region" ? "区域" : "天气");
  const memberRecord = sampleMembers.size ? `公开关联样本记录了 ${sampleMembers.size} 位成员` : "样本作者未记录，不能据此统计实际贡献人数";
  const sourceRecord = ruleSources.size ? `关联规则另记 ${ruleSources.size} 位独立来源` : "关联规则暂无独立来源记录";
  return { turn: now, items: [
    { id: "experience", title: "个人经验分布", summary: personalRange,
      detail: personal.length === agents.length && personal.length ? "按成员当前持有的个人结论计数；条数差异不等于已经证明内容互补。" : "仅展示有记录成员的条数，不把缺失记录当作零。",
      members: agents.map(agent => ({ agentId: agent.id, label: count(agent.personalBeliefCount) === null ? "未记录" : `${agent.personalBeliefCount} 条` })) },
    { id: "knowledge", title: "共享与个人，并列看",
      summary: `${knowledgeKnown ? `共享已验证 ${verifiedBeliefs.length} 条` : "共享已验证条数未记录"} · ${verified.length ? `单个成员最多 ${Math.max(...verified)} 条已验证` : "个人已验证条数未记录"}`,
      detail: "个人已验证数包含采纳的共享结论。两侧口径不同，不相减计算协作净新增。" },
    { id: "evidence", title: "任务留下的依据",
      summary: `${sampleListKnown ? `已列 ${samples.size} 份关联样本索引` : "任务样本未记录"} · ${knowledgeKnown && Array.isArray(state.tasks) ? `${linkedRules.length} 条关联已验证规则` : "关联规则未记录"}`,
      detail: `${memberRecord}；${sourceRecord}。来源不等于本次任务提交者，样本原件仍需逐份核对。${unrecordedTasks ? `另有 ${unrecordedTasks} 项任务未保存样本清单。` : ""}` },
    { id: "metacognition", title: "已经生效的规矩",
      summary: activeMeta.length ? `${activeMeta.length} 条生效元认知${dimensions.length ? ` · 覆盖${dimensions.join("、")}` : ""}`
        : Array.isArray(state.metaBeliefs) ? "尚无生效元认知记录" : "元认知规则未记录",
      detail: activeMeta.length ? `${activeMeta.map(rule => `${rule.id} / T${rule.created_turn}`).join("；")}。按已启用规则统计，不代表它已证明改善了结果。`
        : "按实际规则记录，不根据部落名称、选择结果或认知造型推测已生效制度。" },
  ] };
}
