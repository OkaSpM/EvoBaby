"""Read-only provenance projection. Observed, declared and discovered never merge."""
from collections import deque
from time import monotonic

from app.simulation.belief_engine import evaluate_evidence


def belief_trace(engine, belief_id: str, max_records: int = 120) -> dict:
    beliefs = {item.id: item for item in engine.belief_engine.beliefs}
    evidence = {item.id: item for item in engine.belief_engine.evidence}
    messages = {item.id: item for item in engine.swarm.messages}
    events = {item.event_id: item for item in engine.event_log.events}
    if belief_id not in beliefs:
        raise KeyError(belief_id)
    records, missing, seen = [], [], set()
    lines = {"transmitted": [], "declared": [], "discovered": []}
    pending = deque([belief_id])
    while pending and len(records) < max_records:
        record_id = pending.popleft()
        if record_id in seen:
            continue
        seen.add(record_id)
        if record_id in beliefs:
            belief = beliefs[record_id]
            parents = []
            if belief.lineage:
                lineage = belief.lineage
                parents = [lineage.parent_belief_id, lineage.message_id]
                lines["transmitted"].append({
                    "from": lineage.parent_belief_id, "to": belief.id,
                    "sender": lineage.sender_agent_id, "receiver": lineage.receiver_agent_id,
                    "messageId": lineage.message_id,
                })
            discovered = []
            for case in engine.investigation.cases:
                family = (case.root_belief_id, *engine.swarm.descendants(case.root_belief_id, engine.belief_engine))
                if belief.id not in family:
                    continue
                for evidence_id in case.evidence_ids:
                    sample = evidence.get(evidence_id)
                    if not sample:
                        continue
                    outcome = evaluate_evidence(belief, sample)
                    if outcome is None:
                        continue
                    item = {"id": evidence_id, "outcome": "SUPPORT" if outcome else "COUNTEREXAMPLE"}
                    if item not in discovered:
                        discovered.append(item)
                        lines["discovered"].append({"from": evidence_id, "to": belief.id, "outcome": item["outcome"]})
            declared = list(belief.evidence_ids)
            lines["declared"].extend({"from": ref, "to": belief.id} for ref in declared)
            records.append({"id": belief.id, "content": belief.proposition,
                            "agentId": belief.owner_agent_id, "parentIds": parents,
                            "declaredRefs": declared, "suggestedEvidence": discovered,
                            "details": {"kind": "belief", "turn": belief.created_turn,
                                        "belief": belief.model_dump(mode="json")}})
            pending.extend(parents + declared + [item["id"] for item in discovered])
        elif record_id in messages:
            message = messages[record_id]
            records.append({"id": record_id, "content": f"{message.from_agent} 在篝火边分享了一条常识",
                            "agentId": message.from_agent, "parentIds": [], "declaredRefs": [],
                            "suggestedEvidence": [], "details": {"kind": "message", **message.model_dump(mode="json")}})
        elif record_id in evidence:
            sample = evidence[record_id]
            refs = list(sample.event_ids)
            lines["declared"].extend({"from": ref, "to": sample.id} for ref in refs)
            records.append({"id": record_id, "content": f"{sample.agent_id} · {sample.region.value} · {sample.weather.value} · 回合 {sample.turn}",
                            "agentId": sample.agent_id, "parentIds": [], "declaredRefs": refs,
                            "suggestedEvidence": [], "details": {"kind": "evidence", **sample.model_dump(mode="json")}})
            pending.extend(refs)
        elif record_id in events:
            event = events[record_id]
            records.append({"id": record_id, "content": f"回合 {event.turn} 的实际行动回执",
                            "agentId": event.agent_id, "parentIds": [], "declaredRefs": [],
                            "suggestedEvidence": [], "details": {"kind": "event", **event.model_dump(mode="json")}})
        else:
            missing.append(record_id)
    return {"targetId": belief_id, "records": records, "missingParentIds": missing,
            "truncated": bool(pending), "lines": lines}


class TraceGame:
    def __init__(self):
        self.rounds = {}

    def sync(self, engine):
        for incident in engine.corruption.incidents:
            self.rounds.setdefault(incident.id, {"started": monotonic(), "penalty": 0,
                                                "result": None, "attempts": 0})

    def view(self, engine) -> dict:
        self.sync(engine)
        games = []
        for incident in engine.corruption.incidents:
            run = self.rounds[incident.id]
            result = run["result"]
            games.append({"incident_id": incident.id, "attack_number": incident.attack_number,
                          "elapsed": result["elapsed"] if result else int(monotonic() - run["started"]) + run["penalty"],
                          "penalty_seconds": run["penalty"], "attempts": run["attempts"],
                          "swarm_turns": None if incident.resolved_turn is None else incident.resolved_turn - incident.injected_turn,
                          "swarm_finished": incident.resolved_turn is not None, "result": result})
        return {"active": bool(games), "rounds": games, "current": games[-1] if games else None}

    def accuse(self, engine, agent_id: str, belief_id: str) -> dict:
        self.sync(engine)
        if not engine.corruption.incidents:
            raise ValueError("NO_ACTIVE_TRACE")
        incident = engine.corruption.incidents[-1]
        run = self.rounds[incident.id]
        if run["result"]:
            return run["result"]
        belief = next((item for item in engine.belief_engine.beliefs if item.id == belief_id), None)
        if belief is None or belief.owner_agent_id != agent_id:
            raise ValueError("BELIEF_OWNER_MISMATCH")
        run["attempts"] += 1
        correct = incident.target_agent_id == agent_id and incident.root_belief_id == belief_id
        if not correct:
            run["penalty"] += 30
        result = {"correct": correct, "reason": "找到了最早出现的无源记忆；它的持有人也是受害者。" if correct else
                  "这条常识有人亲手交过，它也是受害者。" if belief.lineage else "这条常识不是本次谣言的零号来源。",
                  "elapsed": int(monotonic() - run["started"]) + run["penalty"],
                  "penalty_seconds": run["penalty"],
                  "swarm_turns": None if incident.resolved_turn is None else incident.resolved_turn - incident.injected_turn,
                  "winner": ("tribe" if incident.resolved_turn is not None else "player") if correct else None}
        if correct:
            result.update({"agent_id": agent_id, "belief_id": belief_id,
                           "trace": belief_trace(engine, belief_id)})
            run["result"] = result
        return result
