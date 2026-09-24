import type { ChoiceOption, Paradigm } from "./types";

export interface CooperationCard {
  id: string;
  number: number;
  title: string;
  motto: string;
  d2: ChoiceOption;
  d3: ChoiceOption;
  pathLabel: string;
  artwork: string;
}

const responses = { A: "敲锣", B: "再试一次", C: "划掉", D: "算了" };
const verification = { A: "换个地方再试", B: "三个人才算", C: "自己先试", D: "不定规矩" };
const stories: [ChoiceOption, ChoiceOption, string, string][] = [
  ["A", "A", "先敲锣，再问雨", "把警觉传给同伴，把答案交给不同的现场。"],
  ["A", "B", "三票，不等于真相", "一起听见疑问，也要问清答案从哪里来。"],
  ["A", "C", "警觉之后，亲手求证", "同伴的提醒是起点，自己的经历才是依据。"],
  ["A", "D", "锣声散后", "警报会过去，留下来的规矩才能接住下一次。"],
  ["B", "A", "走到别处再试", "一次不够，就换一片天空继续追问。"],
  ["B", "B", "把答案交给三个人", "多一份亲历，才多一份值得核对的声音。"],
  ["B", "C", "亲历，再相信", "慢一点没有关系，让每一次相信留下依据。"],
  ["B", "D", "一次求证，下一次呢", "查清眼前的事，也别让经验在明天散去。"],
  ["C", "A", "划掉之后，补上边界", "删掉一个答案，还要说明它在哪里不成立。"],
  ["C", "B", "删除之外，还要互证", "旧说法离开之后，让不同经历坐到一起。"],
  ["C", "C", "从头亲自确认", "没有现成答案，就从自己的第一份证据开始。"],
  ["C", "D", "空白的规则", "错误消失了，不代表解释已经留下。"],
  ["D", "A", "迟来的远行", "没有回应的疑问，仍值得换个地方再问。"],
  ["D", "B", "沉默之后，凑齐三票", "人数可以成为门槛，不能代替真实的来处。"],
  ["D", "C", "先别争，自己试", "当讨论停住，让一次亲历重新打开问题。"],
  ["D", "D", "风吹过，记忆未留", "没有被整理的经历，还会在下一次重演。"]
];

export const COOPERATION_DECK: readonly CooperationCard[] = stories.map(([d2, d3, title, motto], index) => {
  const id = `${d2}${d3}`.toLowerCase();
  return { id, number: index + 1, title, motto, d2, d3, pathLabel: `${responses[d2]} · ${verification[d3]}`, artwork: `/b/art/cooperation-v3/${id}.png` };
});

export function resolveCooperationCard(paradigm: Pick<Paradigm, "choices">): CooperationCard | null {
  return COOPERATION_DECK.find(card => card.d2 === paradigm.choices?.D2 && card.d3 === paradigm.choices?.D3) ?? null;
}

// Used only inside the labelled catalogue preview; never saved as an attained run.
export function cooperationPreview(card: CooperationCard): Paradigm {
  const unknown = { spread: 0, detect_turns: null, repair_turns: null, bad_actions: 0 };
  return {
    name: `协作路径 · ${card.title}`, totem: "", tagline: card.motto,
    choices: { D2: card.d2, D3: card.d3 },
    metrics: { attack1: { ...unknown }, attack2: { ...unknown } },
    rules: [], protocol: {}, applies_to: [], cost: { note: "路径原画预览，不含本局成绩" }
  };
}
