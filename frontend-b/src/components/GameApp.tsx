import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, BookOpen, Check, ChevronRight, CloudRain, ClipboardList, Compass, Download, Eye, EyeOff, FastForward, Fingerprint, History, Info, Layers3, ListFilter, LoaderCircle, Map as MapIcon, MessageCircle, Network, Pause, Play, Radio, RotateCcw, Search, Settings2, ShieldCheck, SkipForward, Sparkles, Sun, Trophy, Unplug, Users, X } from "lucide-react";
import { api } from "../api";
import { judgeRequestIsCurrent, loadJudgeSnapshot } from "../judge-snapshot";
import { actionLabel, beliefStatusLabel, beliefTitle, conditionsLabel, regionLabel, resourceLabel, taskStatusLabel, taskTypeLabel } from "../i18n";
import type { AgentDetail, AgentSummary, Belief, BeliefTrace, ChoiceOption, ChoicePoint, ChoicePrompt, GroundTruth, Paradigm, StateResponse, TraceRecord } from "../types";
import { WildWorldScene } from "./WildWorldScene";
import { Wildling, deriveWildlingState, wildlingColor, wildlingName } from "./Wildling";
import { ChoiceDialog } from "./ChoiceDialog";
import { SwarmPulse, SwarmScene } from "./SwarmScene";
import { resolveSwarmScene } from "../swarm-scene";
import { CHOICE_LABELS, EndingCard, downloadJson } from "./EndingCard";
import { EndingGallery } from "./EndingGallery";
import { CognitionBadge, CognitionGuide, CognitionNotice, CognitionPanel, useCognitionNotices } from "./Cognition";
import { resolveStoryScenes } from "../story-scenes";
import { StoryScene } from "./StoryScene";
import { CaseBook } from "./CaseBook";
import { MissionBar, ReviewWorkspace } from "./ReviewWorkspace";
import type { MissionAction } from "../b-session";
import "../clarity-b.css";

type View = "village" | "review" | "swarm" | "case" | "knowledge" | "trace" | "wall";
type SheetTab = "personal" | "shared" | "source";
type SavedEnding = { id: string; date: string; seed: number; paradigm: Paradigm };
const wallKey = "evobaby.tribe-wall.b2.v1";
const timeLabel = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const promptOf = (state: StateResponse | null): ChoicePrompt | null => typeof state?.awaiting_choice === "string" ? { point: state.awaiting_choice } : state?.awaiting_choice || null;

function readWall(): SavedEnding[] { try { const value = JSON.parse(localStorage.getItem(wallKey) || "[]"); return Array.isArray(value) ? value.filter(item => item?.paradigm?.metrics?.attack1 && item?.paradigm?.metrics?.attack2).slice(0, 40) : []; } catch { return []; } }

export function GameApp({ onJudge }: { onJudge: () => void }) {
  const [live, setLive] = useState<StateResponse | null>(null);
  const [replay, setReplay] = useState<StateResponse | null>(null);
  const [view, setView] = useState<View>("village");
  const [caseSession, setCaseSession] = useState(0);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState("A1");
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [sheetTab, setSheetTab] = useState<SheetTab>("personal");
  const [selectedBelief, setSelectedBelief] = useState<Belief | null>(null);
  const [trace, setTrace] = useState<BeliefTrace | null>(null);
  const [truth, setTruth] = useState<GroundTruth | null>(null);
  const [showTruth, setShowTruth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ correct: boolean; message: string } | null>(null);
  const [speed, setSpeed] = useState<1 | 5 | 20>(5);
  const [wall, setWall] = useState<SavedEnding[]>(readWall);
  const [card, setCard] = useState<Paradigm | null>(null);
  const [cardPreview, setCardPreview] = useState(false);
  const [cardPresentation, setCardPresentation] = useState<"art" | "relic">("art");
  const endingModal = useRef<HTMLDivElement>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [removeAgent, setRemoveAgent] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [showCognitionGuide, setShowCognitionGuide] = useState(false);
  const cognitionNotices = useCognitionNotices(live, !!replay, !!promptOf(live) || !!card || showCognitionGuide);
  const closeCognitionGuide = useCallback(() => setShowCognitionGuide(false), []);
  const requestVersion = useRef(0);
  const truthVisible = useRef(false);
  const refreshInFlight = useRef<number | null>(null);
  const mounted = useRef(false);
  const replaying = useRef(false);
  const mutating = useRef(false);
  const saved = useRef<string | null>(null);
  const replayTimer = useRef<number>();
  const replayVersion = useRef(0);
  useEffect(() => () => { replayVersion.current += 1; window.clearTimeout(replayTimer.current); }, []);
  const state = replay || live;
  const prompt = promptOf(live);
  const activeClock = live?.trace_game?.rounds?.find(item => item.incident_id === selectedCaseId) || live?.trace_game?.current;
  useEffect(() => {
    if (!card || prompt) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = endingModal.current;
    modal?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [!!card, !!prompt]);
  function handleEndingKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); setCard(null); setCardPreview(false); return; }
    if (event.key !== "Tab") return;
    const items = [...(endingModal.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const started = !!(live?.merged_game?.enabled || live?.game_started || live?.game?.enabled || live?.game?.started);

  const refresh = useCallback(async (clearError = true) => {
    if (!mounted.current || mutating.current || replaying.current || refreshInFlight.current === requestVersion.current) return;
    const version = ++requestVersion.current;
    const reveal = truthVisible.current;
    refreshInFlight.current = version;
    const isCurrent = () => mounted.current && !replaying.current && judgeRequestIsCurrent(version, requestVersion.current, reveal, truthVisible.current);
    try {
      const next = await loadJudgeSnapshot(api, reveal);
      if (isCurrent()) { setLive(next.state); setTruth(next.truth); if (clearError) setError(null); }
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "暂时连不上荒野世界。");
    } finally {
      if (refreshInFlight.current === version) refreshInFlight.current = null;
    }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; requestVersion.current += 1; }; }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(), live?.simulation.running ? 500 : 1800); return () => window.clearInterval(timer); }, [live?.simulation.running, refresh]);
  useEffect(() => {
    if (!live || replay) { setDetail(null); return; }
    let active = true;
    void api.agent(selectedAgent).then(value => { if (active) setDetail(value); }).catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [selectedAgent, live?.simulation.turn, live?.simulation.seed, replay]);
  useEffect(() => {
    setTrace(null);
    if (!selectedBelief || replay) return;
    let active = true;
    void api.trace(selectedBelief.id).then(value => { if (active) setTrace(value); }).catch(() => { if (active) setTrace(null); });
    return () => { active = false; };
  }, [selectedBelief?.id, live?.simulation.turn, replay]);
  useEffect(() => {
    const current = activeClock;
    const elapsed = current?.result?.elapsed ?? current?.elapsed ?? 0;
    setSeconds(Math.max(0, Math.floor(elapsed)));
    if (!current || current.result?.correct) return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor(elapsed + (Date.now() - start) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [activeClock?.incident_id, activeClock?.elapsed, activeClock?.result]);
  useEffect(() => {
    if (!live?.paradigm) return;
    const identity = `${live.simulation.seed}:${live.paradigm.id || JSON.stringify(live.paradigm)}:${live.simulation.turn}`;
    if (saved.current === identity) return;
    saved.current = identity;
    const record: SavedEnding = { id: `${Date.now()}`, date: new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }), seed: live.simulation.seed, paradigm: { ...live.paradigm, seed: live.simulation.seed } };
    setWall(current => {
      const last = current[0];
      if (last && last.seed === record.seed && JSON.stringify(last.paradigm) === JSON.stringify(record.paradigm)) return current;
      const next = [record, ...current].slice(0, 40);
      try { localStorage.setItem(wallKey, JSON.stringify(next)); } catch { /* The current card remains downloadable when browser storage is full. */ }
      return next;
    });
    setCardPreview(false); setCardPresentation("art"); setCard(record.paradigm);
  }, [live?.paradigm, live?.simulation.seed]);

  async function act(operation: () => Promise<{ state: StateResponse } | StateResponse>, clearSelection = false) {
    if (!mounted.current || mutating.current) return;
    mutating.current = true;
    const version = ++requestVersion.current;
    setBusy(true); setError(null); setTruth(null);
    if (clearSelection) { truthVisible.current = false; setShowTruth(false); }
    replayVersion.current += 1; window.clearTimeout(replayTimer.current);
    replaying.current = false; setReplay(null);
    let completed = false;
    try {
      const result = await operation(); const next = "state" in result ? result.state : result;
      if (!mounted.current || version !== requestVersion.current) return;
      completed = true;
      if (clearSelection) { cognitionNotices.reset(); setCaseSession(value => value + 1); setSelectedCaseId(null); }
      setLive(next);
      if (clearSelection) { setSelectedBelief(null); setTrace(null); setFeedback(null); setTruth(null); setCard(null); saved.current = null; setView("village"); }
      return next;
    } catch (e) { if (mounted.current && version === requestVersion.current) setError(e instanceof Error ? e.message : "这次操作没有完成，请再试一次。"); }
    finally { mutating.current = false; if (mounted.current) { setBusy(false); void refresh(completed); } }
  }
  async function beginOrToggle() {
    if (live?.merged_game?.b_review?.closure.can_continue) { await continueInvestigation(); return; }
    if (live?.merged_game?.b_review?.closure.status === "awaiting_trace") { investigate(live.merged_game.b_review.closure.pending_incident_ids[0]); return; }
    if (!started) await act(async () => { await api.startGame(); return api.run(speed); }, true);
    else if (live?.simulation.running) await act(api.pause);
    else await act(() => api.run(speed));
  }
  async function fastForward() {
    if (live?.merged_game?.b_review?.closure.status === "awaiting_trace") { investigate(live.merged_game.b_review.closure.pending_incident_ids[0]); return; }
    await act(async () => { if (!started) await api.startGame(); else if (live?.simulation.running) await api.pause(); return api.advance(100); });
  }
  async function choose(option: ChoiceOption) {
    if (!prompt) return;
    const next = await act(() => api.choice(prompt.point, option));
    if (next && mounted.current && (prompt.point === "D1" || prompt.point === "D4")) { setView("review"); setSelectedCaseId(null); setSelectedBelief(null); setFeedback(null); }
  }
  function toggleTruth() {
    if (!mounted.current || mutating.current || replaying.current) return;
    truthVisible.current = !truthVisible.current;
    requestVersion.current += 1;
    // Export.state is public; privileged cells exist only in this separately cleared layer.
    setShowTruth(truthVisible.current); setTruth(null); setError(null);
    void refresh();
  }
  function selectMember(id: string) { setSelectedAgent(id); setDetail(null); setSelectedBelief(null); setTrace(null); setSheetTab("personal"); setFeedback(null); }
  function selectBelief(belief: Belief) { setTrace(null); setSelectedBelief(belief); setSheetTab("source"); setFeedback(null); }
  async function accuse() {
    if (!selectedBelief) return;
    const caseId = live?.incidents.find(item => item.id === selectedCaseId)?.id || live?.incidents.at(-1)?.id;
    await act(async () => { const result = await api.accuse(selectedAgent, selectedBelief.id, live?.merged_game?.b_review ? caseId : undefined); if (mounted.current) setFeedback({ correct: result.correct, message: result.reason }); return result; });
  }
  function investigate(caseId?: string) { setSelectedCaseId(caseId || null); setFeedback(null); setView("trace"); }
  async function continueInvestigation() { setCard(null); setCardPreview(false); await act(api.continueInvestigation); setView("review"); }
  function missionAction(action: MissionAction) {
    if (action === "begin") void beginOrToggle();
    else if (action === "advance") void fastForward();
    else if (action === "continue") void continueInvestigation();
    else if (action === "investigate") investigate(live?.merged_game?.b_review?.closure.pending_incident_ids[0]);
    else if (action === "review") setView("review");
  }
  function returnToLive() {
    replayVersion.current += 1; window.clearTimeout(replayTimer.current); setReplay(null);
    replaying.current = false; requestVersion.current += 1;
    void refresh();
  }
  function scrub(turn: number) {
    if (!mounted.current || mutating.current) return;
    window.clearTimeout(replayTimer.current);
    const ticket = ++replayVersion.current;
    requestVersion.current += 1;
    truthVisible.current = false; setShowTruth(false); setTruth(null);
    if (turn === live?.simulation.turn) { replaying.current = false; setReplay(null); void refresh(); return; }
    replaying.current = true;
    replayTimer.current = window.setTimeout(() => { void (async () => {
      try {
        if (live?.simulation.running) {
          const paused = await api.pause();
          if (!mounted.current || ticket !== replayVersion.current) return;
          setLive(paused.state);
        }
        const snapshot = await api.replay(turn);
        if (!mounted.current || ticket !== replayVersion.current) return;
        setReplay(snapshot); setSelectedBelief(null); setTrace(null);
      } catch (e) {
        if (mounted.current && ticket === replayVersion.current) {
          replaying.current = false; setReplay(null);
          setError(e instanceof Error ? e.message : "这一回合没有可用回放。");
          void refresh(false);
        }
      }
    })(); }, 120);
  }

  if (!state || !live) return <main className="game-loading"><div className="loading-wildlings"><Sparkles size={32} /></div><h1>荒野 · 伪记忆</h1><p>{error || "五个野人，正在等一次出发。"}</p><button className="game-button" onClick={() => void refresh()}><RotateCcw size={15} />重新连接</button></main>;
  const story = resolveStoryScenes(state);
  const closure = state.merged_game?.b_review?.closure;
  const liveClosure = live.merged_game?.b_review?.closure;
  const phase = { index: Number(story.current.number) - 1, title: closure?.observation_complete ? closure.title : story.current.title, subtitle: closure?.observation_complete ? closure.reason : "各自探索，用实际经历核对部落里的说法" };
  const agent = state.agents.find(item => item.id === selectedAgent) || state.agents[0];
  const personal = detail?.personalBeliefs || [];
  const shared = detail?.adoptedSharedBeliefs || [];
  const currentMemories = sheetTab === "shared" ? shared : personal;
  const visibleTrace = trace?.targetId === selectedBelief?.id ? trace : null;
  const activeBelief = selectedBelief ? [...personal, ...shared, ...state.collectiveKnowledge].find(item => item.id === selectedBelief.id) || selectedBelief : null;
  const incident = state.incidents.find(item => item.id === selectedCaseId) || state.incidents.at(-1);
  const openTasks = state.tasks.filter(task => !["RESOLVED", "EXPIRED"].includes(task.status));
  const broadcastEnabled = state.broadcast_enabled !== false;
  const selectedRemoved = !!agent?.removed || !!state.removed_agents?.includes(agent?.id);
  const currentClock = activeClock;
  const maxPersonal = Math.max(0, ...state.agents.map(item => item.verifiedBeliefCount));
  const disabled = busy || !!prompt || !!replay;
  const swarm = resolveSwarmScene(state);
  const caseStatus = incident ? ({ INJECTED: "尚未发现异常", VERIFYING: "正在采纳前核验", SPREADING: "说法正在传播", DISPUTED: "旧说法存在争议", INVESTIGATING: "正在分工复测", REPAIRED: "已完成条件修正", REVOKED: "已撤回，原因未查清", PREVENTED: "已在采纳前拦截" } as Record<string, string>)[incident.status] || "调查进行中" : "尚未发生伪记忆事件";
  const viewClock = state.trace_game?.rounds?.find(item => item.incident_id === incident?.id) || state.trace_game?.current;
  const sourceConfirmed = !!incident?.rootBeliefId && viewClock?.incident_id === incident.id && viewClock.result?.correct === true;
  const traceState = { ...state, incidents: incident ? [incident] : [], trace_game: state.trace_game ? { ...state.trace_game, current: viewClock } : null };
  const caseTasks = openTasks.filter(task => task.type === "INVESTIGATION");
  const headings: Record<View, { title: string; subtitle: string }> = {
    village: phase,
    review: { title: "协作调查", subtitle: "谁发现了矛盾，谁补了证据，结论何时改变" },
    swarm: { title: "蜂群协作", subtitle: `${caseTasks.length} 项案件调查 · ${openTasks.length - caseTasks.length} 项日常任务 · ${state.agents.length} 位成员` },
    case: { title: "伪记忆调查", subtitle: `${state.incidents.length} 起事件 · 规则核验与源头指认分别记录` },
    trace: { title: incident ? `追查第 ${incident.attackNumber} 条伪记忆` : "追零号", subtitle: sourceConfirmed ? "源头已确认，真实传播路径已揭晓" : "源头未确认 · 转述与引用声明不等于原始证据" },
    knowledge: { title: "部落常识", subtitle: `${state.metrics.verifiedCollectiveBeliefs} 条经过独立验证 · ${state.collectiveKnowledge.length} 条公开记录` },
    wall: { title: "结局墙", subtitle: `${wall.length} 份已留存的部落记录` },
  };
  const heading = headings[view];

  return <main className="game-root game-root-b" data-view={view} data-snapshot-turn={state.simulation.turn} data-truth-turn={truth?.turn ?? "hidden"}>
    <div className="b-version-bar"><a href="http://127.0.0.1:8781/" target="_blank" rel="noreferrer">A · 保留版</a><span aria-current="page">B · 协作求证</span><button className="b-cognition-guide-link" onClick={() => setShowCognitionGuide(true)} title="打开四阶形态图鉴"><BookOpen size={12} />认知图鉴</button><small>本地独立展示局</small></div>
    <header className="game-header"><div className="game-brand"><span className="game-brand-mark"><Fingerprint size={27} /></span><div><strong>荒野 · 伪记忆</strong><span>EVOBABY / THE WILD KNOWS</span></div></div><nav className="game-nav" aria-label="部落视图">{([{ id: "village", label: "村子", icon: MapIcon }, { id: "review", label: "协作调查", icon: ShieldCheck }, { id: "swarm", label: "成员分工", icon: Network }, { id: "case", label: "案件卷宗", icon: ClipboardList }, { id: "trace", label: "追查源头", icon: Search }, { id: "knowledge", label: "部落常识", icon: BookOpen }, { id: "wall", label: "结局墙", icon: Trophy }] as const).map(item => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}><item.icon size={15} />{item.label}{item.id === "wall" && wall.length > 0 && <small>{wall.length}</small>}</button>)}</nav><div className="game-header-tools"><span className={`judge-lamp ${state.judge_online ? "online" : ""}`}><i />{state.judge_online ? "Jev 在线" : "本地裁判"}</span><button className="game-icon" title={showTruth ? "隐藏世界真值" : "查看世界真值"} aria-label={showTruth ? "隐藏世界真值" : "查看世界真值"} onClick={toggleTruth} disabled={busy || !!replay}>{showTruth ? <Eye size={17} /> : <EyeOff size={17} />}</button><button className="game-button judge-switch" onClick={onJudge}><Settings2 size={14} />评委模式</button></div></header>
    {error && <div className="game-error" role="alert"><Info size={16} /><span>{error}</span><button className="game-icon" aria-label="关闭提示" onClick={() => setError(null)}><X size={15} /></button></div>}
    <div className="game-workspace">
      <aside className="tribe-sidebar"><header className="tribe-heading"><span className="micro-label">OUR LITTLE TRIBE</span><h2>五个人，一片荒野</h2><span className="tribe-seed">SEED {state.simulation.seed}</span></header><div className="tribe-roster">{state.agents.map(member => {
        const removed = !!member.removed || !!state.removed_agents?.includes(member.id);
        const duty = swarm.members.find(item => item.agentId === member.id);
        const appearance = deriveWildlingState(member, state.recentEvents, state.simulation.turn, { base: state.world.base, showTruth: !!truth, infected: !!truth && !!incident?.affectedAgentIds.includes(member.id), reputation: member.appearance?.reputation || member.reputation || 0 });
        return <button key={member.id} className={`tribe-member ${member.id === selectedAgent ? "selected" : ""} ${removed ? "removed" : ""}`} onClick={() => selectMember(member.id)}><Wildling color={wildlingColor(member.id)} state={{ ...appearance, berry: member.appearance?.hasBerry || appearance.berry, crystal: member.appearance?.hasCrystal || appearance.crystal, ruffled: (member.appearance?.ruffledUntilTurn || 0) >= state.simulation.turn && !!member.appearance?.ruffledUntilTurn, removed }} size={65} /><span className="tribe-member-text"><strong>{wildlingName(member.id)}<small>{member.id}</small></strong><CognitionBadge agent={member} /><span>{removed ? `留下 ${state.memorials?.find(item => item.agent_id === member.id)?.taught_count ?? member.personalBeliefCount} 条记忆` : actionLabel[member.currentAction || ""] || "看看世界"}</span><span className="member-coordination" title={duty?.detail}><Network size={11} />{duty?.taskId ? `${duty.taskId} · ` : ""}{duty?.roleLabel || "自主探索"}</span><span className="member-energy"><i style={{ width: `${member.energy}%`, background: member.energy < 25 ? "#ee806b" : wildlingColor(member.id) }} /></span></span><b className="member-energy-number">{removed ? "—" : member.energy}</b></button>;
      })}</div><section className="tribe-knowledge-meter"><span>我们一起知道的</span><strong>{state.metrics.verifiedCollectiveBeliefs}<small>条已验证常识</small></strong><div><span>个人最多</span><b>{maxPersonal}</b></div><div><span>足迹覆盖</span><b>{Math.round(state.metrics.exploredCellPercent)}%</b></div></section><div className="tribe-policy"><span className="micro-label">HOW WE KNOW</span><p>{state.choices?.D3 ? ({ A: "人多不等于地方多。换个场景，重新验证。", B: "至少三个独立的人验过，再成为常识。", C: "别人讲的，先自己试过，再相信。", D: "这次过后，部落保留原来的验证方式。" })[state.choices.D3] : state.metaBeliefs.length ? "同意的人再多，也要在不同场景里验证。" : "我试过。你也试过。于是我们开始相信。"}</p>{state.choices?.D3 && <span className="policy-choice"><ShieldCheck size={13} />{CHOICE_LABELS.D3[state.choices.D3]}</span>}</div><button className={`broadcast-toggle ${broadcastEnabled ? "" : "disconnected"}`} disabled={disabled || !started} onClick={() => void act(() => api.broadcast(!broadcastEnabled))}>{broadcastEnabled ? <Radio size={16} /> : <Unplug size={16} />}<span>{broadcastEnabled ? "篝火广播已连接" : "各走各的 · 广播已断"}</span><i /></button></aside>

      <section className="game-main"><div className="game-stage-heading"><div><span className="micro-label">CHAPTER 0{phase.index + 1} / {replay ? "REPLAY" : "LIVE WORLD"}</span><h1>{heading.title}</h1><p>{heading.subtitle}</p></div><div className="world-weather">{state.world.weather === "Rain" ? <CloudRain size={22} /> : <Sun size={22} />}<span>{state.world.weather === "Rain" ? "雨正在落下" : "今天晴朗"}<small>TURN {String(state.simulation.turn).padStart(3, "0")}</small></span></div></div>
        <MissionBar state={state} disabled={busy} replaying={!!replay} onAction={missionAction} />
        {replay && <div className="replay-banner"><History size={14} />第 {replay.simulation.turn} 回合的历史现场<button onClick={returnToLive}>回到现在 <ArrowRight size={13} /></button></div>}
        {view === "review" && <ReviewWorkspace state={state} replaying={!!replay} selectedCaseId={selectedCaseId} onSelectCase={setSelectedCaseId} onInvestigate={investigate} onSelectAgent={selectMember} sessionKey={`${caseSession}:${state.simulation.seed}`} />}
        {view === "trace" && state.incidents.length > 1 && <div className="b-trace-cases" role="tablist" aria-label="选择追源案件">{state.incidents.map(item => <button role="tab" aria-selected={incident?.id === item.id} key={item.id} onClick={() => { setSelectedCaseId(item.id); setFeedback(null); setSelectedBelief(null); }}><Search size={14} />第 {item.attackNumber} 案<small>{state.trace_game?.rounds?.find(run => run.incident_id === item.id)?.result?.correct ? "源头已确认" : "等待指认"}</small></button>)}</div>}
        {truth && <div className="truth-banner"><Eye size={14} /><span>世界真值：苔藓仅在{regionLabel[truth.mossRule.positiveWhen.region]}、{truth.mossRule.positiveWhen.weather === "Rain" ? "雨天" : "晴天"}恢复 {truth.mossRule.positiveEnergyDelta} 能量；其他场景 {truth.mossRule.otherEnergyDelta}。</span></div>}
        {view === "village" && <><SwarmPulse state={state} onOpen={() => setView("swarm")} /><div className="village-stage"><WildWorldScene world={state.world} agents={state.agents} selectedAgent={selectedAgent} onSelectAgent={selectMember} events={state.recentEvents} groundTruth={replay ? null : truth} turn={state.simulation.turn} incidents={state.incidents} knownPositions={detail?.knownCells.map(cell => cell.position)} suspended={!!card || !!prompt || showCognitionGuide} /></div><div className="world-strip"><span><i className="region-swatch nw" />西北 · 苔原</span><span><i className="region-swatch ne" />东北 · 晶地</span><span><i className="region-swatch sw" />西南 · 密林</span><span><i className="region-swatch se" />东南 · 赤岩</span><button onClick={() => setShowTasks(current => !current)}><ListFilter size={13} />公告板 <b>{openTasks.length}</b></button></div><StoryScene current={story.current} chapters={story.chapters} replaying={!!replay} events={state.recentEvents} turn={state.simulation.turn} /></>}
        {(view === "swarm" || view === "trace" && !sourceConfirmed) && <section className="b-case-status" aria-label="当前案件进展"><div><span>{incident ? `案件 0${incident.attackNumber}` : "案件状态"}</span><strong>{caseStatus}</strong><small>玩家追源：{sourceConfirmed ? "已确认" : "未确认"}</small></div><button className="game-button" onClick={() => setView("case")}><ClipboardList size={14} />查看案件<ArrowRight size={14} /></button></section>}
        {view === "case" && <CaseBook state={state} replaying={!!replay} initialCaseId={selectedCaseId} sessionKey={`${caseSession}:${state.simulation.seed}`} onInvestigate={investigate} onSelectAgent={selectMember} />}
        {view === "swarm" && <SwarmScene state={state} selectedAgent={selectedAgent} onSelectAgent={selectMember} onSelectBelief={selectBelief} />}
        {view === "knowledge" && <section className="village-knowledge"><div className="knowledge-toolbar"><h2>篝火边留下的常识 <span>{state.collectiveKnowledge.length}</span></h2><span>{state.metrics.verifiedCollectiveBeliefs} 条经过独立验证</span></div>{state.collectiveKnowledge.length ? <div className="knowledge-records">{state.collectiveKnowledge.slice().reverse().map(belief => <button key={belief.id} className={`knowledge-record ${belief.status.toLowerCase()} ${selectedBelief?.id === belief.id ? "selected" : ""}`} onClick={() => selectBelief(belief)}><span className="record-object">{resourceLabel[belief.object]}</span><span className="record-body"><strong>{beliefTitle(belief)}</strong><small>{belief.independent_agent_ids.length} 个独立来源 · {belief.evidence_count} 条证据 · {belief.id}</small></span><span className="record-confidence">{Math.round(belief.display_confidence * 100)}<small>%</small></span><span className="belief-tag">{beliefStatusLabel[belief.status]}</span><ChevronRight size={15} /></button>)}</div> : <div className="game-empty"><BookOpen size={30} /><h3>第一条常识，还在路上。</h3><p>他们要先亲眼看见，再亲自试过。</p></div>}</section>}
        {view === "trace" && <TraceBoard state={traceState} trace={visibleTrace} selectedAgent={selectedAgent} selectedBelief={selectedBelief} onSelect={selectMember} seconds={replay ? Math.floor(viewClock?.elapsed || 0) : seconds} truth={!replay && !!truth} onCase={() => setView("case")} />}
        {view === "wall" && <EndingGallery wall={wall} onOpen={(paradigm, preview, presentation = "art") => { setCardPresentation(presentation); setCardPreview(preview); setCard(paradigm); }} />}
        {showTasks && <section className="game-task-drawer"><header><h2><Radio size={16} />篝火公告板</h2><button className="game-icon" title="收起公告板" aria-label="收起公告板" onClick={() => setShowTasks(false)}><X size={16} /></button></header>{openTasks.length ? openTasks.map(task => <article key={task.id} className={`game-task ${state.simulation.turn - task.created_turn >= 3 && !task.claimant_agent_ids.length ? "waiting" : ""}`}><span>{taskTypeLabel[task.type]}<b>{taskStatusLabel[task.status]}</b></span><strong>{task.description}</strong><small>{task.claimant_agent_ids.length ? task.claimant_agent_ids.map(wildlingName).join("、") : `等待认领 ${state.simulation.turn - task.created_turn} 回合`} · {task.completed_context_ids.length}/{task.required_contexts.length} 个场景</small></article>) : <p className="muted-copy">现在没有待办，继续探索。</p>}</section>}
      </section>

      <aside className="game-inspector"><header className="inspector-profile"><div><span className="micro-label">PERSONAL ARCHIVE</span><h2>{wildlingName(agent.id)}<small>{agent.id}</small></h2><p>{regionLabel[agent.region]} · {selectedRemoved ? "暂离部落" : agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > state.simulation.turn ? "在基地恢复" : actionLabel[agent.currentAction || ""] || "看看世界"}</p></div><Wildling color={wildlingColor(agent.id)} state={deriveWildlingState(agent, state.recentEvents, state.simulation.turn, { base: state.world.base })} size={104} /></header><div className="inspector-vitals"><span><Activity size={13} />能量<b>{agent.energy}<small>/100</small></b></span><span><Layers3 size={13} />亲历<b>{agent.personalBeliefCount}</b></span><span><Network size={13} />采纳<b>{agent.sharedBeliefCount}</b></span></div>
        <CognitionPanel agent={agent} onGuide={() => setShowCognitionGuide(true)} />
        <div className="inspector-tabs"><button className={sheetTab === "personal" ? "active" : ""} onClick={() => setSheetTab("personal")}>个人记忆</button><button className={sheetTab === "shared" ? "active" : ""} onClick={() => setSheetTab("shared")}>共享常识</button><button className={sheetTab === "source" ? "active" : ""} onClick={() => setSheetTab("source")}>三种出处</button></div>
        <div className="inspector-scroll">{replay ? <div className="game-empty small"><History size={24} /><p>正在回看历史现场。<br />返回现在后再调取个人原件。</p></div> : sheetTab !== "source" ? currentMemories.length ? <div className="memory-list">{currentMemories.slice().reverse().map(belief => <button key={belief.id} className={`memory-note ${belief.status.toLowerCase()} ${selectedBelief?.id === belief.id ? "selected" : ""}`} onClick={() => selectBelief(belief)}><span><b>{belief.id}</b><em>{beliefStatusLabel[belief.status]}</em></span><strong>{beliefTitle(belief)}</strong><footer><span>确信 {Math.round(belief.display_confidence * 100)}%</span><span>{belief.evidence_count} 条依据 <ChevronRight size={11} /></span></footer></button>)}</div> : <div className="game-empty small"><BookOpen size={26} /><h3>{sheetTab === "personal" ? "记忆还很轻。" : "还没采纳同伴的经验。"}</h3><p>{sheetTab === "personal" ? "每一次经历，都会留下点什么。" : "先去看看世界，再回篝火边。"}</p></div> : <SourceInspector belief={activeBelief} trace={visibleTrace} onFind={() => setView("trace")} />}
          {view === "trace" && incident && !replay && <section className="accusation-section"><div><span className="micro-label">YOUR VERDICT</span><strong>哪条记忆，是最初的源头？</strong></div><label>指认的成员<select value={selectedAgent} onChange={event => selectMember(event.target.value)} aria-label="指认的成员">{state.agents.map(member => <option value={member.id} key={member.id}>{wildlingName(member.id)} · {member.id}</option>)}</select></label><label>指认的常识<select value={selectedBelief && [...personal, ...shared].some(b => b.id === selectedBelief.id) ? selectedBelief.id : ""} onChange={event => { const belief = [...personal, ...shared].find(item => item.id === event.target.value); if (belief) selectBelief(belief); }} aria-label="指认的常识"><option value="">选择一条记忆</option>{[...personal, ...shared].map(belief => <option key={belief.id} value={belief.id}>{belief.id} · {beliefTitle(belief)}</option>)}</select></label><button className="game-button primary" disabled={disabled || !selectedBelief || !!currentClock?.result?.correct} onClick={() => void accuse()}><Search size={14} />{currentClock?.result?.correct ? "源头已确认" : "提交指认"}<ArrowRight size={15} /></button>{feedback && <p className={`accusation-feedback ${feedback.correct ? "correct" : "wrong"}`} role="status">{feedback.message}</p>}<p className="clock-footnote">你 {timeLabel(seconds)} · 部落 {currentClock?.swarm_turns == null ? "仍在调查" : `${currentClock.swarm_turns} 回合`}<br />现实时间与世界回合分别记录。</p></section>}
        </div><footer className="inspector-bottom"><span>{selectedRemoved ? "它留下的经验仍在部落中" : `${resourceLabel.Berry} ${agent.inventory.Berry || 0} · ${resourceLabel.Crystal} ${agent.inventory.Crystal || 0}`}</span><button className="game-icon" disabled={disabled || !started || selectedRemoved} title="让这个成员暂离部落" aria-label="让这个成员暂离部落" onClick={() => setRemoveAgent(agent.id)}><Unplug size={14} /></button></footer>
      </aside>
    </div>
    <footer className="game-playbar"><div className="play-controls"><button className="game-play" disabled={busy || !!prompt || (!!live.paradigm && !liveClosure?.can_continue) || !!replay} onClick={() => void beginOrToggle()}>{busy ? <LoaderCircle size={17} className="spin" /> : live.simulation.running ? <Pause size={17} /> : <Play size={17} />}<span>{!started ? "开始旅程" : liveClosure?.can_continue ? "继续调查" : liveClosure?.status === "awaiting_trace" ? "追查源头" : live.simulation.running ? "暂停" : "继续旅程"}</span></button><button className="game-icon" disabled={disabled || !started || live.simulation.running || !!live.paradigm || liveClosure?.status === "awaiting_trace"} title="推进一个世界回合" aria-label="推进一个世界回合" onClick={() => void act(api.step)}><SkipForward size={17} /></button><button className="game-icon" disabled={disabled || !!live.paradigm || liveClosure?.status === "awaiting_trace"} title="快进到下一个关口" aria-label="快进到下一个关口" onClick={() => void fastForward()}><FastForward size={19} /></button><div className="game-speed" aria-label="运行速度">{([1, 5, 20] as const).map(value => <button key={value} className={speed === value ? "active" : ""} disabled={disabled} onClick={() => { setSpeed(value); if (live.simulation.running) void act(() => api.run(value)); }}>{value}×</button>)}</div></div><div className="game-replay"><span>{replay ? <History size={13} /> : <i className={live.simulation.running ? "running" : ""} />}<b>{String(state.simulation.turn).padStart(3, "0")}</b><small>回合</small></span><input type="range" min="0" max={Math.max(1, live.simulation.turn)} value={state.simulation.turn} onChange={event => scrub(Number(event.target.value))} disabled={busy || live.simulation.turn === 0} aria-label="世界回合回放" /><span className="replay-end">{live.simulation.turn}</span></div><div className="playbar-end">{live.paradigm ? <button className="game-button accent" onClick={() => setCard(live.paradigm!)}><Download size={14} />领取部落卡</button> : live.simulation.canInjectFirst && !prompt ? <button className="game-button danger" disabled={disabled} onClick={() => void act(() => api.inject("regulator"))}><Fingerprint size={14} />植入伪记忆</button> : live.simulation.canInjectSecond && !prompt ? <button className="game-button danger" disabled={disabled} onClick={() => void act(api.injectSecond)}><Fingerprint size={14} />第二次谣言</button> : <span className="playbar-note">{prompt ? "等待部落决定" : state.metrics.knowledgeMature ? "知识已成熟" : "世界会回应每一次尝试"}</span>}<button className="game-icon" title="同一种子重新出发" aria-label="同一种子重新出发" disabled={busy} onClick={() => void act(api.startGame, true)}><RotateCcw size={16} /></button></div></footer>
    {!prompt && !card && !replay && <CognitionNotice notices={cognitionNotices.notices} onDismiss={cognitionNotices.dismiss} />}
    {showCognitionGuide && <CognitionGuide agents={state.agents} selectedAgent={selectedAgent} onClose={closeCognitionGuide} />}
    {prompt && !replay && <ChoiceDialog prompt={prompt} busy={busy} onChoose={option => void choose(option)} />}
    {card && !prompt && <div className="game-modal-backdrop ending-modal" ref={endingModal} role="dialog" aria-modal="true" aria-label={`${card.name}${cardPreview ? "视觉预览" : "纪念卡"}`} onKeyDown={handleEndingKeys}><EndingCard paradigm={card} initialPresentation={cardPresentation} preview={cardPreview} onContinue={!cardPreview && card.id === live.paradigm?.id && liveClosure?.can_continue ? () => void continueInvestigation() : undefined} onInvestigate={!cardPreview && card.id === live.paradigm?.id && (liveClosure?.pending_incident_ids.length ?? 0) > 0 ? () => { setCard(null); investigate(liveClosure?.pending_incident_ids[0]); } : undefined} onClose={() => { setCard(null); setCardPreview(false); }} onNewGame={cardPreview ? undefined : () => void act(api.startGame, true)} /></div>}
    {removeAgent && <div className="game-modal-backdrop"><section className="remove-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title"><Unplug size={26} /><h2 id="remove-title">让 {wildlingName(removeAgent)} 暂离部落？</h2><p>它将停止行动。已经交给同伴的经验会留下。</p><div><button className="game-button" onClick={() => setRemoveAgent(null)}>留下</button><button className="game-button danger" onClick={() => { const id = removeAgent; setRemoveAgent(null); void act(() => api.remove(id)); }}>暂离部落 <ArrowRight size={14} /></button></div></section></div>}
  </main>;
}

function OriginalRecord({ record, trace }: { record: TraceRecord; trace: BeliefTrace }) {
  const value = record.details;
  const observation = (value.observation || {}) as Record<string, unknown>;
  const result = (value.result || {}) as Record<string, unknown>;
  const region = value.region || observation.region;
  const weather = value.weather || observation.weather;
  const delta = typeof value.energy_delta === "number" ? value.energy_delta : typeof result.resource_effect === "number" ? result.resource_effect : null;
  const turn = value.turn;
  return <details className="original-record"><summary>{record.id}<ChevronRight size={12} /></summary><p>{record.content}</p><dl>{record.agentId && <div><dt>记录成员</dt><dd>{wildlingName(record.agentId)}</dd></div>}{typeof turn === "number" && <div><dt>发生回合</dt><dd>{turn}</dd></div>}{typeof region === "string" && <div><dt>场景</dt><dd>{regionLabel[region as keyof typeof regionLabel] || region} · {weather === "Rain" ? "雨天" : weather === "Sunny" ? "晴天" : "未记录"}</dd></div>}{delta != null && <div><dt>能量变化</dt><dd className={delta < 0 ? "counter-value" : ""}>{delta > 0 ? "+" : ""}{delta}</dd></div>}{typeof result.action === "string" && <div><dt>实际行动</dt><dd>{actionLabel[result.action] || result.action}</dd></div>}</dl>{record.declaredRefs.map(id => { const original = trace.records.find(item => item.id === id); return original && original.id !== record.id ? <div className="raw-reference" key={id}><strong>{id} · {original.content}</strong><span>{String((original.details.result as Record<string, unknown> | undefined)?.reason || "")}</span></div> : <div className="raw-reference" key={id}>引用 {id}，尚缺原始记录</div>; })}</details>;
}

function SourceInspector({ belief, trace, onFind }: { belief: Belief | null; trace: BeliefTrace | null; onFind: () => void }) {
  if (!belief) return <div className="game-empty small"><Network size={28} /><h3>还没有展开的记忆。</h3><p>一条常识，可能有不止一种出处。</p></div>;
  return <div className="source-inspector"><div className="source-selected"><span>{belief.id} · {beliefStatusLabel[belief.status]}</span><h3>{beliefTitle(belief)}</h3><div><b>{Math.round(belief.display_confidence * 100)}%</b><span>{belief.evidence_count} 条声明依据</span></div></div>{trace ? <><section className="source-kind transmitted"><h4><i />亲手交的 <b>{trace.lines.transmitted.length}</b></h4>{trace.lines.transmitted.length ? trace.lines.transmitted.map((edge, index) => <div className="source-line" key={`${edge.from}-${index}`}><strong>{wildlingName(edge.sender)} → {wildlingName(edge.receiver)}</strong><small>{edge.messageId || `${edge.from} → ${edge.to}`}</small></div>) : <p>尚无记录显示这条经验由同伴传入。</p>}</section><section className="source-kind declared"><h4><i />它自己说的 <b>{trace.lines.declared.length}</b></h4>{trace.lines.declared.length ? trace.lines.declared.slice(0, 8).map((edge, index) => <div className="source-line" key={`${edge.to}-${index}`}><strong>{edge.from}</strong><small>{trace.records.find(record => record.id === edge.from)?.content || "只有引用声明，未取得原始记录"}</small>{trace.records.find(record => record.id === edge.from) && <OriginalRecord record={trace.records.find(record => record.id === edge.from)!} trace={trace} />}</div>) : <p>没有声明依据。</p>}</section><section className="source-kind discovered"><h4><i />事后查出的 <b>{trace.lines.discovered.length}</b></h4>{trace.lines.discovered.length ? trace.lines.discovered.map((edge, index) => <div className={`source-line ${edge.outcome === "COUNTEREXAMPLE" ? "counter" : ""}`} key={`${edge.to}-${index}`}><strong>{edge.outcome === "COUNTEREXAMPLE" ? "世界反馈反对它" : "世界反馈支持它"}</strong><small>{trace.records.find(record => record.id === edge.from)?.content || `${edge.from} → ${edge.to}`}</small>{trace.records.find(record => record.id === edge.from) && <OriginalRecord record={trace.records.find(record => record.id === edge.from)!} trace={trace} />}</div>) : <p>还没有后续实验的回执。</p>}</section>{trace.missingParentIds.length > 0 && <div className="missing-provenance"><strong>尚缺原始记录</strong><span>{trace.missingParentIds.join(" · ")}</span></div>}{trace.truncated && <p className="muted-copy">来源较长，本次仅展开部分记录。</p>}</> : <p className="muted-copy">正在调取来源档案…</p>}<button className="game-button full" onClick={onFind}><Search size={14} />带到「追零号」<ArrowRight size={14} /></button></div>;
}

function TraceBoard({ state, trace, selectedAgent, selectedBelief, onSelect, seconds, truth, onCase }: { state: StateResponse; trace: BeliefTrace | null; selectedAgent: string; selectedBelief: Belief | null; onSelect: (id: string) => void; seconds: number; truth: boolean; onCase: () => void }) {
  const points = [{ x: 370, y: 87 }, { x: 592, y: 240 }, { x: 510, y: 450 }, { x: 230, y: 450 }, { x: 146, y: 240 }];
  const indexOf = (id: string | null | undefined) => state.agents.findIndex(agent => agent.id === id);
  const recordOwners = new Map(trace?.records.map(record => [record.id, record.agentId]) || []);
  const [edgeDetail, setEdgeDetail] = useState<string | null>(null);
  const edges: { from: string; to: string; kind: string; text: string }[] = [];
  trace?.lines.transmitted.forEach(edge => edges.push({ from: edge.sender, to: edge.receiver, kind: "transmitted", text: `${wildlingName(edge.sender)} 亲手交给 ${wildlingName(edge.receiver)} · ${edge.messageId}` }));
  trace?.lines.declared.forEach(edge => { const from = recordOwners.get(edge.from); const to = recordOwners.get(edge.to); if (from && to) edges.push({ from, to, kind: "declared", text: `${edge.to} 声称依据 ${edge.from}` }); });
  trace?.lines.discovered.forEach(edge => { const from = recordOwners.get(edge.from); const to = recordOwners.get(edge.to); if (from && to) edges.push({ from, to, kind: edge.outcome === "COUNTEREXAMPLE" ? "counter" : "discovered", text: `${edge.from} → ${edge.to} · ${edge.outcome === "COUNTEREXAMPLE" ? "反证" : "支持"}` }); });
  const resolvedClock = state.trace_game?.current;
  const revealedIncident = resolvedClock?.result?.correct ? state.incidents.find(item => item.id === resolvedClock.incident_id) : null;
  revealedIncident?.lineage.forEach(edge => edges.push({ from: edge.senderAgentId, to: edge.receiverAgentId, kind: "transmitted", text: `已揭晓：${wildlingName(edge.senderAgentId)} ${edge.parentBeliefId} → ${wildlingName(edge.receiverAgentId)} ${edge.childBeliefId}` }));
  const uniqueEdges = [...new Map(edges.map(edge => [`${edge.from}:${edge.to}:${edge.kind}`, edge])).values()];
  const incident = state.incidents.at(-1);
  useEffect(() => setEdgeDetail(null), [state.simulation.seed, state.simulation.turn, incident?.id, selectedBelief?.id]);
  return <section className="trace-playground"><div className="trace-topline"><span><Search size={14} />{incident ? `第 ${incident.attackNumber} 次伪记忆事件` : "还没有伪记忆事件"}</span><strong>{timeLabel(seconds)}<small>你的调查用时</small></strong></div>{revealedIncident && <div className="trace-revealed" role="status"><strong><Check size={14} />{resolvedClock?.result?.winner === "player" ? "你先找到了源头" : resolvedClock?.result?.winner === "tribe" ? revealedIncident.status === "REPAIRED" ? "部落先完成调查，你也找到了源头" : revealedIncident.status === "REVOKED" ? "旧记忆已撤回，你也找到了源头" : revealedIncident.status === "PREVENTED" ? "部落已在采纳前阻止，你也找到了源头" : "你找到了源头，调查仍待核实" : "源头已确认"}</strong><span>{revealedIncident.targetAgentId ? wildlingName(revealedIncident.targetAgentId) : "未知成员"} · {revealedIncident.rootBeliefId} · {revealedIncident.lineage.length} 条实际传播记录</span>{revealedIncident.lineage.length > 0 && <p>{revealedIncident.lineage.map(edge => `${wildlingName(edge.senderAgentId)} ${edge.parentBeliefId} → ${wildlingName(edge.receiverAgentId)} ${edge.childBeliefId}`).join("；")}</p>}<button className="b-case-link" onClick={onCase}>查看结案证据 <ArrowRight size={13} /></button></div>}<div className="trace-world"><svg viewBox="0 0 740 560" preserveAspectRatio="none" className="trace-edge-layer" aria-label="记忆来源连线">{uniqueEdges.map((edge, i) => { const from = points[indexOf(edge.from)], to = points[indexOf(edge.to)]; if (!from || !to) return null; const same = edge.from === edge.to; const path = same ? `M${from.x - 28},${from.y} C${from.x - 126},${from.y - 88} ${from.x + 126},${from.y - 88} ${from.x + 28},${from.y}` : `M${from.x},${from.y} Q370,282 ${to.x},${to.y}`; return <g key={`${edge.from}-${edge.to}-${i}`} className={`trace-edge ${edge.kind}`} tabIndex={0} role="button" aria-label={edge.text} onClick={() => setEdgeDetail(edge.text)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") setEdgeDetail(edge.text); }}><path d={path} /><title>{edge.text}</title></g>; })}</svg><div className={`trace-center-mark ${revealedIncident?.rootBeliefId ? "source-confirmed" : ""}`}><Fingerprint size={36} /><span>{revealedIncident?.rootBeliefId || selectedBelief?.id || "ZERO"}</span><small>{revealedIncident?.targetAgentId ? `${wildlingName(revealedIncident.targetAgentId)} · 已确认零号` : selectedBelief ? resourceLabel[selectedBelief.object] : "源头尚未确认"}</small></div>{state.agents.map((agent, index) => { const point = points[index]; const hurt = state.recentEvents.some(event => event.agent_id === agent.id && event.turn >= state.simulation.turn - 2 && (event.result?.resource_effect || 0) < 0); return <button className={`trace-agent ${selectedAgent === agent.id ? "selected" : ""} ${hurt ? "hurt" : ""} ${revealedIncident?.targetAgentId === agent.id ? "is-origin" : ""}`} style={{ left: `${point.x / 740 * 100}%`, top: `${point.y / 560 * 100}%` }} key={agent.id} onClick={() => onSelect(agent.id)}><Wildling color={wildlingColor(agent.id)} state={deriveWildlingState(agent, state.recentEvents, state.simulation.turn, { base: state.world.base, showTruth: truth, infected: truth && !!incident?.affectedAgentIds.includes(agent.id) })} size={94} /><strong>{wildlingName(agent.id)}</strong><small>{revealedIncident?.targetAgentId === agent.id ? "已确认零号" : hurt ? "最近掉过能量" : `${agent.personalBeliefCount + agent.sharedBeliefCount} 条记忆`}</small></button>; })}</div><div className="trace-line-legend"><span className="transmitted"><i />亲手交的</span><span className="declared"><i />它自己说的</span><span className="discovered"><i />实验支持</span><span className="counter"><i />世界反证</span></div><div className="trace-evidence-caption">{edgeDetail || (selectedBelief ? `${beliefTitle(selectedBelief)} · ${trace ? `${trace.records.length} 份来源记录` : "正在调取来源"}` : revealedIncident ? `源头已确认。${revealedIncident.lineage.length ? "实线为已揭晓的真实传递；引用声明与实验回证分开记录。" : "本案尚无后续传播记录，不代表源头尚未找到。"}` : "源头尚未确认 · 未选中的记忆不会显示来源连线。")}</div></section>;
}
