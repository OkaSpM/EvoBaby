import { Activity, GitBranch, Lightbulb, ShieldCheck } from "lucide-react";
import { incidentStatusLabel, regionLabel } from "../i18n";
import type { ExperimentMetrics, Incident, MetaBelief } from "../types";
import { judgeComparisonComplete, judgeIncidentOutcome, judgeMetricValue, judgeUsesHistoricalDiscovery } from "../judge-comparison";

export function EvolutionPanel({ metaBeliefs, incidents, metrics }: { metaBeliefs: MetaBelief[]; incidents: Incident[]; metrics: ExperimentMetrics }) {
  const active = metaBeliefs.find(m => m.active);
  const current = incidents.at(-1);
  const comparison = metrics.comparison;
  const first = incidents.find(incident => incident.id === comparison?.first_attack.incident_id);
  const second = incidents.find(incident => incident.id === comparison?.second_attack.incident_id);
  const complete = judgeComparisonComplete(first, second);
  const historicalDiscovery = comparison && (judgeUsesHistoricalDiscovery(comparison.first_attack.turns_until_first_dispute, first) || judgeUsesHistoricalDiscovery(comparison.second_attack.turns_until_first_dispute, second));
  return <section className="evolution-layout" id="judge-investigations" aria-label="认知演化与调查对比" tabIndex={-1}>
    <div className="panel how-panel">
      <div className="panel-heading"><div><span className="eyebrow">我们如何判断知识</span><h2><Lightbulb />认知演化</h2></div>{active && <span className="learned-badge"><ShieldCheck />已学习</span>}</div>
      {!active ? <div className="principle before"><span>初始验证原则</span><strong>不同智能体重复得出相同结果，会提高知识可信度。</strong><p>当首次重大错误被发现并修复后，群体将反思这套方法。</p></div>
        : <div className="principle after"><span>新原则 · 第 {active.created_turn} 回合形成</span><strong>独立智能体不等于独立场景。</strong><p>广义结论必须覆盖它所省略的场景维度。当前要求：{active.policy_effect.dimensions.map(d => d === "region" ? "多个地区" : "多种天气").join(" + ")}。</p><small>源自事故 {active.learned_from_incident_id}</small></div>}
    </div>
    <div className="panel incident-panel">
      <div className="panel-heading"><div><span className="eyebrow">认知事故</span><h2><Activity />攻击与调查</h2></div>{current && <em className={`incident-status ${current.status.toLowerCase()}`}>{incidentStatusLabel[current.status]}</em>}</div>
      {incidents.length ? <div className="incident-flow">{incidents.map((incident, index) => <div className="incident-node" key={incident.id}>
        <span className="node-index">{index + 1}</span><div><strong>第 {incident.attackNumber} 次攻击</strong><span className={`judge-outcome ${incident.status.toLowerCase()}`} data-incident-status={incident.status}>{judgeIncidentOutcome(incident)}</span><p>{incident.omittedCondition == null ? "条件未揭示" : `省略${incident.omittedCondition === "region" ? "地区" : "天气"}条件`} · {incident.rootBeliefId == null ? "影响范围未揭示" : `影响 ${incident.affectedAgentIds.length} 个智能体`}</p><small>第 {incident.injectedTurn} 回合注入{incident.resolvedTurn != null ? ` · 第 ${incident.resolvedTurn} 回合结束` : ""}</small><div className="incident-facts"><span>验证场景 {incident.verificationRequestCount}</span><span>证据 {incident.evidenceByContext.length}</span><span>传播链 {incident.rootBeliefId == null ? "未揭示" : incident.lineage.length}</span></div>{incident.evidenceByContext.length > 0 && <div className="context-chips">{incident.evidenceByContext.slice(0, 6).map(e => <i className={e.outcome === "SUPPORT" ? "support" : "counter"} key={e.evidenceId}>{regionLabel[e.region]} · {e.weather === "Rain" ? "雨" : "晴"} · {e.agentId}</i>)}</div>}</div>
        {index < incidents.length - 1 && <GitBranch className="flow-arrow" />}
      </div>)}</div> : <div className="empty-state">集体知识成熟后，可以发起受控错误记忆攻击。</div>}
    </div>
    <div className="panel comparison-panel" data-comparison-state={comparison ? complete ? "complete" : "observing" : "unavailable"}>
      <div className="panel-heading"><div><span className="eyebrow">两案实际指标</span><h2>两次攻击对比</h2></div><span className={complete ? "improved" : "judge-observing"}>{comparison ? complete ? "已完成对照" : "观察中" : "待第二案"}</span></div>
      {comparison ? <div className="judge-table-scroll" role="region" aria-label="两次攻击指标对照" tabIndex={0}><table className="judge-compare-table"><thead><tr><th scope="col">指标</th><th scope="col">第一次<span className={`judge-outcome ${first?.status.toLowerCase() ?? "unknown"}`}>{judgeIncidentOutcome(first)}</span></th><th scope="col">第二次<span className={`judge-outcome ${second?.status.toLowerCase() ?? "unknown"}`}>{judgeIncidentOutcome(second)}</span></th></tr></thead><tbody>
        <Compare label="影响人数" first={comparison.first_attack.agents_affected} second={comparison.second_attack.agents_affected} incidents={[first, second]} complete={complete} />
        <Compare label="发现耗时（回合）" first={comparison.first_attack.turns_until_first_dispute} second={comparison.second_attack.turns_until_first_dispute} incidents={[first, second]} complete={complete} eventTime />
        <Compare label="结案耗时（回合）" first={comparison.first_attack.turns_until_repair} second={comparison.second_attack.turns_until_repair} incidents={[first, second]} complete={complete} eventTime="closure" />
        <Compare label="错误行动" first={comparison.first_attack.incorrect_actions_caused} second={comparison.second_attack.incorrect_actions_caused} incidents={[first, second]} complete={complete} />
        <Compare label="采纳前场景" first={comparison.first_attack.contexts_checked_before_adoption} second={comparison.second_attack.contexts_checked_before_adoption} incidents={[first, second]} complete={complete} higherBetter />
      </tbody></table>{historicalDiscovery && <p className="judge-observing" data-historical-evidence-note="true">* 历史反例早于本次注入，不能作为本次发现耗时；发现耗时未记录，不计为负耗时。</p>}</div> : <div className="empty-state">第二次攻击尚无对照记录。</div>}
    </div>
  </section>;
}

function Compare({ label, first, second, incidents, complete, higherBetter = false, eventTime = false }: { label: string; first: number | null; second: number | null; incidents: [Incident | undefined, Incident | undefined]; complete: boolean; higherBetter?: boolean; eventTime?: boolean | "closure" }) {
  const improved = complete && first != null && second != null && first >= 0 && second >= 0 && (higherBetter ? second > first : second < first);
  return <tr><th scope="row">{label}</th><td>{judgeMetricValue(first, eventTime, incidents[0])}</td><td className={improved ? "better" : ""}>{judgeMetricValue(second, eventTime, incidents[1])}</td></tr>;
}
