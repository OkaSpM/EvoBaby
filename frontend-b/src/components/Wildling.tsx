import { useId } from "react";
import type { AgentSummary, CognitionStage, Position, RawEvent } from "../types";
import { cognitionStage } from "../cognition";
import "../wildling.css";

export const WILDLING_COLORS = ["#f6c85c", "#70d7ba", "#ff987f", "#9eaff0", "#e9a4cf"] as const;
export const WILDLING_NAMES = ["Nuo", "Tek", "Ilo", "Sav", "Omi"] as const;

export interface WildlingState {
  cognitionStage?: CognitionStage;
  berry?: boolean;
  crystal?: boolean;
  ruffled?: boolean;
  reputation?: number;
  lowEnergy?: boolean;
  sleeping?: boolean;
  speaking?: boolean;
  walking?: boolean;
  eating?: boolean;
  infected?: boolean;
  showTruth?: boolean;
  removed?: boolean;
}

export interface WildlingProps {
  color: string;
  state?: WildlingState;
  size?: number | string;
  className?: string;
  label?: string;
}

export function wildlingColor(id: string): string {
  const index = Math.max(0, Number(id.replace(/\D/g, "")) - 1 || 0);
  return WILDLING_COLORS[index % WILDLING_COLORS.length];
}

export function wildlingName(id: string): string {
  const index = Math.max(0, Number(id.replace(/\D/g, "")) - 1 || 0);
  return WILDLING_NAMES[index % WILDLING_NAMES.length];
}

interface Appearance {
  hasBerry?: boolean;
  hasCrystal?: boolean;
  ruffledUntilTurn?: number;
  reputation?: number;
}

export function deriveWildlingState(
  agent: AgentSummary,
  events: RawEvent[],
  turn: number,
  options: { base?: Position; showTruth?: boolean; infected?: boolean; reputation?: number } = {},
): WildlingState {
  const appearance = (agent as AgentSummary & { appearance?: Appearance }).appearance;
  const recent = events.filter(event => event.agent_id === agent.id && event.turn <= turn);
  const atBase = options.base?.every((coordinate, index) => agent.position[index] === coordinate) ?? false;
  const action = agent.currentAction ?? "";
  const removed = !!agent.removed || agent.unavailableUntilTurn === Infinity || (agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > 100000);
  const resting = agent.unavailableUntilTurn != null && agent.unavailableUntilTurn > turn;
  return {
    cognitionStage: cognitionStage(agent.cognition?.stage),
    berry: appearance?.hasBerry ?? (agent.inventory.Berry > 0 || recent.some(event => event.result?.action === "USE_BERRY")),
    crystal: appearance?.hasCrystal ?? (agent.inventory.Crystal > 0 || recent.some(event => event.result?.object === "Crystal" && event.result.success)),
    ruffled: appearance?.ruffledUntilTurn != null ? appearance.ruffledUntilTurn >= turn : recent.some(event => turn - event.turn < 3 && event.result?.action === "USE_MOSS" && event.result.resource_effect < 0),
    reputation: Math.max(0, Math.min(8, Math.floor(appearance?.reputation ?? options.reputation ?? 0))),
    lowEnergy: agent.energy <= 25,
    sleeping: !removed && atBase && (resting || agent.energy <= 35),
    speaking: action === "SHARE_BELIEF" || action === "REQUEST_VERIFY",
    walking: action.startsWith("MOVE_") && !resting,
    eating: action.startsWith("USE_"),
    infected: options.infected,
    showTruth: options.showTruth,
    removed,
  };
}

function tint(hex: string, amount: number): string {
  const source = /^#[\da-f]{6}$/i.test(hex) ? hex : WILDLING_COLORS[0];
  const destination = amount > 0 ? 255 : 0;
  return `#${[1, 3, 5].map(start => {
    const value = parseInt(source.slice(start, start + 2), 16);
    return Math.round(value + (destination - value) * Math.abs(amount)).toString(16).padStart(2, "0");
  }).join("")}`;
}

export function Wildling({ color, state = {}, size = 160, className = "", label }: WildlingProps) {
  const id = useId().replace(/:/g, "");
  const truth = !!(state.showTruth && state.infected);
  const subdued = state.lowEnergy || state.sleeping;
  const reputation = Math.max(0, Math.min(8, Math.floor(state.reputation || 0)));
  const stage = cognitionStage(state.cognitionStage);
  const outline = "#34433b";
  const classes = ["wildling", state.walking && "is-walking", state.eating && "is-eating", state.speaking && "is-speaking", state.sleeping && "is-sleeping", subdued && "is-crouching", state.ruffled && "is-ruffled", state.removed && "is-removed", className].filter(Boolean).join(" ");
  return <svg className={classes} data-cognition-stage={stage} viewBox="0 0 240 280" width={size} height={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id={`${id}-coat`} x1="0" y1="0" x2="0.8" y2="1"><stop stopColor={tint(color, .26)} /><stop offset=".62" stopColor={color} /><stop offset="1" stopColor={tint(color, -.2)} /></linearGradient>
      <linearGradient id={`${id}-skin`} x1="0" y1="0" x2="0.2" y2="1"><stop stopColor="#ffe9ca" /><stop offset="1" stopColor="#efbd98" /></linearGradient>
      <linearGradient id={`${id}-hair`} x1="0" y1="0" x2="0.6" y2="1"><stop stopColor={tint(color, -.2)} /><stop offset="1" stopColor={tint(color, -.44)} /></linearGradient>
    </defs>
    <ellipse className="wildling-shadow" cx="121" cy="257" rx="57" ry="10" fill="#182d2c" opacity=".16" />
    <g className="wildling-body">
      {stage === 4 && <path className="cognition-cape" d="M69 151 Q39 190 29 247 Q65 237 85 254 L119 240 155 254 191 240 213 247 Q201 184 170 151Z" fill={tint(color, -.25)} stroke={outline} strokeWidth="3.5" strokeLinejoin="round" />}
      {stage === 2 && <path d="M77 153 Q42 173 34 211 L65 218 92 207 121 223 150 207 181 216 206 209 Q194 171 165 153Z" fill={tint(color, -.13)} stroke={outline} strokeWidth="3" />}
      <g className="wildling-leg leg-left"><path d="M91 218 Q88 228 87 242 Q73 244 75 253 Q89 260 108 253 L111 218" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" strokeLinejoin="round" /><path d="M82 249v5m9-6v7" fill="none" stroke="#be8c70" strokeWidth="2" strokeLinecap="round" /></g>
      <g className="wildling-leg leg-right"><path d="M130 218 L132 250 Q148 260 165 253 Q167 244 153 242 L151 218" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" strokeLinejoin="round" /><path d="M151 249v6m8-6v5" fill="none" stroke="#be8c70" strokeWidth="2" strokeLinecap="round" /></g>
      <path d="M69 161 Q60 179 61 200 Q63 223 83 231 L91 226 L106 234 L120 228 L135 234 L151 226 L161 231 Q183 218 181 194 Q179 172 169 159Z" fill={`url(#${id}-coat)`} stroke={outline} strokeWidth="3.5" strokeLinejoin="round" />
      <path d="M73 169 Q86 192 98 201 L92 217 M108 169 L119 206 L129 175 M164 169 Q155 191 144 201 L150 217" fill="none" stroke={tint(color, -.37)} strokeWidth="2.5" strokeLinecap="round" opacity=".65" />
      {stage === 3 && <g fill={tint(color, .16)} stroke={outline} strokeWidth="2.5"><path d="m73 167 34 12-13 42-26-13Z" /><path d="m165 167-34 12 13 42 26-13Z" /><path d="m75 186 25 7m39 0 26-7" fill="none" /></g>}
      <path d="M68 204 Q119 218 174 204" fill="none" stroke="#796b45" strokeWidth="5" strokeLinecap="round" /><path d="M69 202 Q119 215 172 202" fill="none" stroke="#e8d8a4" strokeWidth="2" strokeLinecap="round" />
      <path d="M117 207 l-7 15 11 5 10-9-9-13Z" fill="#e5d6a6" stroke="#796b45" strokeWidth="2" /><path d="m118 216 5 2" stroke="#a99871" strokeWidth="2" strokeLinecap="round" />
      <g className="wildling-arm arm-left"><path d="M66 173 Q44 179 49 195 Q56 207 70 196" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" strokeLinecap="round" /><path d="m54 194 2-5m5 8 2-5" stroke="#be8c70" strokeWidth="2" strokeLinecap="round" /></g>
      <g className="wildling-arm arm-right"><path d="M174 173 Q196 179 191 195 Q184 207 170 196" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" strokeLinecap="round" /><path d="m186 194-2-5m-5 8-2-5" stroke="#be8c70" strokeWidth="2" strokeLinecap="round" /></g>
      <g className="wildling-head">
        {stage === 2 && <path d="M36 119 Q26 24 120 13 Q215 25 205 119 L189 164 169 178 153 153 87 153 65 178 44 155Z" fill={`url(#${id}-coat)`} stroke={outline} strokeWidth="4" />}
        <path d="M49 115 Q25 61 68 39 L75 24 93 31 111 16 126 29 147 20 152 35 Q203 42 205 99 L197 129 189 151 174 161 159 158 145 175 124 167 103 174 86 161 67 164 51 142Z" fill={`url(#${id}-hair)`} stroke={outline} strokeWidth="3.5" strokeLinejoin="round" />
        <ellipse cx="50" cy="120" rx="13" ry="17" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" /><ellipse cx="190" cy="120" rx="13" ry="17" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" />
        <path d="M47 116q8-6 9 9m137-9q-8-6-9 9" fill="none" stroke="#cd977c" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M59 113 Q56 70 90 69 Q119 54 149 69 Q184 75 182 114 L180 132 Q174 164 122 169 Q70 169 60 138Z" fill={`url(#${id}-skin)`} stroke={outline} strokeWidth="3" />
        <path d="M50 104 Q54 61 82 56 Q86 42 105 47 Q122 29 137 47 Q171 43 189 79 L190 112 Q174 105 163 86 L158 97 Q143 87 137 74 L129 88 Q112 89 102 75 L94 91 84 85 Q75 103 62 112 L58 98Z" fill={`url(#${id}-hair)`} stroke={outline} strokeWidth="3" strokeLinejoin="round" />
        <path d="M69 77q4-10 14-13m20-8 8-5m48 13q12 5 17 15" fill="none" stroke={tint(color, .22)} strokeWidth="3" strokeLinecap="round" opacity=".65" />
        <g className="wildling-eyes">
          {state.sleeping ? <><path d="M77 119q16 12 30-1m26 0q15 13 30 0" fill="none" stroke={outline} strokeWidth="4.5" strokeLinecap="round" /><path d="m83 125-3 5m21-6 3 5m34-5-2 5m21-5 4 4" stroke={outline} strokeWidth="2" strokeLinecap="round" /></> : <>
            <ellipse cx="92" cy="116" rx="22" ry={subdued ? 20 : 25} fill="#fffdf0" stroke={outline} strokeWidth="3" /><ellipse cx="148" cy="116" rx="22" ry={subdued ? 20 : 25} fill="#fffdf0" stroke={outline} strokeWidth="3" />
            <ellipse cx={truth ? 94 : 97} cy="119" rx={truth ? 7 : 11} ry="16" fill={truth ? "#665d7a" : "#243c39"} /><ellipse cx={truth ? 146 : 143} cy="119" rx={truth ? 7 : 11} ry="16" fill={truth ? "#665d7a" : "#243c39"} />
            <ellipse cx="98" cy="112" rx="4" ry="5" fill="white" /><ellipse cx="144" cy="112" rx="4" ry="5" fill="white" /><circle cx="91" cy="124" r="2.2" fill="#a9d6c4" /><circle cx="137" cy="124" r="2.2" fill="#a9d6c4" />
            {truth && <path d="m72 96 32 5m33 0 29-6" stroke="#665d7a" strokeWidth="4" strokeLinecap="round" />}
          </>}
        </g>
        <ellipse cx="120" cy="138" rx="7" ry="5" fill="#d69b77" /><path d="M116 136q4-3 8 0" fill="none" stroke="#ffe1be" strokeWidth="2" strokeLinecap="round" />
        <ellipse cx="71" cy="139" rx="9" ry="5" fill="#ec9e89" opacity=".6" /><ellipse cx="168" cy="139" rx="9" ry="5" fill="#ec9e89" opacity=".6" />
        {state.eating ? <ellipse cx="122" cy="153" rx="8" ry="6" fill="#785247" /> : state.ruffled ? <path d="M111 156q9-9 19-1" fill="none" stroke="#76564a" strokeWidth="2.5" strokeLinecap="round" /> : <path d="M110 149q11 12 23-1" fill="none" stroke="#76564a" strokeWidth="2.8" strokeLinecap="round" />}
        {stage === 1 && <><path d="M131 33Q127 9 150 11Q153 28 131 33" fill="#9abf72" stroke={outline} strokeWidth="2.5" /><path d="m133 29 11-12" stroke="#577a49" strokeWidth="2" strokeLinecap="round" /></>}
        {stage === 2 && <g><path d="M43 98 Q34 24 120 16 Q205 24 198 98 L177 82 Q153 45 120 47 Q80 48 64 86Z" fill={`url(#${id}-coat)`} stroke={outline} strokeWidth="3" /><path d="M120 18v27m-48-8 16 21m81-21-15 21" fill="none" stroke={tint(color, -.3)} strokeWidth="3" /></g>}
        {stage === 3 && <g className="cognition-wide-hat"><path d="M60 57 Q74 7 123 12 Q169 13 185 59Z" fill={`url(#${id}-coat)`} stroke={outline} strokeWidth="3" /><path d="M16 73 Q45 45 120 48 Q195 45 225 73 L213 89 Q165 71 122 76 Q70 73 27 91Z" fill={tint(color, -.1)} stroke={outline} strokeWidth="3.5" /><path d="M67 53 Q122 66 180 53" fill="none" stroke="#e9d9a2" strokeWidth="6" /></g>}
        {stage === 4 && <g className="cognition-fan" stroke={outline} strokeWidth="2.5" strokeLinejoin="round">{[-56, -28, 0, 28, 56].map(angle => <g key={angle} transform={`rotate(${angle} 120 70)`}><path d="M119 73 Q92 39 119 2 Q148 33 123 73Z" fill={angle === 0 ? tint(color, .16) : color} /><path d="M121 13v50" fill="none" stroke={tint(color, -.35)} strokeWidth="2" /></g>)}<path d="M62 69 Q120 50 180 69 L176 85 Q122 65 66 85Z" fill={tint(color, -.24)} /><circle cx="120" cy="68" r="8" fill="#f5df8d" /></g>}
        {state.ruffled && <g><path d="m61 136 14 6m-14 0 14-6" stroke="#b78a6b" strokeWidth="3" strokeLinecap="round" /><path d="M169 76q9 13 8 19" stroke="#eed8a7" strokeWidth="10" strokeLinecap="round" /><path d="m171 80 4 10" stroke="#caaa77" strokeWidth="2" strokeDasharray="2 3" strokeLinecap="round" /><path d="m43 72-9-6m12-3-1-11" stroke="#91b69a" strokeWidth="3" strokeLinecap="round" /></g>}
      </g>
      {stage === 1 && !state.berry && <g><path d="M168 194q13-8 24 0l-3 31q-15 10-25-2Z" fill="#b38762" stroke={outline} strokeWidth="2.5" /><path d="m164 202 26 3" stroke="#ead5ae" strokeWidth="3" /></g>}
      {stage === 2 && <g className="cognition-book" transform="rotate(-12 174 211)"><path d="M153 184h45v51h-45Z" fill="#986945" stroke={outline} strokeWidth="3" /><path d="M160 188h34v41h-34Z" fill="#eddbab" /><path d="m166 198 20 0m-20 9 18 0m-18 9 12 0" stroke="#96784b" strokeWidth="3" strokeLinecap="round" /><path d="M154 188v43" stroke="#c9a473" strokeWidth="4" /></g>}
      {stage === 3 && <g className="cognition-tools"><path d="m51 208 18-26" stroke={outline} strokeWidth="9" strokeLinecap="round" /><circle cx="76" cy="169" r="19" fill="#c5ebe5" fillOpacity=".7" stroke="#577b76" strokeWidth="6" /><path d="m66 164 10-7" stroke="white" strokeWidth="4" strokeLinecap="round" /><path d="M169 200h24l-2 29q-10 6-21 0Z" fill="#afdccf" stroke={outline} strokeWidth="2.5" /><path d="M166 198h29" stroke="#ab8960" strokeWidth="7" strokeLinecap="round" /><path d="m176 224 3-13 8 14" fill="#5b9e76" /></g>}
      {stage === 4 && <g className="cognition-guide-tools"><path d="M205 244V136q0-12 10-15" fill="none" stroke="#87663f" strokeWidth="8" strokeLinecap="round" /><path d="m199 145 12 0m-12 11 12 0m-12 11 12 0" stroke="#e9d59b" strokeWidth="4" strokeLinecap="round" /><path d="M45 187q18-7 32 4 14-11 32-4v40q-19-5-32 3-17-8-32-3Z" fill="#efdeb3" stroke={outline} strokeWidth="2.5" /><path d="M77 192v36m-23-31 15 4m-15 8 15 4m16-12 15-4m-15 16 15-4" fill="none" stroke="#9b8358" strokeWidth="2" /></g>}
      {reputation > 0 && <g className="wildling-reputation">{Array.from({ length: reputation }, (_, i) => <g key={i} transform={`translate(${81 + i * 11} ${217 + Math.sin(i / 7 * Math.PI) * 7})`}><path d="m0-4 4 4-4 5-4-5Z" fill="#fff4b0" stroke="#9a8148" strokeWidth="1.4" /><path d="M0-2v4" stroke="#dfb950" strokeWidth="1" /></g>)}</g>}
      {state.berry && <g className="wildling-berry"><path d="M169 197q15-8 22 1l-3 27q-15 9-24-3Z" fill="#ad815d" stroke={outline} strokeWidth="2.4" /><path d="m166 202 24 3" stroke="#e0c7a0" strokeWidth="3" /><circle cx="174" cy="195" r="7" fill="#e57a85" stroke="#853f57" strokeWidth="2" /><circle cx="184" cy="194" r="7" fill="#ec8b93" stroke="#853f57" strokeWidth="2" /><circle cx="180" cy="204" r="7" fill="#d85f7a" stroke="#853f57" strokeWidth="2" /><path d="M179 190q-13-14-14-3 7 6 14 3m0 0q2-15 11-10-1 8-11 10" fill="#9abb75" stroke="#506944" strokeWidth="1.5" /><circle cx="176" cy="192" r="2" fill="#ffd9d8" /></g>}
      {state.crystal && <g className="wildling-crystal"><path d="m45 212 10-23 16 15-2 25-18 4Z" fill="#9dddd7" stroke="#395a61" strokeWidth="2.5" /><path d="m55 189 3 23 13-8m-13 8 11 17m-11-17-7 21m7-21-13 0" fill="none" stroke="#569ca4" strokeWidth="1.5" /><path d="m55 189 3 23-13 0Z" fill="#d7fff1" /><path d="m52 231 5-16 11 13Z" fill="#6fbcc8" /></g>}
    </g>
    {state.speaking && <g className="wildling-speech"><path d="M163 20q0-12 15-12h38q14 0 14 13v17q0 13-14 13h-25l-14 10 3-10h-3q-14 0-14-13Z" fill="#ffffec" stroke={outline} strokeWidth="2.5" /><circle cx="182" cy="30" r="3" fill="#557167" /><circle cx="196" cy="30" r="3" fill="#557167" /><circle cx="210" cy="30" r="3" fill="#557167" /></g>}
    {state.sleeping && <g className="wildling-sleep-marks" fill="#91b5ae" fontFamily="sans-serif" fontWeight="700"><text x="177" y="69" fontSize="18">z</text><text x="194" y="45" fontSize="23">z</text></g>}
  </svg>;
}
