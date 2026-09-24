import { Activity, GitBranch, Lightbulb, ShieldCheck } from "lucide-react";
import { incidentStatusLabel, regionLabel } from "../i18n";
import type { ExperimentMetrics, Incident, MetaBelief } from "../types";

export function EvolutionPanel({ metaBeliefs, incidents, metrics }: { metaBeliefs: MetaBelief[]; incidents: Incident[]; metrics: ExperimentMetrics }) {
  const active = metaBeliefs.find(m => m.active);
  const current = incidents.at(-1);
  return <section className="evolution-layout">
    <div className="panel how-panel">
      <div className="panel-heading"><div><span className="eyebrow">我们如何判断知识</span><h2><Lightbulb />认知演化</h2></div>{active && <span className="learned-badge"><ShieldCheck />已学习</span>}</div>
      {!active ? <div className="principle before"><span>初始验证原则</span><strong>不同智能体重复得出相同结果，会提高知识可信度。</strong><p>当首次重大错误被发现并修复后，群体将反思这套方法。</p></div>
        : <div className="principle after"><span>新原则 · 第 {active.created_turn} 回合形成</span><strong>独立智能体不等于独立场景。</strong><p>广义结论必须覆盖它所省略的场景维度。当前要求：{active.policy_effect.dimensions.map(d => d === "region" ? "多个地区" : "多种天气").join(" + ")}。</p><small>源自事故 {active.learned_from_incident_id}</small></div>}
    </div>
    <div className="panel incident-panel">
      <div className="panel-heading"><div><span className="eyebrow">认知事故</span><h2><Activity />攻击与调查</h2></div>{current && <em className={`incident-status ${current.status.toLowerCase()}`}>{incidentStatusLabel[current.status]}</em>}</div>
      {incidents.length ? <div className="incident-flow">{incidents.map((incident, index) => <div className="incident-node" key={incident.id}>
        <span className="node-index">{index + 1}</span><div><strong>第 {incident.attackNumber} 次攻击</strong><p>{incident.omittedCondition == null ? "条件未揭示" : `省略${incident.omittedCondition === "region" ? "地区" : "天气"}条件`} · {incident.rootBeliefId == null ? "影响范围未揭示" : `影响 ${incident.affectedAgentIds.length} 个智能体`}</p><small>第 {incident.injectedTurn} 回合注入{incident.resolvedTurn != null ? ` · 第 ${incident.resolvedTurn} 回合结束` : ""}</small><div className="incident-facts"><span>验证场景 {incident.verificationRequestCount}</span><span>证据 {incident.evidenceByContext.length}</span><span>传播链 {incident.rootBeliefId == null ? "未揭示" : incident.lineage.length}</span></div>{incident.evidenceByContext.length > 0 && <div className="context-chips">{incident.evidenceByContext.slice(0, 6).map(e => <i className={e.outcome === "SUPPORT" ? "support" : "counter"} key={e.evidenceId}>{regionLabel[e.region]} · {e.weather === "Rain" ? "雨" : "晴"} · {e.agentId}</i>)}</div>}</div>
        {index < incidents.length - 1 && <GitBranch className="flow-arrow" />}
      </div>)}</div> : <div className="empty-state">集体知识成熟后，可以发起受控错误记忆攻击。</div>}
    </div>
    {metrics.comparison && <div className="panel comparison-panel">
      <div className="panel-heading"><div><span className="eyebrow">演化效果证据</span><h2>两次攻击对比</h2></div><span className="improved">策略生效</span></div>
      <div className="compare-table"><div className="compare-head"><span>指标</span><span>第一次</span><span>第二次</span></div>
        <Compare label="影响人数" first={metrics.comparison.first_attack.agents_affected} second={metrics.comparison.second_attack.agents_affected} />
        <Compare label="发现用时" first={metrics.comparison.first_attack.turns_until_first_dispute} second={metrics.comparison.second_attack.turns_until_first_dispute} />
        <Compare label="修复用时" first={metrics.comparison.first_attack.turns_until_repair} second={metrics.comparison.second_attack.turns_until_repair} />
        <Compare label="错误行动" first={metrics.comparison.first_attack.incorrect_actions_caused} second={metrics.comparison.second_attack.incorrect_actions_caused} />
        <Compare label="采纳前场景" first={metrics.comparison.first_attack.contexts_checked_before_adoption} second={metrics.comparison.second_attack.contexts_checked_before_adoption} higherBetter />
      </div>
    </div>}
  </section>;
}

function Compare({ label, first, second, higherBetter = false }: { label: string; first: number | null; second: number | null; higherBetter?: boolean }) {
  const improved = first != null && second != null && (higherBetter ? second > first : second < first);
  return <div className="compare-row"><span>{label}</span><strong>{first ?? "未发生"}</strong><strong className={improved ? "better" : ""}>{second ?? "提前阻止"}</strong></div>;
}
