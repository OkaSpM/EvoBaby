"""Structured global broadcast with validated provenance and explicit evidence delivery."""
from app.simulation.agent import AgentState
from app.simulation.belief_engine import BeliefEngine, evaluate_evidence
from app.simulation.coordination_models import MessageIntent, MessageType, SwarmMessage, TaskType, is_open
from app.simulation.memory import Belief, BeliefStatus
from app.simulation.task_engine import TaskEngine, claim_key


class Swarm:
    def __init__(self):
        self._messages: list[SwarmMessage] = []
        self._sent: set[tuple] = set()
        self._task_versions: dict[str, int] = {}
        self._requests: dict[str, SwarmMessage] = {}
        self._published: list[str] = []
        self.broadcast_enabled = True

    @property
    def messages(self) -> tuple[SwarmMessage, ...]:
        return tuple(self._messages)

    def requests(self, tasks: TaskEngine) -> tuple[SwarmMessage, ...]:
        return tuple(message for task_id, message in self._requests.items() if is_open(tasks.get(task_id)))

    def publish_tasks(self, tasks: TaskEngine, memory: BeliefEngine, turn: int):
        if not self.broadcast_enabled:
            return
        for task in tasks.tasks:
            if not is_open(task) or self._task_versions.get(task.id) == task.last_broadcast_turn:
                continue
            belief = memory.get(task.belief_id) if task.belief_id else None
            message = SwarmMessage(id=f"M{len(self._messages) + 1}",
                                   type=MessageType.TASK_AVAILABLE if task.type == TaskType.SURVIVAL else MessageType.REQUEST_VERIFICATION,
                                   turn=turn, from_agent=belief.owner_agent_id if belief else "SYSTEM",
                                   belief_id=task.belief_id, task_id=task.id, belief=belief,
                                   needed_contexts=task.required_contexts)
            self._messages.append(message)
            self._requests[task.id] = message
            self._task_versions[task.id] = task.last_broadcast_turn

    def dispatch(self, sender: AgentState, intent: MessageIntent, agents: list[AgentState],
                 memory: BeliefEngine, tasks: TaskEngine, turn: int) -> bool:
        if not self.broadcast_enabled:
            return False
        try:
            belief = memory.get(intent.belief_id) if intent.belief_id else None
            task = tasks.get(intent.task_id) if intent.task_id else None
        except KeyError:
            return False
        evidence = next((e for e in memory.evidence_for(sender.id) if e.id == intent.evidence_id), None)
        key = (intent.type, sender.id, intent.belief_id, intent.evidence_id, intent.task_id)
        if key in self._sent:
            return False
        if intent.type == MessageType.SUBMIT_EVIDENCE:
            if evidence is None or (belief is None and task is None):
                return False
            if belief and evaluate_evidence(belief, evidence) is None:
                return False
            if belief and intent.task_id is None and evidence.id in belief.evidence_ids:
                return False
            if intent.task_id:
                if task.belief_id != intent.belief_id:
                    return False
                if not tasks.record_submission(sender, task.id, evidence, turn):
                    return False
            else:
                # Unsolicited evidence may only refer to a publicly requested claim.
                if not any(m.belief_id == intent.belief_id for m in self.requests(tasks)):
                    return False
            if (belief and evidence.id not in belief.evidence_ids
                    and evaluate_evidence(belief, evidence) is not None):
                memory.submit_evidence(belief.id, evidence.id, turn=turn)
        elif intent.type == MessageType.SHARE_BELIEF:
            if belief is None or belief.owner_agent_id != sender.id or belief.status != BeliefStatus.VERIFIED:
                return False
        elif intent.type == MessageType.RAISE_DISPUTE:
            if belief is None or belief.owner_agent_id != sender.id or belief.status != BeliefStatus.DISPUTED:
                return False
        elif intent.type == MessageType.REQUEST_VERIFICATION:
            if belief is None or belief.owner_agent_id != sender.id or belief.status != BeliefStatus.TENTATIVE:
                return False
        else:
            return False
        message = SwarmMessage(id=f"M{len(self._messages) + 1}", type=intent.type, turn=turn,
                               from_agent=sender.id, belief_id=intent.belief_id, task_id=intent.task_id,
                               evidence_id=intent.evidence_id, belief=belief, evidence=evidence)
        self._messages.append(message)
        self._sent.add(key)
        if intent.type == MessageType.SHARE_BELIEF:
            self._published.append(belief.id)
            for receiver in agents:
                if receiver.id != sender.id:
                    memory.adopt_shared(receiver, belief.id, sender_agent_id=sender.id,
                                        message_id=message.id, turn=turn)
        # Disputes are broadcast, not silently patched into other people's memories.
        return True

    def collective_knowledge(self, memory: BeliefEngine) -> tuple[Belief, ...]:
        claims = {}
        for belief_id in self._published:
            belief = memory.get(belief_id)
            if belief.status == BeliefStatus.REVOKED:
                continue
            claims.setdefault(claim_key(belief), belief)
        # A public dispute changes the collective view without rewriting private copies.
        for message in self._messages:
            if message.type == MessageType.RAISE_DISPUTE:
                belief = memory.get(message.belief_id)
                key = claim_key(belief)
                if key in claims and belief.status == BeliefStatus.DISPUTED:
                    claims[key] = belief
        return tuple(claims.values())

    def descendants(self, belief_id: str, memory: BeliefEngine) -> tuple[str, ...]:
        discovered = {belief_id}
        result = []
        for _ in range(len(memory.beliefs)):
            additions = [b.id for b in memory.beliefs if b.id not in discovered and b.lineage
                         and b.lineage.parent_belief_id in discovered]
            if not additions:
                break
            result.extend(additions)
            discovered.update(additions)
        return tuple(result)

    def root_ancestor(self, belief_id: str, memory: BeliefEngine) -> str:
        current = memory.get(belief_id)
        seen = {current.id}
        while current.lineage is not None:
            parent_id = current.lineage.parent_belief_id
            if parent_id in seen:
                raise ValueError("Belief lineage contains a cycle")
            seen.add(parent_id)
            current = memory.get(parent_id)
        return current.id

    def debug_snapshot(self, memory: BeliefEngine):
        return {"messages": [m.model_dump(mode="json") for m in self.messages],
                "collectiveKnowledge": [b.model_dump(mode="json") for b in self.collective_knowledge(memory)]}
