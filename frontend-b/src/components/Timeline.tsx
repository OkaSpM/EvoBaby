import { Clock3 } from "lucide-react";
import { actionLabel, incidentStatusLabel, regionLabel, resourceLabel } from "../i18n";
import type { Incident, MetaBelief, RawEvent } from "../types";

type TimelineItem = { id: string; turn: number; title: string; detail: string; tone: string };

export function Timeline({ events, incidents, metaBeliefs }: { events: RawEvent[]; incidents: Incident[]; metaBeliefs: MetaBelief[] }) {
  const items: TimelineItem[] = [];
  events.forEach(event => {
    if (event.type === "RETURNED_TO_BASE") items.push({ id: event.event_id, turn: event.turn, title: `${event.agent_id} 返回基地`, detail: "能量耗尽，进入休整。", tone: "warning" });
    if (event.type === "REACTIVATED") items.push({ id: event.event_id, turn: event.turn, title: `${event.agent_id} 恢复行动`, detail: "能量恢复，可以继续探索。", tone: "normal" });
    if (event.type === "ACTION_EXECUTED" && event.result?.success && ["COLLECT", "USE_BERRY", "USE_CRYSTAL", "USE_MOSS"].includes(event.result.action)) {
      const resource = event.result.object ? resourceLabel[event.result.object] : "资源";
      items.push({ id: event.event_id, turn: event.turn, title: `${event.agent_id} ${actionLabel[event.result.action]}`, detail: `${resource} · ${regionLabel[event.observation.region]} · ${event.observation.weather === "Rain" ? "降雨" : "晴朗"}${event.result.resource_effect ? ` · 能量 ${event.result.resource_effect > 0 ? "+" : ""}${event.result.resource_effect}` : ""}`, tone: event.result.resource_effect < 0 ? "danger" : "normal" });
    }
  });
  incidents.forEach(incident => {
    items.push({ id: `${incident.id}-start`, turn: incident.injectedTurn, title: `第 ${incident.attackNumber} 次错误记忆进入系统`, detail: `${incident.targetAgentId ? `目标 ${incident.targetAgentId}` : "目标未揭示"} · ${incident.omittedCondition == null ? "条件未揭示" : `省略${incident.omittedCondition === "region" ? "地区" : "天气"}条件`}`, tone: "danger" });
    if (incident.detectedTurn != null) items.push({ id: `${incident.id}-detected`, turn: incident.detectedTurn, title: incidentStatusLabel[incident.status], detail: `${incident.rootBeliefId == null ? "影响范围未揭示" : `影响 ${incident.affectedAgentIds.length} 个智能体`}，系统开始基于真实证据处理。`, tone: "warning" });
    if (incident.resolvedTurn != null) items.push({ id: `${incident.id}-done`, turn: incident.resolvedTurn, title: `事故 ${incident.id} 已处理`, detail: incident.rootBeliefId == null ? "调查已结束，源头细节尚未揭示。" : incident.replacementBeliefId ? "错误规则已收窄并重新验证。" : "错误规则已撤销或在扩散前阻止。", tone: "success" });
  });
  metaBeliefs.forEach(meta => items.push({ id: meta.id, turn: meta.created_turn, title: "群体学会新的验证原则", detail: "独立智能体不等于独立场景；广义结论需要场景多样性。", tone: "evolution" }));
  const recent = items.sort((a, b) => b.turn - a.turn || b.id.localeCompare(a.id)).slice(0, 14);
  return <section className="panel timeline-panel"><div className="panel-heading"><div><span className="eyebrow">事件记录</span><h2><Clock3 />关键事件时间线</h2></div><span className="panel-count">已过滤常规移动</span></div>
    <div className="timeline">{recent.length ? recent.map(item => <article key={item.id} className={`timeline-item ${item.tone}`}><time>第 {item.turn} 回合</time><div><strong>{item.title}</strong><p>{item.detail}</p></div></article>) : <div className="empty-state">运行模拟后，关键发现与认知变化会出现在这里。</div>}</div>
  </section>;
}
