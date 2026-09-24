import { useState, type CSSProperties } from "react";
import { ArrowRight, ArrowUpRight, Check, Circle, CircleDot, Fingerprint, FlaskConical, GitBranch, Info, Search, ShieldAlert, Users } from "lucide-react";
import type { StateResponse } from "../types";
import type { CaseFileView } from "../case-file";
import { resolveCollaborationReview } from "../collaboration-review";
import { wildlingColor, wildlingName } from "./Wildling";
import "../collaboration-review.css";

export interface CollaborationReviewProps {
  state: StateResponse;
  cases: CaseFileView[];
  replaying?: boolean;
  selectedCaseId?: string | null;
  onSelectCase?: (id: string) => void;
  onInvestigate?: (incidentId: string) => void;
  onSelectAgent?: (id: string) => void;
}

const round = (turn: number | null) => turn === null ? "未记录" : `第 ${turn} 回合`;
const caseName = (value: number) => value === 1 ? "第一案" : value === 2 ? "第二案" : `第 ${value} 案`;

export function CollaborationReview({ state, cases, replaying = false, selectedCaseId, onSelectCase, onInvestigate, onSelectAgent }: CollaborationReviewProps) {
  const [localCaseId, setLocalCaseId] = useState<string | null>(null);
  const visibleCases = cases.filter(item => item.injectedTurn <= state.simulation.turn);
  const current = visibleCases.find(item => item.id === (selectedCaseId ?? localCaseId)) ?? visibleCases.at(-1);
  const view = current ? resolveCollaborationReview(state, current, { replaying }) : null;
  const select = (id: string) => { setLocalCaseId(id); onSelectCase?.(id); };

  return <section className="collaboration-review" aria-label="协作调查" data-review-case={view?.caseId} data-review-turn={state.simulation.turn}>
    <header className="cr-heading"><div><span className="cr-eyebrow"><Users size={15} />协作调查</span><h2>{view?.heading ?? "先积累经验，再一起查证"}</h2><p>{view?.gap ?? "当前还没有公开案件。部落正在探索荒野，积累各自的观察记录。"}</p></div><span className="cr-round">{replaying ? "历史现场" : "当前案况"}<strong>{round(state.simulation.turn)}</strong></span></header>
    {visibleCases.length > 1 && <nav className="cr-case-tabs" aria-label="调查案件">{visibleCases.map(item => <button key={item.id} aria-pressed={item.id === current?.id} onClick={() => select(item.id)}>{caseName(item.attackNumber)}<small>{item.statusLabel}</small></button>)}</nav>}
    {view && <>
      <ol className="cr-steps" aria-label="从实验到追源的实际进度">{view.steps.map((step, index) => <li key={step.id} className={`is-${step.state}`} data-review-step={step.id} data-step-state={step.state}>
        <div className="cr-step-marker"><span>{step.state === "done" ? <Check size={16} /> : step.state === "active" ? <CircleDot size={16} /> : step.state === "partial" ? <ShieldAlert size={16} /> : <Circle size={16} />}</span><small>{index + 1}</small></div>
        <h3>{step.label}</h3><time>{step.turn !== null ? round(step.turn) : step.state === "done" ? "已完成，回合未记录" : "尚无发生回合"}</time><p>{step.detail}</p>
        {step.agentIds.length > 0 && <div className="cr-actors">{step.agentIds.map(id => <span key={id}><i style={{ background: wildlingColor(id) }} />{wildlingName(id)}</span>)}</div>}
      </li>)}</ol>

      <section className="cr-timing" aria-label="发现与处理时间"><div><span>反例形成</span><strong>{round(view.times.firstCounterexample)}</strong><small>{view.counterexampleAgentIds.length > 0 && <>实验作者：{view.counterexampleAgentIds.map(wildlingName).join("、")}。 </>}{view.evidence.historical > 0 ? "案卷包含历史回执，不作本案首次发现" : "已核对的关联反例"}</small></div><ArrowRight size={15} /><div><span>进入公共争议</span><strong>{round(view.times.disputed)}</strong><small>{view.times.evidenceToDispute === null ? "尚不能计算信息进入调查的间隔" : `与最早关联反例相隔 ${view.times.evidenceToDispute} 回合`}</small></div><ArrowRight size={15} /><div><span>规则修复</span><strong>{round(view.times.repaired)}</strong><small>{view.times.discoveryToRepair === null ? "撤回或到时结束，不计作修复" : `从公开发现到修复 ${view.times.discoveryToRepair} 回合`}</small></div></section>

      <section className="cr-policy" aria-label="当前生效的协作规矩"><header><h3><GitBranch size={17} />现在的部落规矩</h3><span>当前选择；不倒算为过去已经生效</span></header><div className="cr-policy-columns">{view.rules.map(rule => <div key={rule.id} className="cr-rule"><span>{rule.id === "D2" ? "发现不对，怎么办" : "下次凭什么相信"}</span><h4>{rule.name}</h4><p>{rule.requirement}</p><strong>{rule.record}</strong><small>{rule.note}</small></div>)}</div>{view.ruleAmendment && <p className="cr-amendment">{view.ruleAmendment}</p>}</section>

      <section className="cr-contributions" aria-label="成员的实际证据贡献"><header><div><h3><FlaskConical size={17} />每个人补上了什么</h3><p>{view.evidence.verified} 份已核对回执 · {view.evidence.people} 位作者 · {view.evidence.contexts} 种地域与天气组合</p></div>{view.task && <span>{view.task.id} · 任务情境 {view.task.completed}/{view.task.required}</span>}</header>
        {view.task && <div className="cr-repair-requirements"><h4>{view.status === "repaired" || view.status === "complete" ? "本次修正规则的调查材料" : "起草修正规则，需要这些材料"}</h4><dl>{view.repairChecks.map(check => <div key={check.label} className={check.current !== null && check.current >= check.required ? "is-ready" : ""}><dt>{check.label}</dt><dd>{check.current === null ? "未核对" : <>{check.current}<span> / {check.required}</span></>}{check.current !== null && check.current >= check.required && <Check size={13} />}</dd></div>)}</dl><p>只计本调查任务的已核对回执。收齐材料后，新规则仍须满足至少 3 份支持、2 位来源、适用范围内无反例，以及当前制度门槛。</p></div>}
        {view.contributions.length > 0 ? <div className="cr-contribution-table" role="table" aria-label="按真实实验回执统计的贡献"><div className="cr-contribution-labels" role="row"><span role="columnheader">成员与回合</span><span role="columnheader">试过的条件</span><span role="columnheader">交来的证据</span></div>{view.contributions.map(person => <div className="cr-contribution-row" role="row" key={person.agentId} style={{ "--cr-member-color": wildlingColor(person.agentId) } as CSSProperties}>
          <div role="cell" className="cr-person">{onSelectAgent ? <button onClick={() => onSelectAgent(person.agentId)} aria-label={`查看 ${wildlingName(person.agentId)} 的档案`}><i /><strong>{wildlingName(person.agentId)}</strong><ArrowUpRight size={13} /></button> : <strong><i />{wildlingName(person.agentId)}</strong>}<time>{person.firstTurn === person.lastTurn ? round(person.firstTurn) : `第 ${person.firstTurn} 至 ${person.lastTurn} 回合`}</time></div>
          <div role="cell" className="cr-contexts">{person.contexts.map(context => <span key={context}>{context}</span>)}</div>
          <div role="cell" className="cr-receipts"><strong>{person.counterexampleCount > 0 && <span className="cr-counter">{person.counterexampleCount} 份反例</span>}{person.supportCount > 0 && <span className="cr-support">{person.supportCount} 份支持</span>}</strong><code>{person.evidenceIds.join(" · ")}</code></div>
        </div>)}</div> : <p className="cr-empty">尚无核对完成的关联回执。发言、认领任务和传话，都不直接计为实验贡献。</p>}
        <p className="cr-evidence-note"><Info size={15} /><span>{view.limits[0]}</span></p>
      </section>

      <footer className={`cr-verdict is-${view.status}`}><Fingerprint size={22} /><div><strong>{view.sourceConfirmed ? "玩家已确认源头" : "玩家的追源还没有完成"}</strong><p>{view.gap}</p></div>{view.canInvestigate && onInvestigate && <button onClick={() => onInvestigate(view.caseId)}><Search size={15} />追查零号<ArrowRight size={15} /></button>}</footer>
      {view.limits.length > 1 && <details className="cr-limits"><summary><Info size={14} />尚未核实的记录</summary><ul>{view.limits.slice(1).map(limit => <li key={limit}>{limit}</li>)}</ul></details>}
    </>}
  </section>;
}
