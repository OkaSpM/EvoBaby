import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { caseTraceIds, resolveCaseFiles } from "./case-file";
import type { BeliefTrace, StateResponse } from "./types";

interface LoadedTraces { traces: Record<string, BeliefTrace>; error: string | null }

export function createCaseTraceLoader(fetchTrace: (id: string) => Promise<BeliefTrace>) {
  const cache = new Map<string, BeliefTrace>();
  let generation = 0;
  let activeScope = "";
  return {
    clear() { generation += 1; cache.clear(); activeScope = ""; },
    async load(scope: string, revision: string, requestedIds: string[], force = false): Promise<LoadedTraces | null> {
      if (scope !== activeScope) { cache.clear(); activeScope = scope; }
      const ticket = ++generation;
      const ids = [...new Set(requestedIds)].slice(0, 2);
      const entries = await Promise.all(ids.map(async id => {
        const key = JSON.stringify([scope, revision, id]);
        try {
          const existing = cache.get(key);
          const trace = existing && !force ? existing : await fetchTrace(id);
          if (trace.targetId !== id) throw new Error("TRACE_TARGET_MISMATCH");
          if (ticket === generation && activeScope === scope) {
            cache.delete(key); cache.set(key, trace);
            while (cache.size > 8) cache.delete(cache.keys().next().value!);
          }
          return { id, trace, failed: false };
        } catch { return { id, trace: null, failed: true }; }
      }));
      if (ticket !== generation || scope !== activeScope) return null;
      return { traces: Object.fromEntries(entries.flatMap(entry => entry.trace ? [[entry.id, entry.trace]] : [])),
        error: entries.some(entry => entry.failed) ? "部分公开行动回执暂时未能载入，可重试。" : null };
    },
  };
}

export interface UseCaseFileOptions {
  replaying: boolean; selectedCaseId?: string | null; enabled?: boolean; sessionKey?: string | number;
}

export function useCaseFile(state: StateResponse, options: UseCaseFileOptions) {
  const [loaded, setLoaded] = useState<LoadedTraces & { scope: string; caseId: string }>({ traces: {}, error: null, scope: "", caseId: "" });
  const [loading, setLoading] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const loader = useRef<ReturnType<typeof createCaseTraceLoader> | null>(null);
  if (!loader.current) loader.current = createCaseTraceLoader(api.trace);
  const session = useRef({ seed: state.simulation.seed, turn: state.simulation.turn, key: options.sessionKey,
    count: state.incidents.length, epoch: 0 });
  if (!options.replaying) {
    const prior = session.current;
    if (prior.seed !== state.simulation.seed || prior.key !== options.sessionKey || state.simulation.turn < prior.turn
      || state.incidents.length < prior.count) {
      prior.epoch += 1;
      loader.current.clear();
    }
    prior.seed = state.simulation.seed; prior.turn = state.simulation.turn;
    prior.key = options.sessionKey; prior.count = state.incidents.length;
  }
  const scope = `${state.simulation.seed}:${session.current.epoch}:${options.sessionKey ?? ""}`;
  const incident = state.incidents.find(item => item.id === options.selectedCaseId) ?? state.incidents.at(-1);
  const caseId = incident?.id ?? "";
  const ids = incident ? caseTraceIds(state, incident) : [];
  const task = state.tasks.find(item => item.id === incident?.investigationTaskId);
  const signature = JSON.stringify({ ids, status: incident?.status, resolved: incident?.resolvedTurn,
    evidence: incident?.evidenceByContext?.map(item => item.evidenceId), taskEvidence: task?.evidence_ids });
  const active = options.enabled !== false && !options.replaying && ids.length > 0;
  const lastRetry = useRef(0);
  useEffect(() => {
    let cancelled = false;
    if (!active) { setLoading(false); return; }
    const force = lastRetry.current !== retryCount;
    lastRetry.current = retryCount;
    const request = JSON.parse(signature) as { ids: string[] };
    setLoading(true);
    void loader.current!.load(scope, signature, request.ids, force).then(result => {
      if (cancelled || !result) return;
      setLoaded({ ...result, scope, caseId });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, caseId, scope, signature, retryCount]);
  const usable = !options.replaying && loaded.scope === scope && loaded.caseId === caseId;
  const retry = useCallback(() => setRetryCount(value => value + 1), []);
  return { cases: resolveCaseFiles(state, { traces: usable ? loaded.traces : {}, replaying: options.replaying }),
    loading: active && loading, error: usable ? loaded.error : null, retry };
}
