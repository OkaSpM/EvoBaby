import type { AccusationResult, AgentDetail, BeliefTrace, ChoiceOption, ChoicePoint, ExportResponse, Paradigm, StateResponse } from "./types";
import { withBFeedback } from "./b-session";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.code ?? "REQUEST_FAILED", payload.message ?? "服务暂时不可用，请检查后端是否已启动。", response.status);
  if (payload?.simulation && Array.isArray(payload.agents)) return withBFeedback(payload as StateResponse) as T;
  if (payload?.state?.simulation && Array.isArray(payload.state.agents)) payload.state = withBFeedback(payload.state);
  return payload as T;
}

export const api = {
  state: (groundTruth = false) => request<StateResponse>(`/api/state${groundTruth ? "?ground_truth=true" : ""}`),
  startGame: () => request<{ state: StateResponse }>("/api/game/start", { method: "POST" }),
  advance: (turns = 100) => request<{ state: StateResponse }>("/api/simulation/advance", { method: "POST", body: JSON.stringify({ turns }) }),
  replay: (turn: number) => request<StateResponse>(`/api/replay/${turn}`),
  choice: (point: ChoicePoint, option: ChoiceOption) => request<{ state: StateResponse }>("/api/choice", { method: "POST", body: JSON.stringify({ point, option }) }),
  paradigm: () => request<Paradigm | null>("/api/paradigm"),
  trace: (id: string) => request<BeliefTrace>(`/api/beliefs/${encodeURIComponent(id)}/trace`),
  accuse: (agent_id: string, belief_id: string, incident_id?: string) => request<AccusationResult>(incident_id ? "/api/b/trace/accuse" : "/api/trace/accuse", { method: "POST", body: JSON.stringify({ agent_id, belief_id, ...(incident_id ? { incident_id } : {}) }) }),
  continueInvestigation: () => request<{ state: StateResponse }>("/api/b/continue", { method: "POST", body: JSON.stringify({ turns: 60 }) }),
  remove: (id: string) => request<{ state: StateResponse }>(`/api/agents/${encodeURIComponent(id)}/remove`, { method: "POST" }),
  broadcast: (enabled: boolean) => request<{ state: StateResponse }>("/api/swarm/broadcast", { method: "POST", body: JSON.stringify({ enabled }) }),
  step: () => request<{ state: StateResponse }>("/api/simulation/step", { method: "POST" }),
  run: (speed: 1 | 5 | 20) => request<{ state: StateResponse }>("/api/simulation/run", { method: "POST", body: JSON.stringify({ speed }) }),
  pause: () => request<{ state: StateResponse }>("/api/simulation/pause", { method: "POST" }),
  reset: () => request<{ state: StateResponse }>("/api/simulation/reset", { method: "POST" }),
  newSeed: () => request<{ state: StateResponse }>("/api/simulation/new-seed", { method: "POST" }),
  inject: (target_policy?: string) => request<{ state: StateResponse }>("/api/corruption/inject", { method: "POST", body: target_policy ? JSON.stringify({ target_policy }) : undefined }),
  injectSecond: () => request<{ state: StateResponse }>("/api/corruption/inject-second", { method: "POST" }),
  agent: (id: string) => request<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`),
  export: () => request<ExportResponse>("/api/export")
};
