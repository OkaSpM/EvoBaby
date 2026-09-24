import { Bell, Compass, Download, FileJson, Fingerprint, Search, Shield, Wind, X, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { CardMetric, Paradigm } from "../types";
import { Wildling, WILDLING_COLORS } from "./Wildling";

export const ENDING_COLORS: Record<string, string> = { "慎信部落": "#66d6bf", "敲锣部落": "#f5bc58", "走远部落": "#84bcf0", "胆小部落": "#c3aeed", "健忘部落": "#ee8f75", "糊涂部落": "#abbdb3" };
const endingIcons = { "慎信部落": Search, "敲锣部落": Bell, "走远部落": Compass, "胆小部落": Shield, "健忘部落": Fingerprint, "糊涂部落": Wind };
export const CHOICE_LABELS: Record<string, Record<string, string>> = {
  D1: { A: "话最多的", B: "最孤僻的", C: "随便挑", D: "让它自己挑" },
  D2: { A: "敲锣", B: "再试一次", C: "划掉", D: "算了" },
  D3: { A: "换个地方再试", B: "三个人才算", C: "自己先试", D: "不定规矩" },
  D4: { A: "够了", B: "更挑剔", C: "必须跨区", D: "轮流把关" }
};

export function downloadJson(paradigm: Paradigm) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(paradigm, null, 2)], { type: "application/json" }));
  download(url, `${paradigm.name}-协作协议.json`);
}
function download(url: string, name: string, revoke = true) {
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const metricText = (value: number | null | undefined, absent: string) => value == null ? absent : String(value);

export async function downloadPng(paradigm: Paradigm) {
  const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 1280;
  const context = canvas.getContext("2d"); if (!context) return;
  context.font = "24px 'PingFang SC', sans-serif";
  const ruleHeight = paradigm.rules.reduce((height, rule, index) => {
    let width = 0, lines = 1;
    for (const char of `${index + 1}. ${rule}`) {
      const advance = context.measureText(char).width;
      if (width + advance > 770) { lines += 1; width = 0; }
      width += advance;
    }
    return height + lines * 38.4 + 12;
  }, 0);
  canvas.height = Math.max(1280, Math.ceil(875 + ruleHeight + 220));
  const color = ENDING_COLORS[paradigm.name] || "#66d6bf";
  context.fillStyle = "#181c1b"; context.fillRect(0, 0, 900, canvas.height);
  context.fillStyle = color; context.fillRect(0, 0, 900, 14);
  const text = (value: string, x: number, y: number, size = 24, fill = "#e5e9e3", weight = "400") => { context.fillStyle = fill; context.font = `${weight} ${size}px 'PingFang SC', 'Microsoft YaHei', sans-serif`; context.fillText(value, x, y); };
  const wrap = (value: string, y: number, width = 770, size = 24, fill = "#bdc8bf") => {
    context.font = `${size}px 'PingFang SC', sans-serif`; let line = "";
    for (const char of value) { if (context.measureText(line + char).width > width) { text(line, 64, y, size, fill); line = char; y += size * 1.6; } else line += char; }
    if (line) { text(line, 64, y, size, fill); y += size * 1.6; }
    return y;
  };
  text("EVOBABY / TRIBE PROTOCOL", 64, 72, 18, color);
  text(paradigm.name, 60, 158, 64, "#f0f2e8", "600");
  wrap(paradigm.tagline, 212, 770, 27);
  const portraits = [...document.querySelectorAll(".ending-portraits svg")].slice(0, 5);
  await Promise.all(portraits.map(async (node, index) => {
    const clone = node.cloneNode(true) as SVGElement; clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", "140"); clone.setAttribute("height", "150");
    const source = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }); const url = URL.createObjectURL(source);
    await new Promise<void>(resolve => { const img = new Image(); img.onload = () => { context.drawImage(img, 70 + index * 150, 236, 140, 150); URL.revokeObjectURL(url); resolve(); }; img.onerror = () => { URL.revokeObjectURL(url); resolve(); }; img.src = url; });
  }));
  const choiceText = ["D2", "D3"].map(point => `${point === "D2" ? "②" : "③"} ${CHOICE_LABELS[point]?.[paradigm.choices[point as "D2" | "D3"] || ""] || "未选择"}`).join("    ");
  text(choiceText, 64, 428, 24, color);
  context.strokeStyle = "#455047"; context.beginPath(); context.moveTo(64, 460); context.lineTo(836, 460); context.stroke();
  [paradigm.metrics.attack1, paradigm.metrics.attack2].forEach((metric, index) => {
    const x = 64 + index * 405; text(`第${index ? "二" : "一"}次谣言`, x, 510, 23);
    for (let member = 0; member < 5; member++) {
      context.fillStyle = member < metric.spread ? color : "#39433d";
      context.beginPath(); context.arc(x + 18 + member * 48, 548, 10, 0, Math.PI * 2); context.fill();
      context.fillRect(x + 6 + member * 48, 562, 24, 28);
    }
    text(`${metric.spread} 人受影响`, x, 629, 29, color);
    text(`发现  ${metricText(metric.detect_turns, "观察期内未发现")}${metric.detect_turns == null ? "" : " 回合"}`, x, 674, 23);
    text(`修复  ${metricText(metric.repair_turns, "观察期内未修复")}${metric.repair_turns == null ? "" : " 回合"}`, x, 713, 23);
    text(`错误行动  ${metric.bad_actions} 次`, x, 752, 23);
  });
  text("我们留下的规矩", 64, 829, 25, color, "600");
  let y = 875;
  paradigm.rules.forEach((rule, index) => { y = wrap(`${index + 1}. ${rule}`, y, 770, 24); y += 12; });
  y = canvas.height - 200;
  wrap("适用于共享知识库、多智能体研究与核对任务。", y, 610, 20, "#9cae9f");
  const cost = paradigm.cost || {};
  wrap(`采纳延迟：${cost.adoption_delay_turns == null ? "未计量" : `${cost.adoption_delay_turns} 回合`}  ·  Token 开销：${cost.token_overhead_pct == null ? "未计量" : `${cost.token_overhead_pct}%`}`, y + 40, 610, 19, "#9cae9f");
  text(`SEED ${paradigm.seed ?? "—"}   /   由实际运行生成`, 64, canvas.height - 50, 17, "#819285");
  if (paradigm.id) await new Promise<void>(resolve => {
    const qr = new Image();
    qr.onload = () => { context.fillStyle = "#ffffff"; context.fillRect(702, canvas.height - 174, 134, 134); context.drawImage(qr, 708, canvas.height - 168, 122, 122); resolve(); };
    qr.onerror = () => resolve();
    qr.src = `/api/paradigm/cards/${encodeURIComponent(paradigm.id!)}/qr`;
  });
  return await new Promise<string | null>(resolve => canvas.toBlob(blob => {
    if (!blob) { resolve(null); return; }
    const url = URL.createObjectURL(blob);
    download(url, `${paradigm.name}-部落协作卡.png`, false);
    resolve(url);
  }, "image/png"));
}

function AttackFigure({ metric, index }: { metric: CardMetric; index: number }) {
  return <div className="ending-attack"><span>第{index ? "二" : "一"}次谣言</span><div className="affected-people">{Array.from({ length: 5 }, (_, i) => <UserRound key={i} className={i < metric.spread ? "affected" : ""} />)}</div><strong>{metric.spread}<small>人受影响</small></strong><div className="attack-measures"><span>首次发现<b>{metricText(metric.detect_turns, "观察期内未发现")}{metric.detect_turns == null ? "" : " 回合"}</b></span><span>完成修复<b>{metricText(metric.repair_turns, "观察期内未修复")}{metric.repair_turns == null ? "" : " 回合"}</b></span><span>错误行动<b>{metric.bad_actions} 次</b></span></div></div>;
}

export function EndingCard({ paradigm, onClose, onNewGame }: { paradigm: Paradigm; onClose?: () => void; onNewGame?: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function exportPng() {
    setExporting(true); setExportError(null);
    try {
      const url = await downloadPng(paradigm);
      if (url) setPreview(url); else setExportError("图片没有生成，请再次尝试。");
    } catch { setExportError("图片生成未完成，JSON 协议原件仍可打开。"); }
    finally { setExporting(false); }
  }
  const Totem = endingIcons[paradigm.name as keyof typeof endingIcons] || Fingerprint;
  const cost = paradigm.cost || {};
  return <section className="ending-sheet" style={{ "--ending-color": ENDING_COLORS[paradigm.name] || "#66d6bf" } as React.CSSProperties}>
    <header><span className="micro-label">EVOBABY / TRIBE PROTOCOL</span>{onClose && <button className="game-icon" onClick={onClose} title="关闭部落卡" aria-label="关闭部落卡"><X size={18} /></button>}</header>
    <div className="ending-title"><Totem size={32} /><h2>{paradigm.name}</h2></div><p className="ending-tagline">{paradigm.tagline}</p>
    <div className="ending-portraits">{WILDLING_COLORS.map(color => <Wildling key={color} color={color} size={86} state={{ reputation: 3 }} />)}</div>
    <div className="ending-choices">{(["D2", "D3"] as const).map(point => <span key={point}>{point === "D2" ? "②" : "③"} {CHOICE_LABELS[point][paradigm.choices[point] || ""] || "未选择"}</span>)}</div>
    <div className="ending-comparison"><AttackFigure metric={paradigm.metrics.attack1} index={0} /><AttackFigure metric={paradigm.metrics.attack2} index={1} /></div>
    <section className="ending-rules"><h3>我们留下的规矩</h3>{paradigm.rules.map((rule, i) => <p key={rule}><b>{String(i + 1).padStart(2, "0")}</b>{rule}</p>)}</section>
    <div className="ending-cost"><span>采纳延迟 <b>{cost.adoption_delay_turns == null ? "未计量" : `${cost.adoption_delay_turns} 回合`}</b></span><span>Token 开销 <b>{cost.token_overhead_pct == null ? "未计量" : `${cost.token_overhead_pct}%`}</b></span></div>
    {paradigm.id && <div className="ending-qr"><img src={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}/qr`} width={78} height={78} alt="这张部落协作卡的 JSON 原件二维码" /><div><strong>这张卡的协议原件</strong><span>二维码随当前访问地址生成</span><a href={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}`} target="_blank" rel="noreferrer">查看 JSON 原件</a></div></div>}
    <div className="ending-downloads"><button className="game-button primary" disabled={exporting} onClick={() => void exportPng()}><Download size={15} />{exporting ? "生成中…" : "生成部落卡 PNG"}</button><button className="game-button" onClick={() => { setShowJson(true); downloadJson(paradigm); }}><FileJson size={15} />JSON 协议</button></div>
    {exportError && <p className="ending-export-error" role="alert">{exportError}</p>}
    {preview && <section className="ending-export-preview"><img src={preview} alt={`${paradigm.name}部落协作卡完整导出预览`} /><p>图片已生成。是否保存到磁盘取决于当前浏览器的下载设置。</p><div><a href={preview} target="_blank" rel="noreferrer">打开 PNG 原图</a><a href={preview} download={`${paradigm.name}-部落协作卡.png`}>保存 PNG 文件</a></div></section>}
    {showJson && <section className="ending-export-preview"><pre>{JSON.stringify(paradigm, null, 2)}</pre>{paradigm.id && <div><a href={`/api/paradigm/cards/${encodeURIComponent(paradigm.id)}`} target="_blank" rel="noreferrer">打开 JSON 协议原件</a></div>}</section>}
    {onNewGame && <button className="new-tribe-link" onClick={onNewGame}>再出发，做一个不同的选择</button>}
  </section>;
}
