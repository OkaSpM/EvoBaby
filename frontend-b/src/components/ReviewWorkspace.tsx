import { ArrowRight, Compass, FlaskConical, Search } from "lucide-react";
import type { StateResponse } from "../types";
import { currentMission, type MissionAction } from "../b-session";
import { useCaseFile } from "../use-case-file";
import { CollaborationReview } from "./CollaborationReview";
import "../b-exhibition.css";

export function ReviewWorkspace({ state, replaying = false, selectedCaseId, onSelectCase, onInvestigate, onSelectAgent, sessionKey }: {
  state: StateResponse; replaying?: boolean; selectedCaseId?: string | null;
  onSelectCase?: (id: string) => void; onInvestigate?: (id?: string) => void;
  onSelectAgent?: (id: string) => void; sessionKey?: string;
}) {
  const { cases, loading, error, retry } = useCaseFile(state, { replaying, selectedCaseId, sessionKey });
  return <section className="b-review-workspace" aria-label="协作规则与实际证据">
    <CollaborationReview state={state} cases={cases} replaying={replaying} selectedCaseId={selectedCaseId}
      onSelectCase={onSelectCase} onInvestigate={onInvestigate} onSelectAgent={onSelectAgent} />
    {loading && <p className="b-review-loading" role="status">正在核对本案原始回执</p>}
    {error && <p className="b-review-loading" role="status">{error} <button onClick={retry}>重新核对</button></p>}
  </section>;
}

export function MissionBar({ state, disabled, replaying, onAction }: {
  state: StateResponse; disabled: boolean; replaying: boolean; onAction: (action: MissionAction) => void;
}) {
  const mission = currentMission(state);
  const Icon = mission.action === "investigate" ? Search : mission.action === "review" ? FlaskConical : Compass;
  return <section className="b-mission" aria-label="当前任务" data-mission={mission.action}>
    <Icon size={20} aria-hidden="true" />
    <div><span>{replaying ? "当时的调查进度" : "当前目标"}</span><strong>{mission.title}</strong><p>{mission.detail}</p></div>
    <button className="game-button" disabled={disabled || replaying || mission.action === "choose"}
      onClick={() => onAction(mission.action)}>{mission.label}<ArrowRight size={14} /></button>
  </section>;
}
