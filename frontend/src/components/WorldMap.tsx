import { Home, Map as MapIcon } from "lucide-react";
import { regionLabel, resourceIcon, resourceLabel } from "../i18n";
import type { AgentSummary, GroundTruth, Position, WorldView } from "../types";

interface Props { world: WorldView; agents: AgentSummary[]; selectedAgent: string | null; knownPositions: Position[]; truth: GroundTruth | null }
const agentColors = ["#f0b45b", "#60c4b0", "#e07a67", "#88a9e8", "#b18bd4"];

export function WorldMap({ world, agents, selectedAgent, knownPositions, truth }: Props) {
  const known = new Set(knownPositions.map(p => p.join(",")));
  const truthByPosition = new Map(truth?.cells.map(cell => [cell.position.join(","), cell]) ?? []);
  return <section className="panel map-panel">
    <div className="panel-heading"><div><span className="eyebrow">实时世界状态</span><h2><MapIcon />荒野地图</h2></div><div className="weather-pill">{world.weather === "Rain" ? "☂" : "☀"} {world.weather === "Rain" ? "正在降雨" : "天气晴朗"}</div></div>
    <div className="region-key">{Object.entries(regionLabel).map(([key, label]) => <span key={key}><i className={`region-dot ${key.toLowerCase()}`} />{label}</span>)}</div>
    <div className="world-grid" aria-label="8×8 世界地图">
      {world.cells.map(cell => {
        const key = cell.position.join(",");
        const isBase = cell.position[0] === world.base[0] && cell.position[1] === world.base[1];
        const occupants = agents.filter(a => a.position[0] === cell.position[0] && a.position[1] === cell.position[1]);
        const visibleObject = truth ? truthByPosition.get(key)?.object ?? null : cell.object;
        const selectedKnown = selectedAgent ? known.has(key) : false;
        return <div key={key} className={`world-cell region-${cell.region.toLowerCase()} ${cell.known ? "known" : "unknown"} ${selectedAgent && selectedKnown ? "agent-known" : ""}`} title={`${regionLabel[cell.region]} · (${cell.position.join(", ")})${visibleObject ? ` · ${resourceLabel[visibleObject]}` : ""}`}>
          <span className="coordinate">{cell.position[0]},{cell.position[1]}</span>
          {isBase && <Home className="base-icon" aria-label="基地" />}
          {visibleObject && <span className={`resource resource-${visibleObject.toLowerCase()}`} aria-label={resourceLabel[visibleObject]}>{resourceIcon[visibleObject]}</span>}
          {!cell.known && !truth && <span className="unknown-mark">?</span>}
          <div className="occupants">{occupants.map(agent => <span key={agent.id} style={{ background: agentColors[Number(agent.id.slice(1)) - 1] }} className={selectedAgent === agent.id ? "selected" : ""}>{agent.id.slice(1)}</span>)}</div>
        </div>;
      })}
    </div>
    <div className="map-caption"><span><i className="legend known" />已探索</span><span><i className="legend unknown" />未知区域</span><span><Home />基地</span>{selectedAgent && <strong>高亮：{selectedAgent} 已知区域</strong>}</div>
  </section>;
}
