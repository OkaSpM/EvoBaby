import type { Paradigm } from "./types";

export const ENDING_CATALOG = [
  { name: "慎信部落", slug: "witness", note: "亲自核验，让相信有所依据。" },
  { name: "敲锣部落", slug: "alarm", note: "公开警觉，也可能暂停了真实常识。" },
  { name: "走远部落", slug: "pathfinder", note: "走到不同的地方，才能看清规则的边界。" },
  { name: "胆小部落", slug: "shelter", note: "挡住了谣言，却可能把探索也关在门外。" },
  { name: "健忘部落", slug: "forgetful", note: "经历过一次，不代表下一次记得住。" },
  { name: "糊涂部落", slug: "confused", note: "划掉了错误，还没有留下解释。" }
] as const;

export function endingModelPath(name: string): string | null {
  const ending = ENDING_CATALOG.find(item => item.name === name);
  return ending ? `/b/models/expanded-v2/ending-${ending.slug}.glb` : null;
}

export function endingArtworkPath(name: string): string | null {
  const ending = ENDING_CATALOG.find(item => item.name === name);
  return ending ? `/b/art/endings-v2/${ending.slug}.png` : null;
}

// This object is only passed to the explicitly labelled preview renderer. Its
// metric placeholders must never enter the saved wall, JSON, or results UI.
export function endingPreview(name: string): Paradigm {
  const ending = ENDING_CATALOG.find(item => item.name === name) ?? ENDING_CATALOG[0];
  const unknown = { spread: 0, detect_turns: null, repair_turns: null, bad_actions: 0 };
  return {
    name: ending.name, totem: "", tagline: ending.note, choices: {},
    metrics: { attack1: { ...unknown }, attack2: { ...unknown } },
    rules: [], protocol: {}, applies_to: [], cost: { note: "视觉预览，不含运行记录" }
  };
}
