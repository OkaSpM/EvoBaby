"""Phase 1 smoke demo; no autonomous agent runtime is implied."""

from app.config import WorldConfig
from app.schemas import Action, BodyState, Resource
from app.simulation.world import World


def main():
    world = World(WorldConfig())
    position = next(p for p, c in world.cells.items() if c.object == Resource.BERRY)
    body = BodyState(id="A1", position=position)
    print("EvoBaby · 第一阶段世界引擎演示")
    print(f"世界种子：{world.config.seed}；地图：8×8；初始能量：{body.energy}")
    world.advance()
    world.execute(body, Action.COLLECT)
    print(f"第 {world.turn} 回合：采集浆果，能量 {body.energy}")
    world.execute(body, Action.USE_BERRY)
    print(f"食用浆果后能量：{body.energy}")
    for _ in range(3):
        world.advance()
        visible = "浆果已再生" if world.cells[position].object == Resource.BERRY else "资源尚未再生"
        print(f"第 {world.turn} 回合：{visible}")


if __name__ == "__main__":
    main()
