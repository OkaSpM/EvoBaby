import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUpRight, Archive, Box, GalleryHorizontalEnd } from "lucide-react";
import type { Paradigm } from "../types";
import { ENDING_CATALOG, endingArtworkPath, endingPreview } from "../ending-catalog";
import { COOPERATION_DECK, cooperationPreview, resolveCooperationCard } from "../cooperation-deck";
import { ENDING_COLORS, CHOICE_LABELS } from "./EndingCard";
import "../ending-gallery-b.css";

type SavedEnding = { id: string; date: string; seed: number; paradigm: Paradigm };
type Props = { wall: SavedEnding[]; onOpen: (paradigm: Paradigm, preview: boolean, presentation?: "art" | "relic") => void };

function EndingArtwork({ source, label }: { source: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return source && !failed
    ? <img src={source} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span className="gallery-art-fallback"><GalleryHorizontalEnd size={32} /><strong>{label}</strong><span>原画尚未载入</span></span>;
}

export function EndingGallery({ wall, onOpen }: Props) {
  const [tab, setTab] = useState<"catalog" | "records" | "relic">("catalog");
  const catalogTab = useRef<HTMLButtonElement>(null);
  const recordsTab = useRef<HTMLButtonElement>(null);
  const relicTab = useRef<HTMLButtonElement>(null);
  const collected = new Set(wall.map(item => resolveCooperationCard(item.paradigm)?.id).filter(Boolean));
  return <section className="ending-gallery cooperation-gallery" aria-label="协作路径图鉴与真实留存">
    <header className="ending-gallery-heading"><div><span className="micro-label">COOPERATION DECK / 16 PATHS</span><h2>{tab === "catalog" ? "十六张协作纪念" : tab === "relic" ? "六种 3D 勋章" : "这一程，真实留下的记录"}</h2></div><span className="ending-collected">已留存路径 <b>{collected.size}</b> / 16</span></header>
    <div className="ending-gallery-tabs" role="tablist" aria-label="纪念卡记录类型" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = ["catalog", "records", "relic"] as const;
      const next = event.key === "Home" ? "catalog" : event.key === "End" ? "relic" : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3];
      setTab(next); (next === "catalog" ? catalogTab : next === "records" ? recordsTab : relicTab).current?.focus();
    }}>
      <button ref={catalogTab} type="button" role="tab" tabIndex={tab === "catalog" ? 0 : -1} aria-selected={tab === "catalog"} aria-controls="ending-catalog-panel" id="ending-catalog-tab" onClick={() => setTab("catalog")}><GalleryHorizontalEnd size={16} />协作图鉴 <small>16</small></button>
      <button ref={recordsTab} type="button" role="tab" tabIndex={tab === "records" ? 0 : -1} aria-selected={tab === "records"} aria-controls="ending-records-panel" id="ending-records-tab" onClick={() => setTab("records")}><Archive size={16} />真实存档 <small>{wall.length}</small></button>
      <button ref={relicTab} type="button" role="tab" tabIndex={tab === "relic" ? 0 : -1} aria-selected={tab === "relic"} aria-controls="ending-relic-panel" id="ending-relic-tab" onClick={() => setTab("relic")}><Box size={16} />3D勋章 <small>6</small></button>
    </div>
    {tab === "catalog" ? <div id="ending-catalog-panel" role="tabpanel" aria-labelledby="ending-catalog-tab">
      <p className="ending-gallery-notice">16 条 D2 × D3 协作路径，不等于 16 种结局。原画是情境作品；结局与成绩以实际运行记录为准。</p>
      <div className="ending-catalog-grid">{COOPERATION_DECK.map(card => <button type="button" key={card.id} className="ending-catalog-item cooperation-catalog-item" data-cooperation-card={card.id} onClick={() => onOpen(cooperationPreview(card), true)} aria-label={`预览协作路径 ${String(card.number).padStart(2, "0")}：${card.title}`}>
        <div className="ending-catalog-art cooperation-catalog-art"><EndingArtwork source={card.artwork} label={`${card.title}。${card.motto}`} /></div>
        <div className="cooperation-catalog-caption"><span>{collected.has(card.id) ? "已有真实路径记录" : "路径原画预览"}<small>D2 {card.d2} · D3 {card.d3}</small></span><ArrowUpRight size={19} /></div>
      </button>)}</div>
    </div> : tab === "relic" ? <div id="ending-relic-panel" role="tabpanel" aria-labelledby="ending-relic-tab"><p className="ending-gallery-notice">六种立体造型预览 · 不代表本局已解锁或已通关</p><div className="ending-catalog-grid">{ENDING_CATALOG.map(ending => <button type="button" key={ending.slug} className="ending-catalog-item" onClick={() => onOpen(endingPreview(ending.name), true, "relic")} aria-label={`预览${ending.name}3D勋章`}><div className="ending-catalog-art"><EndingArtwork source={endingArtworkPath(ending.name)} label={`${ending.name}勋章主题`} /></div><div className="ending-catalog-copy"><h3><Box size={18} />{ending.name}<ArrowUpRight size={18} /></h3><span>五位同行者与立体图腾 · 造型预览</span></div></button>)}</div></div> : <div id="ending-records-panel" role="tabpanel" aria-labelledby="ending-records-tab">
      <p className="ending-gallery-notice">本浏览器保存的实际结果 · 原始协议与成绩保持不变</p>
      {wall.length ? <div className="ending-catalog-grid">{wall.map(item => {
        const route = resolveCooperationCard(item.paradigm);
        return <button type="button" key={item.id} className="ending-catalog-item ending-record-item" style={{ "--ending-color": ENDING_COLORS[item.paradigm.name] || "#80b5a4" } as CSSProperties} onClick={() => onOpen(item.paradigm, false)} aria-label={`查看${item.paradigm.name}真实记录 ${item.date}`}>
          <div className={`ending-catalog-art ${route ? "cooperation-catalog-art" : ""}`}><EndingArtwork source={route?.artwork || endingArtworkPath(item.paradigm.name)} label={route ? `${route.title}。${route.motto}` : `${item.paradigm.name}主题情境`} /></div>
          <div className="ending-catalog-copy"><span className="cooperation-record-label">真实留存 · SEED {item.seed}</span><h3>{item.paradigm.name}<ArrowUpRight size={20} /></h3><span>D2 {CHOICE_LABELS.D2[item.paradigm.choices.D2 || ""] || "未记录"} · D3 {CHOICE_LABELS.D3[item.paradigm.choices.D3 || ""] || "未记录"}</span><footer>{item.date} · T{item.paradigm.completed_turn ?? "未记录"}</footer></div>
        </button>;
      })}</div> : <div className="ending-gallery-empty"><Archive size={34} /><h3>还没有留下正式记录</h3><p>两次谣言之后，部落会留下这一程的结局。</p></div>}
    </div>}
  </section>;
}
