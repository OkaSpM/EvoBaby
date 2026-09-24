"""B tracing can revisit either case; source confirmation does not repair rules."""
from time import monotonic

from app.api.trace import TraceGame, belief_trace


class BTraceGame(TraceGame):
    def accuse_case(self, engine, incident_id, agent_id, belief_id):
        self.sync(engine)
        incident = next((item for item in engine.corruption.incidents if item.id == incident_id), None)
        if incident is None:
            raise ValueError("UNKNOWN_INCIDENT")
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
        result = {"correct": correct, "incident_id": incident.id,
                  "turn": engine.world.turn,
                  "reason": "已确认本案最初的无源记忆；持有人也是受害者，规则修复另行核验。" if correct
                  else "这不是所选案件的零号记忆；实际传递与引用声明请分别核对。",
                  "elapsed": int(monotonic() - run["started"]) + run["penalty"],
                  "penalty_seconds": run["penalty"],
                  "swarm_turns": None if incident.resolved_turn is None else incident.resolved_turn - incident.injected_turn,
                  "winner": ("tribe" if incident.resolved_turn is not None else "player") if correct else None}
        if correct:
            result.update({"agent_id": agent_id, "belief_id": belief_id,
                           "trace": belief_trace(engine, belief_id)})
            run["result"] = result
        return result

    def accuse(self, engine, agent_id, belief_id):
        if not engine.corruption.incidents:
            raise ValueError("NO_ACTIVE_TRACE")
        return self.accuse_case(engine, engine.corruption.incidents[-1].id, agent_id, belief_id)
