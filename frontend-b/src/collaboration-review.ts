import type { CaseEvidence, CaseFileView } from "./case-file";
import type { ChoiceOption, StateResponse, Task } from "./types";

export type ReviewStepId = "observe" | "notice" | "check" | "repair" | "trace";
export interface CollaborationReviewStep {
  id: ReviewStepId; label: string; state: "done" | "active" | "pending" | "partial";
  turn: number | null; detail: string; agentIds: string[]; evidenceCount: number;
}
export interface CollaborationRuleReview {
  id: "D2" | "D3"; name: string; requirement: string; record: string;
  note: string; chosen: boolean;
}
export interface CollaborationContribution {
  agentId: string; evidenceCount: number; supportCount: number; counterexampleCount: number;
  firstTurn: number; lastTurn: number; contexts: string[]; evidenceIds: string[];
}
export interface CollaborationReviewView {
  caseId: string; attackNumber: number; turn: number; heading: string; gap: string;
  status: "open" | "contained" | "repaired" | "complete";
  steps: CollaborationReviewStep[]; rules: CollaborationRuleReview[];
  ruleAmendment: string | null;
  contributions: CollaborationContribution[];
  evidence: { verified: number; unchecked: number; people: number; contexts: number; historical: number };
  times: { firstCounterexample: number | null; discovered: number | null; disputed: number | null;
    repaired: number | null; evidenceToDispute: number | null; discoveryToRepair: number | null };
  counterexampleAgentIds: string[];
  task: { id: string; completed: number; required: number; members: string[] } | null;
  repairChecks: { label: string; current: number | null; required: number }[];
  sourceConfirmed: boolean; canInvestigate: boolean; limits: string[];
}

const regions: Record<string, string> = { NW: "西北", NE: "东北", SW: "西南", SE: "东南" };
const weather: Record<string, string> = { Rain: "雨天", Sunny: "晴天" };
const unique = <T,>(values: T[]) => [...new Set(values)];
const isTurn = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const reached = (value: unknown, now: number): value is number => isTurn(value) && value <= now;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function taskFor(state: StateResponse, item: CaseFileView): Task | null {
  const incident = state.incidents.find(value => value.id === item.id);
  return state.tasks.find(task => task.id === incident?.investigationTaskId && task.type === "INVESTIGATION"
    && reached(task.created_turn, state.simulation.turn) && reached(task.updated_turn, state.simulation.turn)) ?? null;
}

function sourceTurn(state: StateResponse, item: CaseFileView): number | null {
  if (!item.sourceConfirmed) return null;
  const game = record(state.trace_game);
  const rounds = Array.isArray(game.rounds) ? game.rounds : [];
  for (const value of [...rounds, game.current]) {
    const round = record(value), result = record(round.result);
    if (round.incident_id !== item.id || result.correct !== true) continue;
    // Older saves store elapsed seconds but no turn; seconds must not become rounds.
    for (const value of [result.turn, round.solved_turn]) if (reached(value, state.simulation.turn)) return value;
  }
  return null;
}

function hasFutureConfirmation(state: StateResponse, item: CaseFileView): boolean {
  const game = record(state.trace_game);
  const rounds = Array.isArray(game.rounds) ? game.rounds : [];
  return [...rounds, game.current].some(value => {
    const round = record(value), result = record(round.result);
    return round.incident_id === item.id && result.correct === true
      && [result.turn, round.solved_turn].some(value => isTurn(value) && value > state.simulation.turn);
  });
}

function contributionsFor(evidence: CaseEvidence[]): CollaborationContribution[] {
  const result = new Map<string, CollaborationContribution>();
  for (const sample of evidence) {
    if (sample.turn === null) continue;
    const person = result.get(sample.agentId) ?? { agentId: sample.agentId, evidenceCount: 0,
      supportCount: 0, counterexampleCount: 0, firstTurn: sample.turn, lastTurn: sample.turn,
      contexts: [], evidenceIds: [] };
    person.evidenceCount += 1;
    if (sample.outcome === "SUPPORT") person.supportCount += 1; else person.counterexampleCount += 1;
    person.firstTurn = Math.min(person.firstTurn, sample.turn);
    person.lastTurn = Math.max(person.lastTurn, sample.turn);
    person.contexts = unique([...person.contexts, `${regions[sample.region]} · ${weather[sample.weather]}`]);
    person.evidenceIds.push(sample.id);
    result.set(sample.agentId, person);
  }
  return [...result.values()].sort((a, b) => a.firstTurn - b.firstTurn || a.agentId.localeCompare(b.agentId));
}

function rulesFor(state: StateResponse, item: CaseFileView, evidence: CaseEvidence[], contributions: CollaborationContribution[]): CollaborationRuleReview[] {
  const d2 = state.choices?.D2, d3 = state.choices?.D3;
  const disputed = reached(item.discovery.disputedTurn, state.simulation.turn) ? item.discovery.disputedTurn : null;
  const d2Rules: Record<ChoiceOption, Omit<CollaborationRuleReview, "id" | "chosen">> = {
    A: { name: "发现反例，公开提醒", requirement: "争议规则暂停普通使用，调查试验仍可进行。",
      record: disputed === null ? "本案尚无公开争议时间" : `本案第 ${disputed} 回合进入公开争议`,
      note: "停止沿用错误与完成修复分别记录。" },
    B: { name: "同一个人，再试够三次", requirement: "同一成员累积 3 份关联反例后，再启动公共争议。",
      record: `已核对的同人反例最多 ${Math.max(0, ...contributions.map(person => person.counterexampleCount))} / 3 份`,
      note: "这里只数可核对的回执；公开样本不全时不能还原当时的完整计数。" },
    C: { name: "先撤回这条说法", requirement: "反例出现后撤回同一说法，不等待完整替代规则。",
      record: item.status === "REVOKED" && reached(item.resolvedTurn, state.simulation.turn)
        ? `第 ${item.resolvedTurn} 回合已撤回` : "撤回结果以本案处理记录为准",
      note: "撤回是止损，不等于查清原因或找到源头。" },
    D: { name: "暂不处理反例", requirement: "这项选择不把已收到的反例升级为公共争议。",
      record: `本案已核对 ${evidence.filter(sample => sample.outcome === "COUNTEREXAMPLE").length} 份反例`,
      note: "有人遇到反例，不代表团队已经处理它。" },
  };
  const regionsSeen = unique(evidence.map(sample => sample.region)).length;
  const weatherSeen = unique(evidence.map(sample => sample.weather)).length;
  const subject = state.collectiveKnowledge.find(belief => belief.id === (item.replacement?.id ?? item.subject?.id)
    && reached(belief.created_turn, state.simulation.turn) && reached(belief.updated_turn, state.simulation.turn));
  const registeredSources = subject ? unique(subject.independent_agent_ids ?? []).length : null;
  const d3Rules: Record<ChoiceOption, Omit<CollaborationRuleReview, "id" | "chosen">> = {
    A: { name: "换条件，查适用范围", requirement: "说法未限定的地域或天气，至少要覆盖 2 种取值。",
      record: `本案已核对 ${regionsSeen} 个地域、${weatherSeen} 种天气`,
      note: "这是案卷覆盖范围；每条候选规则仍按自己的条件和证据单独核验。" },
    B: { name: "至少三名实验来源", requirement: "同一候选结论至少登记 3 名不同实验来源，转述人数不计。",
      record: registeredSources === null ? "候选结论的来源人数尚未公开" : `当前公开候选 ${subject!.id} 登记 ${registeredSources} / 3 名来源`,
      note: "人数满足仍不等于规则通过；置信度、反例与其他已选门槛也要检查。" },
    C: { name: "采纳前，自己先试", requirement: "成员采纳共享的效果结论前，要有自己的支持实验。",
      record: `本案 ${unique(evidence.filter(sample => sample.outcome === "SUPPORT").map(sample => sample.agentId)).length} 人有已核对的支持样本`,
      note: "案内参与人数不能代替逐人、逐条规则的采纳记录。" },
    D: { name: "保留原有核验门槛", requirement: "本次不额外加入跨条件、三人来源或亲自试验要求。",
      record: `本案已核对 ${evidence.length} 份实验回执`,
      note: "不加新规矩不等于没有基础核验。" },
  };
  return [d2 ? { id: "D2", chosen: true, ...d2Rules[d2] } : { id: "D2", chosen: false, name: "异常处理尚未决定",
    requirement: "出现反例后，部落需要决定怎样处理。", record: "尚无 D2 选择", note: "不预设接下来会采用哪种处理方法。" },
  d3 ? { id: "D3", chosen: true, ...d3Rules[d3] } : { id: "D3", chosen: false, name: "今后的核验规矩尚未决定",
    requirement: "调查之后，部落需要决定今后怎样采纳结论。", record: "尚无 D3 选择", note: "当前仍按已经生效的规则行动。" }];
}

export function resolveCollaborationReview(state: StateResponse, input: CaseFileView, options: { replaying?: boolean } = {}): CollaborationReviewView | null {
  const now = state.simulation.turn;
  const snapshot = state.merged_game?.b_review?.cases.find(value => value.incident_id === input.id
    && value.injected_turn === input.injectedTurn && reached(value.injected_turn, now));
  const item: CaseFileView = snapshot ? { ...input, status: snapshot.status, sourceConfirmed: snapshot.source_confirmed,
    resolvedTurn: snapshot.resolved_turn,
    discovery: { ...input.discovery, turn: snapshot.detected_turn },
    evidence: snapshot.evidence.filter(sample => reached(sample.turn, now)).map(sample => ({ id: sample.id, agentId: sample.agent_id,
      turn: sample.receipt_verified ? sample.turn : null, region: sample.region, weather: sample.weather,
      outcome: sample.outcome, delta: sample.receipt_verified ? sample.energy_delta : null,
      receiptVerified: sample.receipt_verified,
      timing: sample.receipt_verified ? sample.turn < snapshot.injected_turn ? "historical" : "current-incident" : "unknown",
      basis: "investigation" })) } : input;
  if (!reached(item.injectedTurn, now)) return null;
  const evidence = [...new Map(item.evidence.filter(sample => sample.turn === null || reached(sample.turn, now))
    .map(sample => [sample.id, sample])).values()];
  const verified = evidence.filter(sample => sample.receiptVerified && reached(sample.turn, now));
  const contributions = contributionsFor(verified);
  const newEvidence = verified.filter(sample => sample.turn! >= item.injectedTurn);
  const counter = verified.filter(sample => sample.outcome === "COUNTEREXAMPLE")
    .sort((a, b) => a.turn! - b.turn!)[0] ?? null;
  const currentCounter = verified.filter(sample => sample.outcome === "COUNTEREXAMPLE" && sample.turn! >= item.injectedTurn)
    .sort((a, b) => a.turn! - b.turn!)[0] ?? null;
  const counterTurn = snapshot && reached(snapshot.first_counterexample_turn, now) ? snapshot.first_counterexample_turn : currentCounter?.turn ?? counter?.turn ?? null;
  const discovered = reached(item.discovery.turn, now) && item.discovery.turn >= item.injectedTurn ? item.discovery.turn : null;
  const disputed = reached(item.discovery.disputedTurn, now) && item.discovery.disputedTurn >= item.injectedTurn ? item.discovery.disputedTurn : null;
  const resolved = reached(item.resolvedTurn, now) && item.resolvedTurn >= item.injectedTurn ? item.resolvedTurn : null;
  const repaired = item.status === "REPAIRED" && resolved !== null;
  const contained = ["REVOKED", "PREVENTED"].includes(item.status) && resolved !== null;
  const sourceConfirmed = item.sourceConfirmed && !hasFutureConfirmation(state, item);
  const task = taskFor(state, item);
  const reusedTask = !!task && task.created_turn < item.injectedTurn;
  const taskReceiptIds = new Set(task?.evidence_ids ?? []);
  const taskEvidence = verified.filter(sample => taskReceiptIds.has(sample.id));
  const taskReceiptsKnown = !!task && Array.isArray(task.evidence_ids);
  const requirements = unique((task?.required_contexts ?? []).map(context => context.id));
  const completed = unique((task?.completed_context_ids ?? []).filter(id => requirements.includes(id)));
  const participants = unique(verified.map(sample => sample.agentId));
  const firstExperiment = newEvidence.length ? Math.min(...newEvidence.map(sample => sample.turn!)) : null;
  const discoveryEvidence = unique(item.discovery.evidenceIds ?? []);
  const discoverers = unique(verified.filter(sample => discoveryEvidence.includes(sample.id)).map(sample => sample.agentId));
  const noticeDone = discovered !== null || disputed !== null;
  const status = repaired && sourceConfirmed ? "complete" : repaired ? "repaired" : contained ? "contained" : "open";
  const heading = status === "complete" ? "规则已修复，源头已找到" : status === "repaired" ? "部落已修复，源头还待你确认"
    : status === "contained" ? sourceConfirmed ? "源头已找到，错误已止损" : "错误已止损，源头尚待确认"
      : sourceConfirmed ? "源头已找到，部落还在补证" : noticeDone ? "已经发现矛盾，正在查证" : "还没有公开发现记录";
  const gap = status === "complete" ? "本案修复与追源均有确认记录。"
    : repaired ? "还缺：玩家确认零号记忆。"
      : contained ? sourceConfirmed ? "还缺：经过核验的完整替代规则。" : "还缺：源头确认；完整替代规则也未确认。"
        : sourceConfirmed ? "还缺：部落完成规则处理，不能仅凭正确指认宣告完整修复。"
          : task ? `还缺：${requirements.length > completed.length ? `${requirements.length - completed.length} 个任务情境的回证，以及` : ""}规则处理与源头确认。`
            : "还缺：把异常交给共同调查，再确认处理结果与源头。";
  const steps: CollaborationReviewStep[] = [
    { id: "observe", label: "各自试验", state: firstExperiment !== null ? "done" : verified.length ? "partial" : "pending",
      turn: firstExperiment, detail: firstExperiment !== null ? `${newEvidence.length} 份本轮实验回执已核对`
        : verified.length ? "已有历史回执，本轮新实验尚未核对" : "等待可核对的关联实验",
      agentIds: unique(newEvidence.map(sample => sample.agentId)), evidenceCount: newEvidence.length },
    { id: "notice", label: "发现矛盾", state: noticeDone ? "done" : currentCounter ? "active" : "pending",
      turn: discovered ?? disputed, detail: discovered !== null ? `第 ${discovered} 回合出现公开发现记录`
        : disputed !== null ? "已有公共争议，首次发现时间未记录"
          : currentCounter ? "已有反例，尚未确认进入公共调查" : "尚无公开异常记录",
      agentIds: discoverers, evidenceCount: verified.filter(sample => discoveryEvidence.includes(sample.id)).length },
    { id: "check", label: reusedTask ? "复用已有任务" : "分头补证", state: repaired ? "done" : task ? "active" : "pending",
      turn: task?.created_turn ?? null, detail: task ? `${reusedTask ? `调查任务原建于第 ${task.created_turn} 回合，本案沿用；` : ""}${participants.length} 人交来 ${verified.length} 份已核对回执；任务情境 ${completed.length}/${requirements.length}`
        : "尚无关联的共同调查任务", agentIds: participants, evidenceCount: verified.length },
    { id: "repair", label: "修正规则", state: repaired ? "done" : contained ? "partial" : noticeDone ? "active" : "pending",
      turn: resolved, detail: repaired ? "替代规则已通过核验，旧说法已撤回"
        : item.status === "REVOKED" && contained ? "旧说法已撤回，完整规则未查明"
          : item.status === "PREVENTED" && contained ? "错误在采纳前被拦下，未记作修复"
            : "尚未确认修正规则", agentIds: [], evidenceCount: 0 },
    { id: "trace", label: "玩家追源", state: sourceConfirmed ? "done" : "pending", turn: sourceConfirmed ? sourceTurn(state, item) : null,
      detail: sourceConfirmed ? "零号记忆已正确指认；持有人不等于造假者" : "还未正确指认零号记忆",
      agentIds: [], evidenceCount: 0 },
  ];
  const limits = ["同一份观察被转述三次，仍只算一份原始证据。不同作者也不保证没有共同误差。"];
  if (evidence.length !== verified.length) limits.push(`${evidence.length - verified.length} 份公开样本尚未核对原件，未计入下方贡献。`);
  if (!discoverers.length && noticeDone) limits.push("首次发现者的关联回执未记录，不按同回合实验猜名字。");
  if (options.replaying) limits.push("这是当时快照，不用后来的记录补写当时已经知道的事。");
  return { caseId: item.id, attackNumber: item.attackNumber, turn: now, heading, gap, status, steps,
    rules: rulesFor(state, item, verified, contributions), contributions,
    ruleAmendment: state.choices?.D4 === "B" ? "追加门槛：候选规则的置信度至少达到 90%。"
      : state.choices?.D4 === "C" ? "追加门槛：效果结论的证据至少覆盖两个地域。"
        : state.choices?.D4 === "D" ? "追加门槛：轮值复核人必须成为该结论的实验来源之一。" : null,
    evidence: { verified: verified.length, unchecked: evidence.length - verified.length, people: participants.length,
      contexts: unique(verified.map(sample => `${sample.region}:${sample.weather}`)).length,
      historical: verified.filter(sample => sample.turn! < item.injectedTurn).length },
    times: { firstCounterexample: counterTurn, discovered, disputed, repaired: repaired ? resolved : null,
      evidenceToDispute: counterTurn !== null && counterTurn >= item.injectedTurn && disputed !== null && disputed >= counterTurn ? disputed - counterTurn : null,
      discoveryToRepair: discovered !== null && repaired && resolved! >= discovered ? resolved! - discovered : null },
    counterexampleAgentIds: snapshot ? unique(snapshot.evidence.filter(sample => sample.receipt_verified
      && reached(sample.turn, now) && sample.turn === counterTurn && record(sample).basis === "first-counterexample")
      .map(sample => sample.agent_id)) : currentCounter ? [currentCounter.agentId] : counter ? [counter.agentId] : [],
    task: task ? { id: task.id, required: requirements.length, completed: completed.length,
      members: unique(task.claimant_agent_ids ?? []) } : null,
    repairChecks: [
      { label: "任务实验回执", current: taskReceiptsKnown ? taskEvidence.length : null, required: 4 },
      { label: "实验作者", current: taskReceiptsKnown ? unique(taskEvidence.map(sample => sample.agentId)).length : null, required: 2 },
      { label: "支持旧说法", current: taskReceiptsKnown ? taskEvidence.filter(sample => sample.outcome === "SUPPORT").length : null, required: 1 },
      { label: "反驳旧说法", current: taskReceiptsKnown ? taskEvidence.filter(sample => sample.outcome === "COUNTEREXAMPLE").length : null, required: 1 },
    ],
    sourceConfirmed, canInvestigate: !options.replaying && !sourceConfirmed && (!!snapshot || state.trace_game?.current?.incident_id === item.id),
    limits };
}
