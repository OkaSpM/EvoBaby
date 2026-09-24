import type { ExportResponse, GroundTruth, StateResponse } from "./types";

interface JudgeApi {
  state: () => Promise<StateResponse>;
  export: () => Promise<ExportResponse>;
}

export interface JudgeSnapshot { state: StateResponse; truth: GroundTruth | null }

export async function loadJudgeSnapshot(client: JudgeApi, reveal: boolean): Promise<JudgeSnapshot> {
  if (!reveal) return { state: await client.state(), truth: null };
  // Export produces its public state and privileged world data under one backend lock.
  const snapshot = await client.export();
  if (snapshot.state.simulation.turn !== snapshot.groundTruth.turn || snapshot.state.simulation.seed !== snapshot.groundTruth.seed) {
    throw new Error("世界真相与状态快照不一致，请重新刷新。");
  }
  return { state: snapshot.state, truth: snapshot.groundTruth };
}

export function judgeRequestIsCurrent(version: number, currentVersion: number, reveal: boolean, currentReveal: boolean) {
  return version === currentVersion && reveal === currentReveal;
}
