import { CloudRain, Flame, MapPin, Sun } from "lucide-react";
import type { AgentSummary, GroundTruth, Incident, Position, RawEvent, Resource, WorldView } from "../types";
import { deriveWildlingState, Wildling, wildlingColor, wildlingName } from "./Wildling";
import { regionLabel, resourceLabel } from "../i18n";
import "../wildling.css";

interface Props {
  world: WorldView;
  agents: AgentSummary[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  events: RawEvent[];
  groundTruth?: GroundTruth | null;
  turn?: number;
  incidents?: Incident[];
  knownPositions?: Position[];
  showNames?: boolean;
}

export function WildResource({ type, className = "" }: { type: Resource; className?: string }) {
  return <svg viewBox="0 0 56 56" className={`wild-resource wild-resource-${type.toLowerCase()} ${className}`} role="img" aria-label={resourceLabel[type]}>
    {type === "Berry" ? <>
      <path d="M13 40q-8-17 5-22 12-8 24 2 12 13-1 24Z" fill="#486e4e" stroke="#243e38" strokeWidth="2" />
      <circle cx="19" cy="29" r="9" fill="#cf7383" stroke="#67454d" strokeWidth="2" /><circle cx="36" cy="28" r="9" fill="#e29391" stroke="#67454d" strokeWidth="2" /><circle cx="27" cy="40" r="10" fill="#d87987" stroke="#67454d" strokeWidth="2" /><circle cx="17" cy="26" r="2.5" fill="#ffd4ca" /><circle cx="34" cy="25" r="2.5" fill="#ffe1d0" />
      <path d="M26 24Q10 12 16 8q11-2 13 13Q34 4 44 10q-1 13-15 15Z" fill="#a6c979" stroke="#395d43" strokeWidth="2" />
    </> : type === "Crystal" ? <>
      <path d="m10 35 4-15 10 4 9-18 13 20-5 21-24 3Z" fill="#9cd4e5" stroke="#4a6377" strokeWidth="2" strokeLinejoin="round" /><path d="m33 6-5 26 13 15 5-21Z" fill="#91a8d4" /><path d="m33 6 4 21-9 5Z" fill="#d8f8f4" /><path d="m14 20 5 17-2 13 11-18-4-8" fill="#b8e5ec" /><path d="m14 20 5 17 9-5m0 0 9-5 9-1m-18 6 5-26m-5 26 13 15" fill="none" stroke="#648598" strokeWidth="1.4" />
    </> : <>
      <path d="M8 36q-2-10 8-12 0-10 11-7 9-8 16 4 10 2 8 12 5 10-8 12H17Q4 45 8 36Z" fill="#76a679" stroke="#3b6554" strokeWidth="2" /><path d="m17 36 1-11m10 15 1-17m10 13 4-11m-25 7-5-3m16 2 5-4" stroke="#b1cf91" strokeWidth="2.5" strokeLinecap="round" /><path d="M12 43q18 7 34-2" stroke="#4d805b" fill="none" strokeWidth="3" />
    </>}
  </svg>;
}

export function Campfire({ quiet = false }: { quiet?: boolean }) {
  return <svg viewBox="0 0 100 104" className={`wild-campfire ${quiet ? "is-quiet" : ""}`} role="img" aria-label="篝火基地">
    <ellipse cx="51" cy="85" rx="39" ry="13" fill="#213b34" opacity=".23" />
    <g stroke="#4d5143" strokeWidth="2"><ellipse cx="23" cy="81" rx="11" ry="7" fill="#a7b5a4" transform="rotate(-25 23 81)" /><ellipse cx="44" cy="91" rx="12" ry="6" fill="#bbc3a9" /><ellipse cx="71" cy="88" rx="12" ry="7" fill="#a0b1a3" transform="rotate(-15 71 88)" /><ellipse cx="82" cy="77" rx="10" ry="7" fill="#bac4ad" /><path d="m26 82 45-20 5 9-43 21Z" fill="#9a7655" /><path d="m27 68 9-7 39 24-6 8Z" fill="#b1885b" /></g>
    <g className="wild-fire-flame"><path d="M52 12q-1 21-14 32-3-12-8-15 3 20-9 31-12 31 29 31 39-1 28-30-3-7-2-22-7 4-9 13Q69 30 52 12Z" fill="#f69b5b" stroke="#a66442" strokeWidth="2.5" /><path d="M50 43q4 13-7 23-5-5-5-10-15 24 10 29 26 3 20-17-7-13-8-21-1 15-10 16 4-9 0-20Z" fill="#ffd887" /><path d="M51 67q-17 16 1 20 19-4-1-20Z" fill="#fff0bb" /></g>
    <g className="wild-fire-sparks" fill="#f5c977"><ellipse cx="34" cy="22" rx="2" ry="4" /><ellipse cx="69" cy="13" rx="2" ry="3" /><circle cx="58" cy="2" r="2" /></g>
  </svg>;
}

function Terrain() {
  return <svg viewBox="0 0 800 800" preserveAspectRatio="none" className="wild-terrain" aria-hidden="true">
    <defs>
      <pattern id="wild-terrain-grain" width="39" height="39" patternUnits="userSpaceOnUse"><path d="m8 10 4-3m17 22 3-2" stroke="#d9e4b7" strokeWidth="1" opacity=".13" /></pattern>
    </defs>
    <path d="M0 0H410Q387 92 406 190T398 403Q286 374 194 408T0 391Z" fill="#456d4f" />
    <path d="M410 0H800V403Q699 378 603 402T398 403Q417 295 400 197T410 0Z" fill="#496b8e" />
    <path d="M0 391q110 34 206 9t192 3q21 102 1 206t11 191H0Z" fill="#28746a" />
    <path d="M398 403q98 17 205-1t197 1v397H410q-30-101-10-193t-2-204Z" fill="#a06a54" />
    <path d="M-10 402q109 38 215 9t194 3q96 19 205-1t211 9M401-10q-31 108-5 211t2 204q28 103 8 203t14 205" fill="none" stroke="#d5d5a3" strokeWidth="2" strokeDasharray="5 11" opacity=".27" />
    <path d="M34 335q27-20 41-1m73-201q21-18 39-2m75 175q24-17 38-2M54 112l4-17m5 20 6-13m234-48 4-12m8 14 5-9" fill="none" stroke="#9fc38a" strokeWidth="4" strokeLinecap="round" opacity=".3" />
    <g fill="#8aabb5" opacity=".25"><path d="m470 92 21-25 37 15 9 24-50 6Zm196 164 17-29 47 7 20 31-54 6ZM526 345l13-23 25 4 10 21Z" /><path d="m680 87 20-20 20 9 9 22-41 3Z" /></g>
    <g fill="none" stroke="#99c7b6" strokeWidth="3" opacity=".2"><path d="M41 485q38-16 65-1m-40 13q24-10 51-3m119 165q45-17 77 1m-54 10q28-10 54-4M53 718q37-18 72-2" /></g>
    <g stroke="#ddd6a4" strokeWidth="3" opacity=".21" strokeLinecap="round"><path d="m472 480 9 6m5-24 11 4m193 109 10 5m21-14 9 4M556 690l14 4m11 10 12 2m118 48 12 2" /></g>
    <rect width="800" height="800" fill="url(#wild-terrain-grain)" />
  </svg>;
}

export function WildWorldScene({ world, agents, selectedAgent, onSelectAgent, events, groundTruth = null, turn = 0, incidents = [], knownPositions = [], showNames = true }: Props) {
  const known = new Set(knownPositions.map(position => position.join(",")));
  const truthCells = new Map(groundTruth?.cells.map(cell => [cell.position.join(","), cell]) ?? []);
  const infectedIds = new Set(groundTruth ? incidents.filter(incident => !["REPAIRED", "REVOKED", "PREVENTED"].includes(incident.status)).flatMap(incident => incident.affectedAgentIds) : []);
  const removed = (agent: AgentSummary) => !!agent.removed || agent.unavailableUntilTurn === Infinity || (agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > 100000);
  return <section className="wild-world-scene" aria-label="部落荒野地图">
    <div className="wild-scene-heading"><div><span>WILD WORLD · {world.size} × {world.size}</span><h2>同一片荒野，各自的发现</h2></div><div className="wild-weather">{world.weather === "Rain" ? <CloudRain size={18} /> : <Sun size={18} />}<span>{world.weather === "Rain" ? "雨正在下" : "晴朗"}</span></div></div>
    <div className={`wild-world-map ${world.weather === "Rain" ? "is-raining" : ""}`} style={{ gridTemplateColumns: `repeat(${world.size}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${world.size}, minmax(0, 1fr))` }}>
      <Terrain />
      {world.cells.map(cell => {
        const [x, y] = cell.position;
        const key = cell.position.join(",");
        const isBase = x === world.base[0] && y === world.base[1];
        const occupants = agents.filter(agent => agent.position[0] === x && agent.position[1] === y);
        const visible = cell.known || !!groundTruth;
        const resource = groundTruth ? truthCells.get(key)?.object ?? null : visible ? cell.object : null;
        const selectedKnown = !!selectedAgent && known.has(key);
        return <div key={key} className={`wild-world-cell ${visible ? "is-known" : "is-unknown"} ${isBase ? "is-base" : ""} ${selectedKnown ? "is-agent-known" : ""}`} style={{ gridColumn: x + 1, gridRow: y + 1 }} title={`${regionLabel[cell.region]} (${x}, ${y})${visible && resource ? ` · ${resourceLabel[resource]}` : !visible ? " · 尚未探索" : ""}`}>
          <span className="wild-cell-coordinate">{x},{y}</span>
          {resource && !isBase && <WildResource type={resource} />}
          {!visible && !isBase && <span className="wild-unknown-mark">·</span>}
          {isBase && <div className="wild-base"><Campfire /><span>篝火</span></div>}
          {occupants.length > 0 && <div className={`wild-occupants occupants-${Math.min(occupants.length, 5)}`}>
            {occupants.map(agent => {
              const artState = deriveWildlingState(agent, events, turn, { base: world.base, showTruth: !!groundTruth, infected: infectedIds.has(agent.id) });
              const name = showNames ? wildlingName(agent.id) : agent.id;
              return <button type="button" key={agent.id} className={`wild-map-agent ${selectedAgent === agent.id ? "is-selected" : ""} ${removed(agent) ? "is-retired" : ""}`} onClick={() => onSelectAgent(agent.id)} aria-label={`${name}，能量 ${agent.energy}，${regionLabel[agent.region]}`} aria-pressed={selectedAgent === agent.id} title={`${name} · 能量 ${agent.energy}`}>
                {removed(agent) ? <svg className="wild-memorial" viewBox="0 0 50 60" aria-hidden="true"><path d="M10 55V21Q11 6 25 6q15 0 16 15v34Z" fill="#a7b7a2" stroke="#506759" strokeWidth="2" /><path d="m25 18-7 10h5v10h5V28h5Z" fill="#718968" /><path d="M5 55h40" stroke="#637d61" strokeWidth="5" strokeLinecap="round" /></svg> : <Wildling color={wildlingColor(agent.id)} state={artState} size="100%" />}
                <span className="wild-map-name">{name}</span>
              </button>;
            })}
          </div>}
        </div>;
      })}
      <div className="wild-region-label region-nw"><i />西北 <small>NW</small></div><div className="wild-region-label region-ne"><i />东北 <small>NE</small></div><div className="wild-region-label region-sw"><i />西南 <small>SW</small></div><div className="wild-region-label region-se"><i />东南 <small>SE</small></div>
      {world.weather === "Rain" && <div className="wild-rain" aria-hidden="true">{Array.from({ length: 15 }, (_, index) => <i key={index} style={{ left: `${4 + index * 6.5}%`, animationDelay: `${index * -.19}s` }} />)}</div>}
    </div>
    <footer className="wild-map-caption"><span><Flame size={13} /> 篝火基地</span><span><i className="wild-known-dot" /> 已探索 {world.cells.filter(cell => cell.known).length} / {world.cells.length}</span>{selectedAgent ? <strong><MapPin size={13} />{showNames ? wildlingName(selectedAgent) : selectedAgent} 的已知区域</strong> : <span>回合 {turn}</span>}</footer>
  </section>;
}
