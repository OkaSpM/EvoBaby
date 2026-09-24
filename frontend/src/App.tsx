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
import "./game.css";

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

  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const version = ++requestVersion.current;
    try { const next = await api.state(showTruth); if (version === requestVersion.current) { setState(next); setError(null); } }
    catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : "无法连接模拟服务。"); }
  }, [showTruth]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!state?.simulation.running) return;
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [state?.simulation.running, refresh]);
  useEffect(() => {
    if (!selectedAgent) { setDetail(null); return; }
    void api.agent(selectedAgent).then(setDetail).catch(e => setError(e.message));
  }, [selectedAgent, state?.simulation.turn]);

  async function act(action: "step" | "run" | "pause" | "reset" | "newSeed" | "inject" | "injectSecond", speed?: 1 | 5 | 20) {
    if (mutating.current) return;
    mutating.current = true; requestVersion.current += 1;
    setBusy(true); setError(null);
    try {
      const result = action === "step" ? await api.step() : action === "run" ? await api.run(speed ?? 1) : action === "pause" ? await api.pause() : action === "reset" ? await api.reset() : action === "newSeed" ? await api.newSeed() : action === "inject" ? await api.inject() : await api.injectSecond();
      setState(result.state);
      if (["reset", "newSeed"].includes(action)) { setSelectedAgent(null); setTruth(null); setShowTruth(false); }
      else if (showTruth) { setTruth((await api.export()).groundTruth); setState(await api.state(true)); }
    } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : "操作未完成，请稍后重试。"); }
    finally { mutating.current = false; setBusy(false); }
  }

  async function toggleTruth() {
    if (mutating.current) return;
    mutating.current = true; requestVersion.current += 1;
    setBusy(true);
    try {
      const reveal = !showTruth;
      const nextTruth = reveal ? (await api.export()).groundTruth : null;
      setState(await api.state(reveal)); setTruth(nextTruth); setShowTruth(reveal);
    }
    catch (e) { setError(e instanceof Error ? e.message : "无法读取世界真相。"); }
    finally { mutating.current = false; setBusy(false); }
  }

  if (!state) return <main className="loading-screen"><div className="loading-mark"><Sparkles /></div><h1>EvoBaby</h1><p>{error ?? "正在连接荒野世界…"}</p><button onClick={() => void refresh()}>重新连接</button></main>;
  const m = state.metrics;
  return <main className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><Sparkles /></div><div><span>EVOBABY · 荒野世界</span><h1>荒野认知演化实验</h1></div></div><div className="live-state"><i className={state.simulation.running ? "live" : ""} /><span>{state.simulation.running ? "模拟运行中" : "模拟已暂停"}</span><strong>种子 {state.simulation.seed}</strong></div></header>
    <Controls simulation={state.simulation} busy={busy} showTruth={showTruth} onAction={act} onTruth={() => void toggleTruth()} />
    {error && <div className="error-banner" role="alert"><strong>操作提示</strong><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}
    <section className="metric-strip">
      <Metric icon={<Activity />} label="当前回合" value={state.simulation.turn} />
      <Metric icon={state.world.weather === "Rain" ? <CloudRain /> : <Compass />} label="天气" value={weatherLabel[state.world.weather]} />
      <Metric icon={<Radio />} label="平均能量" value={m.averageEnergy.toFixed(1)} suffix="/100" />
      <Metric icon={<Compass />} label="已探索" value={m.exploredCellPercent.toFixed(0)} suffix="%" />
      <Metric icon={<Database />} label="已验证集体知识" value={m.verifiedCollectiveBeliefs} />
      <Metric icon={<Radio />} label="开放任务" value={m.openTasks} />
      <div className={`maturity-card ${m.knowledgeMature ? "ready" : ""}`}><span>知识成熟度</span><strong>{m.knowledgeMature ? "已成熟" : "积累中"}</strong><i /></div>
    </section>
    {truth && showTruth && <TruthPanel truth={truth} />}
    <div className="dashboard-grid">
      <WorldMap world={state.world} agents={state.agents} selectedAgent={selectedAgent} knownPositions={detail?.knownCells.map(c => c.position) ?? []} truth={truth} />
      <AgentPanel agents={state.agents} selected={selectedAgent} detail={detail} onSelect={id => setSelectedAgent(current => current === id ? null : id)} />
      <KnowledgePanel beliefs={state.collectiveKnowledge} tasks={state.tasks} />
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
