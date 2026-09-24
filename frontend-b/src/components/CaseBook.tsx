import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2, Circle, CircleDot, CloudRain, FileSearch, Fingerprint, FlaskConical, History, Info, LoaderCircle, LockKeyhole, Network, RefreshCw, Search, ShieldAlert, Sun, Users } from "lucide-react";
import type { StateResponse } from "../types";
import type { CaseFileView } from "../case-file";
import { useCaseFile } from "../use-case-file";
import { regionLabel } from "../i18n";
import { wildlingColor, wildlingName } from "./Wildling";
import "../casebook-b.css";

interface CaseBookProps {
  state: StateResponse;
  replaying: boolean;
  onInvestigate: (incidentId?: string) => void;
  onSelectAgent: (id: string) => void;
  sessionKey?: string;
  initialCaseId?: string | null;
}

type CaseEvidence = CaseFileView["evidence"][number];
const turnLabel = (turn: number | null) => turn == null ? "回合未记录" : `T${turn}`;
const caseLabel = (number: number) => number === 1 ? "第一案" : number === 2 ? "第二案" : `第 ${number} 案`;
const terminalStatus = (status: string) => ["REPAIRED", "REVOKED", "PREVENTED"].includes(status);
const resultTone = (status: string) => status === "REPAIRED" || status === "PREVENTED" ? "success" : status === "REVOKED" ? "warning" : "pending";

export function CaseBook({ state, replaying, onInvestigate: startInvestigation, onSelectAgent, sessionKey, initialCaseId }: CaseBookProps) {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(initialCaseId ?? null);
  const { cases, loading, error, retry } = useCaseFile(state, { replaying, selectedCaseId, sessionKey });
  const current = cases.find(item => item.id === selectedCaseId) || cases.at(-1);
  const onInvestigate = () => startInvestigation(current?.id);
  const counterexample = current?.firstCounterexample || current?.earliestVerifiedCounterexample;
  const hasHistoricalReceipts = current?.evidence.some(item => item.timing === "historical");
  const canInvestigate = !!current && !replaying && !current.sourceConfirmed && (!!state.merged_game?.b_review || state.trace_game?.current?.incident_id === current.id);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? cases.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + cases.length) % cases.length;
    setSelectedCaseId(cases[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return <section className="casebook" aria-label="案件卷宗" data-casebook-turn={state.simulation.turn}>
    <header className="casebook-heading"><div><span className="casebook-eyebrow"><FileSearch size={14} />PUBLIC CASE FILES</span><h2>把每一次求证，连成一条线</h2><p>{replaying ? `历史现场 · 第 ${state.simulation.turn} 回合` : `公开案卷 · 第 ${state.simulation.turn} 回合`}</p></div><figure><img src="/b/art/story/verification.png" alt="森林中的样本和观察工具" /><figcaption>情境插画</figcaption></figure></header>
    {!current ? <div className="casebook-empty"><BookOpen size={30} /><h3>还没有公开案件</h3><p>荒野尚未留下伪记忆事件记录。</p></div> : <>
      <div className="casebook-tabs" role="tablist" aria-label="选择伪记忆案件">{cases.map((item, index) => <button key={item.id} role="tab" id={`casebook-tab-${item.id}`} aria-controls={`casebook-panel-${item.id}`} aria-selected={item.id === current.id} tabIndex={item.id === current.id ? 0 : -1} className={item.id === current.id ? "selected" : ""} onClick={() => setSelectedCaseId(item.id)} onKeyDown={event => navigateTabs(event, index)}><span>{caseLabel(item.attackNumber)}<code>{item.id}</code></span><small className={`is-${resultTone(item.status)}`}>{item.statusLabel}</small></button>)}</div>
      <div className="casebook-case" id={`casebook-panel-${current.id}`} role="tabpanel" aria-labelledby={`casebook-tab-${current.id}`} data-case-id={current.id}>
        <header className="casebook-case-heading"><div><span className="casebook-eyebrow">{caseLabel(current.attackNumber)} · {turnLabel(current.injectedTurn)} 进入部落</span><h3>第 {current.attackNumber} 次伪记忆事件</h3></div>{replaying && <span className="casebook-replay"><History size={13} />回放</span>}</header>
        <div className="casebook-state-row"><div className={`casebook-status is-${resultTone(current.status)}`}><span>部落处理</span><strong>{terminalStatus(current.status) ? <CheckCircle2 size={14} /> : <FlaskConical size={14} />}{current.statusLabel}</strong></div><div className={`casebook-status ${current.sourceConfirmed ? "is-confirmed" : "is-unknown"}`}><span>玩家追源</span><strong>{current.sourceConfirmed ? <Fingerprint size={14} /> : <LockKeyhole size={14} />}{current.sourceConfirmed ? "源头已确认" : "尚未指认成功"}</strong></div></div>
        <p className="casebook-summary">{current.summary}</p>
        <section className="casebook-discovery" aria-label="异常发现时间" data-discovery-basis={current.discovery.basis}>
          <div><span>{current.discovery.label}</span><strong>{current.discovery.turn == null ? "发现回合未记录" : `T${current.discovery.turn}`}</strong><small>{current.discovery.elapsedTurns == null ? "距注入耗时未确认" : `注入后 ${current.discovery.elapsedTurns} 回合`}</small></div>
          <div><p>{current.discovery.detail}</p>{current.discovery.historicalEvidenceTurn != null && <p className="casebook-disputed">历史证据 T{current.discovery.historicalEvidenceTurn} · 注入前记录，不作发现耗时</p>}{current.discovery.disputedTurn != null && <p className="casebook-disputed">公开争议 T{current.discovery.disputedTurn}{current.discovery.disputedElapsedTurns == null ? "" : ` · 注入后 ${current.discovery.disputedElapsedTurns} 回合`}</p>}<small>下方回执的 T 值是原始实验发生时刻，不等同于本案发现时刻。</small></div>
        </section>
        {loading && <p className="casebook-load" role="status"><LoaderCircle size={13} className="spin" />正在核对公开原件</p>}
        {error && <div className="casebook-error" role="status"><Info size={14} /><span>{error}</span><button onClick={retry}><RefreshCw size={13} />重新读取</button></div>}

        <ol className="casebook-steps" aria-label="案件事实进度">{current.steps.map((step, index) => <li key={step.id} className={`is-${step.state}`} data-case-step={step.id} data-state={step.state}><div><span>{step.state === "done" ? <Check size={14} /> : step.state === "active" ? <CircleDot size={14} /> : <Circle size={14} />}</span><small>{String(index + 1).padStart(2, "0")}</small></div><strong>{step.label}</strong><p>{step.detail}</p><time>{turnLabel(step.turn)}</time></li>)}</ol>

        <section className="casebook-rules" aria-label="原说法与处理结果"><div className="casebook-rule original"><span><BookOpen size={14} />当时的说法</span>{current.subject ? <><h4>{current.subject.title}</h4><code>{current.subject.id}</code></> : <><h4>原始说法尚未公开</h4><p>当前案卷没有可核对的原始记忆。</p></>}</div><div className={`casebook-rule outcome is-${resultTone(current.status)}`}><span><FlaskConical size={14} />{current.status === "REPAIRED" ? "修正后的规则" : "本次处理结果"}</span><ResultRule item={current} /></div></section>

        {current.sourceConfirmed && current.origin && current.subject && current.subject.id !== current.origin.beliefId && <p className="casebook-evidence-caption" data-case-subject-origin="distinct">调查核验的是规则 {current.subject.id}；你指认的零号记忆是 {current.origin.beliefId}。实验查明规则的边界，追源确认记忆从哪里开始，两者分别记录。</p>}
        <section className="casebook-counterexample"><div className="casebook-section-title"><h4><ShieldAlert size={15} />{counterexample?.timing === "historical" ? "既有反例回执" : "可核对的反例"}</h4><span>世界反馈</span></div>{counterexample ? <><p className="casebook-evidence-caption">{counterexample.timing === "historical" ? "事件前的回执供本页对照，未确认是本轮首次发现或实际拦截来源。" : current.firstCounterexample ? "首次反例记录" : "最早可核对的调查反例，未确认是最初发现"}</p><EvidenceReceipt evidence={counterexample} onSelectAgent={onSelectAgent} /></> : <p className="casebook-missing">当前公开记录没有可核对的首条反例。不能仅凭一次能量下降，判定它由本案伪记忆造成。</p>}</section>

        <section className="casebook-verification"><div className="casebook-section-title"><h4><Users size={15} />{hasHistoricalReceipts ? "复测与历史回执" : "谁在什么条件下复测"}</h4><span>{current.evidence.length} 份关联回执</span></div>{hasHistoricalReceipts && <p className="casebook-evidence-caption">历史回执来自此前实验，不计为本轮新做的复测。</p>}{current.participants.length > 0 && <div className="casebook-participants">{current.participants.map(member => <button key={member.agentId} style={{ "--case-member-color": wildlingColor(member.agentId) } as CSSProperties} onClick={() => onSelectAgent(member.agentId)} aria-label={`查看 ${wildlingName(member.agentId)}，${member.evidenceCount} 份关联回执`}><i /><strong>{wildlingName(member.agentId)}</strong><span>{member.evidenceCount} 份</span><small>支持 {member.supportCount} · 反例 {member.counterexampleCount}</small><ArrowUpRight size={12} /></button>)}</div>}{current.evidence.length > 0 ? <div className="casebook-evidence-list">{current.evidence.map(item => <EvidenceReceipt key={`${item.id}-${item.agentId}`} evidence={item} onSelectAgent={onSelectAgent} />)}</div> : <p className="casebook-missing">尚无与本案关联的公开复测回证。</p>}</section>

        <section className="casebook-source" data-source-confirmed={current.sourceConfirmed}><div className="casebook-section-title"><h4><Network size={15} />源头与实际传播</h4><span>{current.sourceConfirmed ? "指认后揭晓" : "尚未揭晓"}</span></div>{current.sourceConfirmed && current.origin ? <><div className="casebook-origin"><Fingerprint size={22} /><div><span>已确认的零号记忆</span><strong><button onClick={() => onSelectAgent(current.origin!.agentId)}><i style={{ background: wildlingColor(current.origin.agentId) }} />{wildlingName(current.origin.agentId)}<ArrowUpRight size={12} /></button><code>{current.origin.beliefId}</code></strong></div></div>{current.lineage.length ? <ol className="casebook-lineage" aria-label="实际传播记录">{current.lineage.map((edge, index) => <li key={`${edge.parentBeliefId}-${edge.childBeliefId}-${index}`}><span className="casebook-lineage-index">{String(index + 1).padStart(2, "0")}</span><div><span><i style={{ background: wildlingColor(edge.senderAgentId) }} />{wildlingName(edge.senderAgentId)}</span><code>{edge.parentBeliefId}</code></div><ArrowRight size={15} /><div><span><i style={{ background: wildlingColor(edge.receiverAgentId) }} />{wildlingName(edge.receiverAgentId)}</span><code>{edge.childBeliefId}</code></div></li>)}</ol> : <p className="casebook-missing">源头已确认；当前案卷未记录后续传播。</p>}</> : <div className="casebook-source-locked"><LockKeyhole size={20} /><div><strong>部落的处理结果，不代替你的源头指认。</strong><p>{replaying ? "回放只保留这一回合已公开的事实，不能提交指认。" : canInvestigate ? "尚未指认成功，源头成员和真实传播链保持未揭晓。" : "本案尚未指认成功。当前只能指认最新案件，旧案不开放补交指认。"}</p>{canInvestigate && <button className="casebook-investigate" onClick={onInvestigate}><Search size={14} />去追零号<ArrowRight size={14} /></button>}</div></div>}</section>
        {current.limitations.length > 0 && <details className="casebook-limitations"><summary><Info size={13} />记录边界 <span>{current.limitations.length}</span></summary><ul>{current.limitations.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details>}
      </div>
    </>}
  </section>;
}

function ResultRule({ item }: { item: CaseFileView }) {
  if (item.status === "REPAIRED") return <>{item.replacement ? <><h4>{item.replacement.title}</h4><code>{item.replacement.id}</code></> : <><h4>已记录修复，新规则原件未公开</h4><p>修复结果已确认，具体条件仍以公开原件为准。</p></>}<time>{turnLabel(item.resolvedTurn)} · 修复</time></>;
  if (item.status === "REVOKED") return <><h4>旧说法已撤回</h4><p>这次处理是撤销，不代表已经查清完整规则。</p><time>{turnLabel(item.resolvedTurn)} · 撤回</time></>;
  if (item.status === "PREVENTED") return <><h4>采纳前已拦下</h4><p>这条说法在通过集体采纳前被拦下，不等同于扩散后的修复。</p><time>{turnLabel(item.resolvedTurn)} · 拦截</time></>;
  return <><h4>尚未形成结案结果</h4><p>已有的公开回证列在下方，暂不把调查中的说法当作新规则。</p></>;
}

function EvidenceReceipt({ evidence, onSelectAgent }: { evidence: CaseEvidence; onSelectAgent: (id: string) => void }) {
  const Weather = evidence.weather === "Rain" ? CloudRain : Sun;
  return <article className={`casebook-receipt ${evidence.outcome === "COUNTEREXAMPLE" ? "is-counter" : "is-support"}`} data-evidence-id={evidence.id} data-receipt-verified={evidence.receiptVerified} data-evidence-timing={evidence.timing} data-evidence-basis={evidence.basis}><div className="casebook-receipt-member"><button onClick={() => onSelectAgent(evidence.agentId)}><i style={{ background: wildlingColor(evidence.agentId) }} /><strong>{wildlingName(evidence.agentId)}</strong><ArrowUpRight size={11} /></button><time>{turnLabel(evidence.turn)}</time></div><div className="casebook-receipt-context"><strong>{regionLabel[evidence.region] || evidence.region}<span><Weather size={13} />{evidence.weather === "Rain" ? "雨天" : evidence.weather === "Sunny" ? "晴天" : "天气未记录"}</span></strong><code>{evidence.id}</code>{evidence.timing === "historical" && <small>历史回执 · 本页对照依据</small>}{evidence.basis === "belief-reference" && <small>规则直接引用的回执</small>}</div><div className="casebook-receipt-result"><strong>{evidence.outcome === "COUNTEREXAMPLE" ? "反例" : "支持样本"}</strong><span>{evidence.receiptVerified && evidence.delta != null ? `能量 ${evidence.delta > 0 ? "+" : ""}${evidence.delta}` : "能量回执未核对"}</span></div></article>;
}
