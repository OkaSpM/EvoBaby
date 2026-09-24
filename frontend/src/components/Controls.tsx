import { Bug, Eye, EyeOff, Pause, Play, RefreshCcw, RotateCw, StepForward, Zap } from "lucide-react";
import type { SimulationStatus } from "../types";

interface Props {
  simulation: SimulationStatus; busy: boolean; showTruth: boolean;
  onAction: (action: "step" | "run" | "pause" | "reset" | "newSeed" | "inject" | "injectSecond", speed?: 1 | 5 | 20) => void;
  onTruth: () => void;
}

export function Controls({ simulation, busy, showTruth, onAction, onTruth }: Props) {
  return <div className="control-bar">
    <div className="control-group primary-controls">
      <button className="button primary" onClick={() => onAction("step")} disabled={busy || simulation.running}><StepForward />单步</button>
      {!simulation.running
        ? <button className="button" onClick={() => onAction("run", simulation.speed)} disabled={busy}><Play />自动运行</button>
        : <button className="button warn" onClick={() => onAction("pause")} disabled={busy}><Pause />暂停</button>}
      <div className="speed-control" aria-label="运行速度">
        <span>速度</span>{([1, 5, 20] as const).map(speed => <button key={speed} className={simulation.speed === speed ? "active" : ""} onClick={() => onAction("run", speed)} disabled={busy}>{speed}×</button>)}
      </div>
    </div>
    <div className="control-group">
      <button className="button subtle" onClick={() => onAction("reset")} disabled={busy}><RefreshCcw />同种子重置</button>
      <button className="button subtle" onClick={() => onAction("newSeed")} disabled={busy}><RotateCw />新种子</button>
      <button className="button danger" onClick={() => onAction("inject")} disabled={busy || !simulation.canInjectFirst} title={!simulation.canInjectFirst ? "集体知识成熟后开放" : "注入一次受约束的错误记忆"}><Bug />注入错误记忆</button>
      <button className="button evolution" onClick={() => onAction("injectSecond")} disabled={busy || !simulation.canInjectSecond} title={!simulation.canInjectSecond ? "首次事故修复并形成元认知后开放" : "检验认知演化效果"}><Zap />发起第二次攻击</button>
      <button className={`button truth ${showTruth ? "active" : ""}`} onClick={onTruth}>{showTruth ? <EyeOff /> : <Eye />}{showTruth ? "隐藏真相" : "显示真相"}</button>
    </div>
  </div>;
}
