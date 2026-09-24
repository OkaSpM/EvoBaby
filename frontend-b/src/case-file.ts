import type { BeliefTrace, Incident, IncidentStatus, Region, StateResponse, TraceRecord, Weather } from "./types";

export interface CaseEvidence {
  id: string; agentId: string; turn: number | null; region: Region; weather: Weather; delta: number | null;
  outcome: "SUPPORT" | "COUNTEREXAMPLE"; receiptVerified: boolean;
  timing: "current-incident" | "historical" | "unknown"; basis: "investigation" | "belief-reference" | "first-counterexample";
}
export interface CaseParticipant { agentId: string; evidenceCount: number; supportCount: number; counterexampleCount: number }
export interface CaseStep {
  id: "injection" | "counterexample" | "verification" | "resolution"; label: string; detail: string;
  turn: number | null; state: "done" | "active" | "pending" | "unknown"; evidenceIds: string[];
}
export interface CaseDiscovery {
  turn: number | null; elapsedTurns: number | null;
  basis: "choice-alert" | "incident-detected" | "historical-evidence" | "unrecorded";
  label: string; detail: string; evidenceIds: string[];
  disputedTurn: number | null; disputedElapsedTurns: number | null; historicalEvidenceTurn: number | null;
}
export interface CaseFileView {
  id: string; attackNumber: number; status: IncidentStatus; statusLabel: string; summary: string;
  injectedTurn: number; resolvedTurn: number | null; sourceConfirmed: boolean;
  subject: { id: string; title: string } | null; replacement: { id: string; title: string } | null;
  origin: { agentId: string; beliefId: string } | null;
  lineage: { senderAgentId: string; parentBeliefId: string; receiverAgentId: string; childBeliefId: string }[];
  evidence: CaseEvidence[]; participants: CaseParticipant[]; steps: CaseStep[]; limitations: string[];
  firstCounterexample: CaseEvidence | null; earliestVerifiedCounterexample: CaseEvidence | null;
  discovery: CaseDiscovery;
}
export interface CaseFileOptions { traces?: Record<string, BeliefTrace>; replaying?: boolean }

const objectLabels: Record<string, string> = { Moss: "苔藓", Berry: "浆果", Crystal: "水晶" };
const regionLabels: Record<string, string> = { NW: "西北区", NE: "东北区", SW: "西南区", SE: "东南区" };
const weatherLabels: Record<string, string> = { Rain: "雨天", Sunny: "晴天" };
const terminal = new Set<IncidentStatus>(["REPAIRED", "REVOKED", "PREVENTED"]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const turn = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const region = (value: unknown): value is Region => typeof value === "string" && Object.hasOwn(regionLabels, value);
const weather = (value: unknown): value is Weather => typeof value === "string" && Object.hasOwn(weatherLabels, value);

function confirmed(state: StateResponse, incident: Incident): boolean {
  if (!incident.rootBeliefId || !incident.targetAgentId) return false;
  const traceGame = record(state.trace_game);
  const rounds = Array.isArray(traceGame.rounds) ? traceGame.rounds : [];
  return [...rounds, traceGame.current].some(value => {
    const item = record(value);
    const result = record(item.result);
    return item.incident_id === incident.id && result.correct === true
      && [result.turn, item.solved_turn].every(value => !turn(value) || value <= state.simulation.turn);
  });
}

function caseTask(state: StateResponse, incident: Incident) {
  const now = state.simulation.turn;
  return (state.tasks ?? []).find(task => task.id === incident.investigationTaskId
    && task.type === "INVESTIGATION" && turn(task.created_turn) && task.created_turn <= now
    && turn(task.updated_turn) && task.updated_turn <= now);
}

export function caseTraceIds(state: StateResponse, incident: Incident): string[] {
  if (!turn(incident.injectedTurn) || incident.injectedTurn > state.simulation.turn) return [];
  const revealed = confirmed(state, incident);
  const subject = caseTask(state, incident)?.belief_id ?? (revealed ? incident.rootBeliefId : null);
  const replacement = revealed && incident.status === "REPAIRED" && turn(incident.resolvedTurn)
    && incident.resolvedTurn <= state.simulation.turn ? incident.replacementBeliefId : null;
  return [...new Set([subject, replacement].filter((id): id is string => !!id))].slice(0, 2);
}

function titleFrom(value: unknown, now: number): string | null {
  const belief = record(value), conditions = record(belief.conditions);
  if (!turn(belief.created_turn) || belief.created_turn > now || !text(belief.object) || !Object.hasOwn(objectLabels, String(belief.object))) return null;
  if (belief.type !== "CONDITIONAL_EFFECT") return text(belief.proposition)?.slice(0, 240) ?? null;
  if (belief.expected_effect !== "ENERGY_POSITIVE" && belief.expected_effect !== "ENERGY_NEGATIVE") return null;
  const contexts = [region(conditions.region) ? regionLabels[conditions.region] : null,
    weather(conditions.weather) ? weatherLabels[conditions.weather] : null].filter(Boolean);
  return `${objectLabels[String(belief.object)]} · ${contexts.length ? contexts.join(" / ") : "所有场景"} → ${belief.expected_effect === "ENERGY_POSITIVE" ? "恢复能量" : "消耗能量"}`;
}

function publicTitle(id: string, state: StateResponse, records: Map<string, TraceRecord>): string {
  const belief = (state.collectiveKnowledge ?? []).find(item => item.id === id);
  return titleFrom(belief, state.simulation.turn)
    ?? titleFrom(record(records.get(id)?.details).belief, state.simulation.turn)
    ?? "规则内容尚未公开";
}

function receiptFor(sample: Record<string, unknown>, records: Map<string, TraceRecord>, now: number) {
  if (sample.kind !== "ACTION_EFFECT" || !turn(sample.turn) || sample.turn > now || !number(sample.energy_delta)) return null;
  const actions: Record<string, string> = { Moss: "USE_MOSS", Berry: "USE_BERRY", Crystal: "USE_CRYSTAL" };
  if (sample.action !== actions[String(sample.object)]) return null;
  const samplePosition = Array.isArray(sample.position) ? sample.position : [];
  for (const id of strings(sample.event_ids)) {
    const event = record(records.get(id)?.details), result = record(event.result);
    const eventPosition = Array.isArray(result.position) ? result.position : [];
    if (event.kind !== "event" || event.type !== "ACTION_EXECUTED" || event.event_id !== id
      || event.turn !== sample.turn || event.agent_id !== sample.agent_id || result.success !== true
      || result.agent_id !== sample.agent_id || result.turn !== sample.turn || result.action !== sample.action
      || result.object !== sample.object || result.region !== sample.region || result.weather !== sample.weather
      || samplePosition.length !== 2 || eventPosition.length !== 2 || samplePosition.some((value, index) => value !== eventPosition[index])
      || !number(result.resource_effect)
      || !number(result.energy_before) || !number(result.energy_after) || !number(result.action_cost)
      || result.energy_after - result.energy_before + result.action_cost !== sample.energy_delta
      || result.energy_after !== Math.max(0, Math.min(100, result.energy_before - result.action_cost + result.resource_effect))) continue;
    return { turn: sample.turn, delta: sample.energy_delta };
  }
  return null;
}

function directOutcome(belief: Record<string, unknown>, sample: Record<string, unknown>): CaseEvidence["outcome"] | null {
  if (belief.type !== "CONDITIONAL_EFFECT" || belief.object !== sample.object || !number(sample.energy_delta) || sample.energy_delta === 0) return null;
  const conditions = record(belief.conditions);
  if ((conditions.region != null && conditions.region !== sample.region) || (conditions.weather != null && conditions.weather !== sample.weather)) return null;
  if (belief.expected_effect !== "ENERGY_POSITIVE" && belief.expected_effect !== "ENERGY_NEGATIVE") return null;
  return (sample.energy_delta > 0) === (belief.expected_effect === "ENERGY_POSITIVE") ? "SUPPORT" : "COUNTEREXAMPLE";
}

function discoveryFor(state: StateResponse, incident: Incident): CaseDiscovery {
  const now = state.simulation.turn, injected = incident.injectedTurn;
  const reached = (value: unknown): value is number => turn(value) && value >= injected && value <= now;
  const prompt = record(state.awaiting_choice);
  const alert = incident.attackNumber === 1 && prompt.point === "D2" && reached(prompt.turn) ? prompt.turn : null;
  const detected = reached(incident.detectedTurn) ? incident.detectedTurn : null;
  const historicalEvidenceTurn = turn(incident.detectedTurn) && incident.detectedTurn < injected && incident.detectedTurn <= now
    ? incident.detectedTurn : null;
  const disputedTurn = reached(incident.disputedTurn) ? incident.disputedTurn : null;
  const value = alert ?? detected;
  return {
    turn: value, elapsedTurns: value === null ? null : value - injected,
    basis: alert !== null ? "choice-alert" : detected !== null ? "incident-detected" : historicalEvidenceTurn !== null ? "historical-evidence" : "unrecorded",
    label: alert !== null ? "首次异常提示" : detected !== null ? "公开发现记录" : historicalEvidenceTurn !== null ? "历史证据时间" : "发现时间未记录",
    detail: alert !== null ? "公开 D2 提示在这一回合出现；关联引用是否有原始行动回执，在下方另行核验。"
      : detected !== null ? "事件公开字段在此记录发现；它不一定是第一条异常行动，也不等于正式争议或完成修复。"
      : historicalEvidenceTurn !== null ? "发现字段指向植入前的历史证据时间，不能作为本案发现回合或发现耗时。"
      : "没有可核对的本案公开发现时间；不以最早复测样本或争议时间代替首次发现。",
    evidenceIds: alert !== null ? strings(prompt.evidence_ids) : [],
    disputedTurn, disputedElapsedTurns: disputedTurn === null ? null : disputedTurn - injected,
    historicalEvidenceTurn,
  };
}

export function resolveCaseFiles(state: StateResponse, options: CaseFileOptions = {}): CaseFileView[] {
  const now = state.simulation.turn;
  return (state.incidents ?? []).filter(incident => turn(incident.injectedTurn) && incident.injectedTurn <= now).map(incident => {
    const discovery = discoveryFor(state, incident);
    const sourceConfirmed = confirmed(state, incident);
    const ids = caseTraceIds(state, incident);
    const task = caseTask(state, incident);
    const subjectId = task?.belief_id ?? (sourceConfirmed ? incident.rootBeliefId : null);
    const replacementId = sourceConfirmed && incident.status === "REPAIRED" && turn(incident.resolvedTurn) && incident.resolvedTurn <= now
      ? incident.replacementBeliefId : null;
    const traces = options.replaying ? [] : ids.flatMap(id => {
      const trace = options.traces?.[id];
      return trace?.targetId === id ? [trace] : [];
    });
    const records = new Map<string, TraceRecord>();
    for (const trace of traces) for (const item of trace.records.slice(0, 120)) {
      if (!records.has(item.id)) records.set(item.id, item);
    }
    const resolvedTurn = terminal.has(incident.status) && turn(incident.resolvedTurn) && incident.resolvedTurn <= now ? incident.resolvedTurn : null;
    const isFuture = [incident.detectedTurn, incident.disputedTurn, incident.resolvedTurn].some(value => turn(value) && value > now);
    const status: IncidentStatus = terminal.has(incident.status) && resolvedTurn === null
      ? task ? "INVESTIGATING" : "INJECTED" : incident.status;
    const candidates = new Map<string, { agentId: string; region: Region; weather: Weather; outcome: CaseEvidence["outcome"]; basis: CaseEvidence["basis"] }>();
    if (!isFuture) for (const item of incident.evidenceByContext ?? []) {
      if (region(item.region) && weather(item.weather) && (item.outcome === "SUPPORT" || item.outcome === "COUNTEREXAMPLE")) {
        candidates.set(item.evidenceId, { agentId: item.agentId, region: item.region, weather: item.weather, outcome: item.outcome, basis: "investigation" });
      }
    }
    for (const trace of traces) for (const line of trace.lines.discovered) {
      if (line.to !== subjectId || candidates.has(line.from)) continue;
      const sample = record(records.get(line.from)?.details);
      if (text(sample.agent_id) && region(sample.region) && weather(sample.weather) && (line.outcome === "SUPPORT" || line.outcome === "COUNTEREXAMPLE")) {
        candidates.set(line.from, { agentId: String(sample.agent_id), region: sample.region, weather: sample.weather, outcome: line.outcome, basis: "investigation" });
      }
    }
    // Only explicit first-evidence links identify a first sample; same-turn negative actions do not.
    const prompt = record(state.awaiting_choice);
    const firstIds = incident.attackNumber === 1 && prompt.point === "D2" ? strings(prompt.evidence_ids) : [];
    const subjectBelief = record(record(records.get(subjectId ?? "")?.details).belief);
    const subjectRecord = records.get(subjectId ?? "");
    const declaredIds = new Set(subjectRecord?.declaredRefs ?? []);
    const heldEvidenceIds = new Set(strings(subjectBelief.evidence_ids));
    const directLinks = new Set(traces.flatMap(trace => trace.lines.declared.filter(line => line.to === subjectId).map(line => line.from)));
    const taskEvidenceIds = new Set(task?.evidence_ids ?? []);
    // A task's explicit evidence IDs or a checked direct belief reference establish association; neither guesses a culprit.
    for (const id of task ? taskEvidenceIds : declaredIds) {
      if (candidates.has(id)) continue;
      const sample = record(records.get(id)?.details);
      const outcome = directOutcome(subjectBelief, sample);
      const linked = task ? taskEvidenceIds.has(id) : heldEvidenceIds.has(id) && directLinks.has(id);
      if (linked && outcome && text(sample.agent_id) && region(sample.region) && weather(sample.weather) && receiptFor(sample, records, now)) {
        candidates.set(id, { agentId: String(sample.agent_id), region: sample.region, weather: sample.weather, outcome,
          basis: task ? "investigation" : "belief-reference" });
      }
    }
    for (const id of firstIds) {
      const sample = record(records.get(id)?.details);
      if (text(sample.agent_id) && region(sample.region) && weather(sample.weather)
        && directOutcome(subjectBelief, sample) === "COUNTEREXAMPLE" && receiptFor(sample, records, now)) {
        candidates.set(id, { agentId: String(sample.agent_id), region: sample.region, weather: sample.weather, outcome: "COUNTEREXAMPLE", basis: "belief-reference" });
      }
    }
    const evidence: CaseEvidence[] = [];
    for (const [id, candidate] of candidates) {
      const sample = record(records.get(id)?.details);
      if (turn(sample.turn) && sample.turn > now) continue;
      const receipt = sample.id === id && sample.agent_id === candidate.agentId && sample.region === candidate.region && sample.weather === candidate.weather
        ? receiptFor(sample, records, now) : null;
      if (turn(sample.turn) && sample.turn < incident.injectedTurn && !receipt) continue;
      evidence.push({ id, ...candidate, turn: receipt?.turn ?? null, delta: receipt?.delta ?? null, receiptVerified: !!receipt,
        timing: receipt ? receipt.turn < incident.injectedTurn ? "historical" : "current-incident" : "unknown" });
    }
    // B records freeze verified public receipts with each snapshot, including replay.
    const chronology = state.merged_game?.b_review?.cases.find(item => item.incident_id === incident.id && item.injected_turn === incident.injectedTurn);
    for (const receipt of chronology?.evidence ?? []) {
      if (!text(receipt.id) || !text(receipt.agent_id) || !turn(receipt.turn) || receipt.turn > now
        || !region(receipt.region) || !weather(receipt.weather) || !["SUPPORT", "COUNTEREXAMPLE"].includes(receipt.outcome)) continue;
      const verified = receipt.receipt_verified === true;
      const isFirst = record(receipt).basis === "first-counterexample";
      const index = evidence.findIndex(item => item.id === receipt.id);
      const item: CaseEvidence = { id: receipt.id, agentId: receipt.agent_id, turn: verified ? receipt.turn : null,
        region: receipt.region, weather: receipt.weather, outcome: receipt.outcome,
        delta: verified && number(receipt.energy_delta) ? receipt.energy_delta : null, receiptVerified: verified,
        timing: verified ? receipt.turn < incident.injectedTurn ? "historical" : "current-incident" : "unknown",
        basis: isFirst ? "first-counterexample" : "investigation" };
      if (index < 0) evidence.push(item);
      else if (item.receiptVerified || !evidence[index].receiptVerified) evidence[index] = item;
      if (isFirst && verified && item.outcome === "COUNTEREXAMPLE" && item.timing === "current-incident"
        && receipt.turn === chronology?.first_counterexample_turn && !firstIds.includes(receipt.id)) firstIds.push(receipt.id);
    }
    evidence.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity) || a.id.localeCompare(b.id));
    const firstCounterexample = evidence.find(item => firstIds.includes(item.id) && item.receiptVerified && item.timing === "current-incident" && item.outcome === "COUNTEREXAMPLE") ?? null;
    const earliestVerifiedCounterexample = evidence.find(item => item.receiptVerified && item.timing === "current-incident" && item.outcome === "COUNTEREXAMPLE")
      ?? evidence.find(item => item.receiptVerified && item.outcome === "COUNTEREXAMPLE") ?? null;
    const people = new Map<string, CaseParticipant>();
    for (const item of evidence) {
      const person = people.get(item.agentId) ?? { agentId: item.agentId, evidenceCount: 0, supportCount: 0, counterexampleCount: 0 };
      person.evidenceCount += 1;
      if (item.outcome === "SUPPORT") person.supportCount += 1; else person.counterexampleCount += 1;
      people.set(item.agentId, person);
    }
    const participants = [...people.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
    const statusText: Record<IncidentStatus, [string, string]> = {
      INJECTED: ["尚待发现", "伪记忆已经进入本轮，尚无公开记录说明部落发现了问题。"],
      VERIFYING: ["采纳前核验", "这条说法仍在核验中，不能据此宣称已经被阻止。"],
      SPREADING: ["说法正在传播", "部分成员已接触这条说法，调查是否成立仍需公开证据。"],
      DISPUTED: ["已公开争议", "已有公开争议，但还没有确认修正后的规则。"],
      INVESTIGATING: ["正在对照调查", "部落正在收集不同条件下的实验回证，结果尚未确定。"],
      REPAIRED: ["规则已修正", "对照调查形成了通过核验的修正规则，旧说法已撤回；这不等于玩家已找到零号。"],
      REVOKED: ["旧说法已撤回", "旧说法已经停止使用，但没有据此查出完整的替代规则。"],
      PREVENTED: ["采纳前已阻止", "这轮说法在通过采纳前被反例拦下，没有经历先传播再修复的过程。"],
    };
    const [statusLabel, summary] = statusText[status];
    const limitations: string[] = [];
    if (!firstCounterexample) limitations.push(firstIds.length || incident.detectedTurn != null || incident.disputedTurn != null
      ? "首次触发异常的关联行动回执未在本页记录中核实；最早可核对的调查反例不等于首次发现。"
      : "尚无可核对的首次关联反例，不能把其他成员掉能量算作本案发现。");
    if (evidence.some(item => !item.receiptVerified)) limitations.push("部分公开调查样本缺少可匹配的原始行动回执，其回合和能量变化保持未记录。");
    if (evidence.some(item => item.timing === "historical")) limitations.push("部分关联回执产生于本次事件之前，只能作为本页对照依据；它们不是本轮新实验，也未确认是本次拦截的直接来源，不能把样本回合当作本案发现回合。");
    if (task?.belief_id && sourceConfirmed && task.belief_id !== incident.rootBeliefId) limitations.push("调查任务关联的旧规则与零号记忆编号不同；案卷分别展示调查依据和已确认源头，不将它们合并为同一条记忆。");
    if (options.replaying) limitations.push("回放只使用当时快照，不调取当前追源记录补写过去。");
    if (subjectId && publicTitle(subjectId, state, records) === "规则内容尚未公开") limitations.push("本案原说法的具体规则尚未取得公开记录。");
    if (status === "REPAIRED" && !replacementId) limitations.push("后台公开状态已修正，但替代规则的关联编号尚未公开，因此不推断新规则内容。");
    if (traces.some(trace => trace.truncated)) limitations.push("追源记录有截断，缺失记录不代表从未发生。");
    const counter = firstCounterexample ?? earliestVerifiedCounterexample;
    const steps: CaseStep[] = [
      { id: "injection", label: "事件开始", detail: "本轮伪记忆事件进入记录；持有人不因此被指认为造假者。", turn: incident.injectedTurn, state: "done", evidenceIds: [] },
      { id: "counterexample", label: firstCounterexample ? "首次关联反例" : counter?.timing === "historical" ? "既有反例对照" : "可核对的调查反例",
        detail: firstCounterexample ? firstCounterexample.basis === "first-counterexample"
          ? "本案明确记录的首条关联反例；实验发生回合与公开发现回合分别记录。"
          : "这份回执与首次异常提示明确关联。" : counter?.timing === "historical" ? "规则引用的既有反例可在本页对照；未确认它是本次拦截的直接来源，不是本轮新实验或本案发现回合。" : counter ? "这是目前最早能核对的调查反例，不冒称首次发现。" : "尚未核实关联的原始反例回执。",
        turn: counter?.turn ?? null, state: counter ? "done" : "unknown", evidenceIds: counter ? [counter.id] : [] },
      { id: "verification", label: "多人核验", detail: participants.length >= 2 ? `${participants.length} 位成员贡献了 ${evidence.length} 份公开关联样本。`
        : task ? "已有调查任务，尚未看到两位成员的关联回证。" : "尚无可确认的专项调查记录。",
        turn: task?.created_turn ?? null, state: participants.length >= 2 ? "done" : task ? "active" : "pending", evidenceIds: evidence.map(item => item.id) },
      { id: "resolution", label: "案件结果", detail: summary, turn: resolvedTurn,
        state: resolvedTurn !== null ? "done" : "pending", evidenceIds: [] },
    ];
    return { id: incident.id, attackNumber: incident.attackNumber, status, statusLabel, summary,
      injectedTurn: incident.injectedTurn, resolvedTurn, sourceConfirmed,
      subject: subjectId ? { id: subjectId, title: publicTitle(subjectId, state, records) } : null,
      replacement: replacementId ? { id: replacementId, title: publicTitle(replacementId, state, records) } : null,
      origin: sourceConfirmed ? { agentId: incident.targetAgentId!, beliefId: incident.rootBeliefId! } : null,
      lineage: sourceConfirmed ? (incident.lineage ?? []).map(edge => ({ senderAgentId: edge.senderAgentId, parentBeliefId: edge.parentBeliefId,
        receiverAgentId: edge.receiverAgentId, childBeliefId: edge.childBeliefId })) : [],
      evidence, participants, steps, limitations, firstCounterexample, earliestVerifiedCounterexample, discovery };
  }).sort((a, b) => a.attackNumber - b.attackNumber || a.injectedTurn - b.injectedTurn);
}
