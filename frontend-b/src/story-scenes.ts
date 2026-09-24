import type { ChoicePoint, Incident, StateResponse } from "./types";

export type StorySceneId = "departure" | "hearth" | "anomaly" | "verification" | "repair" | "second-trial";
export interface StorySceneDefinition { id: StorySceneId; number: string; title: string; image: string; imageAlt: string }
export interface StoryChapter extends StorySceneDefinition { caption: string; recordedTurn: number | null; turnLabel: string; reached: boolean }

export const STORY_SCENES: Record<StorySceneId, StorySceneDefinition> = {
  departure: { id: "departure", number: "01", title: "从一无所知的荒野出发", image: "/b/art/story/departure.png", imageAlt: "五色叶衣成员在连成一体的荒野格地上准备启程" },
  hearth: { id: "hearth", number: "02", title: "把亲历，带回篝火边", image: "/b/art/story/hearth.png", imageAlt: "叶屋村落的篝火旁，五位成员交换树皮记录与见闻" },
  anomaly: { id: "anomaly", number: "03", title: "经验，碰到了一次反例", image: "/b/art/story/anomaly.png", imageAlt: "苔藓试验地上的叶片记录与样本，呈现需要重新对照的异常情境" },
  verification: { id: "verification", number: "04", title: "带着问题，重新看世界", image: "/b/art/story/verification.png", imageAlt: "不同地形上的采样点、观察镜与待对照的记录，呈现尚未定论的核验情境" },
  repair: { id: "repair", number: "05", title: "把修正过的经验，交给彼此", image: "/b/art/story/repair.png", imageAlt: "村落中的旧证据和修正记录，呈现经验被整理并重新传递的情境" },
  "second-trial": { id: "second-trial", number: "06", title: "同一片荒野，第二次考验", image: "/b/art/story/second-trial.png", imageAlt: "荒野岔路上的核验工具与待检记录，呈现再次接受考验的中性情境" },
};

export const CHOICE_STORY_SCENES: Record<ChoicePoint, StorySceneId> = { D1: "hearth", D2: "anomaly", D3: "verification", D4: "second-trial" };

const minTurn = (values: (number | null | undefined)[], now: number) => {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now);
  return valid.length ? Math.min(...valid) : null;
};

/** Uses only public state. Historical chapters never infer repair from a choice or a timer. */
export function resolveStoryScenes(state: StateResponse): { current: StoryChapter; chapters: StoryChapter[] } {
  const now = state.simulation.turn;
  const choice = typeof state.awaiting_choice === "string" ? state.awaiting_choice : state.awaiting_choice?.point;
  const choices = state.choices || state.paradigm?.choices || {};
  const incidents = state.incidents.filter(item => item.injectedTurn <= now);
  const first = incidents.find(item => item.attackNumber === 1);
  const second = incidents.find(item => item.attackNumber === 2);
  const inPast = (turn: number | null | undefined) => typeof turn === "number" && turn >= 0 && turn <= now;
  const repaired = incidents.filter(item => item.status === "REPAIRED" && inPast(item.resolvedTurn));
  const tasks = state.tasks.filter(task => task.type === "INVESTIGATION" && task.created_turn <= now && incidents.some(item => item.investigationTaskId === task.id));
  const disputed = incidents.filter(item => ["DISPUTED", "INVESTIGATING"].includes(item.status) || inPast(item.disputedTurn));
  const sharedTurns = [
    ...(state.story_events || []).filter(event => event.kind === "SHARE_BELIEF").map(event => event.turn),
    ...(state.messages || []).filter(message => message.type === "SHARE_BELIEF").map(message => message.turn),
  ];
  const anomalyReached = choice === "D2" || !!choices.D2 || incidents.some(item => inPast(item.detectedTurn) || inPast(item.disputedTurn));
  const hasInquiry = tasks.length > 0 || disputed.length > 0;
  const reviewReached = choice === "D3" || !!choices.D3;
  const hasHearth = minTurn(sharedTurns, now) !== null || state.collectiveKnowledge.length > 0 || state.metrics.knowledgeMature || choice === "D1" || !!choices.D1 || incidents.length > 0;
  const secondPrepared = !!second || choice === "D4" || !!choices.D4 || state.merged_game?.phase === "awaiting_second_candidate";
  const started = now > 0 || state.simulation.running || !!state.game_started || !!state.game?.started;
  const chapter = (id: StorySceneId, reached: boolean, caption: string, recordedTurn: number | null = null, turnLabel = "公开记录") => ({ ...STORY_SCENES[id], reached, caption, recordedTurn, turnLabel });

  const departure = chapter("departure", state.agents.length > 0, started ? "五位成员从营地出发。看见、尝试、留下记录，经验从亲历中长出来。" : "五位成员已经聚在营地。没有现成答案，第一份经验要从亲历开始。", 0, "旅程起点");
  const hearth = chapter("hearth", hasHearth, choice === "D1" ? "篝火边已经有了共同经验。一条看似可信的记忆即将加入，你将决定它从哪里开始。" : "自己的经历开始被同伴听见。一起相信的常识，仍然需要回到世界中验证。", minTurn(sharedTurns, now), "可见分享记录");
  const anomaly = chapter("anomaly", anomalyReached,
    choice === "D2" || choices.D2 ? "一次真实反馈与原有经验对不上了。部落曾在这里停下来，决定如何回应异常。" : "公开实验留下了负反馈。这说明条件值得重新检查，还不能仅凭掉能量认定原因。",
    minTurn([...incidents.map(item => item.detectedTurn), ...incidents.map(item => item.disputedTurn)], now), "可见异常记录");
  const reviewCaption = first?.status === "REVOKED" && inPast(first.resolvedTurn) ? "旧常识已被撤销，但撤销不等于原因已经查清。部落开始讨论下一次该怎样验证。" : "调查尚未确认修复。部落仍要决定，下一次如何留下更可靠的依据。";
  const verification = chapter("verification", hasInquiry || reviewReached,
    reviewReached && !repaired.length ? reviewCaption : hasInquiry ? "争议已经进入公开核验。不同成员带回自己的实验，逐条对照条件和来源。" : "部落开始复盘验证方式。多个人点头，不一定代表每一种条件都验过。",
    minTurn([...tasks.map(task => task.created_turn), ...disputed.map(item => item.disputedTurn)], now), "公开核验记录");
  if (reviewReached && !hasInquiry) verification.title = "给下一次，留一条规矩";
  const repair = chapter("repair", repaired.length > 0, "公开调查已确认修复。原有结论被补上必要条件，修正后的经验继续交给同伴。", minTurn(repaired.map(item => item.resolvedTurn), now), "修复完成");
  const secondCaption = (incident?: Incident) => {
    if (!incident) return "新的考验还没有开始。先决定验证门槛，再看规则能不能经受下一次检验。";
    if (incident.status === "PREVENTED" && inPast(incident.resolvedTurn)) return "第二条问题记忆已在采纳前被拦下。这次门槛挡住了它，不等于世界从此不会出错。";
    if (incident.status === "REPAIRED" && inPast(incident.resolvedTurn)) return "第二次调查已确认修复。把两次实际结果放在一起，看看这套规矩改变了什么。";
    if (incident.status === "REVOKED" && inPast(incident.resolvedTurn)) return "第二条争议记忆已撤销。记住：删掉一条经验，与查清它为什么错，是两件事。";
    return state.paradigm ? "第二次观察已经结束。部落卡保留实际结果，未发现或未修复的部分也如实留下。" : "第二条问题记忆已经进入世界。新规矩正在接受检验，结果还没有写定。";
  };
  const secondTrial = chapter("second-trial", secondPrepared, secondCaption(second), second?.injectedTurn ?? null, second ? "第二次开始" : "等待下一次考验");
  if (!second) secondTrial.title = "为第二次考验，做好准备";
  if (state.paradigm && second) secondTrial.title = "这一程，长成了自己的样子";
  const all = [departure, hearth, anomaly, verification, repair, secondTrial];
  const reached = all.filter(item => item.reached);
  const dated = reached.filter(item => item.recordedTurn !== null).sort((a, b) => a.recordedTurn! - b.recordedTurn!);
  let cursor = 0;
  const chapters = reached.map(item => item.recordedTurn === null ? item : dated[cursor++]);
  const current = secondPrepared ? secondTrial : repaired.length ? repair : hasInquiry || reviewReached ? verification : anomalyReached ? anomaly : hasHearth ? hearth : departure;
  return { current, chapters };
}
