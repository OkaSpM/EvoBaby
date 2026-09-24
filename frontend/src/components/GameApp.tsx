import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, BookOpen, Check, ChevronRight, CloudRain, Compass, Download, Eye, EyeOff, FastForward, Fingerprint, Flame, History, Info, Layers3, ListFilter, LoaderCircle, Map as MapIcon, MessageCircle, Network, Pause, Play, Radio, RotateCcw, Search, Settings2, ShieldCheck, SkipForward, Sparkles, Sun, Trophy, Unplug, Users, X } from "lucide-react";
import { api } from "../api";
import { actionLabel, beliefStatusLabel, beliefTitle, conditionsLabel, regionLabel, resourceLabel, taskStatusLabel, taskTypeLabel } from "../i18n";
import type { AgentDetail, AgentSummary, Belief, BeliefTrace, ChoiceOption, ChoicePoint, ChoicePrompt, GroundTruth, Paradigm, RawEvent, StateResponse, StoryEvent, TraceRecord } from "../types";
import { WildWorldScene } from "./WildWorldScene";
import { Wildling, deriveWildlingState, wildlingColor, wildlingName } from "./Wildling";
import { ChoiceDialog } from "./ChoiceDialog";
import { CHOICE_LABELS, ENDING_COLORS, EndingCard, downloadJson } from "./EndingCard";

type View = "village" | "knowledge" | "trace" | "wall";
type SheetTab = "personal" | "shared" | "source";
type SavedEnding = { id: string; date: string; seed: number; paradigm: Paradigm };
const wallKey = "evobaby.tribe-wall.v1";
const timeLabel = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const promptOf = (state: StateResponse | null): ChoicePrompt | null => typeof state?.awaiting_choice === "string" ? { point: state.awaiting_choice } : state?.awaiting_choice || null;
const phaseOf = (state: StateResponse) => state.paradigm ? { index: 4, title: "部落，长成了自己的样子", subtitle: "把这次学会的协作方式带走" } : state.incidents.length > 1 ? { index: 4, title: "同样的荒野，第二次考验", subtitle: "新的规则正在接受世界检验" } : state.incidents.length ? { index: 3, title: "大家相信的，也可能不对", subtitle: "沿着记忆追溯，等世界给出证据" } : state.metrics.knowledgeMature ? { index: 2, title: "篝火边，常识已经传开", subtitle: "一条半真半假的记忆即将到来" } : state.collectiveKnowledge.length ? { index: 1, title: "我试过的，讲给你听", subtitle: "亲历与分享，正在成为部落的常识" } : { index: 0, title: "五个同样的野人，第一次出发", subtitle: "别饿着，也别停止好奇" };

function readWall(): SavedEnding[] { try { const value = JSON.parse(localStorage.getItem(wallKey) || "[]"); return Array.isArray(value) ? value.filter(item => item?.paradigm?.metrics?.attack1 && item?.paradigm?.metrics?.attack2).slice(0, 40) : []; } catch { return []; } }

export function GameApp({ onJudge }: { onJudge: () => void }) {
  const [live, setLive] = useState<StateResponse | null>(null);
  const [replay, setReplay] = useState<StateResponse | null>(null);
  const [view, setView] = useState<View>("village");
  const [selectedAgent, setSelectedAgent] = useState("A1");
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [sheetTab, setSheetTab] = useState<SheetTab>("personal");
  const [selectedBelief, setSelectedBelief] = useState<Belief | null>(null);
  const [trace, setTrace] = useState<BeliefTrace | null>(null);
  const [truth, setTruth] = useState<GroundTruth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ correct: boolean; message: string } | null>(null);
  const [speed, setSpeed] = useState<1 | 5 | 20>(5);
  const [wall, setWall] = useState<SavedEnding[]>(readWall);
  const [card, setCard] = useState<Paradigm | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [removeAgent, setRemoveAgent] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const requestVersion = useRef(0);
  const mutating = useRef(false);
  const saved = useRef<string | null>(null);
  const replayTimer = useRef<number>();
  const state = replay || live;
  const prompt = promptOf(live);
  const started = !!(live?.merged_game?.enabled || live?.game_started || live?.game?.enabled || live?.game?.started);

  const refresh = useCallback(async (reveal = false) => {
    if (mutating.current) return;
    const version = ++requestVersion.current;
    try { const result = await api.state(reveal); if (version === requestVersion.current) { setLive(result); setError(null); } }
    catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : "暂时连不上荒野世界。"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(!!truth), live?.simulation.running ? 500 : 1800); return () => clearInterval(timer); }, [live?.simulation.running, truth, refresh]);
  useEffect(() => {
    if (!live || replay) { setDetail(null); return; }
    let active = true;
    void api.agent(selectedAgent).then(value => { if (active) setDetail(value); }).catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [selectedAgent, live?.simulation.turn, live?.simulation.seed, replay]);
  useEffect(() => {
    if (!selectedBelief || replay) { setTrace(null); return; }
    let active = true;
    void api.trace(selectedBelief.id).then(value => { if (active) setTrace(value); }).catch(() => { if (active) setTrace(null); });
    return () => { active = false; };
  }, [selectedBelief?.id, live?.simulation.turn, replay]);
  useEffect(() => {
    const current = live?.trace_game?.current;
    const elapsed = current?.result?.elapsed ?? current?.elapsed ?? 0;
    setSeconds(Math.max(0, Math.floor(elapsed)));
    if (!current || current.result?.correct) return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor(elapsed + (Date.now() - start) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [live?.trace_game?.current?.incident_id, live?.trace_game?.current?.elapsed, live?.trace_game?.current?.result]);
  useEffect(() => {
    if (!live?.paradigm) return;
    const identity = `${live.simulation.seed}:${JSON.stringify(live.paradigm.choices)}:${live.simulation.turn}`;
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
    setCard(record.paradigm);
  }, [live?.paradigm, live?.simulation.seed]);

  async function act(operation: () => Promise<{ state: StateResponse } | StateResponse>, clearSelection = false) {
    if (mutating.current) return;
    mutating.current = true; requestVersion.current += 1; setBusy(true); setError(null);
    try {
      const result = await operation(); const next = "state" in result ? result.state : result;
      setLive(next); setReplay(null);
      if (clearSelection) { setSelectedBelief(null); setTrace(null); setFeedback(null); setTruth(null); setCard(null); saved.current = null; setView("village"); }
      return next;
    } catch (e) { setError(e instanceof Error ? e.message : "这次操作没有完成，请再试一次。"); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function beginOrToggle() {
    if (!started) await act(async () => { await api.startGame(); return api.run(speed); }, true);
    else if (live?.simulation.running) await act(api.pause);
    else await act(() => api.run(speed));
  }
  async function fastForward() {
    await act(async () => { if (!started) await api.startGame(); else if (live?.simulation.running) await api.pause(); return api.advance(100); });
  }
  async function choose(option: ChoiceOption) {
    if (!prompt) return;
    await act(() => api.choice(prompt.point, option));
    if (prompt.point === "D1" || prompt.point === "D4") { setView("trace"); setSelectedBelief(null); setFeedback(null); }
  }
  async function toggleTruth() {
    if (truth) { setTruth(null); void refresh(false); return; }
    setBusy(true);
    try { const exported = await api.export(); setTruth(exported.groundTruth); setLive(await api.state(true)); }
    catch (e) { setError(e instanceof Error ? e.message : "无法读取世界真值。"); }
    finally { setBusy(false); }
  }
  function selectMember(id: string) { setSelectedAgent(id); setDetail(null); setSelectedBelief(null); setTrace(null); setSheetTab("personal"); setFeedback(null); }
  function selectBelief(belief: Belief) { setSelectedBelief(belief); setSheetTab("source"); setFeedback(null); }
  async function accuse() {
    if (!selectedBelief) return;
    await act(async () => { const result = await api.accuse(selectedAgent, selectedBelief.id); setFeedback({ correct: result.correct, message: result.reason }); return result; });
  }
  function scrub(turn: number) {
    window.clearTimeout(replayTimer.current);
    if (turn === live?.simulation.turn) { setReplay(null); return; }
    replayTimer.current = window.setTimeout(() => { void (async () => {
      try { if (live?.simulation.running) { const paused = await api.pause(); setLive(paused.state); } setReplay(await api.replay(turn)); setSelectedBelief(null); setTrace(null); }
      catch (e) { setError(e instanceof Error ? e.message : "这一回合没有可用回放。"); }
    })(); }, 120);
  }

  if (!state || !live) return <main className="game-loading"><div className="loading-wildlings"><Sparkles size={32} /></div><h1>荒野 · 伪记忆</h1><p>{error || "五个野人，正在等一次出发。"}</p><button className="game-button" onClick={() => void refresh()}><RotateCcw size={15} />重新连接</button></main>;
  const phase = phaseOf(state);
  const agent = state.agents.find(item => item.id === selectedAgent) || state.agents[0];
  const personal = detail?.personalBeliefs || [];
  const shared = detail?.adoptedSharedBeliefs || [];
  const currentMemories = sheetTab === "shared" ? shared : personal;
  const activeBelief = selectedBelief ? [...personal, ...shared, ...state.collectiveKnowledge].find(item => item.id === selectedBelief.id) || selectedBelief : null;
  const incident = state.incidents.at(-1);
  const openTasks = state.tasks.filter(task => !["RESOLVED", "EXPIRED"].includes(task.status));
  const meaningful = [...state.recentEvents.filter(event => event.type === "RETURNED_TO_BASE" || event.type === "REACTIVATED" || (event.result && ["USE_MOSS", "USE_BERRY", "USE_CRYSTAL", "COLLECT"].includes(event.result.action))), ...(state.story_events || []).filter(event => ["SHARE_BELIEF", "RAISE_DISPUTE", "SUBMIT_EVIDENCE", "REQUEST_VERIFICATION"].includes(event.kind))].sort((a, b) => b.turn - a.turn).slice(0, 5);
  const broadcastEnabled = state.broadcast_enabled !== false;
  const selectedRemoved = !!agent?.removed || !!state.removed_agents?.includes(agent?.id);
  const currentClock = live.trace_game?.current;
  const maxPersonal = Math.max(0, ...state.agents.map(item => item.verifiedBeliefCount));
  const disabled = busy || !!prompt || !!replay;

  return <main className="game-root">
    <header className="game-header"><div className="game-brand"><span className="game-brand-mark"><Fingerprint size={27} /></span><div><strong>荒野 · 伪记忆</strong><span>EVOBABY / THE WILD KNOWS</span></div></div><nav className="game-nav" aria-label="部落视图">{([{ id: "village", label: "村子", icon: MapIcon }, { id: "knowledge", label: "部落常识", icon: BookOpen }, { id: "trace", label: "追零号", icon: Search }, { id: "wall", label: "结局墙", icon: Trophy }] as const).map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={15} />{item.label}{item.id === "wall" && wall.length > 0 && <small>{wall.length}</small>}</button>)}</nav><div className="game-header-tools"><span className={`judge-lamp ${state.judge_online ? "online" : ""}`}><i />{state.judge_online ? "Jev 在线" : "本地裁判"}</span><button className="game-icon" title={truth ? "隐藏世界真值" : "查看世界真值"} aria-label={truth ? "隐藏世界真值" : "查看世界真值"} onClick={() => void toggleTruth()} disabled={busy}>{truth ? <Eye size={17} /> : <EyeOff size={17} />}</button><button className="game-button judge-switch" onClick={onJudge}><Settings2 size={14} />评委模式</button></div></header>
    {error && <div className="game-error" role="alert"><Info size={16} /><span>{error}</span><button className="game-icon" aria-label="关闭提示" onClick={() => setError(null)}><X size={15} /></button></div>}
    <div className="game-workspace">
      <aside className="tribe-sidebar"><header className="tribe-heading"><span className="micro-label">OUR LITTLE TRIBE</span><h2>五个人，一片荒野</h2><span className="tribe-seed">SEED {state.simulation.seed}</span></header><div className="tribe-roster">{state.agents.map(member => {
        const removed = !!member.removed || !!state.removed_agents?.includes(member.id);
        const appearance = deriveWildlingState(member, state.recentEvents, state.simulation.turn, { base: state.world.base, showTruth: !!truth, infected: !!truth && !!incident?.affectedAgentIds.includes(member.id), reputation: member.appearance?.reputation || member.reputation || 0 });
        return <button key={member.id} className={`tribe-member ${member.id === selectedAgent ? "selected" : ""} ${removed ? "removed" : ""}`} onClick={() => selectMember(member.id)}><Wildling color={wildlingColor(member.id)} state={{ ...appearance, berry: member.appearance?.hasBerry || appearance.berry, crystal: member.appearance?.hasCrystal || appearance.crystal, ruffled: (member.appearance?.ruffledUntilTurn || 0) >= state.simulation.turn && !!member.appearance?.ruffledUntilTurn, removed }} size={65} /><span className="tribe-member-text"><strong>{wildlingName(member.id)}<small>{member.id}</small></strong><span>{removed ? `留下 ${state.memorials?.find(item => item.agent_id === member.id)?.taught_count ?? member.personalBeliefCount} 条记忆` : actionLabel[member.currentAction || ""] || "看看世界"}</span><span className="member-energy"><i style={{ width: `${member.energy}%`, background: member.energy < 25 ? "#ee806b" : wildlingColor(member.id) }} /></span></span><b className="member-energy-number">{removed ? "—" : member.energy}</b></button>;
      })}</div><section className="tribe-knowledge-meter"><span>我们一起知道的</span><strong>{state.metrics.verifiedCollectiveBeliefs}<small>条已验证常识</small></strong><div><span>个人最多</span><b>{maxPersonal}</b></div><div><span>足迹覆盖</span><b>{Math.round(state.metrics.exploredCellPercent)}%</b></div></section><div className="tribe-policy"><span className="micro-label">HOW WE KNOW</span><p>{state.choices?.D3 ? ({ A: "人多不等于地方多。换个场景，重新验证。", B: "至少三个独立的人验过，再成为常识。", C: "别人讲的，先自己试过，再相信。", D: "这次过后，部落保留原来的验证方式。" })[state.choices.D3] : state.metaBeliefs.length ? "同意的人再多，也要在不同场景里验证。" : "我试过。你也试过。于是我们开始相信。"}</p>{state.choices?.D3 && <span className="policy-choice"><ShieldCheck size={13} />{CHOICE_LABELS.D3[state.choices.D3]}</span>}</div><button className={`broadcast-toggle ${broadcastEnabled ? "" : "disconnected"}`} disabled={disabled || !started} onClick={() => void act(() => api.broadcast(!broadcastEnabled))}>{broadcastEnabled ? <Radio size={16} /> : <Unplug size={16} />}<span>{broadcastEnabled ? "篝火广播已连接" : "各走各的 · 广播已断"}</span><i /></button></aside>

      <section className="game-main"><div className="game-stage-heading"><div><span className="micro-label">CHAPTER 0{phase.index + 1} / {replay ? "REPLAY" : "LIVE WORLD"}</span><h1>{phase.title}</h1><p>{phase.subtitle}</p></div><div className="world-weather">{state.world.weather === "Rain" ? <CloudRain size={22} /> : <Sun size={22} />}<span>{state.world.weather === "Rain" ? "雨正在落下" : "今天晴朗"}<small>TURN {String(state.simulation.turn).padStart(3, "0")}</small></span></div></div>
        {replay && <div className="replay-banner"><History size={14} />第 {replay.simulation.turn} 回合的历史现场<button onClick={() => setReplay(null)}>回到现在 <ArrowRight size={13} /></button></div>}
        {truth && <div className="truth-banner"><Eye size={14} /><span>世界真值：苔藓仅在{regionLabel[truth.mossRule.positiveWhen.region]}、{truth.mossRule.positiveWhen.weather === "Rain" ? "雨天" : "晴天"}恢复 {truth.mossRule.positiveEnergyDelta} 能量；其他场景 {truth.mossRule.otherEnergyDelta}。</span></div>}
        {view === "village" && <><div className="village-stage"><WildWorldScene world={state.world} agents={state.agents} selectedAgent={selectedAgent} onSelectAgent={selectMember} events={state.recentEvents} groundTruth={replay ? null : truth} turn={state.simulation.turn} incidents={state.incidents} knownPositions={detail?.knownCells.map(cell => cell.position)} /></div><div className="world-strip"><span><i className="region-swatch nw" />西北 · 苔原</span><span><i className="region-swatch ne" />东北 · 晶地</span><span><i className="region-swatch sw" />西南 · 密林</span><span><i className="region-swatch se" />东南 · 赤岩</span><button onClick={() => setShowTasks(current => !current)}><ListFilter size={13} />公告板 <b>{openTasks.length}</b></button></div><div className="postcard-strip">{meaningful.length ? meaningful.slice(0, 3).map(event => "event_id" in event ? <Postcard key={event.event_id} event={event} /> : <StoryPostcard key={event.id} event={event} />) : <div className="first-postcard"><Flame size={21} /><div><strong>篝火已经点起来。</strong><span>还没有人知道，这片荒野会教会我们什么。</span></div></div>}</div></>}
        {view === "knowledge" && <section className="village-knowledge"><div className="knowledge-toolbar"><h2>篝火边留下的常识 <span>{state.collectiveKnowledge.length}</span></h2><span>{state.metrics.verifiedCollectiveBeliefs} 条经过独立验证</span></div>{state.collectiveKnowledge.length ? <div className="knowledge-records">{state.collectiveKnowledge.slice().reverse().map(belief => <button key={belief.id} className={`knowledge-record ${belief.status.toLowerCase()} ${selectedBelief?.id === belief.id ? "selected" : ""}`} onClick={() => selectBelief(belief)}><span className="record-object">{resourceLabel[belief.object]}</span><span className="record-body"><strong>{beliefTitle(belief)}</strong><small>{belief.independent_agent_ids.length} 个独立来源 · {belief.evidence_count} 条证据 · {belief.id}</small></span><span className="record-confidence">{Math.round(belief.display_confidence * 100)}<small>%</small></span><span className="belief-tag">{beliefStatusLabel[belief.status]}</span><ChevronRight size={15} /></button>)}</div> : <div className="game-empty"><BookOpen size={30} /><h3>第一条常识，还在路上。</h3><p>他们要先亲眼看见，再亲自试过。</p></div>}</section>}
        {view === "trace" && <TraceBoard state={state} trace={trace} selectedAgent={selectedAgent} selectedBelief={selectedBelief} onSelect={selectMember} seconds={replay ? Math.floor(state.trace_game?.current?.elapsed || 0) : seconds} truth={!replay && !!truth} />}
        {view === "wall" && <section className="ending-wall"><div className="knowledge-toolbar"><h2>今天，这里长出了 {wall.length} 个部落</h2><span>{new Set(wall.map(item => item.paradigm.name)).size} 种协作方式</span></div>{wall.length ? <div className="ending-wall-grid">{wall.map(item => <button key={item.id} className="wall-tribe" style={{ "--ending-color": ENDING_COLORS[item.paradigm.name] } as React.CSSProperties} onClick={() => setCard(item.paradigm)}><span className="micro-label">TRIBE / {item.id.slice(-4)}</span><div className="wall-portrait"><Wildling color={ENDING_COLORS[item.paradigm.name] || "#66d6bf"} state={{ reputation: 4 }} size={110} /></div><h3>{item.paradigm.name}</h3><p>{item.paradigm.tagline}</p><span className="wall-choices">② {CHOICE_LABELS.D2[item.paradigm.choices.D2 || ""]} · ③ {CHOICE_LABELS.D3[item.paradigm.choices.D3 || ""]}</span><footer>{item.date}<ArrowRight size={14} /></footer></button>)}</div> : <div className="game-empty"><Trophy size={32} /><h3>第一个部落，会长成什么样？</h3><p>两次谣言过后，把你们的规矩留在这里。</p></div>}</section>}
        {showTasks && <section className="game-task-drawer"><header><h2><Radio size={16} />篝火公告板</h2><button className="game-icon" title="收起公告板" aria-label="收起公告板" onClick={() => setShowTasks(false)}><X size={16} /></button></header>{openTasks.length ? openTasks.map(task => <article key={task.id} className={`game-task ${state.simulation.turn - task.created_turn >= 3 && !task.claimant_agent_ids.length ? "waiting" : ""}`}><span>{taskTypeLabel[task.type]}<b>{taskStatusLabel[task.status]}</b></span><strong>{task.description}</strong><small>{task.claimant_agent_ids.length ? task.claimant_agent_ids.map(wildlingName).join("、") : `等待认领 ${state.simulation.turn - task.created_turn} 回合`} · {task.completed_context_ids.length}/{task.required_contexts.length} 个场景</small></article>) : <p className="muted-copy">现在没有待办，继续探索。</p>}</section>}
      </section>

      <aside className="game-inspector"><header className="inspector-profile"><div><span className="micro-label">PERSONAL ARCHIVE</span><h2>{wildlingName(agent.id)}<small>{agent.id}</small></h2><p>{regionLabel[agent.region]} · {selectedRemoved ? "暂离部落" : agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > state.simulation.turn ? "在基地恢复" : actionLabel[agent.currentAction || ""] || "看看世界"}</p></div><Wildling color={wildlingColor(agent.id)} state={deriveWildlingState(agent, state.recentEvents, state.simulation.turn, { base: state.world.base })} size={104} /></header><div className="inspector-vitals"><span><Activity size={13} />能量<b>{agent.energy}<small>/100</small></b></span><span><Layers3 size={13} />亲历<b>{agent.personalBeliefCount}</b></span><span><Network size={13} />采纳<b>{agent.sharedBeliefCount}</b></span></div>
        <div className="inspector-tabs"><button className={sheetTab === "personal" ? "active" : ""} onClick={() => setSheetTab("personal")}>个人记忆</button><button className={sheetTab === "shared" ? "active" : ""} onClick={() => setSheetTab("shared")}>共享常识</button><button className={sheetTab === "source" ? "active" : ""} onClick={() => setSheetTab("source")}>三种出处</button></div>
        <div className="inspector-scroll">{replay ? <div className="game-empty small"><History size={24} /><p>正在回看历史现场。<br />返回现在后再调取个人原件。</p></div> : sheetTab !== "source" ? currentMemories.length ? <div className="memory-list">{currentMemories.slice().reverse().map(belief => <button key={belief.id} className={`memory-note ${belief.status.toLowerCase()} ${selectedBelief?.id === belief.id ? "selected" : ""}`} onClick={() => selectBelief(belief)}><span><b>{belief.id}</b><em>{beliefStatusLabel[belief.status]}</em></span><strong>{beliefTitle(belief)}</strong><footer><span>确信 {Math.round(belief.display_confidence * 100)}%</span><span>{belief.evidence_count} 条依据 <ChevronRight size={11} /></span></footer></button>)}</div> : <div className="game-empty small"><BookOpen size={26} /><h3>{sheetTab === "personal" ? "记忆还很轻。" : "还没采纳同伴的经验。"}</h3><p>{sheetTab === "personal" ? "每一次经历，都会留下点什么。" : "先去看看世界，再回篝火边。"}</p></div> : <SourceInspector belief={activeBelief} trace={trace} onFind={() => setView("trace")} />}
          {view === "trace" && incident && !replay && <section className="accusation-section"><div><span className="micro-label">YOUR VERDICT</span><strong>哪条记忆，是最初的源头？</strong></div><label>指认的成员<select value={selectedAgent} onChange={event => selectMember(event.target.value)} aria-label="指认的成员">{state.agents.map(member => <option value={member.id} key={member.id}>{wildlingName(member.id)} · {member.id}</option>)}</select></label><label>指认的常识<select value={selectedBelief && [...personal, ...shared].some(b => b.id === selectedBelief.id) ? selectedBelief.id : ""} onChange={event => { const belief = [...personal, ...shared].find(item => item.id === event.target.value); if (belief) selectBelief(belief); }} aria-label="指认的常识"><option value="">选择一条记忆</option>{[...personal, ...shared].map(belief => <option key={belief.id} value={belief.id}>{belief.id} · {beliefTitle(belief)}</option>)}</select></label><button className="game-button primary" disabled={disabled || !selectedBelief || !!currentClock?.result?.correct} onClick={() => void accuse()}><Search size={14} />{currentClock?.result?.correct ? "源头已确认" : "提交指认"}<ArrowRight size={15} /></button>{feedback && <p className={`accusation-feedback ${feedback.correct ? "correct" : "wrong"}`} role="status">{feedback.message}</p>}<p className="clock-footnote">你 {timeLabel(seconds)} · 部落 {currentClock?.swarm_turns == null ? "仍在调查" : `${currentClock.swarm_turns} 回合`}<br />现实时间与世界回合分别记录。</p></section>}
        </div><footer className="inspector-bottom"><span>{selectedRemoved ? "它留下的经验仍在部落中" : `${resourceLabel.Berry} ${agent.inventory.Berry || 0} · ${resourceLabel.Crystal} ${agent.inventory.Crystal || 0}`}</span><button className="game-icon" disabled={disabled || !started || selectedRemoved} title="让这个成员暂离部落" aria-label="让这个成员暂离部落" onClick={() => setRemoveAgent(agent.id)}><Unplug size={14} /></button></footer>
      </aside>
    </div>
    <footer className="game-playbar"><div className="play-controls"><button className="game-play" disabled={busy || !!prompt || !!live.paradigm || !!replay} onClick={() => void beginOrToggle()}>{busy ? <LoaderCircle size={17} className="spin" /> : live.simulation.running ? <Pause size={17} /> : <Play size={17} />}<span>{!started ? "开始旅程" : live.simulation.running ? "暂停" : "继续旅程"}</span></button><button className="game-icon" disabled={disabled || !started || live.simulation.running || !!live.paradigm} title="推进一个世界回合" aria-label="推进一个世界回合" onClick={() => void act(api.step)}><SkipForward size={17} /></button><button className="game-icon" disabled={disabled || !!live.paradigm} title="快进到下一个关口" aria-label="快进到下一个关口" onClick={() => void fastForward()}><FastForward size={19} /></button><div className="game-speed" aria-label="运行速度">{([1, 5, 20] as const).map(value => <button key={value} className={speed === value ? "active" : ""} disabled={disabled} onClick={() => { setSpeed(value); if (live.simulation.running) void act(() => api.run(value)); }}>{value}×</button>)}</div></div><div className="game-replay"><span>{replay ? <History size={13} /> : <i className={live.simulation.running ? "running" : ""} />}<b>{String(state.simulation.turn).padStart(3, "0")}</b><small>回合</small></span><input type="range" min="0" max={Math.max(1, live.simulation.turn)} value={state.simulation.turn} onChange={event => scrub(Number(event.target.value))} disabled={busy || live.simulation.turn === 0} aria-label="世界回合回放" /><span className="replay-end">{live.simulation.turn}</span></div><div className="playbar-end">{live.paradigm ? <button className="game-button accent" onClick={() => setCard(live.paradigm!)}><Download size={14} />领取部落卡</button> : live.simulation.canInjectFirst && !prompt ? <button className="game-button danger" disabled={disabled} onClick={() => void act(() => api.inject("regulator"))}><Fingerprint size={14} />植入伪记忆</button> : live.simulation.canInjectSecond && !prompt ? <button className="game-button danger" disabled={disabled} onClick={() => void act(api.injectSecond)}><Fingerprint size={14} />第二次谣言</button> : <span className="playbar-note">{prompt ? "等待部落决定" : state.metrics.knowledgeMature ? "知识已成熟" : "世界会回应每一次尝试"}</span>}<button className="game-icon" title="同一种子重新出发" aria-label="同一种子重新出发" disabled={busy} onClick={() => void act(api.startGame, true)}><RotateCcw size={16} /></button></div></footer>
    {prompt && !replay && <ChoiceDialog prompt={prompt} busy={busy} onChoose={option => void choose(option)} />}
    {card && !prompt && <div className="game-modal-backdrop ending-modal"><EndingCard paradigm={card} onClose={() => setCard(null)} onNewGame={() => void act(api.startGame, true)} /></div>}
    {removeAgent && <div className="game-modal-backdrop"><section className="remove-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title"><Unplug size={26} /><h2 id="remove-title">让 {wildlingName(removeAgent)} 暂离部落？</h2><p>它将停止行动。已经交给同伴的经验会留下。</p><div><button className="game-button" onClick={() => setRemoveAgent(null)}>留下</button><button className="game-button danger" onClick={() => { const id = removeAgent; setRemoveAgent(null); void act(() => api.remove(id)); }}>暂离部落 <ArrowRight size={14} /></button></div></section></div>}
  </main>;
}

function Postcard({ event }: { event: RawEvent }) {
  const effect = event.result?.resource_effect || 0;
  return <article className={`event-postcard ${effect < 0 ? "hurt" : ""}`}><div><span className="postcard-stamp">亲历</span><time>T{event.turn}</time></div><strong>{wildlingName(event.agent_id)} · {event.type === "RETURNED_TO_BASE" ? "回到篝火边休息" : event.type === "REACTIVATED" ? "重新出发" : actionLabel[event.result?.action || ""] || "留下一次观察"}</strong><p>{regionLabel[event.observation.region]} · {event.observation.weather === "Rain" ? "雨天" : "晴天"}{effect ? ` · ${effect > 0 ? "+" : ""}${effect} 能量` : ""}</p></article>;
}

function StoryPostcard({ event }: { event: StoryEvent }) {
  const labels: Record<string, string> = { SHARE_BELIEF: "讲出了一个办法", RAISE_DISPUTE: "提出了反证", SUBMIT_EVIDENCE: "交回了验证证据", REQUEST_VERIFICATION: "请同伴换个场景验证" };
  return <article className="event-postcard shared-postcard"><div><span className="postcard-stamp">篝火</span><time>T{event.turn}</time></div><strong>{wildlingName(event.agent_id)} · {labels[event.kind] || "发来一份记录"}</strong><p>{event.belief_id || "部落广播"} · {event.kind === "SHARE_BELIEF" ? "常识进入共享频道" : "结构化回证已留档"}</p></article>;
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

function TraceBoard({ state, trace, selectedAgent, selectedBelief, onSelect, seconds, truth }: { state: StateResponse; trace: BeliefTrace | null; selectedAgent: string; selectedBelief: Belief | null; onSelect: (id: string) => void; seconds: number; truth: boolean }) {
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
  return <section className="trace-playground"><div className="trace-topline"><span><Search size={14} />{incident ? `第 ${incident.attackNumber} 次伪记忆事件` : "还没有伪记忆事件"}</span><strong>{timeLabel(seconds)}<small>你的调查用时</small></strong></div>{revealedIncident && <div className="trace-revealed" role="status"><strong><Check size={14} />{resolvedClock?.result?.winner === "player" ? "你先找到了源头" : resolvedClock?.result?.winner === "tribe" ? "部落先完成调查，你也找到了源头" : "源头已确认"}</strong><span>{revealedIncident.targetAgentId ? wildlingName(revealedIncident.targetAgentId) : "未知成员"} · {revealedIncident.rootBeliefId} · {revealedIncident.lineage.length} 条实际传播记录</span>{revealedIncident.lineage.length > 0 && <p>{revealedIncident.lineage.map(edge => `${wildlingName(edge.senderAgentId)} ${edge.parentBeliefId} → ${wildlingName(edge.receiverAgentId)} ${edge.childBeliefId}`).join("；")}</p>}</div>}<div className="trace-world"><svg viewBox="0 0 740 560" preserveAspectRatio="none" className="trace-edge-layer" aria-label="记忆来源连线">{uniqueEdges.map((edge, i) => { const from = points[indexOf(edge.from)], to = points[indexOf(edge.to)]; if (!from || !to) return null; const same = edge.from === edge.to; const path = same ? `M${from.x - 28},${from.y} C${from.x - 126},${from.y - 88} ${from.x + 126},${from.y - 88} ${from.x + 28},${from.y}` : `M${from.x},${from.y} Q370,282 ${to.x},${to.y}`; return <g key={`${edge.from}-${edge.to}-${i}`} className={`trace-edge ${edge.kind}`} tabIndex={0} role="button" aria-label={edge.text} onClick={() => setEdgeDetail(edge.text)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") setEdgeDetail(edge.text); }}><path d={path} /><title>{edge.text}</title></g>; })}</svg><div className="trace-center-mark"><Fingerprint size={36} /><span>{selectedBelief?.id || "ZERO"}</span><small>{selectedBelief ? resourceLabel[selectedBelief.object] : "最初的记忆，在哪里"}</small></div>{state.agents.map((agent, index) => { const point = points[index]; const hurt = state.recentEvents.some(event => event.agent_id === agent.id && event.turn >= state.simulation.turn - 2 && (event.result?.resource_effect || 0) < 0); return <button className={`trace-agent ${selectedAgent === agent.id ? "selected" : ""} ${hurt ? "hurt" : ""}`} style={{ left: `${point.x / 740 * 100}%`, top: `${point.y / 560 * 100}%` }} key={agent.id} onClick={() => onSelect(agent.id)}><Wildling color={wildlingColor(agent.id)} state={deriveWildlingState(agent, state.recentEvents, state.simulation.turn, { base: state.world.base, showTruth: truth, infected: truth && !!incident?.affectedAgentIds.includes(agent.id) })} size={94} /><strong>{wildlingName(agent.id)}</strong><small>{hurt ? "最近掉过能量" : `${agent.personalBeliefCount + agent.sharedBeliefCount} 条记忆`}</small></button>; })}</div><div className="trace-line-legend"><span className="transmitted"><i />亲手交的</span><span className="declared"><i />它自己说的</span><span className="discovered"><i />实验支持</span><span className="counter"><i />世界反证</span></div><div className="trace-evidence-caption">{edgeDetail || (selectedBelief ? `${beliefTitle(selectedBelief)} · ${trace ? `${trace.records.length} 份来源记录` : "正在调取来源"}` : "五份不同的经历，正在拼成同一个故事。")}</div></section>;
}
