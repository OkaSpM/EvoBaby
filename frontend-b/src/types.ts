export type Position = [number, number];
export type Region = "NW" | "NE" | "SW" | "SE";
export type Weather = "Sunny" | "Rain";
export type Resource = "Berry" | "Crystal" | "Moss";
export type BeliefStatus = "TENTATIVE" | "VERIFIED" | "DISPUTED" | "REVOKED";
export type TaskStatus = "OPEN" | "CLAIMED" | "IN_PROGRESS" | "RESOLVED" | "EXPIRED";
export type TaskType = "SURVIVAL" | "VERIFICATION" | "INVESTIGATION";
export type IncidentStatus = "INJECTED" | "VERIFYING" | "SPREADING" | "DISPUTED" | "INVESTIGATING" | "REPAIRED" | "REVOKED" | "PREVENTED";
export type CognitionStage = 1 | 2 | 3 | 4;
export interface CognitionMilestone { stage: CognitionStage; turn: number; reason: string; evidenceIds: string[] }
export interface AgentCognition {
  stage: CognitionStage; name: string; earnedTurn: number; milestones: CognitionMilestone[];
  nextGoal: string | null; progress: { current: number; target: number; label: string };
}
export interface MemberCognition { agentId: string; stage: CognitionStage; name: string }
export interface BCognitionFeedback {
  state: "stable" | "review" | "misaligned" | "rebuilding" | "recovered";
  label: string; reason: string; since_turn: number; ruleIds: string[];
  methodLabel: string; stage: number;
}
export interface BClosure {
  status: "playing" | "awaiting_trace" | "success" | "partial" | "unresolved";
  title: string; reason: string; can_continue: boolean; observation_complete: boolean;
  pending_incident_ids: string[]; continuation_count: number;
}
export interface BCaseChronology {
  incident_id: string; attack_number: number; injected_turn: number;
  first_counterexample_turn: number | null; detected_turn: number | null; resolved_turn: number | null;
  source_confirmed_turn?: number | null;
  status: IncidentStatus; source_confirmed: boolean; investigation_task_id: string | null;
  evidence: { id: string; agent_id: string; turn: number; region: Region; weather: Weather;
    outcome: "SUPPORT" | "COUNTEREXAMPLE"; energy_delta: number | null; receipt_verified: boolean;
    basis?: "first-counterexample" | "investigation"; event_ids?: string[] }[];
}
export interface BProtocolReview {
  summary: string;
  cards: { id: string; title: string; selected: string; mechanism: string; observed: string;
    tradeoff: string; status: "chosen" | "observed" | "pending" }[];
}
export interface BReview {
  version: number; closure: BClosure; cognition_feedback: Record<string, BCognitionFeedback>;
  cases: BCaseChronology[]; protocol_review: BProtocolReview;
}

export interface Conditions { region: Region | null; weather: Weather | null }
export interface WorldCell { position: Position; region: Region; known: boolean; object: Resource | null }
export interface WorldView { size: number; base: Position; weather: Weather; cells: WorldCell[] }

export interface SimulationStatus {
  running: boolean; speed: 1 | 5 | 20; turn: number; seed: number;
  canInjectFirst: boolean; canInjectSecond: boolean;
}
export interface AgentSummary {
  id: string; energy: number; position: Position; region: Region;
  inventory: Record<Resource, number>; personalBeliefCount: number;
  sharedBeliefCount: number; verifiedBeliefCount: number;
  currentAction: string | null; currentTaskId: string | null;
  unavailableUntilTurn: number | null;
  removed?: boolean; reputation?: number;
  cognition?: AgentCognition | null;
  cognitionFeedback?: BCognitionFeedback | null;
  appearance?: { hasBerry: boolean; hasCrystal: boolean; ruffledUntilTurn: number; reputation: number };
}
export interface Belief {
  id: string; type: "DISTRIBUTION" | "PERSISTENCE" | "CONDITIONAL_EFFECT";
  proposition: string; object: Resource; conditions: Conditions;
  expected_effect: string; alpha: number; beta: number; evidence_ids: string[];
  independent_agent_ids: string[]; source_agent_id: string; owner_agent_id: string;
  origin: "PERSONAL" | "SHARED"; status: BeliefStatus;
  created_turn: number; updated_turn: number; confidence: number;
  display_confidence: number; evidence_count: number;
}
export interface RequiredContext {
  id: string; conditions: Conditions; object: Resource | null;
  evidence_kind: string; independent_of: string[];
}
export interface Task {
  id: string; type: TaskType; status: TaskStatus; priority: number;
  created_turn: number; updated_turn: number; description: string;
  belief_id: string | null; required_contexts: RequiredContext[];
  claimant_agent_ids: string[]; completed_context_ids: string[];
  claimed_contexts?: { agent_id: string; context_id: string; claimed_turn: number }[];
  evidence_ids?: string[];
  resolution: string | null;
}
export interface MetaBelief {
  id: string; type: "REQUIRE_CONTEXT_DIVERSITY"; principle: string;
  learned_from_incident_id: string; created_turn: number; active: boolean;
  policy_effect: { applies_to: string; dimensions: ("region" | "weather")[]; minimum_distinct_values: number };
}
export interface Incident {
  id: string; attackNumber: number; status: IncidentStatus; injectedTurn: number;
  targetAgentId: string | null; rootBeliefId: string | null; omittedCondition: "region" | "weather" | null;
  affectedAgentIds: string[]; detectedTurn: number | null; disputedTurn: number | null;
  investigationTaskId: string | null; replacementBeliefId: string | null;
  revokedBeliefIds: string[]; resolvedTurn: number | null; verificationRequestCount: number;
  evidenceByContext: { evidenceId: string; agentId: string; region: Region; weather: Weather; outcome: "SUPPORT" | "COUNTEREXAMPLE" }[];
  lineage: { parentBeliefId: string; childBeliefId: string; senderAgentId: string; receiverAgentId: string }[];
}
export interface RawEvent {
  event_id: string; type: "OBSERVATION" | "ACTION_EXECUTED" | "RETURNED_TO_BASE" | "REACTIVATED";
  turn: number; agent_id: string;
  observation: { position: Position; region: Region; weather: Weather; object: Resource | null; energy: number };
  result: null | { action: string; object: Resource | null; success: boolean; reason: string; resource_effect: number; returned_to_base: boolean };
}
export interface AttackMetric {
  incident_id: string; attack_number: number; agents_affected: number;
  injected_turn: number; first_dispute_turn: number | null; resolved_turn: number | null;
  turns_until_first_dispute: number | null; turns_until_repair: number | null;
  incorrect_actions_caused: number; contexts_checked_before_adoption: number; adopted: boolean;
}
export interface ExperimentMetrics {
  attacks: AttackMetric[];
  comparison: null | {
    first_attack: AttackMetric; second_attack: AttackMetric;
    spread_reduction: number; incorrect_action_reduction: number;
    additional_contexts_before_adoption: number;
  };
}
export interface StateResponse {
  simulation: SimulationStatus; world: WorldView; agents: AgentSummary[];
  tasks: Task[]; collectiveKnowledge: Belief[]; metaBeliefs: MetaBelief[];
  incidents: Incident[]; metrics: {
    averageEnergy: number; exploredCellPercent: number; verifiedCollectiveBeliefs: number;
    openTasks: number; knowledgeMature: boolean; attacks: ExperimentMetrics;
  }; recentEvents: RawEvent[];
  choices?: Partial<Record<ChoicePoint, ChoiceOption>>;
  awaiting_choice?: ChoicePrompt | ChoicePoint | null;
  paradigm?: Paradigm | null;
  trace_game?: TraceGame | null;
  judge_online?: boolean;
  game_started?: boolean;
  game?: { enabled?: boolean; started?: boolean; [key: string]: unknown };
  broadcast_enabled?: boolean;
  removed_agents?: string[];
  messages?: SwarmMessage[];
  merged_game?: { enabled: boolean; phase: string; complete: boolean; observation_window_turns?: number; b_review?: BReview };
  story_events?: StoryEvent[];
  memorials?: { agent_id: string; turn: number; taught_count: number; belief_ids: string[] }[];
}
export interface Evidence {
  id: string; kind: string; turn: number; agent_id: string; position: Position;
  region: Region; weather: Weather; object: Resource | null; energy_delta: number | null;
}
export interface AgentDetail {
  agent: AgentSummary; knownCells: WorldCell[]; personalBeliefs: Belief[];
  adoptedSharedBeliefs: Belief[]; evidence: Evidence[]; recentEvents: RawEvent[];
}
export interface GroundTruth {
  seed: number; turn: number; weather: Weather; base: Position;
  cells: { position: Position; object: Resource | null; respawn_at: number | null }[];
  mossRule: { object: Resource; positiveWhen: { region: Region; weather: Weather }; positiveEnergyDelta: number; otherEnergyDelta: number };
  incidents: unknown[];
}
export interface ExportResponse { state: StateResponse; groundTruth: GroundTruth }

export type ChoicePoint = "D1" | "D2" | "D3" | "D4";
export type ChoiceOption = "A" | "B" | "C" | "D";
export interface ChoicePrompt {
  point: ChoicePoint; title?: string; story?: string; description?: string;
  options?: { key?: ChoiceOption; option?: ChoiceOption; title?: string; story?: string; action?: string; analogy?: string }[];
}
export interface CardMetric {
  spread: number; detect_turns: number | null; repair_turns: number | null; bad_actions: number;
  status?: IncidentStatus; injected_turn?: number; resolved_turn?: number | null;
  observed_until_turn?: number; censored?: boolean;
  contexts_before_adoption?: number; reported_contexts_before_adoption?: number;
}
export interface Paradigm {
  id?: string;
  name: string; totem: string; tagline: string;
  choices: Partial<Record<ChoicePoint, ChoiceOption>>;
  metrics: { attack1: CardMetric; attack2: CardMetric };
  rules: string[];
  protocol: Record<string, string | string[]>;
  applies_to: string[];
  cost: { adoption_delay_turns?: number | null; token_overhead_pct?: number | null; note?: string; [key: string]: unknown };
  seed?: number; completed_turn?: number; judge?: { name?: string; confidence?: number; mode?: string };
  memberCognition?: MemberCognition[];
  b_outcome?: BClosure;
  memberFeedback?: Record<string, BCognitionFeedback>;
  caseChronology?: BCaseChronology[];
  protocolReview?: BProtocolReview;
}
export interface TraceGame {
  rounds?: { incident_id: string; attack_number: number; elapsed: number; penalty_seconds: number; attempts: number; swarm_turns: number | null; swarm_finished: boolean; result: AccusationResult | null }[];
  attack_number?: number; active?: boolean; started_at?: number; elapsed?: number;
  penalty_seconds?: number; correct?: boolean; solved?: boolean; winner?: string | null;
  swarm_turns?: number | null; agent_id?: string | null; belief_id?: string | null;
  current?: { incident_id: string; attack_number: number; elapsed: number; penalty_seconds: number; attempts: number; swarm_turns: number | null; swarm_finished: boolean; result: AccusationResult | null } | null;
  [key: string]: unknown;
}
export interface TraceRecord {
  id: string; content: string; agentId: string | null;
  parentIds: string[]; declaredRefs: string[]; suggestedEvidence: { id: string; outcome: string }[];
  details: Record<string, unknown>;
}
export interface BeliefTrace {
  targetId: string; records: TraceRecord[]; missingParentIds: string[]; truncated: boolean;
  lines: {
    transmitted: { from: string; to: string; sender: string; receiver: string; messageId: string }[];
    declared: { from: string; to: string }[];
    discovered: { from: string; to: string; outcome: "SUPPORT" | "COUNTEREXAMPLE" }[];
  };
}
export interface AccusationResult {
  turn?: number;
  correct: boolean; reason: string; elapsed: number; penalty_seconds: number;
  swarm_turns: number | null; winner: string | null; state: StateResponse;
}
export interface SwarmMessage { id: string; type: string; turn: number; from_agent_id?: string; from_agent?: string; sender_agent_id?: string; belief_id?: string; recipient_agent_ids?: string[]; [key: string]: unknown }
export interface StoryEvent { id: string; turn: number; kind: string; agent_id: string; belief_id: string | null; content: string }
