// Downloadable report: a self-contained .html page for one simulation, or one page covering several simulations.

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

const STYLE = `
  body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#17202e;max-width:960px;margin:2rem auto;padding:0 1rem}
  header{border-bottom:3px solid #1d5fd1;padding-bottom:.6rem;margin-bottom:1.2rem}
  h1{margin:0;font-size:1.5rem} h2{font-size:1.1rem;margin:1.6rem 0 .5rem}
  .sub{color:#5d6b7e;font-size:.85rem}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #dde3ec}
  th{background:#f3f6fb} td.n{text-align:right;font-variant-numeric:tabular-nums}
  .flag{color:#c42b1c;font-weight:700}.ok{color:#0a7a3a;font-weight:700}
  .verdict{margin:.8rem 0;padding:.6rem .9rem;border-radius:8px;font-weight:700}
  .verdict.bad{background:#fee4e2;color:#b42318}.verdict.good{background:#dcfae6;color:#067647}
  .note{background:#fff7e0;color:#7a5600;border:1px solid #f0d98a;border-radius:8px;padding:.5rem .8rem;font-size:.88rem}
  img{max-width:100%;border:1px solid #dde3ec;border-radius:8px}
  section.sim{margin-top:2rem;padding-top:.5rem;border-top:2px solid #dde3ec}
  table.sum td,table.sum th{text-align:center} table.sum td:first-child,table.sum th:first-child{text-align:left}
  footer{margin-top:2rem;color:#5d6b7e;font-size:.8rem}
  @media print{body{margin:0}h2{break-after:avoid}img{break-inside:avoid}section.sim{break-before:page}}`;
const FOOTER = `<footer>Created with the Memar Lab Brain Injury Biomechanics Platform. MPS95 and MAS95 are the 95th percentile maximum principal strain and maximum axonal strain.</footer>`;

/** Settings, prediction table, verdict, optional caution and the results figure of one simulation. */
function simulationHTML(info, thresholds, figureDataURL, notes) {
  const { settings, results, verdict } = reportRows(info, thresholds);
  const bad = results.some((r) => r[3]);
  return `<h2>Input settings</h2>
<table>${settings.map(([k, v]) => `<tr><th style="width:30%">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
<h2>Overall prediction</h2>
<table><tr><th>Metric</th><th>Predicted</th><th>Threshold</th><th>Result</th></tr>
${results.map(([k, v, t, f]) => `<tr><td>${k}</td><td class="n">${v}</td><td class="n">${t}</td><td class="${f ? "flag" : "ok"}">${f ? "Exceeded" : "Below"}</td></tr>`).join("")}</table>
<div class="verdict ${bad ? "bad" : "good"}">${esc(verdict)}</div>
${notes ? `<div class="note">${esc(notes)}</div>` : ""}
<h2>Results</h2>
<img src="${figureDataURL}" alt="Dataset distribution, overall prediction, spatial MPS and spatial MAS">`;
}

const page = (title, header, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}
</style></head><body>
<header><h1>Memar Lab Brain Injury Biomechanics Platform: Run Report</h1><div class="sub">${header}</div></header>
${inner}
${FOOTER}
</body></html>`;

/** One simulation. */
export function buildReportHTML(info, thresholds, figureDataURL, notes) {
  return page(`Report - ${info.res.simulationId}`, `Pig head impact · generated ${esc(new Date().toLocaleString())}`,
    simulationHTML(info, thresholds, figureDataURL, notes));
}

/** Several simulations: a summary table, then one section per simulation. items = [{info, figure, notes}] */
export function buildMultiReportHTML(items, thresholds) {
  const summary = items.map(({ info }) => {
    const o = info.res.overall, bad = o.MPS95_InjuryFlag || o.MAS95_InjuryFlag;
    return `<tr><td>${esc(info.res.simulationId)}</td><td class="n">${fmt(o.MPS95)}</td><td class="n">${fmt(o.MAS95)}</td>` +
      `<td>${o.MPS95_InjuryFlag ? "Yes" : "No"}</td><td>${o.MAS95_InjuryFlag ? "Yes" : "No"}</td><td class="${bad ? "flag" : "ok"}">${bad ? "Injured" : "Not Injured"}</td></tr>`;
  }).join("\n");
  const inner = `<h2>Summary of ${items.length} simulations</h2>
<table class="sum"><tr><th>SimulationID</th><th>MPS95</th><th>MAS95</th><th>MPS95 flag</th><th>MAS95 flag</th><th>Status</th></tr>
${summary}</table>
<p class="sub">Thresholds: MPS95 ${thresholds.MPS95.toFixed(2)}, MAS95 ${thresholds.MAS95.toFixed(2)}. A flag is set when the value is equal to or above its threshold.</p>
${items.map(({ info, figure, notes }) => `<section class="sim"><h2 style="margin-top:0">${esc(info.res.simulationId)}</h2>\n${simulationHTML(info, thresholds, figure, notes)}</section>`).join("\n")}`;
  return page(`Report - ${items.length} simulations`, `Pig head impact · ${items.length} simulations · generated ${esc(new Date().toLocaleString())}`, inner);
}
