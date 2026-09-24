import { BookOpenCheck, ClipboardList } from "lucide-react";
import { beliefStatusLabel, beliefTitle, conditionsLabel, resourceLabel, taskResolutionLabel, taskStatusLabel, taskTypeLabel } from "../i18n";
import type { Belief, Task } from "../types";

export function KnowledgePanel({ beliefs, tasks }: { beliefs: Belief[]; tasks: Task[] }) {
  const open = tasks.filter(t => !["RESOLVED", "EXPIRED"].includes(t.status)).sort((a, b) => b.priority - a.priority);
  return <section className="side-stack">
    <div className="panel knowledge-panel">
      <div className="panel-heading"><div><span className="eyebrow">群体共识</span><h2><BookOpenCheck />集体知识</h2></div><span className="panel-count">{beliefs.length} 条</span></div>
      <div className="knowledge-list">{beliefs.length ? beliefs.map(b => <article className={`knowledge-card ${b.status.toLowerCase()}`} key={b.id}>
        <div><span className="knowledge-object">{resourceLabel[b.object]}</span><em className={`status ${b.status.toLowerCase()}`}>{beliefStatusLabel[b.status]}</em></div>
        <h3>{beliefTitle(b)}</h3>
        <div className="confidence"><i style={{ width: `${Math.round(b.display_confidence * 100)}%` }} /><strong>{Math.round(b.display_confidence * 100)}%</strong></div>
        <footer>{b.evidence_count} 条证据 · {b.independent_agent_ids.length} 个独立来源</footer>
      </article>) : <div className="empty-state">探索和验证后，集体认可的知识会出现在这里。</div>}</div>
    </div>
    <div className="panel task-panel">
      <div className="panel-heading"><div><span className="eyebrow">协作任务板</span><h2><ClipboardList />任务协作</h2></div><span className="panel-count">{open.length} 待处理</span></div>
      <div className="task-list">{open.length ? open.slice(0, 8).map(task => <article className={`task-card type-${task.type.toLowerCase()}`} key={task.id}>
        <div className="task-top"><strong>{taskTypeLabel[task.type]}</strong><span>优先级 {task.priority}</span></div>
        <p>{task.required_contexts.slice(0, 3).map(r => `${r.object ? resourceLabel[r.object] + " · " : ""}${conditionsLabel(r.conditions)}`).join("；") || "等待条件满足"}{task.required_contexts.length > 3 ? ` 等 ${task.required_contexts.length} 个场景` : ""}</p>
        <footer><span>{taskStatusLabel[task.status]}</span><span>{task.claimant_agent_ids.length ? `认领：${task.claimant_agent_ids.join("、")}` : "尚未认领"}</span></footer>
      </article>) : <div className="empty-state">当前没有待处理任务。{tasks.at(-1)?.resolution && <small>最近结果：{taskResolutionLabel(tasks.at(-1)!.resolution)}</small>}</div>}</div>
    </div>
  </section>;
}
