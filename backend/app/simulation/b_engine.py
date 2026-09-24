"""Opt-in B runtime. The legacy engine and executable World remain unchanged."""
from app.config import LLMConfig
from app.llm.provider import ReasoningService
from app.simulation.b_evidence import checked_effects
from app.simulation.b_feedback import BFeedbackTracker
from app.simulation.b_policy import BCooperativePolicy, BDecisionContext, BMockProvider
from app.simulation.agent import decision_context
from app.simulation.coordination_models import is_open, matches
from app.simulation.engine import SimulationEngine
from app.simulation.memory import EvidenceKind


class BSimulationEngine(SimulationEngine):
    def __init__(self, config=None):
        super().__init__(config=config, reasoning=ReasoningService(LLMConfig(mode="mock")))

    def reset(self, seed=None):
        super().reset(seed)
        self.policy = BCooperativePolicy()
        self.reasoning.mock = BMockProvider()
        self.feedback = BFeedbackTracker(agent.id for agent in self.agents)
        self.method_actions = []

    def _context(self, agent, observation):
        personal, shared = self.belief_engine.memories_for(agent)
        own_evidence = self.belief_engine.evidence_for(agent.id)
        real = checked_effects(own_evidence, self.event_log.events, self.world.turn)
        evidence = tuple(sample for sample in own_evidence
                         if sample.kind != EvidenceKind.ACTION_EFFECT or sample.id in real)
        tasks = tuple(task for task in self.task_engine.tasks if is_open(task))
        requirements = [requirement for task in tasks for requirement in task.required_contexts]
        relevant = tuple(sample for sample in evidence if sample in evidence[-24:]
                         or any(matches(requirement, sample) for requirement in requirements))
        context = decision_context(agent, observation, self.belief_engine.uncertainty_targets(agent),
                                   personal_beliefs=personal, adopted_shared_beliefs=shared,
                                   relevant_evidence=relevant,
                                   active_meta_beliefs=self.meta_belief_engine.active_beliefs,
                                   open_tasks=tasks,
                                   active_task=self.task_engine.get(agent.active_task) if agent.active_task else None,
                                   verification_requests=self.swarm.requests(self.task_engine))
        return BDecisionContext(**context.model_dump(round_trip=True), cognition_stage=self.cognition.view(agent.id).stage,
                                cognition_feedback=self.feedback.view(agent.id))

    async def _advance_async(self):
        events = await super()._advance_async()
        self.feedback.observe(self.agents, self.belief_engine, self.swarm, self.event_log.events,
                              self.world.turn, self.cognition, self.method_actions, self.task_engine)
        return events
