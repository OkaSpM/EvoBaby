import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronRight, X } from "lucide-react";
import type { StoryChapter, StorySceneDefinition, StorySceneId } from "../story-scenes";
import type { RawEvent } from "../types";
import { actionLabel, regionLabel } from "../i18n";
import { wildlingColor, wildlingName } from "./Wildling";
import "../story-b.css";

export function StoryArtwork({ scene, className = "" }: { scene: StorySceneDefinition; className?: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [scene.image]);
  return <div className={`story-artwork ${missing ? "is-unavailable" : ""} ${className}`}><img src={scene.image} alt={scene.imageAlt} decoding="async" onError={() => setMissing(true)} />{missing && <span>这一幕的画面暂未载入</span>}</div>;
}

export function StoryScene({ current, chapters, replaying, events, turn }: { current: StoryChapter; chapters: StoryChapter[]; replaying: boolean; events: RawEvent[]; turn: number }) {
  const [journalOpen, setJournalOpen] = useState(false);
  const recent = events.filter(event => event.turn <= turn && (event.type === "RETURNED_TO_BASE" || event.type === "REACTIVATED" || event.result && ["USE_MOSS", "USE_BERRY", "USE_CRYSTAL", "COLLECT"].includes(event.result.action))).slice().sort((a, b) => b.turn - a.turn).slice(0, 3);
  return <><section className="story-scene-strip" aria-label="当前荒野故事" data-story-scene={current.id}>
    <button className="story-scene-picture" onClick={() => setJournalOpen(true)} aria-label={`打开荒野手记：${current.title}`}><StoryArtwork scene={current} /><span>{current.number}<ChevronRight size={14} /></span></button>
    <div className="story-scene-copy"><div><span>{replaying ? "当时的荒野" : "荒野手记"} / {current.number}</span><button onClick={() => setJournalOpen(true)} title="打开荒野手记" aria-label="打开荒野手记"><BookOpen size={14} /><span>{chapters.length} 幕</span></button></div><p>{current.caption}</p>{recent[0] && <div className="story-latest-action"><span>亲历</span><ActionRecord event={recent[0]} /></div>}</div>
  </section>{journalOpen && <StoryJournal chapters={chapters} initialId={current.id} replaying={replaying} recent={recent} onClose={() => setJournalOpen(false)} />}</>;
}

function ActionRecord({ event }: { event: RawEvent }) {
  const effect = event.result?.resource_effect || 0;
  const action = event.type === "RETURNED_TO_BASE" ? "回到基地" : event.type === "REACTIVATED" ? "重新出发" : actionLabel[event.result?.action || ""] || "留下观察";
  return <div className="story-action-record"><time>T{event.turn}</time><i style={{ background: wildlingColor(event.agent_id) }} /><strong>{wildlingName(event.agent_id)}</strong><span>{regionLabel[event.observation.region]} · {action}</span><b className={effect < 0 ? "negative" : ""}>{effect ? `${effect > 0 ? "+" : ""}${effect} 资源反馈` : event.result?.success === false ? "未完成" : "已完成"}</b></div>;
}

function StoryJournal({ chapters, initialId, replaying, recent, onClose }: { chapters: StoryChapter[]; initialId: StorySceneId; replaying: boolean; recent: RawEvent[]; onClose: () => void }) {
  const [selected, setSelected] = useState<StorySceneId>(initialId);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const scene = chapters.find(item => item.id === selected) || chapters.at(-1);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const targets = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  if (!scene) return null;
  return <div className="game-modal-backdrop story-journal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="story-journal" role="dialog" aria-modal="true" aria-labelledby="story-journal-title"><header><div><span>FIELD NOTES / {replaying ? "REPLAY" : "THIS JOURNEY"}</span><h2 id="story-journal-title">荒野手记</h2></div><div><small>{chapters.length} 幕已经到达</small><button className="game-icon" aria-label="关闭荒野手记" title="关闭荒野手记" onClick={onClose}><X size={18} /></button></div></header>
    <StoryArtwork scene={scene} className="story-journal-main-art" />
    <div className="story-journal-caption" aria-live="polite"><div><span>第 {scene.number} 幕 · 情境插画</span><small>{scene.recordedTurn == null ? scene.turnLabel === "等待下一次考验" ? scene.turnLabel : "已到达 · 首次回合未记录" : `${scene.turnLabel} · T${scene.recordedTurn}`}</small></div><h3>{scene.title}</h3><p>{scene.caption}</p></div>
    <nav className="story-journal-chapters" aria-label="已经到达的故事章节">{[...chapters].sort((a, b) => Number(a.number) - Number(b.number)).map(chapter => <button key={chapter.id} className={chapter.id === scene.id ? "selected" : ""} aria-current={chapter.id === scene.id ? "step" : undefined} aria-label={`查看第 ${chapter.number} 幕 ${chapter.title}`} onClick={() => setSelected(chapter.id)}><StoryArtwork scene={chapter} /><span><b>{chapter.number}</b>{chapter.title}</span></button>)}</nav>
    {recent.length > 0 && <section className="story-recent-actions" aria-label="当前时刻最近的实际行动"><h4>{replaying ? "当时最近的亲历" : "最近的亲历"}<small>实际记录，不是插画情节</small></h4>{recent.map(event => <ActionRecord key={event.event_id} event={event} />)}</section>}
    <footer>{replaying ? "只收录这一历史时刻之前的经历" : "只收录本次旅程已经到达的章节"} · 翻阅不改变世界进度</footer>
  </section></div>;
}
