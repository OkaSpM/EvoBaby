import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CloudRain, Compass, Database, Radio, Sparkles } from "lucide-react";
import { api, ApiError } from "./api";
import { weatherLabel } from "./i18n";
import type { AgentDetail, GroundTruth, StateResponse } from "./types";
import { Controls } from "./components/Controls";
import { WorldMap } from "./components/WorldMap";
import { AgentPanel } from "./components/AgentPanel";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { EvolutionPanel } from "./components/EvolutionPanel";
import { Timeline } from "./components/Timeline";
import { TruthPanel } from "./components/TruthPanel";
import { GameApp } from "./components/GameApp";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import { judgeRequestIsCurrent, loadJudgeSnapshot } from "./judge-snapshot";
import "./game.css";
import "./judge-b.css";

function JudgeDashboard() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [truth, setTruth] = useState<GroundTruth | null>(null);
  const [showTruth, setShowTruth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const mutating = useRef(false);
  const truthVisible = useRef(false);
  const refreshInFlight = useRef<number | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async (clearError = true) => {
    if (!mounted.current || mutating.current || refreshInFlight.current === requestVersion.current) return;
    const version = ++requestVersion.current;
    const reveal = truthVisible.current;
    refreshInFlight.current = version;
    try {
      const next = await loadJudgeSnapshot(api, reveal);
      if (judgeRequestIsCurrent(version, requestVersion.current, reveal, truthVisible.current)) {
        setState(next.state); setTruth(next.truth); if (clearError) setError(null);
      }
    } catch (e) {
      if (judgeRequestIsCurrent(version, requestVersion.current, reveal, truthVisible.current)) setError(e instanceof Error ? e.message : "无法连接模拟服务。");
    } finally {
      if (refreshInFlight.current === version) refreshInFlight.current = null;
    }
  }, []);

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; requestVersion.current += 1; }; }, [refresh]);
  useEffect(() => {
    if (!state?.simulation.running) return;
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [state?.simulation.running, refresh]);
  useEffect(() => {
    if (!selectedAgent) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null);
    void api.agent(selectedAgent).then(next => { if (!cancelled) setDetail(next); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedAgent, state?.simulation.turn]);

  async function act(action: "step" | "run" | "pause" | "reset" | "newSeed" | "inject" | "injectSecond", speed?: 1 | 5 | 20) {
    if (mutating.current) return;
    mutating.current = true; requestVersion.current += 1;
    setBusy(true); setError(null);
    let completed = false;
    try {
      await (action === "step" ? api.step() : action === "run" ? api.run(speed ?? 1) : action === "pause" ? api.pause() : action === "reset" ? api.reset() : action === "newSeed" ? api.newSeed() : action === "inject" ? api.inject() : api.injectSecond());
      completed = true;
      if (mounted.current && ["reset", "newSeed"].includes(action)) {
        setSelectedAgent(null); setDetail(null); setTruth(null); setShowTruth(false); truthVisible.current = false;
      }
    } catch (e) { if (mounted.current) setError(e instanceof ApiError || e instanceof Error ? e.message : "操作未完成，请稍后重试。"); }
    finally { mutating.current = false; if (mounted.current) { setBusy(false); void refresh(completed); } }
  }

  function toggleTruth() {
    truthVisible.current = !truthVisible.current;
    requestVersion.current += 1;
    setShowTruth(truthVisible.current); setTruth(null); setError(null);
    void refresh();
  }

  if (!state) return <main className="loading-screen judge-dashboard-b"><div className="loading-mark"><Sparkles /></div><h1>EvoBaby</h1><p>{error ?? "正在连接荒野世界…"}</p><button onClick={() => void refresh()}>重新连接</button></main>;
  const m = state.metrics;
  return <main className="app-shell judge-dashboard-b" data-snapshot-turn={state.simulation.turn} data-truth-turn={truth?.turn ?? "hidden"}>
    <header className="app-header"><div className="brand"><div className="brand-mark"><Sparkles /></div><div><span>EVOBABY · 荒野世界</span><h1>荒野认知演化实验</h1></div></div><div className="live-state"><i className={state.simulation.running ? "live" : ""} /><span>{state.simulation.running ? "模拟运行中" : "模拟已暂停"}</span><strong>种子 {state.simulation.seed}</strong></div></header>
    <Controls simulation={state.simulation} busy={busy} showTruth={showTruth} onAction={act} onTruth={() => void toggleTruth()} />
    <nav className="judge-section-nav" aria-label="评委栏目"><a href="#judge-collaboration">协作怎么发生</a><a href="#judge-overview">世界状态</a><a href="#judge-experience">个人经历</a><a href="#judge-knowledge">知识与任务</a><a href="#judge-investigations">两次事件对比</a></nav>
    <section id="judge-collaboration" tabIndex={-1}><ReviewWorkspace state={state} onSelectAgent={setSelectedAgent} /></section>
    {error && <div className="error-banner" role="alert"><strong>操作提示</strong><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}
    <section className="metric-strip" id="judge-overview" aria-label="概览" tabIndex={-1}>
      <Metric icon={<Activity />} label="当前回合" value={state.simulation.turn} />
      <Metric icon={state.world.weather === "Rain" ? <CloudRain /> : <Compass />} label="天气" value={weatherLabel[state.world.weather]} />
      <Metric icon={<Radio />} label="平均能量" value={m.averageEnergy.toFixed(1)} suffix="/100" />
      <Metric icon={<Compass />} label="已探索" value={m.exploredCellPercent.toFixed(0)} suffix="%" />
      <Metric icon={<Database />} label="已验证集体知识" value={m.verifiedCollectiveBeliefs} />
      <Metric icon={<Radio />} label="开放任务" value={m.openTasks} />
      <div className={`maturity-card ${m.knowledgeMature ? "ready" : ""}`}><span>知识成熟度</span><strong>{m.knowledgeMature ? "已成熟" : "积累中"}</strong><i /></div>
    </section>
    {truth && showTruth && <TruthPanel truth={truth} />}
    {showTruth && !truth && !error && <p className="judge-truth-pending" role="status">正在读取同回合真相快照…</p>}
    <div className="dashboard-grid">
      <div className="judge-map-slot"><WorldMap world={state.world} agents={state.agents} selectedAgent={selectedAgent} knownPositions={detail?.knownCells.map(c => c.position) ?? []} truth={showTruth ? truth : null} /></div>
      <div className="judge-agent-slot" id="judge-experience" tabIndex={-1}><AgentPanel agents={state.agents} selected={selectedAgent} detail={detail} onSelect={id => setSelectedAgent(current => current === id ? null : id)} /></div>
      <div className="judge-knowledge-slot" id="judge-knowledge" tabIndex={-1}><KnowledgePanel beliefs={state.collectiveKnowledge} tasks={state.tasks} /></div>
    </div>
    <EvolutionPanel metaBeliefs={state.metaBeliefs} incidents={state.incidents} metrics={m.attacks} />
    <Timeline events={state.recentEvents} incidents={state.incidents} metaBeliefs={state.metaBeliefs} />
    <footer className="app-footer"><span>EvoBaby · 证据驱动的多智能体认知演化</span><span>内部协议使用英文 · 用户展示使用中文</span></footer>
  </main>;
}

export default function App() {
  const [mode, setMode] = useState<"village" | "judge">("village");
  return mode === "village" ? <GameApp onJudge={() => setMode("judge")} /> : <><button className="return-to-village" onClick={() => setMode("village")}><Compass size={14} /> 返回部落</button><JudgeDashboard /></>;
}

function Metric({ icon, label, value, suffix }: { icon: React.ReactNode; label: string; value: string | number; suffix?: string }) {
  return <div className="metric-card"><span>{icon}{label}</span><strong>{value}<small>{suffix}</small></strong></div>;
}
