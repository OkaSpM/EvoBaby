import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, BookOpenCheck, Brain, Check, CheckCircle2, Circle, CircleDot, ClipboardList, Compass, FileSearch, FlaskConical, MessageCircle, Network, PauseCircle, Radio, RadioOff, ShieldAlert, Users } from "lucide-react";
import type { Belief, StateResponse } from "../types";
import { cognitionLabel } from "../cognition";
import { resolveSwarmScene } from "../swarm-scene";
import { resolveSwarmValues } from "../swarm-value";
import { Wildling, deriveWildlingState, wildlingColor, wildlingName } from "./Wildling";
import { actionLabel, effectLabel, regionLabel, resourceLabel } from "../i18n";
import "../swarm-b.css";
import "../swarm-value-b.css";

type SwarmView = ReturnType<typeof resolveSwarmScene>;
type SwarmTask = SwarmView["tasks"][number];
const taskIcon = (type: string) => type === "INVESTIGATION" ? FileSearch : type === "VERIFICATION" ? FlaskConical : Compass;
const taskLabel = (type: string) => type === "INVESTIGATION" ? "追查争议" : type === "VERIFICATION" ? "独立核验" : "生存协作";
const turnLabel = (turn: number | null) => turn == null ? "回合未记录" : `T${turn}`;
const taskDescriptionLabel: Record<string, string> = {
  "Find a reliable energy source.": "寻找可靠的能量来源。",
  "Collect the missing independent evidence.": "补齐缺少的独立证据。",
  "Test missing contexts to determine the supported rule.": "补测尚未验证的情境，确认规则在哪些条件下成立。",
};
function publicText(value: string): string {
  if (taskDescriptionLabel[value]) return taskDescriptionLabel[value];
  const effect = value.match(/^(Berry|Crystal|Moss): (OBJECT_PRESENT|RENEWABLE|NOT_RENEWABLE|ENERGY_POSITIVE|ENERGY_NEGATIVE)$/);
  return effect ? `${resourceLabel[effect[1] as keyof typeof resourceLabel]}：${effectLabel[effect[2]]}` : value;
}

export function SwarmPulse({ state, onOpen }: { state: StateResponse; onOpen: () => void }) {
  const swarm = useMemo(() => resolveSwarmScene(state), [state]);
  const latest = swarm.messages[0];
  return <button className="swarm-pulse" onClick={onOpen} aria-label={`查看蜂群协作，${swarm.activeTaskCount} 项活跃任务`}>
    <span className="swarm-pulse-title"><Network size={15} /><strong>蜂群协作</strong><b>{swarm.activeTaskCount}<small>项活跃</small></b></span>
    <span className="swarm-pulse-center"><span className="swarm-pulse-members">{swarm.members.map(member => <span key={member.agentId} className={`is-${member.mode}`} title={`${wildlingName(member.agentId)} · ${member.roleLabel}`} aria-label={`${wildlingName(member.agentId)} · ${member.roleLabel}`}><i style={{ background: wildlingColor(member.agentId) }} /><span>{wildlingName(member.agentId)}</span></span>)}</span><span className="swarm-pulse-message">{latest ? `${wildlingName(latest.agentId)} · ${latest.actionLabel}` : swarm.activeTaskCount ? "任务已挂上公告板" : "各自探索，等待第一份合作任务"}</span></span>
    <ArrowRight size={15} className="swarm-pulse-arrow" />
  </button>;
}

export function SwarmScene({ state, selectedAgent, onSelectAgent, onSelectBelief }: { state: StateResponse; selectedAgent: string; onSelectAgent: (id: string) => void; onSelectBelief: (belief: Belief) => void }) {
  const swarm = useMemo(() => resolveSwarmScene(state), [state]);
  const values = useMemo(() => resolveSwarmValues(state), [state]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const task = swarm.tasks.find(item => item.id === selectedTaskId) || swarm.focusTask;
  const belief = task?.beliefId ? state.collectiveKnowledge.find(item => item.id === task.beliefId) : undefined;
  const recentResult = swarm.latestResult?.id !== task?.id ? swarm.latestResult : null;
  return <section className="swarm-scene" aria-label="蜂群协作现场" data-swarm-turn={swarm.turn}>
    <header className="swarm-scene-header"><div><span>SWARM / PUBLIC COOPERATION</span><h2>五个人，怎样一起求证</h2></div><div className="swarm-overview"><span><ClipboardList size={13} /><b>{swarm.activeTaskCount}</b>活跃任务</span><span><Users size={13} /><b>{swarm.claimedAgentCount}</b>人认领</span><span className={swarm.broadcastEnabled === false ? "disconnected" : ""}>{swarm.broadcastEnabled === false ? <RadioOff size={13} /> : <Radio size={13} />}{swarm.broadcastEnabled === null ? "广播状态未记录" : swarm.broadcastEnabled ? "广播已连接" : "广播已断开"}</span></div></header>
    <section className="swarm-values" aria-label="协作留下的增量"><header><h3><Network size={15} />协作留下的增量</h3><span>T{values.turn} 公开快照 · 不作净收益估算</span></header><dl>{values.items.map(item => { const Icon = item.id === "experience" ? Compass : item.id === "knowledge" ? BookOpenCheck : item.id === "evidence" ? FileSearch : Brain; return <div key={item.id} className="swarm-value" data-swarm-value={item.id}><dt><Icon size={16} />{item.title}</dt><dd><strong>{item.summary}</strong>{item.members && <div className="swarm-value-members">{item.members.map(member => <span key={member.agentId}><i style={{ background: wildlingColor(member.agentId) }} />{wildlingName(member.agentId)}<b>{member.label}</b></span>)}</div>}<p>{item.detail}</p></dd></div>; })}</dl></section>
    <div className="swarm-members" aria-label="五位成员当前分工">{swarm.members.map(member => {
      const agent = state.agents.find(item => item.id === member.agentId);
      if (!agent) return null;
      const stage = agent.cognition ? cognitionLabel(agent.cognition.stage) : null;
      const detail = actionLabel[member.detail] || member.detail;
      const Icon = member.mode === "removed" || member.mode === "resting" ? PauseCircle : member.mode === "task" ? FlaskConical : Compass;
      return <button key={member.agentId} className={`swarm-member ${selectedAgent === member.agentId ? "selected" : ""} is-${member.mode}`} style={{ "--member-color": wildlingColor(member.agentId) } as React.CSSProperties} onClick={() => onSelectAgent(member.agentId)} aria-label={`选择 ${wildlingName(member.agentId)}，${member.roleLabel}${stage ? `，${stage.numeral} ${stage.name}` : ""}`}>
        <div className="swarm-member-top"><strong>{wildlingName(member.agentId)}</strong><span>{stage?.numeral || "?"}</span></div>
        <Wildling color={wildlingColor(member.agentId)} state={deriveWildlingState(agent, state.recentEvents, state.simulation.turn, { base: state.world.base })} size={79} />
        <span className="swarm-member-role"><Icon size={11} />{member.roleLabel}</span><small title={detail}>{detail}</small><code>{member.taskId || (member.mode === "removed" ? "已暂离" : member.mode === "resting" ? "恢复体力" : "自由探索")}</code>
      </button>;
    })}</div>

    <div className="swarm-workbench"><aside className="swarm-task-list"><header><ClipboardList size={14} /><h3>协作公告板</h3><span>{swarm.tasks.length}</span></header>{swarm.tasks.length ? swarm.tasks.map(item => {
      const Icon = taskIcon(item.type);
      return <button key={item.id} className={`swarm-task-row ${item.id === task?.id ? "selected" : ""}`} onClick={() => setSelectedTaskId(item.id)} aria-pressed={item.id === task?.id} aria-label={`查看${taskLabel(item.type)}任务 ${item.id}`}><div><Icon size={14} /><strong>{taskLabel(item.type)}</strong><span>{item.statusLabel}</span></div><h4>{item.title}</h4><footer><code>{item.id}</code><span>{item.claimantAgentIds.length ? item.claimantAgentIds.map(wildlingName).join(" · ") : "暂无认领记录"}</span></footer></button>;
    }) : <div className="swarm-task-empty"><Compass size={25} /><p>还没有协作任务</p><span>自己的亲历，也会成为同伴的依据。</span></div>}{recentResult && <div className={`swarm-last-result is-${recentResult.result.tone}`}><span>最近一项结果</span><strong>{recentResult.result.label}</strong><code>{recentResult.id} · {turnLabel(recentResult.result.turn)}</code></div>}</aside>

    <div className="swarm-focus">{task ? <><header className="swarm-focus-heading"><div><span>{taskLabel(task.type)} / {task.id}</span><h3>{task.title}</h3><p>{publicText(task.description)}</p></div><span className={`swarm-result-label is-${task.result.tone}`}>{task.result.label}</span></header>
      <ol className="swarm-workflow" aria-label="任务协作事实进度">{task.steps.map((step, index) => <li key={step.id} className={`is-${step.state}`} data-step={step.id} data-state={step.state}><div><span>{step.state === "done" ? <Check size={13} /> : step.state === "attention" ? <ShieldAlert size={13} /> : step.state === "active" ? <CircleDot size={13} /> : <Circle size={13} />}</span><small>{String(index + 1).padStart(2, "0")}</small></div><strong>{step.label}</strong><p>{step.detail}</p><time>{turnLabel(step.turn)}</time></li>)}</ol>

      <section className="swarm-contexts"><header><h4><FlaskConical size={13} />场景核验</h4><span>{task.totalContexts > 0 ? `${task.completedCount} / ${task.totalContexts} 个条件已收证` : "未列细分条件"}</span></header>{task.totalContexts > 0 && <progress max={task.totalContexts} value={task.completedCount} aria-label="任务条件收证进度" />}{task.contexts.length > 0 ? <div className="swarm-context-rows">{task.contexts.map(context => <div key={context.id} className={context.completed ? "complete" : ""}><span>{context.completed ? <CheckCircle2 size={14} /> : <Circle size={14} />}</span><div><strong>{context.label}</strong><small>{context.claimantAgentIds.length ? `${context.claimantAgentIds.map(wildlingName).join(" · ")} 参与认领` : context.completed ? "执行成员未记录" : "暂无认领记录"}</small></div><b>{context.completed ? "已收证" : "待回证"}</b></div>)}</div> : <p className="swarm-empty-copy">这项任务没有附带可展示的分场景要求。</p>}</section>

      <section className="swarm-evidence"><header><h4><FileSearch size={13} />公开证据</h4><span>{task.evidenceCount === null ? "总量未记录" : `${task.evidenceCount} 份回证`}</span></header>{task.evidence.length > 0 ? <EvidenceRows evidence={task.evidence} /> : <p className="swarm-empty-copy">当前公开记录尚未附带可展示的证据明细。</p>}{task.beliefId && <div className="swarm-belief-reference"><span>关联常识 <code>{task.beliefId}</code></span>{belief && <button onClick={() => onSelectBelief(belief)}>查看依据<ArrowUpRight size={12} /></button>}</div>}</section>
    </> : <div className="swarm-focus-empty"><Network size={35} /><h3>合作，从一次需要开始</h3><p>有人需要补给、有人想找同伴核验，任务才会挂上公告板。</p></div>}</div></div>

    <section className="swarm-message-log"><header><h3><MessageCircle size={14} />篝火通信</h3><span>最近 {swarm.messages.length} 条公开消息</span></header>{swarm.messages.length ? <ol>{swarm.messages.map(message => <li key={message.id}><time>T{message.turn}</time><span className="swarm-message-person"><i style={{ background: wildlingColor(message.agentId) }} /><strong>{wildlingName(message.agentId)}</strong></span><div><strong>{message.actionLabel}</strong><p>{publicText(message.content)}</p></div>{message.beliefId && <code>{message.beliefId}</code>}</li>)}</ol> : <p className="swarm-empty-copy">暂时没有公开通信记录。</p>}</section>
  </section>;
}

function EvidenceRows({ evidence }: { evidence: SwarmTask["evidence"] }) {
  return <div className="swarm-evidence-table" role="table" aria-label="公开实验回证"><div className="swarm-evidence-head" role="row"><span role="columnheader">成员 / 来源</span><span role="columnheader">实验条件</span><span role="columnheader">反馈</span></div>{evidence.map(item => <div key={`${item.evidenceId}-${item.agentId}`} className="swarm-evidence-row" role="row"><div role="cell"><strong><i style={{ background: wildlingColor(item.agentId) }} />{wildlingName(item.agentId)}</strong><code>{item.evidenceId}</code></div><span role="cell">{regionLabel[item.region as keyof typeof regionLabel] || item.region} · {item.weather === "Rain" ? "雨天" : item.weather === "Sunny" ? "晴天" : "天气未记录"}</span><span role="cell" className={item.outcome === "COUNTEREXAMPLE" ? "counterexample" : "support"}>{item.label}</span></div>)}</div>;
}
