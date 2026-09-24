import { ArrowRight, Bell, Compass, Fingerprint, FlaskConical, MessageCircle, Search, Shield, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ChoiceOption, ChoicePoint, ChoicePrompt } from "../types";
import { CHOICE_STORY_SCENES, STORY_SCENES } from "../story-scenes";
import { StoryArtwork } from "./StoryScene";

const descriptions: Record<ChoicePoint, { title: string; story: string; options: [string, string, string, string][] }> = {
  D1: { title: "谣言会找上谁？", story: "一条看起来很可信的记忆，即将混进篝火边的故事。", options: [["话最多的", "挑那个最爱在篝火边讲的人", "交给分享次数最多的成员", "污染进入最活跃的知识库维护者"], ["最孤僻的", "挑那个总是一个人走的人", "交给分享与采纳最少的成员", "污染进入缺乏复核的孤岛 Agent"], ["随便挑", "谁碰上，就从谁开始", "按种子随机选择目标", "无差别的信息污染"], ["让它自己挑", "它会挑最不容易发现破绽的人", "根据已有反证筛选目标", "针对证据薄弱处的定向攻击"]] },
  D2: { title: "有人掉血了。部落怎么办？", story: "一条被大家相信的常识，和刚刚发生的事情对不上了。", options: [["敲锣", "先别用了，全部落停一停", "冻结争议常识，立刻展开调查", "全局冻结知识并启动事故调查"], ["再试一次", "你先再试两次，确定了再说", "本地复测后，再向部落广播", "上报之前先复现异常"], ["划掉", "把这条常识划掉就好了", "直接撤销，不追查原因", "删除错误知识，但不追溯根因"], ["算了", "也许只是他运气不好", "降低信心，继续使用原有流程", "把异常暂时视为噪音"]] },
  D3: { title: "这次过后，我们记住什么？", story: "一群人点头，未必意味着每个地方都试过。部落要留下一条新规矩。", options: [["换个地方再试", "人多不够，地方和天气也要不同", "要求跨场景的独立证据", "独立评审不等于独立测试场景"], ["三个人才算", "下次至少让三个人试过", "提高独立来源数量门槛", "让更多人参与复核"], ["自己先试", "别人讲的，先自己试一次", "采纳共享知识前做本地验证", "共享知识入库前先验证"], ["不定规矩", "这次只是意外，照旧吧", "保留原有验证规则", "事故后不改变协作流程"]] },
  D4: { title: "谣言还会来。门槛再抬高吗？", story: "第二条半真半假的常识即将出现。这次，部落准备好了吗？", options: [["够了", "看看刚刚定下的规矩够不够", "保持现有验证门槛", "只评估已经做出的流程改变"], ["更挑剔", "没有很大把握，就别当常识", "置信度准入门槛提高到 0.9", "提高知识准入阈值"], ["必须跨区", "只在一个地方验过的不算", "必须提交多个区域的证据", "强制多环境验证"], ["轮流把关", "每次轮一个人，专门再看一遍", "为新常识设置轮值复核", "引入轮值 Reviewer"]] }
};
const choiceIcons = [Bell, FlaskConical, Shield, Fingerprint];
const pointIcons = { D1: MessageCircle, D2: Search, D3: Compass, D4: Users };

export function ChoiceDialog({ prompt, busy, onChoose }: { prompt: ChoicePrompt; busy: boolean; onChoose: (option: ChoiceOption) => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [prompt.point]);
  const fallback = descriptions[prompt.point];
  const PointIcon = pointIcons[prompt.point];
  const scene = STORY_SCENES[CHOICE_STORY_SCENES[prompt.point]];
  return <div className="game-modal-backdrop"><section ref={dialog} className="choice-dialog story-choice-dialog" role="dialog" aria-modal="true" aria-labelledby="choice-title" onKeyDown={event => {
    if (event.key !== "Tab") return;
    const options = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
    const first = options[0], last = options.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><header><span className="micro-label">TRIBE DECISION / {prompt.point}</span><span className="choice-required">部落在等你的决定</span></header><div className="story-choice-art"><StoryArtwork scene={scene} /><span>情境插画 · {prompt.point}</span></div><div className="choice-intro"><PointIcon size={28} /><h2 id="choice-title">{prompt.title || fallback.title}</h2><p>{prompt.story || prompt.description || fallback.story}</p></div><div className="choice-options">{fallback.options.map((option, index) => {
    const key = String.fromCharCode(65 + index) as ChoiceOption;
    const fromApi = prompt.options?.find(item => (item.key || item.option) === key);
    const OptionIcon = choiceIcons[index];
    return <button type="button" className="choice-option" key={key} disabled={busy} onClick={() => onChoose(key)}><div><span className="choice-letter">{key}</span><OptionIcon size={20} /><strong>{fromApi?.title || option[0]}</strong><ArrowRight size={16} /></div><p>{fromApi?.story || option[1]}</p><span>{fromApi?.action || option[2]}</span><small>真实 AI 团队里：{fromApi?.analogy || option[3]}</small></button>;
  })}</div></section></div>;
}
