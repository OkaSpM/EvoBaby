import { BatteryMedium, Brain, ChevronRight, PackageOpen, Users } from "lucide-react";
import { actionLabel, beliefStatusLabel, beliefTitle, regionLabel, resourceLabel } from "../i18n";
import type { AgentDetail, AgentSummary, Belief } from "../types";

interface Props { agents: AgentSummary[]; selected: string | null; detail: AgentDetail | null; onSelect: (id: string) => void }

function BeliefRows({ beliefs, empty }: { beliefs: Belief[]; empty: string }) {
  if (!beliefs.length) return <div className="empty-small">{empty}</div>;
  return <div className="belief-list compact">{beliefs.map(b => <div className="belief-row" key={b.id}>
    <div><strong>{beliefTitle(b)}</strong><span>{b.evidence_count} 条证据 · {b.independent_agent_ids.length} 个独立来源</span></div>
    <em className={`status ${b.status.toLowerCase()}`}>{beliefStatusLabel[b.status]}</em>
  </div>)}</div>;
}

export function AgentPanel({ agents, selected, detail, onSelect }: Props) {
  return <section className="panel agent-panel">
    <div className="panel-heading"><div><span className="eyebrow">智能体群体</span><h2><Users />经验分化</h2></div><span className="panel-count">{agents.length} 个体</span></div>
    <div className="agent-grid">{agents.map(agent => <button key={agent.id} className={`agent-card ${selected === agent.id ? "selected" : ""}`} onClick={() => onSelect(agent.id)}>
      <div className="agent-title"><span className={`agent-avatar avatar-${agent.id.toLowerCase()}`}>{agent.id}</span><div><strong>智能体 {agent.id}</strong><small>{regionLabel[agent.region]} · ({agent.position.join(", ")})</small></div><ChevronRight /></div>
      <div className="energy-line"><span><BatteryMedium />能量</span><strong>{agent.energy}</strong></div>
      <div className="energy-track"><i style={{ width: `${agent.energy}%` }} /></div>
      <div className="agent-stats"><span><Brain />个人 {agent.personalBeliefCount}</span><span><Users />共享 {agent.sharedBeliefCount}</span><span>✓ 已验证 {agent.verifiedBeliefCount}</span></div>
      <div className="agent-current">{agent.unavailableUntilTurn ? `基地休整至第 ${agent.unavailableUntilTurn} 回合` : actionLabel[agent.currentAction ?? ""] ?? "等待下一步"}{agent.currentTaskId && <b>{agent.currentTaskId}</b>}</div>
    </button>)}</div>
    {selected && detail && <div className="agent-detail">
      <div className="detail-heading"><div><span className="eyebrow">个人记忆</span><h3>{selected} 的认知档案</h3></div><div className="inventory"><PackageOpen />{Object.entries(detail.agent.inventory).map(([key, count]) => <span key={key}>{resourceLabel[key as keyof typeof resourceLabel]} {count}</span>)}</div></div>
      <div className="memory-columns"><div><h4>个人信念 <span>自身经验</span></h4><BeliefRows beliefs={detail.personalBeliefs} empty="尚未形成个人信念" /></div><div><h4>采纳知识 <span>群体共享</span></h4><BeliefRows beliefs={detail.adoptedSharedBeliefs} empty="尚未采纳共享知识" /></div></div>
    </div>}
  </section>;
}
