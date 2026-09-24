"""Deterministic physical truth. Never pass this object to an LLM provider."""

import random
from dataclasses import dataclass

from app.config import BASE, GRID_SIZE, SPAWN_PROBABILITIES, WorldConfig
from app.schemas import Action, ActionResult, BodyState, Observation, Region, Resource, Weather


@dataclass
class Cell:
    position: tuple[int, int]
    object: Resource | None = None
    respawn_at: int | None = None


def region_at(position: tuple[int, int]) -> Region:
    x, y = position
    if not (0 <= x < GRID_SIZE and 0 <= y < GRID_SIZE):
        raise ValueError("Position outside world")
    return Region(("N" if y < 4 else "S") + ("W" if x < 4 else "E"))


class World:
    def __init__(self, config: WorldConfig | None = None):
        self.config = config or WorldConfig()
        self._rng = random.Random(self.config.seed)
        self.turn = 0
        self.weather = Weather.SUNNY
        if self.config.weather_schedule:
            self.weather = Weather(self.config.weather_schedule[0])
        self.cells: dict[tuple[int, int], Cell] = {}
        for y in range(GRID_SIZE):
            for x in range(GRID_SIZE):
                position = (x, y)
                sample = self._rng.random()
                cumulative = 0.0
                resource = None
                for kind, probability in zip(Resource, SPAWN_PROBABILITIES[region_at(position)]):
                    cumulative += probability
                    if sample < cumulative:
                        resource = kind
                        break
                self.cells[position] = Cell(position, resource)
        if self.config.demo_mode:
            self._ensure_viability()

    def _ensure_viability(self):
        # Reserve minima so later repairs cannot undo an earlier guarantee.
        reserved: set[tuple[int, int]] = set()
        requirements = (
            (Resource.MOSS, 2, lambda p: region_at(p) == Region.NW),
            (Resource.MOSS, 2, lambda p: region_at(p) != Region.NW),
            (Resource.BERRY, 3, lambda p: True),
            (Resource.CRYSTAL, 2, lambda p: True),
        )
        for kind, minimum, eligible in requirements:
            existing = [p for p, c in self.cells.items() if eligible(p) and c.object == kind]
            reserved.update(existing[:minimum])
            missing = max(0, minimum - len(existing))
            candidates = [p for p, c in self.cells.items()
                          if eligible(p) and p not in reserved and c.object != kind]
            self._rng.shuffle(candidates)
            # Prefer empty cells, preserving the seeded distribution where possible.
            candidates.sort(key=lambda p: self.cells[p].object is not None)
            for position in candidates[:missing]:
                self.cells[position].object = kind
                reserved.add(position)

    def advance(self):
        """Called once at the start of each simulation turn, before actions."""
        self.turn += 1
        if self.turn % 4 == 0:
            schedule = self.config.weather_schedule
            if schedule:
                self.weather = Weather(schedule[(self.turn // 4) % len(schedule)])
            elif self._rng.random() >= 0.70:
                self.weather = Weather.RAIN if self.weather == Weather.SUNNY else Weather.SUNNY
        for cell in self.cells.values():
            if cell.respawn_at is not None and cell.respawn_at <= self.turn:
                cell.object = Resource.BERRY
                cell.respawn_at = None

    def reactivate(self, body: BodyState) -> bool:
        if body.unavailable_until_turn is not None:
            if self.turn < body.unavailable_until_turn:
                return False
            body.energy = 40
            body.unavailable_until_turn = None
        return True

    def observe(self, body: BodyState) -> Observation:
        return Observation(position=body.position, region=region_at(body.position),
                           weather=self.weather, object=self.cells[body.position].object,
                           energy=body.energy)

    @staticmethod
    def resource_effect(resource: Resource, region: Region, weather: Weather) -> int:
        """Privileged physical rule used by execution and regulator validation."""
        if resource == Resource.BERRY:
            return 10
        if resource == Resource.CRYSTAL:
            return 18
        if resource == Resource.MOSS:
            return 20 if weather == Weather.RAIN and region == Region.NW else -8
        raise ValueError("Unknown resource")

    def execute(self, body: BodyState, action: Action) -> ActionResult:
        action = Action(action)
        available = self.reactivate(body)
        before = body.energy
        position = body.position
        cell = self.cells[position]
        resource = cell.object
        cost = effect = 0
        success, reason = True, "OK"
        moves = {Action.MOVE_N: (0, -1), Action.MOVE_S: (0, 1),
                 Action.MOVE_E: (1, 0), Action.MOVE_W: (-1, 0)}
        if not available:
            success, reason = False, "UNAVAILABLE"
        elif action in moves:
            dx, dy = moves[action]
            target = (position[0] + dx, position[1] + dy)
            if target not in self.cells:
                success, reason = False, "OUT_OF_BOUNDS"
            else:
                body.position = position = target
                resource = self.cells[target].object
                cost = 1
        elif action == Action.INSPECT:
            cost = 1
        elif action == Action.COLLECT:
            if resource not in (Resource.BERRY, Resource.CRYSTAL):
                success, reason = False, "NOT_COLLECTIBLE"
            else:
                cost = 1
                body.inventory[resource] = body.inventory.get(resource, 0) + 1
                cell.object = None
                cell.respawn_at = self.turn + 3 if resource == Resource.BERRY else None
        elif action in (Action.USE_BERRY, Action.USE_CRYSTAL):
            resource = Resource.BERRY if action == Action.USE_BERRY else Resource.CRYSTAL
            if body.inventory.get(resource, 0) <= 0:
                success, reason = False, "EMPTY_INVENTORY"
            else:
                body.inventory[resource] -= 1
                effect = self.resource_effect(resource, region_at(position), self.weather)
        elif action == Action.USE_MOSS:
            if resource != Resource.MOSS:
                success, reason = False, "MOSS_NOT_PRESENT"
            else:
                effect = self.resource_effect(resource, region_at(position), self.weather)
        else:
            # Cognitive actions belong to the agent/task/swarm runtime, not physics.
            success, reason = False, "REQUIRES_AGENT_RUNTIME"
        body.energy = max(0, min(100, before - cost + effect))
        exhausted = available and body.energy <= 0
        if exhausted:
            body.position = BASE
            # Unavailable for the next three complete turns; resumes on t+4.
            body.unavailable_until_turn = self.turn + 4
        return ActionResult(turn=self.turn, agent_id=body.id, action=action,
                            position=position, region=region_at(position), weather=self.weather,
                            object=resource, success=success, reason=reason,
                            energy_before=before, energy_after=body.energy,
                            action_cost=cost, resource_effect=effect, returned_to_base=exhausted)

    def debug_snapshot(self) -> dict:
        """Privileged snapshot for tests/export. Not an agent observation."""
        return {"seed": self.config.seed, "turn": self.turn, "weather": self.weather.value,
                "base": list(BASE), "cells": [
                    {"position": list(c.position), "object": c.object.value if c.object else None,
                     "respawn_at": c.respawn_at} for c in self.cells.values()]}
