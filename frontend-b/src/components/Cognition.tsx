import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, Check, Sparkles, X } from "lucide-react";
import type { AgentSummary, CognitionStage, StateResponse } from "../types";
import { COGNITION_STAGES, cognitionLabel, cognitionStage, resolveCognitionFeedback } from "../cognition";
import { Wildling, WILDLING_COLORS, WILDLING_NAMES, wildlingColor, wildlingName } from "./Wildling";
import { CognitionPreview } from "./CognitionPreview";
import "../cognition-feedback.css";

export function CognitionFeedback({ agent, compact = false }: { agent: AgentSummary; compact?: boolean }) {
  const feedback = resolveCognitionFeedback(agent);
  if (!feedback) return null;
  return <div className={`cognition-feedback ${compact ? "is-compact" : ""}`} data-feedback-state={feedback.state}>
    <div><span>当前判断</span><strong>{feedback.label}</strong>{!compact && feedback.sinceTurn !== null && <time>T{feedback.sinceTurn} 起</time>}</div>
    {!compact && <><p>{feedback.reason || "本条状态未保存原因。"}</p>{feedback.methodLabel && <small>当前方法：{feedback.methodLabel}</small>}</>}
  </div>;
}

export function CognitionBadge({ agent }: { agent: AgentSummary }) {
  const label = cognitionLabel(agent.cognition?.stage);
  return <span className="cognition-badge" data-stage={agent.cognition ? label.stage : "unknown"} title={agent.cognition ? `${label.name} · 第 ${agent.cognition.earnedTurn} 回合获得` : "认知阶段尚未记录，头像为初始造型示意"}>{agent.cognition ? label.numeral : "?"}<span>{agent.cognition ? label.name : "未记录"}</span></span>;
}

export function CognitionPanel({ agent, onGuide }: { agent: AgentSummary; onGuide: () => void }) {
  const label = cognitionLabel(agent.cognition?.stage);
  const cognition = agent.cognition;
  const milestone = cognition?.milestones.at(-1);
  const progress = cognition?.progress;
  const current = Math.max(0, progress?.current ?? 0);
  const target = Math.max(1, progress?.target ?? 1);
  return <section className="cognition-panel" aria-label={`${wildlingName(agent.id)}的认知成长`}>
    <header><span><Sparkles size={14} />历史成长</span><button onClick={onGuide} title="打开四阶形态图鉴" aria-label="打开四阶形态图鉴"><BookOpen size={15} /><span>图鉴</span></button></header>
    <div className="cognition-current"><strong><b>{cognition ? label.numeral : "?"}</b>{cognition ? label.name : "阶段未记录"}</strong><span>{cognition ? `T${cognition.earnedTurn} 获得` : "历史记录"}</span></div>
    <div className="cognition-steps" aria-label={cognition ? `当前第 ${label.stage} 阶，共四阶` : "认知阶段未记录"}>{COGNITION_STAGES.map(item => <span key={item.stage} className={cognition && item.stage <= label.stage ? "earned" : ""} aria-current={cognition && item.stage === label.stage ? "step" : undefined}><i />{item.numeral}</span>)}</div>
    <CognitionFeedback agent={agent} />
    <p className="cognition-goal">{cognition ? cognition.nextGoal ?? (label.stage === 4 ? "继续探索，发现错误后继续修正。" : label.goal) : "这份历史记录未保存个人认知阶段，造型仅作示意。"}</p>
    {cognition && label.stage < 4 && <div className="cognition-progress"><div><span>{progress?.label || "下一阶"}</span><b>{current} / {target}</b></div><progress value={Math.min(current, target)} max={target} aria-label={progress?.label || "下一阶进度"} /></div>}
    {milestone && milestone.stage > 1 && <details className="cognition-evidence"><summary>这次成长的依据</summary><p>{milestone.reason}</p>{milestone.evidenceIds.length > 0 && <small>{milestone.evidenceIds.join(" · ")}</small>}</details>}
  </section>;
}

export function CognitionGuide({ agents, selectedAgent, onClose }: { agents: AgentSummary[]; selectedAgent: string; onClose: () => void }) {
  const [agentId, setAgentId] = useState(selectedAgent);
  const [stage, setStage] = useState<CognitionStage>(cognitionStage(agents.find(agent => agent.id === selectedAgent)?.cognition?.stage));
  const dialog = useRef<HTMLElement>(null);
  const agent = agents.find(item => item.id === agentId);
  const label = cognitionLabel(stage);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const elements = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']");
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);
  return <div className="game-modal-backdrop cognition-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="cognition-guide" role="dialog" aria-modal="true" aria-labelledby="cognition-guide-title">
    <header className="cognition-guide-header"><div><span className="micro-label">FIELD GUIDE / 01-04</span><h2 id="cognition-guide-title">同一个野人，四种成长</h2></div><button className="game-icon" onClick={onClose} title="关闭认知图鉴" aria-label="关闭认知图鉴"><X size={20} /></button></header>
    <div className="cognition-identities" role="group" aria-label="预览成员身份色">{WILDLING_NAMES.map((name, index) => <button key={name} onClick={() => setAgentId(`A${index + 1}`)} aria-pressed={agentId === `A${index + 1}`} aria-label={`预览 ${name} 的${["金黄", "青绿", "珊瑚", "蓝紫", "粉紫"][index]}服装`}><i style={{ background: WILDLING_COLORS[index] }} />{name}{agentId === `A${index + 1}` && <Check size={12} />}</button>)}</div>
    <div className="cognition-preview-heading"><span>形态预览 · 不改变当前进度</span><strong>{wildlingName(agentId)} 现在：{agent?.cognition ? `${cognitionLabel(agent.cognition.stage).numeral} ${cognitionLabel(agent.cognition.stage).name}` : "阶段未记录"}</strong></div>
    <div className="cognition-guide-body"><div className="cognition-guide-model"><CognitionPreview stage={stage} agentId={agentId} /></div><div className="cognition-guide-description"><div className="cognition-stage-tabs" role="group" aria-label="预览认知阶位">{COGNITION_STAGES.map(item => <button key={item.stage} aria-pressed={stage === item.stage} onClick={() => setStage(item.stage)} aria-label={`预览第 ${item.stage} 阶 ${item.name}`}>{item.numeral}</button>)}</div><div className="cognition-preview-description" aria-live="polite"><span>STAGE {String(stage).padStart(2, "0")}</span><h3>{label.name}</h3><strong>{label.principle}</strong><p>{label.goal}</p><small>{label.garment}</small></div><p className="cognition-guide-rule">形态保留已经获得的成长；当前判断另行复核。体力下降不自动降阶，高阶也可能信错。</p>{agent && <CognitionFeedback agent={agent} />}</div></div>
    <div className="cognition-silhouettes" aria-label="四阶形态对照">{COGNITION_STAGES.map(item => <button key={item.stage} className={stage === item.stage ? "selected" : ""} onClick={() => setStage(item.stage)} aria-label={`${item.numeral} ${item.name}形态对照`} aria-pressed={stage === item.stage}><Wildling color={wildlingColor(agentId)} state={{ cognitionStage: item.stage }} size={104} /><span><b>{item.numeral}</b>{item.name}</span></button>)}</div>
  </section></div>;
}

type UpgradeNotice = { agentId: string; stage: CognitionStage; reason: string; turn: number };
export function useCognitionNotices(live: StateResponse | null, replaying: boolean, suspended = false) {
  const previous = useRef<{ seed: number; turn: number; stages: Record<string, number> } | null>(null);
  const [batches, setBatches] = useState<UpgradeNotice[][]>([]);
  useEffect(() => {
    if (!live) return;
    const prior = previous.current;
    const next = { seed: live.simulation.seed, turn: live.simulation.turn, stages: Object.fromEntries(live.agents.map(agent => [agent.id, cognitionStage(agent.cognition?.stage)])) };
    previous.current = next;
    if (!prior || replaying || prior.seed !== next.seed || next.turn < prior.turn) { setBatches([]); return; }
    const changes = live.agents.flatMap(agent => {
      const stage = cognitionStage(agent.cognition?.stage);
      const milestone = agent.cognition?.milestones.slice().reverse().find(item => item.stage === stage);
      return stage > (prior.stages[agent.id] ?? stage) && milestone && milestone.turn > prior.turn
        ? [{ agentId: agent.id, stage, reason: milestone.reason, turn: milestone.turn }] : [];
    });
    if (changes.length) setBatches(current => [...current, changes].slice(-4));
  }, [live, replaying]);
  useEffect(() => {
    if (!batches.length || suspended) return;
    const timer = window.setTimeout(() => setBatches(current => current.slice(1)), 7500);
    return () => clearTimeout(timer);
  }, [batches, suspended]);
  return { notices: batches[0] || [], dismiss: () => setBatches(current => current.slice(1)), reset: () => { previous.current = null; setBatches([]); } };
}

export function CognitionNotice({ notices, onDismiss }: { notices: UpgradeNotice[]; onDismiss: () => void }) {
  if (!notices.length) return null;
  return <aside className="cognition-notice" role="status" aria-live="polite"><header><span><ArrowUp size={15} />{notices.length > 1 ? `${notices.length} 位成员有了新的成长` : "认知成长"}</span><button className="game-icon" onClick={onDismiss} title="关闭成长提示" aria-label="关闭成长提示"><X size={14} /></button></header>{notices.map(notice => <div className="cognition-notice-member" key={`${notice.agentId}-${notice.stage}-${notice.turn}`}><Wildling color={wildlingColor(notice.agentId)} state={{ cognitionStage: notice.stage }} size={52} /><div><strong>{wildlingName(notice.agentId)}<b>{cognitionLabel(notice.stage).numeral} {cognitionLabel(notice.stage).name}</b></strong><p>{notice.reason}</p></div></div>)}</aside>;
}
