// Downloadable report of one run: a self-contained .html page, or a one-page A4 .pdf.
// The PDF is written directly (no library): the page is drawn on a canvas, stored as a JPEG and wrapped in a minimal PDF.

import { modelLabel } from "./models.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 4) => Number(v).toFixed(d);

/** Settings / results shown at the top of the report, as [label, value] rows. */
export function reportRows({ res, cfg }, thresholds) {
  const o = res.overall;
  const input = cfg.inputType === "PeakValues"
    ? `Peak values: ${Number(cfg.peakAcceleration).toLocaleString("en-US")} rad/s², ${Number(cfg.peakVelocity)} rad/s`
    : `${cfg.inputType === "VelocityTrace" ? "Angular velocity trace" : "Angular acceleration trace"}${cfg.fileName ? ` (${cfg.fileName})` : ""}`;
  return {
    settings: [
      ["Simulation ID", res.simulationId], ["Species", "Pig"], ["Input", input],
      ["Impact direction", cfg.direction], ["Model", modelLabel(cfg.modelType)],
    ],
    results: [
      ["MPS95", fmt(o.MPS95), thresholds.MPS95.toFixed(2), o.MPS95_InjuryFlag],
      ["MAS95", fmt(o.MAS95), thresholds.MAS95.toFixed(2), o.MAS95_InjuryFlag],
    ],
    verdict: o.MPS95_InjuryFlag || o.MAS95_InjuryFlag ? "Injury threshold exceeded: predicted injury-level response" : "No injury threshold exceeded",
  };
}

export function buildReportHTML(info, thresholds, figureDataURL, notes) {
  const { settings, results, verdict } = reportRows(info, thresholds);
  const when = new Date().toLocaleString();
  const bad = results.some((r) => r[3]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report - ${esc(info.res.simulationId)}</title>
<style>
  body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#17202e;max-width:960px;margin:2rem auto;padding:0 1rem}
  header{border-bottom:3px solid #1d5fd1;padding-bottom:.6rem;margin-bottom:1.2rem}
  h1{margin:0;font-size:1.5rem} h2{font-size:1.1rem;margin:1.6rem 0 .5rem}
  .sub{color:#5d6b7e;font-size:.85rem}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #dde3ec}
  th{background:#f3f6fb} td.n{text-align:right;font-variant-numeric:tabular-nums}
  .flag{color:#c42b1c;font-weight:700}.ok{color:#0a7a3a;font-weight:700}
  .verdict{margin:.8rem 0;padding:.6rem .9rem;border-radius:8px;font-weight:700;background:${bad ? "#fee4e2" : "#dcfae6"};color:${bad ? "#b42318" : "#067647"}}
  .note{background:#fff7e0;color:#7a5600;border:1px solid #f0d98a;border-radius:8px;padding:.5rem .8rem;font-size:.88rem}
  img{max-width:100%;border:1px solid #dde3ec;border-radius:8px}
  footer{margin-top:2rem;color:#5d6b7e;font-size:.8rem}
  @media print{body{margin:0}h2{break-after:avoid}img{break-inside:avoid}}
</style></head><body>
<header><h1>Memar Lab Brain Injury Biomechanics Platform: Run Report</h1><div class="sub">Pig head impact · generated ${esc(when)}</div></header>
<h2>Input settings</h2>
<table>${settings.map(([k, v]) => `<tr><th style="width:30%">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
<h2>Overall prediction</h2>
<table><tr><th>Metric</th><th>Predicted</th><th>Threshold</th><th>Result</th></tr>
${results.map(([k, v, t, f]) => `<tr><td>${k}</td><td class="n">${v}</td><td class="n">${t}</td><td class="${f ? "flag" : "ok"}">${f ? "Exceeded" : "Below"}</td></tr>`).join("")}</table>
<div class="verdict">${esc(verdict)}</div>
${notes ? `<div class="note">${esc(notes)}</div>` : ""}
<h2>Results</h2>
<img src="${figureDataURL}" alt="Dataset distribution, overall prediction, spatial MPS and spatial MAS">
<footer>Created with the Memar Lab Brain Injury Biomechanics Platform. MPS95 and MAS95 are the 95th percentile maximum principal strain and maximum axonal strain.</footer>
</body></html>`;
}

/** Draw the report page (A4 portrait at 150 dpi) and return the canvas. */
export function drawReportPage(info, thresholds, figureCanvas, notes) {
  const W = 1240, H = 1754, M = 70;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const { settings, results, verdict } = reportRows(info, thresholds);
  const font = (w, s) => `${w} ${s}px system-ui, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1d5fd1"; ctx.fillRect(0, 0, W, 12);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = "#17202e"; ctx.font = font(700, 32); ctx.fillText("Memar Lab Brain Injury Biomechanics Platform: Run Report", M, 80);
  ctx.fillStyle = "#5d6b7e"; ctx.font = font(400, 20); ctx.fillText(`Pig head impact · generated ${new Date().toLocaleString()}`, M, 112);

  let y = 160;
  ctx.fillStyle = "#17202e"; ctx.font = font(700, 24); ctx.fillText("Input settings", M, y); y += 14;
  ctx.font = font(400, 21);
  for (const [k, v] of settings) {
    y += 34;
    ctx.fillStyle = "#5d6b7e"; ctx.fillText(k, M, y);
    ctx.fillStyle = "#17202e"; ctx.fillText(v, M + 240, y);
  }
  // results block on the right-hand side of the settings
  const rx = W / 2 + 80;
  let ry = 160;
  ctx.fillStyle = "#17202e"; ctx.font = font(700, 24); ctx.fillText("Overall prediction", rx, ry);
  for (const [k, v, t, f] of results) {
    ry += 48;
    ctx.fillStyle = "#17202e"; ctx.font = font(700, 22); ctx.fillText(k, rx, ry);
    ctx.fillStyle = f ? "#c42b1c" : "#0a7a3a"; ctx.font = font(700, 30); ctx.fillText(v, rx + 120, ry);
    ctx.fillStyle = "#5d6b7e"; ctx.font = font(400, 18); ctx.fillText(`threshold ${t}`, rx + 290, ry);
  }
  const bad = results.some((r) => r[3]);
  y = Math.max(y, ry) + 36;
  ctx.fillStyle = bad ? "#fee4e2" : "#dcfae6"; ctx.beginPath(); ctx.roundRect(M, y, W - 2 * M, 50, 10); ctx.fill();
  ctx.fillStyle = bad ? "#b42318" : "#067647"; ctx.font = font(700, 22); ctx.textAlign = "center";
  ctx.fillText(verdict, W / 2, y + 33); ctx.textAlign = "left";
  y += 50;
  if (notes) {
    ctx.font = font(400, 17); ctx.fillStyle = "#7a5600";
    const words = notes.split(" "); let line = "";
    const lines = [];
    for (const w of words) { if (ctx.measureText(line + w).width > W - 2 * M) { lines.push(line); line = ""; } line += w + " "; }
    lines.push(line);
    y += 14;
    ctx.fillStyle = "#fff7e0"; ctx.fillRect(M, y, W - 2 * M, lines.length * 24 + 16);
    ctx.fillStyle = "#7a5600";
    lines.forEach((l, i) => ctx.fillText(l.trim(), M + 12, y + 28 + i * 24));
    y += lines.length * 24 + 16;
  }
  y += 30;

  const fw = W - 2 * M, fh = (figureCanvas.height / figureCanvas.width) * fw;
  ctx.drawImage(figureCanvas, M, y, fw, fh);
  ctx.strokeStyle = "#dde3ec"; ctx.lineWidth = 1.5; ctx.strokeRect(M, y, fw, fh);
  ctx.textAlign = "left";
  ctx.fillStyle = "#5d6b7e"; ctx.font = font(400, 16);
  ctx.fillText("Created with the Memar Lab Brain Injury Biomechanics Platform.", M, H - 40);
  return c;
}

/** Wrap one JPEG page image in a single-page A4 PDF. */
export async function pageCanvasToPDF(canvas) {
  const jpeg = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92))).arrayBuffer());
  const enc = new TextEncoder();
  const PW = 595.28, PH = 841.89;
  const parts = []; let len = 0; const offsets = [];
  const add = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; add(`${n} 0 obj\n`); add(body); add("\nendobj\n"); };
  add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  add(jpeg); add("\nendstream\nendobj\n");
  const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) add(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
