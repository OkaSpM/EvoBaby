import { Eye, ShieldAlert } from "lucide-react";
import { regionLabel, resourceIcon, resourceLabel, weatherLabel } from "../i18n";
import type { GroundTruth } from "../types";

export function TruthPanel({ truth }: { truth: GroundTruth }) {
  const counts = truth.cells.reduce<Record<string, number>>((acc, c) => { if (c.object) acc[c.object] = (acc[c.object] ?? 0) + 1; return acc; }, {});
  return <section className="panel truth-panel" data-truth-snapshot-turn={truth.turn}><div className="panel-heading"><div><span className="eyebrow">特权调试视图 · 第 {truth.turn} 回合</span><h2><Eye />世界真相</h2></div><span className="danger-label"><ShieldAlert />智能体不可见</span></div>
    <div className="truth-grid"><div><span>苔藓真实规则</span><strong>仅在{regionLabel[truth.mossRule.positiveWhen.region]} + {weatherLabel[truth.mossRule.positiveWhen.weather]}时恢复能量</strong><p>符合条件 +{truth.mossRule.positiveEnergyDelta}，其他场景 {truth.mossRule.otherEnergyDelta}</p></div><div><span>真实资源配置</span><div className="truth-counts">{Object.entries(counts).map(([key, count]) => <b key={key}>{resourceIcon[key as keyof typeof resourceIcon]} {resourceLabel[key as keyof typeof resourceLabel]} {count}</b>)}</div><p>当前种子 {truth.seed} · 第 {truth.turn} 回合</p></div><div><span>监管审计</span><strong>{truth.incidents.length} 次受控攻击</strong><p>评委真相不代表玩家已完成来源指认。</p></div></div>
  </section>;
}
