import { ArrowUpRight, Bell, Box, Check, ChevronDown, Compass, Download, FileJson, Fingerprint, Image as ImageIcon, Info, Search, Shield, Wind, X, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CardMetric, MemberCognition, Paradigm } from "../types";
import { Wildling, WILDLING_COLORS, WILDLING_NAMES } from "./Wildling";
import { cognitionLabel } from "../cognition";
import { cardMetricLabels } from "../card-metrics";
import { resolveCooperationCard } from "../cooperation-deck";
import { resolveEndingInsights, type EndingInsights } from "../ending-insights";
import { RelicStage, RELIC_THEMES, type RelicStageHandle } from "./RelicStage";
import "../ending-b.css";
import "../cognition-feedback.css";

export const ENDING_COLORS: Record<string, string> = Object.fromEntries(Object.entries(RELIC_THEMES).map(([name, theme]) => [name, theme.color]));
const endingIcons = { "慎信部落": Search, "敲锣部落": Bell, "走远部落": Compass, "胆小部落": Shield, "健忘部落": Fingerprint, "糊涂部落": Wind };
export const CHOICE_LABELS: Record<string, Record<string, string>> = {
  D1: { A: "话最多的", B: "最孤僻的", C: "随便挑", D: "让它自己挑" },
  D2: { A: "敲锣", B: "再试一次", C: "划掉", D: "算了" },
  D3: { A: "换个地方再试", B: "三个人才算", C: "自己先试", D: "不定规矩" },
  D4: { A: "够了", B: "更挑剔", C: "必须跨区", D: "轮流把关" }
};
const themeFor = (name: string) => RELIC_THEMES[name] || RELIC_THEMES["慎信部落"];
const serialFor = (paradigm: Paradigm) => paradigm.id?.slice(-8).toUpperCase() || `SEED ${paradigm.seed ?? "?"}`;
export const ENDING_ART: Record<string, { slug: string; title: string; detail: string; paper: string }> = {
  "慎信部落": { slug: "witness", title: "核对之后，再相信", detail: "记录、对照与共同确认", paper: "#edf5f0" },
  "敲锣部落": { slug: "alarm", title: "让疑问被所有人听见", detail: "信号、集结与公开质疑", paper: "#fbf1dd" },
  "走远部落": { slug: "pathfinder", title: "答案，也许在另一片荒野", detail: "足迹、边界与跨区求证", paper: "#ecf1f8" },
  "胆小部落": { slug: "shelter", title: "在庇护与探索之间", detail: "避风处、谨慎与行动边界", paper: "#f2edf6" },
  "健忘部落": { slug: "forgetful", title: "记住的，和再次遗失的", detail: "旧纸页、回声与记忆缺口", paper: "#f7ece9" },
  "糊涂部落": { slug: "confused", title: "还没有拼好的那张地图", detail: "岔路、疑问与未解之处", paper: "#f1f2e8" }
};
const artFor = (name: string) => ENDING_ART[name] || ENDING_ART["慎信部落"];
const artworkFor = (name: string) => `/b/art/endings-v2/${artFor(name).slug}.png`;
const timelineTime = (point: EndingInsights["attacks"][number]["points"][number]) => `${point.turn == null ? "绝对回合未记录" : `T${point.turn}`}${point.elapsedTurns == null ? "" : ` · 注入后 ${point.elapsedTurns} 回合`}`;
const factTime = (point: EndingInsights["attacks"][number]["points"][number] | undefined) => point?.turn != null
  ? `T${point.turn}${point.elapsedTurns != null ? ` · 注入后${point.elapsedTurns}回合` : point.basis === "historical" ? " · 历史样本" : ""}`
  : point?.elapsedTurns != null ? `注入后${point.elapsedTurns}回合 · 绝对回合未记录` : "未记录";
const caseFacts = (attack: EndingInsights["attacks"][number]) => {
  const counter = attack.points.find(point => point.id === "counterexample");
  const discovered = attack.points.find(point => point.id === "discovery");
  const resolved = attack.points.find(point => point.id === "resolved");
  const source = attack.points.find(point => point.id === "source");
  return [{ label: counter?.label || "反例形成", value: factTime(counter) },
    { label: discovered?.label || "正式发现", value: factTime(discovered) },
    { label: resolved?.label || "规则修正", value: resolved?.label === "尚未结案" ? "尚未完成" : factTime(resolved) },
    { label: "玩家指认", value: attack.sourceConfirmed === true ? source?.turn != null ? factTime(source) : "已指认 · 回合未记录" : attack.sourceConfirmed === false ? "待指认" : "旧卡未记录" }];
};
const recordLimits = (insights: EndingInsights) => {
  const shown = new Set(insights.attacks.flatMap(attack => attack.warnings.map(warning => `第 ${attack.attackNumber} 次：${warning}`)));
  return insights.limits.filter(limit => !shown.has(limit));
};

function recordedMember(paradigm: Paradigm, agentId: string): MemberCognition | undefined {
  return Array.isArray(paradigm.memberCognition)
    ? paradigm.memberCognition.find(member => member.agentId === agentId && [1, 2, 3, 4].includes(member.stage)) : undefined;
}

export function downloadJson(paradigm: Paradigm) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(paradigm, null, 2)], { type: "application/json" }));
  download(url, `${paradigm.name}-协作协议.json`);
}
function download(url: string, name: string, revoke = true) {
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function loadImage(url: string) {
  if (!url) return Promise.resolve(null);
  return new Promise<HTMLImageElement | null>(resolve => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url;
  });
}

export async function downloadPng(paradigm: Paradigm, _sculpture?: string | null, options: { preview?: boolean; download?: boolean; presentation?: "art" | "relic" } = {}) {
  const canvas = document.createElement("canvas"); canvas.width = 1100;
  const context = canvas.getContext("2d"); if (!context) return null;
  await document.fonts.ready;
  const preview = options.preview === true;
  const route = resolveCooperationCard(paradigm);
  const theme = themeFor(paradigm.name);
  if (options.presentation === "relic" && !_sculpture) return null;
  const scene = await loadImage(options.presentation === "relic" ? _sculpture! : route?.artwork || artworkFor(paradigm.name));
  if (options.presentation === "relic" && !scene) return null;
  const draws: (() => void)[] = [];
  const text = (value: string, x: number, y: number, size = 24, color = "#35483e", weight = "400") => {
    draws.push(() => { context.font = `${weight} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`; context.fillStyle = color; context.fillText(value, x, y); });
  };
  const paragraph = (value: string, x: number, top: number, width: number, size = 24, color = "#53665c", weight = "400", maxLines = 3) => {
    context.font = `${weight} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    const lines: string[] = []; let line = "";
    for (const char of value) {
      if (context.measureText(line + char).width > width && line) { lines.push(line); line = char; }
      else line += char;
    }
    if (line) lines.push(line);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      let last = visible[maxLines - 1];
      while (last && context.measureText(last + "…").width > width) last = last.slice(0, -1);
      visible[maxLines - 1] = last + "…";
    }
    visible.forEach((value, index) => text(value, x, top + size + index * size * 1.55, size, color, weight));
    return top + visible.length * size * 1.55;
  };
  const rule = (y: number) => draws.push(() => { context.fillStyle = "#d8e1db"; context.fillRect(65, y, 970, 1); });
  // The artwork already contains its Chinese title and motto. Keep every pixel in frame.
  let y = scene ? 1100 * scene.height / scene.width : 340;
  if (scene) {
    const height = y;
    draws.push(() => context.drawImage(scene, 0, 0, 1100, height));
  } else {
    text("原画尚未载入", 65, 120, 34, "#61736a", "550");
    paragraph(route?.title || paradigm.name, 65, 162, 970, 37, "#33483c", "600", 2);
    paragraph(route?.pathLabel || artFor(paradigm.name).detail, 65, 273, 970, 22);
  }
  const footerTop = y;
  draws.push(() => { context.fillStyle = "#f8faf8"; context.fillRect(0, footerTop, 1100, canvas.height - footerTop); });
  y += 38;
  if (preview) {
    y = paragraph(route ? "协作路径预览 · 不是已达成结局" : "视觉预览 · 非本局成绩", 65, y, 970, 28, "#415d50", "600", 2) + 12;
    y = paragraph("情境作品，不含真实运行数据、成绩或认知阶位。", 65, y, 970, 22) + 22;
  } else {
    const insights = resolveEndingInsights(paradigm);
    text("本局真实结果", 65, y + 21, 21, "#64766b", "550"); y += 33;
    y = paragraph(insights.outcome.title, 65, y, 970, 40, theme.dark, "600", 2) + 8;
    y = paragraph(insights.outcome.reason, 65, y, 970, 21, "#53665c", "400", 2) + 14;
    rule(y); y += 21;
    const columns = insights.attacks.map((attack, index) => {
      const metric = index === 0 ? paradigm.metrics.attack1 : paradigm.metrics.attack2;
      const x = index === 0 ? 65 : 580;
      const value = (number: number | undefined) => Number.isFinite(number) && number! >= 0 ? String(number) : "未记录";
      let bottom = paragraph(`第${index === 0 ? "一" : "二"}案 · ${attack.statusLabel}`, x, y, 450, 25, theme.dark, "600", 2) + 12;
      bottom = paragraph(`影响 ${value(metric.spread)} / 5 人 · 错误行动 ${value(metric.bad_actions)} 次`, x, bottom, 450, 23, "#3c5044", "500", 2) + 9;
      for (const fact of caseFacts(attack)) bottom = paragraph(`${fact.label}：${fact.value}`, x, bottom, 450, 20, "#53665c", "400", 2) + 4;
      return bottom;
    });
    y = Math.max(...columns) + 24;
    if ([paradigm.metrics.attack1, paradigm.metrics.attack2].some(metric => cardMetricLabels(metric).note)) {
      y = paragraph("* 历史证据时间不是本次发现耗时；异常原始值保留在 JSON。", 65, y, 970, 20, "#9a6150", "400", 2) + 14;
    }
    rule(y); y += 18;
    text("个人成长 / 当前判断", 65, y + 22, 22, "#354b40", "600"); y += 38;
    insights.growth.forEach((member, index) => {
      const x = 65 + index * 194;
      text(`${WILDLING_NAMES[index]} · ${member.stage ? cognitionLabel(member.stage).numeral : "未记录"}`, x, y + 20, 20, WILDLING_COLORS[index], "600");
      text(member.stage ? cognitionLabel(member.stage).name : "历史阶段未知", x, y + 49, 18);
      text(member.feedback?.label ?? "当前状态未记录", x, y + 77, 17);
    }); y += 97;
    const verification = insights.values.find(value => value.id === "verification");
    if (verification) y = paragraph(`协作规矩：${verification.title}。${paradigm.protocolReview?.summary || "是否改善，仍须分别核对两案记录。"}`, 65, y, 970, 20, "#53665c", "400", 3) + 10;
    y = paragraph(insights.gaps.length ? `未竟事项：${insights.gaps.join(" ")}` : "两案规则修正与源头确认均已留存。", 65, y, 970, 20, insights.gaps.length ? "#965e4c" : "#3b7157", "400", 4) + 12;
    rule(y); y += 16;
    y = paragraph("本局两次观察，非因果证明。情境原画不代替实际调查记录。", 65, y, 970, 20, "#66776d", "400", 2) + 10;
    y = paragraph(`原分类：${paradigm.name}`, 65, y, 970, 18, "#77877d", "400", 2) + 5;
    y = paragraph(`SEED ${paradigm.seed ?? "未记录"} · TURN ${paradigm.completed_turn ?? "未记录"} · ${serialFor(paradigm)}`, 65, y, 970, 19, "#77877d", "400", 2) + 10;
  }
  text(route ? `荒野 · 伪记忆 / 协作纪念 ${String(route.number).padStart(2, "0")} / 16` : "荒野 · 伪记忆 / 部落纪念", 65, y + 27, 20, "#6b7c71");
  canvas.height = Math.ceil(y + 66);
  context.fillStyle = "#f8faf8"; context.fillRect(0, 0, canvas.width, canvas.height);
  draws.forEach(draw => draw());
  return await new Promise<string | null>(resolve => canvas.toBlob(blob => {
    if (!blob) { resolve(null); return; }
    const url = URL.createObjectURL(blob);
    if (options.download !== false) download(url, `${route?.title || paradigm.name}-${preview ? "视觉预览" : "协作纪念卡"}.png`, false);
    resolve(url);
  }, "image/png"));
}
function AttackFigure({ metric, index }: { metric: CardMetric; index: number }) {
  const labels = cardMetricLabels(metric);
  return <div className="ending-attack b-attack"><div className="b-attack-label"><span>0{index + 1}</span>第{index ? "二" : "一"}次谣言</div>
    <div className="b-spread"><strong>{metric.spread}<small>/ 5</small></strong><span>人受影响</span><div className="affected-people">{Array.from({ length: 5 }, (_, i) => <UserRound key={i} className={i < metric.spread ? "affected" : ""} />)}</div></div>
    <div className="attack-measures"><span>发现 / 争议<b>{labels.detection}</b></span><span>结案用时<b>{labels.resolution}</b></span><span>错误行动<b>{metric.bad_actions} 次</b></span></div>
    {labels.note && <p className="b-metric-note">{labels.note}</p>}
  </div>;
}

function CollaborationInsights({ insights }: { insights: EndingInsights }) {
  const limits = recordLimits(insights);
  return <>
    <section className="b-ending-insights" aria-label="本局协作价值"><div className="b-section-heading"><h3>协作留下了什么</h3><span>OBSERVED VALUE</span></div><p className="b-ending-section-note">本局两次观察，非因果证明。代价与不确定性也保留。</p><ul>{insights.values.map(value => <li key={value.id} className={`is-${value.tone}`} data-ending-value={value.id}><span>{value.tone === "positive" ? <Check size={15} /> : <Info size={15} />}</span><div><h4>{value.title}</h4><p>{value.detail}</p></div></li>)}</ul></section>
    <section className="b-ending-timelines" aria-label="两案发现时间线"><div className="b-section-heading"><h3>两案发现时间线</h3><span>CASE CHRONICLE</span></div><p className="b-ending-section-note">发现记录与原始反例的实验时间分开看。</p>{insights.attacks.map(attack => <article key={attack.attackNumber} className="b-ending-attack-timeline" data-attack-number={attack.attackNumber}><header><span>0{attack.attackNumber}</span><div><h4>第{attack.attackNumber === 1 ? "一" : "二"}案</h4><p>{attack.summary}</p></div><strong>{attack.statusLabel}</strong></header><ol>{attack.points.map(point => <li key={point.id} data-timeline-point={point.id} data-time-basis={point.basis}><span className="b-timeline-dot" /><div><strong>{point.label}</strong><time>{timelineTime(point)}</time>{point.detail !== attack.summary && <p>{point.detail}</p>}</div></li>)}</ol>{attack.warnings.map((warning, index) => <p key={index} className="b-ending-warning"><Info size={12} />{warning}</p>)}</article>)}{limits.length > 0 && <div className="b-ending-limits"><h4>记录边界</h4><ul>{limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul></div>}</section>
  </>;
}

function ResultReceipt({ paradigm, insights }: { paradigm: Paradigm; insights: EndingInsights }) {
  const value = (number: number | undefined) => Number.isFinite(number) && number! >= 0 ? number : "未记录";
  return <section className="b-card-receipt" aria-label="本局真实结果">
    <header><span>本局真实结果</span><h2>{insights.outcome.title}</h2><p>{insights.outcome.reason}</p></header>
    <div className="b-receipt-cases">{insights.attacks.map((attack, index) => {
      const metric = index === 0 ? paradigm.metrics.attack1 : paradigm.metrics.attack2;
      return <div key={attack.attackNumber} data-receipt-case={attack.attackNumber}>
        <h3>第{index === 0 ? "一" : "二"}案 <span>{attack.statusLabel}</span></h3>
        <dl><div><dt>受影响</dt><dd>{value(metric.spread)}<small> / 5 人</small></dd></div><div><dt>错误行动</dt><dd>{value(metric.bad_actions)}<small> 次</small></dd></div></dl>
      </div>;
    })}</div>
    {[paradigm.metrics.attack1, paradigm.metrics.attack2].some(metric => cardMetricLabels(metric).note) && <p className="b-receipt-warning">* 历史证据时间不是本次发现耗时，异常原始值保留在 JSON。</p>}
    <footer>本局两次观察，非因果证明。情境原画不代替实际调查记录。</footer>
  </section>;
}

function EssentialFacts({ paradigm, insights }: { paradigm: Paradigm; insights: EndingInsights }) {
  const verification = insights.values.find(value => value.id === "verification");
  return <div className="b-card-facts" data-essential-facts="true">
    <section aria-label="个人成长与当前判断"><h3>个人成长与当前判断</h3><div className="b-card-growth">{insights.growth.map((member, index) => <div key={member.agentId} data-cognition-stage={member.stage ?? "unknown"} data-member-feedback={member.feedback?.state ?? "unrecorded"}>
      <Wildling color={WILDLING_COLORS[index]} state={{ cognitionStage: member.stage ?? undefined }} size={48} />
      <strong>{WILDLING_NAMES[index]}</strong><span>{member.stage ? `${cognitionLabel(member.stage).numeral} ${cognitionLabel(member.stage).name}` : "历史阶段未记录"}</span>
      <small>{member.feedback?.label ?? "当前状态未记录"}</small>{member.feedback?.reason && <p>{member.feedback.reason}</p>}
    </div>)}</div><p>阶段保留成长履历；当前判断按具体规则复核。未记录的状态不以外形或体力补写。</p></section>
    <section aria-label="两案关键时点"><h3>两案关键时点</h3><div className="b-fact-chronicles">{insights.attacks.map(attack => <article key={attack.attackNumber}>
      <h4>第{attack.attackNumber === 1 ? "一" : "二"}案 · {attack.statusLabel}</h4><dl>{caseFacts(attack).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    </article>)}</div><p>反例形成、正式发现、规则修正与玩家指认分别记录。旧卡未分开保存时，不用其它时间补写。</p></section>
    <section aria-label="协作与未竟事项"><h3>协作与未竟事项</h3>{verification && <p><strong>{verification.title}</strong>。{paradigm.protocolReview?.summary || verification.detail}</p>}
      <ul>{insights.gaps.length ? insights.gaps.map(gap => <li className="b-fact-gap" key={gap}>{gap}</li>) : <li>两案规则修正与源头确认均已留存。</li>}</ul>
      <p>原分类：{paradigm.name}。原始分类与数据保留在 JSON。</p>
    </section>
  </div>;
}

export function EndingCard({ paradigm, onClose, onNewGame, onContinue, onInvestigate, preview = false, initialPresentation = "art" }: { paradigm: Paradigm; onClose?: () => void; onNewGame?: () => void; onContinue?: () => void; onInvestigate?: () => void; preview?: boolean; initialPresentation?: "art" | "relic" }) {
  const sculpture = useRef<RelicStageHandle>(null);
  const exportVersion = useRef(0);
  const currentCard = useRef({ paradigm, preview });
  currentCard.current = { paradigm, preview };
  const [pngPreview, setPngPreview] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [artMissing, setArtMissing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [presentation, setPresentation] = useState<"art" | "relic">(initialPresentation);
  useEffect(() => { setPresentation(initialPresentation); }, [paradigm, initialPresentation]);
  useEffect(() => () => { if (pngPreview) URL.revokeObjectURL(pngPreview); }, [pngPreview]);
  useEffect(() => {
    exportVersion.current += 1;
    setPngPreview(null); setShowJson(false); setExportError(null); setArtMissing(false); setExporting(false); setDetailsOpen(false);
    return () => { exportVersion.current += 1; };
  }, [paradigm, preview]);
  async function exportPng() {
    const version = ++exportVersion.current;
    const isCurrent = () => exportVersion.current === version && currentCard.current.paradigm === paradigm && currentCard.current.preview === preview;
    setExporting(true); setExportError(null);
    try {
      const captured = presentation === "relic" ? await sculpture.current?.capture() : null;
      if (presentation === "relic" && !captured) { if (isCurrent()) setExportError("3D勋章尚未准备好，请稍后再保存。"); return; }
      const url = await downloadPng(paradigm, captured, { preview, download: false, presentation });
      if (!isCurrent()) { if (url) URL.revokeObjectURL(url); return; }
      if (url) { download(url, `${resolveCooperationCard(paradigm)?.title || paradigm.name}-${preview ? "视觉预览" : "协作纪念卡"}.png`, false); setPngPreview(url); }
      else setExportError("图片没有生成，请再次尝试。");
    } catch { if (isCurrent()) setExportError(preview ? "预览图片生成未完成，请再次尝试。" : "图片生成未完成，JSON 协议原件仍可打开。"); }
    finally { if (isCurrent()) setExporting(false); }
  }
  const route = resolveCooperationCard(paradigm);
  const Totem = endingIcons[paradigm.name as keyof typeof endingIcons] || Fingerprint;
  const theme = themeFor(paradigm.name), art = artFor(paradigm.name);
  const insights = preview ? null : resolveEndingInsights(paradigm);
  const cost = paradigm.cost || {};
  const title = route?.title || paradigm.name;
  const number = route ? String(route.number).padStart(2, "0") : theme.number;
  return <section className={`ending-sheet b-ending-sheet b-ending-compact ${route ? "b-cooperation-sheet" : `b-ending-${art.slug}`}`} data-ending-theme={route ? `cooperation-${route.id}` : art.slug} data-cooperation-card={route?.id} data-preview={preview} aria-label={`${title}${preview ? "路径预览" : "收藏纪念卡"}`} style={{ "--ending-color": theme.color, "--ending-ink": theme.dark, "--ending-paper": route ? "#eef3f0" : art.paper } as CSSProperties}>
    <header className="b-card-masthead"><span className="b-card-brand">EVOBABY<span>WILD WORLD</span></span><span className="b-card-edition">{preview ? "路径原画" : "协作纪念"} / {number}<small>{route ? "COOPERATION / 16" : "TRIBAL ARCHIVE / 06"}</small></span>{onClose && <button className="game-icon" onClick={onClose} title="关闭部落卡" aria-label="关闭部落卡"><X size={18} /></button>}</header>
    <div className="b-card-presentation" role="group" aria-label="纪念卡呈现方式"><button type="button" aria-pressed={presentation === "art"} disabled={exporting} onClick={() => setPresentation("art")}><ImageIcon size={16} />图文纪念</button><button type="button" aria-pressed={presentation === "relic"} disabled={exporting} onClick={() => setPresentation("relic")}><Box size={16} />3D勋章</button></div>
    {preview && <div className="b-ending-preview-banner"><Info size={15} /><strong>{route ? "协作路径预览 · 不是已达成结局" : "视觉预览 · 非本局成绩"}</strong><span>不含真实运行数据</span></div>}
    {!route && <div className="b-card-heading"><div className="b-card-kicker"><Totem size={16} /><span>{theme.label}</span></div><div className="ending-title"><h2>{preview ? paradigm.name : insights?.outcome.title}</h2><span className="b-card-number">{theme.number}<small>/ 06</small></span></div>{preview && <p className="ending-tagline">{art.title}</p>}</div>}
    {presentation === "relic" ? <section className="b-card-primary-relic" data-presentation="relic" aria-label="3D勋章主舞台"><p>{preview ? `造型预览 · 非已解锁勋章${route ? " · 敲锣主题示意，与路径结果无关" : ""}` : "本局立体纪念 · 成长形态以卡片留存为准"}</p><RelicStage ref={sculpture} name={preview && route ? "敲锣部落" : paradigm.name} memberCognition={preview ? undefined : paradigm.memberCognition} /></section> : <figure className={route ? "b-cooperation-art" : "b-ending-scene"}>
      {artMissing ? <div className="b-ending-art-missing"><Totem size={28} /><strong>{title}</strong><span>原画尚未载入</span><small>{route?.pathLabel || art.detail}</small></div> : <img src={route?.artwork || artworkFor(paradigm.name)} onError={() => setArtMissing(true)} alt={route ? `协作纪念 ${number}：${route.title}。${route.motto} 路径：${route.pathLabel}。` : `${paradigm.name}主题情境：${art.detail}`} />}
      {!route && <figcaption><span className="b-ending-seal"><Totem size={23} /><b>{theme.number}</b></span><div><strong>{art.title}</strong><span>{art.detail}</span></div><small>情境插画</small></figcaption>}
    </figure>}
    {insights && <ResultReceipt paradigm={paradigm} insights={insights} />}
    {insights && <EssentialFacts paradigm={paradigm} insights={insights} />}
    {!preview && <div className="ending-downloads">{onContinue && paradigm.b_outcome?.can_continue && <button className="game-button primary" onClick={onContinue}>继续调查 <ArrowUpRight size={15} /></button>}{onInvestigate && (paradigm.b_outcome?.status === "awaiting_trace" || (paradigm.b_outcome?.pending_incident_ids.length ?? 0) > 0) && <button className="game-button primary" onClick={onInvestigate}>追查源头 <Search size={15} /></button>}</div>}
    <div className="ending-downloads"><button className="game-button primary" disabled={exporting} onClick={() => void exportPng()}><Download size={15} />{exporting ? "生成中…" : presentation === "relic" ? "3D勋章 PNG" : preview ? "原画预览 PNG" : "收藏纪念卡 PNG"}</button>{!preview && <button className="game-button" onClick={() => { setShowJson(true); setDetailsOpen(true); downloadJson(paradigm); }}><FileJson size={15} />JSON 协议</button>}</div>
    {exportError && <p className="ending-export-error" role="alert">{exportError}</p>}
    {pngPreview && <section className="ending-export-preview"><img src={pngPreview} alt={`${title}${preview ? "路径预览，非本局成绩" : "原画与真实结果"}完整导出预览`} /><p>图片已生成。是否保存到磁盘取决于当前浏览器的下载设置。</p><div><a href={pngPreview} target="_blank" rel="noreferrer">打开 PNG 原图</a><a href={pngPreview} download={`${title}-${preview ? "视觉预览" : "协作纪念卡"}.png`}>保存 PNG 文件</a></div></section>}
    {(!preview || !route) && <details className="b-ending-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary tabIndex={0}><span>{preview ? "立体造型预览" : "完整纪念档案"}<small>{preview ? "造型示意，不表示真实认知阶位" : "两案证据 · 协作规矩 · 五位同行者"}</small></span><ChevronDown size={18} /></summary>
      {presentation !== "relic" && <div className="b-sculpture-wrap"><span className="b-sculpture-eyebrow">{preview ? "造型示意 · 不表示真实认知阶位" : "部落立体纪念 · 阶位以留存记录为准"}</span>{detailsOpen && <RelicStage ref={sculpture} name={paradigm.name} memberCognition={preview ? undefined : paradigm.memberCognition} />}</div>}
      <div className="b-members b-cognition-members"><div className="ending-portraits">{(preview ? WILDLING_COLORS : []).map((color, index) => { const member = preview ? undefined : recordedMember(paradigm, `A${index + 1}`); return <div className="ending-member-stage" key={color} data-cognition-stage={preview ? "preview" : member?.stage ?? "unknown"}><Wildling color={color} size={55} state={{ cognitionStage: member?.stage }} /><strong>{WILDLING_NAMES[index]}</strong><span>{preview ? "造型预览" : member ? `${cognitionLabel(member.stage).numeral} ${cognitionLabel(member.stage).name}` : "阶段未记录"}</span></div>; })}</div><div className="b-member-caption"><span>{preview ? "五位同行者，五种身份色。" : "这一程，我们在一起。"}{!preview && <small>SEED {paradigm.seed ?? "—"} · TURN {paradigm.completed_turn ?? "—"}</small>}</span>{!preview && <span className="b-serial">{serialFor(paradigm)}</span>}</div></div>
      {!preview && <><div className="ending-choices">{(["D2", "D3"] as const).map(point => <span key={point}><small>{point}</small>{CHOICE_LABELS[point][paradigm.choices[point] || ""] || "未选择"}</span>)}</div><div className="b-result-band"><div className="b-section-heading"><h3>两次谣言之后</h3><span>ACTUAL RUN</span></div><div className="ending-comparison"><AttackFigure metric={paradigm.metrics.attack1} index={0} /><AttackFigure metric={paradigm.metrics.attack2} index={1} /></div></div>{insights && <CollaborationInsights insights={insights} />}<section className="ending-rules"><div className="b-section-heading"><h3>我们留下的规矩</h3><span>TRIBE PROTOCOL</span></div>{paradigm.rules.map((rule, i) => <p key={`${i}-${rule}`}><b>{String(i + 1).padStart(2, "0")}</b>{rule}</p>)}</section><div className="ending-cost"><span>采纳延迟 <b>{cost.adoption_delay_turns == null ? "未计量" : `${cost.adoption_delay_turns} 回合`}</b></span><span>Token 开销 <b>{cost.token_overhead_pct == null ? "未计量" : `${cost.token_overhead_pct}%`}</b></span></div></>}
      {!preview && paradigm.id && <div className="ending-qr"><img src={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}/qr`} width={72} height={72} alt="这张部落协作卡的 JSON 原件二维码" /><div><strong>把这一次协作留下来</strong><span>协议原件 · {serialFor(paradigm)}</span><a href={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}`} target="_blank" rel="noreferrer">查看 JSON 原件 <ArrowUpRight size={12} /></a></div></div>}
      {!preview && showJson && <section className="ending-export-preview"><pre>{JSON.stringify(paradigm, null, 2)}</pre>{paradigm.id && <div><a href={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}`} target="_blank" rel="noreferrer">打开 JSON 协议原件</a></div>}</section>}
    </details>}
    {!preview && onNewGame && <button className="new-tribe-link" onClick={onNewGame}>再出发，做一个不同的选择 <ArrowUpRight size={12} /></button>}
    <footer className="b-card-footer"><span>荒野 · 伪记忆</span><span>{preview ? "路径预览 / 非本局成绩" : "每一次选择，成为我们。"}</span><div className="b-card-footer-actions"><span>{number} / {route ? "16" : "06"}</span>{onClose && <button type="button" className="b-ending-close-bottom" onClick={onClose} title="关闭部落卡" aria-label="关闭部落卡（底部）"><X size={17} /></button>}</div></footer>
  </section>;
}
