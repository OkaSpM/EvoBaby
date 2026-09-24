import type { BCaseChronology, BCognitionFeedback, BClosure, CardMetric, CognitionStage, IncidentStatus, Paradigm } from "./types";
import { cognitionFeedback } from "./cognition";

export type EndingTone = "positive" | "neutral" | "caution";
export interface EndingValue { id: string; title: string; detail: string; tone: EndingTone }
export interface EndingComparison {
  id: "spread" | "bad-actions"; label: string; first: number | null; second: number | null;
  delta: number | null; detail: string; tone: EndingTone;
}
export interface EndingTimelinePoint {
  id: "injected" | "counterexample" | "discovery" | "resolved" | "source" | "observed"; label: string;
  turn: number | null; elapsedTurns: number | null;
  basis: "recorded" | "derived" | "historical" | "unrecorded"; detail: string;
}
export interface EndingAttackTimeline {
  attackNumber: 1 | 2; status: IncidentStatus | null; statusLabel: string; summary: string;
  spread: number | null; badActions: number | null; contextsBeforeAdoption: number | null;
  points: EndingTimelinePoint[]; warnings: string[];
  sourceConfirmed: boolean | null;
}
export interface EndingOutcome { status: BClosure["status"] | "legacy"; title: string; reason: string; tone: EndingTone }
export interface EndingGrowth { agentId: string; stage: CognitionStage | null; feedback: ReturnType<typeof cognitionFeedback> }
export interface EndingInsights {
  values: EndingValue[]; attacks: EndingAttackTimeline[]; comparisons: EndingComparison[]; limits: string[];
  outcome: EndingOutcome; growth: EndingGrowth[]; gaps: string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): number | null => finite(value) && Number.isInteger(value) && value >= 0 ? value : null;
const amount = (value: unknown): number | null => finite(value) && value >= 0 ? value : null;
const terminal = new Set<IncidentStatus>(["REPAIRED", "REVOKED", "PREVENTED"]);
const descriptions: Record<IncidentStatus, [string, string]> = {
  INJECTED: ["尚待发现", "事件已植入，观察记录中尚无结案。"],
  VERIFYING: ["采纳前核验中", "正在核验，不等于已经阻止或完成修复。"],
  SPREADING: ["传播中", "说法正在传播，不能宣布协作已消除风险。"],
  DISPUTED: ["已公开争议", "反例引发争议，尚未形成已确认的替代规则。"],
  INVESTIGATING: ["调查中", "部落仍在对照复测，结果尚未确定。"],
  REPAIRED: ["规则已修正", "对照调查形成修正规则，旧说法已撤回；不等于玩家已指认源头。"],
  REVOKED: ["旧说法已撤回", "停止使用旧说法，但没有据此查出完整替代规则。"],
  PREVENTED: ["采纳前已阻止", "本次说法在采纳前被拦下，并非先传播后修复。"],
};

function attackTimeline(metric: Partial<CardMetric> | undefined, attackNumber: 1 | 2, completed: number | null): EndingAttackTimeline {
  const data = metric ?? {}, warnings: string[] = [];
  const injected = count(data.injected_turn);
  const observed = count(data.observed_until_turn);
  const horizon = observed !== null && completed !== null ? Math.min(observed, completed) : observed ?? completed;
  const inRange = (value: number) => (injected === null || value >= injected) && (horizon === null || value <= horizon);
  const rawStatus = data.status && Object.hasOwn(descriptions, data.status) ? data.status : null;
  const status = rawStatus;
  const [statusLabel, summary] = status ? descriptions[status] : ["状态未记录", "旧卡未保存本案终态，不能根据结局名称推断已经修复或阻止。"];
  const points: EndingTimelinePoint[] = [{ id: "injected", label: "事件植入", turn: injected !== null && (horizon === null || injected <= horizon) ? injected : null,
    elapsedTurns: injected !== null && (horizon === null || injected <= horizon) ? 0 : null,
    basis: injected !== null && (horizon === null || injected <= horizon) ? "recorded" : "unrecorded", detail: "本案开始回合；卡片未保存时保留未知。" }];
  if (injected !== null && horizon !== null && injected > horizon) warnings.push("植入回合晚于观察截止，时间记录不一致。");

  const detection = data.detect_turns;
  if (finite(detection) && Number.isInteger(detection) && detection < 0) {
    const historical = injected === null ? null : count(injected + detection);
    points.push({ id: "discovery", label: "历史证据时间", turn: historical !== null && (horizon === null || historical <= horizon) ? historical : null,
      elapsedTurns: null, basis: "historical", detail: "发现指标为负，指向植入前的证据时间；本案发现回合与耗时未可靠记录。" });
    warnings.push("负发现指标不是更快发现，也不能归零；本页不把历史证据时间算作本案发现耗时。");
  } else {
    const elapsed = count(detection), absolute = injected !== null && elapsed !== null ? injected + elapsed : null;
    const valid = elapsed !== null && (absolute === null || inRange(absolute));
    points.push({ id: "discovery", label: "发现 / 争议记录", turn: valid ? absolute : null, elapsedTurns: valid ? elapsed : null,
      basis: valid ? absolute === null ? "recorded" : "derived" : "unrecorded",
      detail: valid ? "原卡指标可能来自发现或争议记录；不能据此确定首次异常行动，绝对回合由植入回合加指标得到。" : "没有可靠的发现指标；不把结案时间、最早样本或缺失值当作发现时间。" });
    if (elapsed !== null && !valid) warnings.push("发现指标推算的回合超出观察范围，未作为真实发现时间呈现。");
  }

  const rawResolved = count(data.resolved_turn), rawElapsed = count(data.repair_turns);
  const statusAllowsClosure = status === null || terminal.has(status);
  const resolved = statusAllowsClosure && rawResolved !== null && inRange(rawResolved) ? rawResolved : null;
  const elapsedFromTurn = resolved !== null && injected !== null ? resolved - injected : null;
  const derived = data.resolved_turn === undefined && statusAllowsClosure && injected !== null && rawElapsed !== null && inRange(injected + rawElapsed)
    ? injected + rawElapsed : null;
  const usableElapsed = statusAllowsClosure && rawElapsed !== null && (injected === null || inRange(injected + rawElapsed)) ? rawElapsed : null;
  const closedTurn = resolved ?? derived;
  points.push({ id: "resolved", label: status === "REPAIRED" ? "规则修正" : status === "REVOKED" ? "撤回旧说法"
    : status === "PREVENTED" ? "采纳前阻止" : status === null ? "结案记录（状态未知）" : "尚未结案",
    turn: closedTurn, elapsedTurns: elapsedFromTurn ?? usableElapsed,
    basis: resolved !== null ? "recorded" : derived !== null ? "derived" : usableElapsed !== null ? "recorded" : "unrecorded",
    detail: status ? summary : "只展示原卡保留的时间指标，不把它命名为修复结果。" });
  if (rawResolved !== null && resolved === null) warnings.push("结案回合与观察范围或公开状态不一致，未作为已结案时间呈现。");
  if (elapsedFromTurn !== null && rawElapsed !== null && rawElapsed !== elapsedFromTurn) warnings.push("原卡结案用时与起止回合不一致，本页以有效起止回合计算，并保留异常说明。");
  if (finite(data.repair_turns) && data.repair_turns < 0) warnings.push("结案用时为负，未作为有效耗时呈现。");
  if (data.censored === true && status !== null && terminal.has(status)) warnings.push("原卡同时标为终态和观察未完成，两个记录存在冲突。");
  if (observed !== null && (injected === null || observed >= injected) && (completed === null || observed <= completed)) {
    points.push({ id: "observed", label: data.censored === true || (status !== null && !terminal.has(status)) ? "观察截止（未结案）" : "观察截止",
      turn: observed, elapsedTurns: injected === null ? null : observed - injected, basis: "recorded", detail: "这是指标统计截止，不替代发现或结案时间。" });
  }
  return { attackNumber, status, statusLabel, summary, spread: count(data.spread), badActions: count(data.bad_actions),
    contextsBeforeAdoption: count(data.contexts_before_adoption), points, warnings, sourceConfirmed: null };
}

function chronologyTimeline(legacy: EndingAttackTimeline, record: BCaseChronology | undefined, completed: number | null): EndingAttackTimeline {
  if (!record) return legacy;
  const injected = count(record.injected_turn);
  const valid = (value: unknown, allowHistorical = false) => {
    const turn = count(value);
    return turn !== null && (completed === null || turn <= completed) && (allowHistorical || injected === null || turn >= injected) ? turn : null;
  };
  const point = (id: EndingTimelinePoint["id"], label: string, value: unknown, detail: string, allowHistorical = false): EndingTimelinePoint => {
    const turn = valid(value, allowHistorical);
    const historical = turn !== null && injected !== null && turn < injected;
    return { id, label: historical ? "历史反例记录" : label, turn,
      elapsedTurns: turn !== null && injected !== null && !historical ? turn - injected : null,
      basis: historical ? "historical" : turn === null ? "unrecorded" : "recorded", detail };
  };
  const status = Object.hasOwn(descriptions, record.status) ? record.status : null;
  const [statusLabel, summary] = status ? descriptions[status] : ["状态未记录", "本案终态未记录。"];
  const points = [point("injected", "事件植入", injected, "本案开始回合。"),
    point("counterexample", "反例形成", record.first_counterexample_turn, "本案关联的真实行动反例；与公开发现分开记录。", true),
    point("discovery", "正式发现", record.detected_turn, "系统登记本案被发现的回合，不以样本时间替代。"),
    point("resolved", status === "REPAIRED" ? "规则修正" : status === "REVOKED" ? "撤回旧说法" : status === "PREVENTED" ? "采纳前阻止" : "尚未结案",
      status && terminal.has(status) ? record.resolved_turn : null, summary),
    point("source", "玩家指认", record.source_confirmed === true ? record.source_confirmed_turn : null,
      record.source_confirmed === true ? "玩家已确认源头；指认回合仅使用本卡留存记录。" : "源头尚未确认，不以修复时间替代指认时间。")];
  return { ...legacy, status, statusLabel, summary, points, warnings: [],
    sourceConfirmed: typeof record.source_confirmed === "boolean" ? record.source_confirmed : null };
}

function endingOutcome(paradigm: Paradigm, attacks: EndingAttackTimeline[]): EndingOutcome {
  const closure = paradigm.b_outcome;
  const allRepaired = attacks.every(attack => attack.status === "REPAIRED");
  const allConfirmed = attacks.every(attack => attack.sourceConfirmed === true);
  if (closure) {
    const titles: Record<BClosure["status"], string> = { playing: "调查进行中", awaiting_trace: "已修正规则 · 追源待完成", success: "真相已查明", partial: "调查部分完成", unresolved: "调查未竟" };
    // A success card needs both independent goals; a name or a repaired rule cannot supply source confirmation.
    if (closure.status === "success" && (!allRepaired || !allConfirmed)) return { status: "unresolved", title: "结案记录待核对", reason: "成功标记与两案修复、源头确认记录不一致。", tone: "caution" };
    if (Object.hasOwn(titles, closure.status)) return { status: closure.status, title: titles[closure.status], reason: closure.reason,
      tone: closure.status === "success" ? "positive" : closure.status === "playing" || closure.status === "awaiting_trace" ? "neutral" : "caution" };
  }
  const metrics = [paradigm.metrics?.attack1, paradigm.metrics?.attack2];
  if (attacks.some((attack, index) => metrics[index]?.censored === true || (attack.status !== null && !terminal.has(attack.status)))) {
    return { status: "legacy", title: "调查未竟", reason: "留存记录中仍有案件未处理完；旧卡未保存追源完成状态。", tone: "caution" };
  }
  if (allRepaired) return { status: "legacy", title: "规则已修正 · 追源未记录", reason: "两案保留了规则修正结果；旧卡没有源头确认记录。", tone: "neutral" };
  if (attacks.some(attack => attack.status === "REVOKED" || attack.status === "PREVENTED")) return { status: "legacy", title: "案件处理记录", reason: "拦截、撤回与完整修复分别保留；旧卡没有完整结案判定。", tone: "neutral" };
  return { status: "legacy", title: "本局记录不完整", reason: "旧卡缺少案件状态与源头确认记录，无法据此判定通关。", tone: "neutral" };
}

function endingGrowth(paradigm: Paradigm): EndingGrowth[] {
  return Array.from({ length: 5 }, (_, index) => {
    const agentId = `A${index + 1}`, member = paradigm.memberCognition?.find(item => item.agentId === agentId);
    const stage = member && [1, 2, 3, 4].includes(member.stage) ? member.stage : null;
    const feedback = cognitionFeedback(paradigm.memberFeedback?.[agentId] as BCognitionFeedback | undefined);
    return { agentId, stage, feedback };
  });
}

function compare(id: EndingComparison["id"], label: string, first: number | null, second: number | null, unit: string): EndingComparison {
  const delta = first === null || second === null ? null : second - first;
  const detail = delta === null ? `至少一轮未记录${label}，不能进行数值比较。`
    : `本局两次观察：${first} → ${second}${unit}，${delta === 0 ? "没有变化" : `第二次${delta < 0 ? "少" : "多"} ${Math.abs(delta)}${unit}`}；不单独归因为验证规矩。`;
  return { id, label, first, second, delta, detail, tone: delta === null || delta === 0 ? "neutral" : delta < 0 ? "positive" : "caution" };
}

function verificationValue(paradigm: Paradigm): EndingValue {
  const byChoice: Record<string, string> = { A: "context_diversity", B: "source_diversity", C: "verify_before_adopt", D: "none" };
  const meta = typeof paradigm.protocol?.meta_rule === "string" ? paradigm.protocol.meta_rule : byChoice[paradigm.choices?.D3 ?? ""];
  const known: Record<string, [string, string]> = {
    context_diversity: ["把场景差异纳入验证", "已记录跨场景验证制度：同伴人数与场景覆盖分别看待。"],
    source_diversity: ["提高独立来源门槛", "已记录至少三位独立成员支持的验证制度，不把同一人的重复转述计为独立来源。"],
    verify_before_adopt: ["把复测放在采纳之前", "已记录采纳前核验制度；接收者须有自身支持证据，不能直接把转述当亲历。"],
    none: ["没有新增验证规矩", "本局明确选择不新增验证制度，不能将结局解释为已经学会新的验证方法。"],
  };
  const selected = known[meta];
  const modifiers: Record<string, string> = { A: "第二轮保持原门槛。", B: "第二轮将置信门槛提高到 0.9。", C: "第二轮额外要求跨区证据。", D: "第二轮按规则轮换把关成员。" };
  return { id: "verification", title: selected?.[0] ?? "验证规矩未记录",
    detail: `${selected?.[1] ?? "卡片没有明确的验证制度，不能根据部落名称补写。"}${modifiers[paradigm.choices?.D4 ?? ""] ?? ""}这些记录证明规则被选择，不单独证明它带来了改善。`,
    tone: selected && meta !== "none" ? "positive" : "neutral" };
}

export function resolveEndingInsights(paradigm: Paradigm): EndingInsights {
  const completed = count(paradigm.completed_turn);
  const attacks = ([1, 2] as const).map(number => chronologyTimeline(
    attackTimeline(number === 1 ? paradigm.metrics?.attack1 : paradigm.metrics?.attack2, number, completed),
    paradigm.caseChronology?.find(item => item.attack_number === number), completed));
  const comparisons = [compare("spread", "受影响人数", attacks[0].spread, attacks[1].spread, " 人"),
    compare("bad-actions", "错误行动", attacks[0].badActions, attacks[1].badActions, " 次")];
  const delay = amount(paradigm.cost?.adoption_delay_turns), token = amount(paradigm.cost?.token_overhead_pct);
  const costDetail = `${delay === null ? "采纳等待时间未计量" : `已记录平均采纳等待 ${Number(delay.toFixed(2))} 回合`}；${token === null ? "真实模型 Token 成本未计量" : `原卡记录 Token 开销增幅 ${token}%`}。未计量不是零成本，无法据此算出协作净收益。`;
  const values: EndingValue[] = comparisons.map(item => ({ id: item.id, title: item.label, detail: item.detail, tone: item.tone }));
  values.push(verificationValue(paradigm), { id: "outcomes", title: "分别记录两次处理结果",
    detail: `第一次：${attacks[0].statusLabel}。第二次：${attacks[1].statusLabel}。修正规则、仅撤回、采纳前阻止是不同结果，不能都算作修复。`,
    tone: attacks.some(item => item.status === "REVOKED" || (item.status !== null && !terminal.has(item.status))) ? "caution" : "neutral" },
  { id: "cost", title: "协作成本保留边界", detail: costDetail, tone: "caution" });
  const limits = ["比较仅来自本局两次不同攻击的观察，不是对照实验，也不能证明某条规矩造成了提升。",
    paradigm.caseChronology ? "反例形成、正式发现、规则修正与源头确认分别记录。" : "旧卡发现指标未区分最早异常行动与正式发现 / 争议；样本生成时间不等于事件被发现的时间。",
    "原部落分类保留在原件中，不用分类补写缺失的案件结果。",
    ...(delay === null || token === null ? ["部分协作成本未计量，不能把缺失值当作零成本或计算投入产出。"] : []),
    ...attacks.flatMap(item => item.warnings.map(warning => `第 ${item.attackNumber} 次：${warning}`))];
  const outcome = endingOutcome(paradigm, attacks), growth = endingGrowth(paradigm);
  const gaps = attacks.flatMap(attack => {
    const prefix = `第${attack.attackNumber === 1 ? "一" : "二"}案`;
    const missing: string[] = [];
    if (attack.status === null) missing.push(`${prefix}：案件状态未记录。`);
    else if (attack.status !== "REPAIRED") missing.push(`${prefix}：${attack.status === "PREVENTED" ? "已拦下本次说法，未完成规则修复" : attack.status === "REVOKED" ? "已撤回旧说法，替代规则尚未完成" : "调查尚未完成"}。`);
    if (attack.sourceConfirmed !== true) missing.push(`${prefix}：${attack.sourceConfirmed === null ? "旧卡未保存源头确认" : "源头待指认"}。`);
    return missing;
  });
  return { values, attacks, comparisons, limits, outcome, growth, gaps };
}
