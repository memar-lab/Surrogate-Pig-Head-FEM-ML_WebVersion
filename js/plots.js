// Small 2D canvas plots. Every function draws into a rectangle of a ctx so the same code serves the
// on-screen panels and the exported "Run Results" PNG.
import { jetCSS } from "./viewer3d.js";
import { MPS95_THRESHOLD, MAS95_THRESHOLD } from "./pipeline.js";

const LIGHT = {
  ink: "#1f2933", muted: "#6b7280", grid: "#e5e7eb", axis: "#9ca3af", line: "#0a66e6",
  dot: "rgba(140,146,156,0.65)", dotLegend: "rgba(140,146,156,0.9)", legendBg: "rgba(255,255,255,0.9)",
  user: "#e11d1d", userEdge: "#500000", track: "#eceff3", marker: "#111827",
  red: "#d92d20", green: "#12a150",
  highlight: "#e8590c",
  badBg: "#fee4e2", badInk: "#b42318", okBg: "#dcfae6", okInk: "#067647",
};
const DARK = {
  ink: "#e6ebf2", muted: "#9aa7b8", grid: "#273449", axis: "#52627a", line: "#5eb0ff",
  dot: "rgba(148,163,184,0.55)", dotLegend: "rgba(148,163,184,0.9)", legendBg: "rgba(15,23,42,0.88)",
  user: "#ff4d6d", userEdge: "#ffffff", track: "#1c2a40", marker: "#e6ebf2",
  red: "#f87171", green: "#34d399",
  highlight: "#ffa94d",
  badBg: "rgba(248,113,113,0.16)", badInk: "#fca5a5", okBg: "rgba(52,211,153,0.16)", okInk: "#6ee7b7",
};
let forceLight = false;
/** Palette for the current page theme (exports always use the light palette). */
const pal = () => (!forceLight && document.documentElement.dataset.theme === "dark" ? DARK : LIGHT);
/** Run fn (synchronous drawing) with the light palette, e.g. when building a PNG for download. */
export function withLightTheme(fn) {
  forceLight = true;
  try { return fn(); } finally { forceLight = false; }
}

/** Size a canvas for the device pixel ratio and return a ctx in CSS pixels. */
export function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Fix the CSS height from the HTML attribute so resizing the bitmap never changes the layout.
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height") || "260";
  canvas.style.height = canvas.dataset.h + "px";
  const w = canvas.clientWidth || canvas.width, h = parseFloat(canvas.dataset.h);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function fmtTick(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace("e+", "e");
  return String(+v.toPrecision(4));
}

function axes(ctx, r, xr, yr, xlabel, ylabel, title, grid = true, topExtra = 0) {
  const pad = { l: 52, r: 12, t: (title ? 26 : 10) + topExtra, b: 40 };
  const px = r.x + pad.l, py = r.y + pad.t, pw = r.w - pad.l - pad.r, ph = r.h - pad.t - pad.b;
  const X = (v) => px + ((v - xr[0]) / (xr[1] - xr[0])) * pw;
  const Y = (v) => py + ph - ((v - yr[0]) / (yr[1] - yr[0])) * ph;
  const P = pal();
  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = P.muted; ctx.strokeStyle = P.grid; ctx.lineWidth = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const v of niceTicks(...xr)) {
    if (grid) { ctx.beginPath(); ctx.moveTo(X(v), py); ctx.lineTo(X(v), py + ph); ctx.stroke(); }
    ctx.fillText(fmtTick(v), X(v), py + ph + 4);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of niceTicks(...yr)) {
    if (grid) { ctx.beginPath(); ctx.moveTo(px, Y(v)); ctx.lineTo(px + pw, Y(v)); ctx.stroke(); }
    ctx.fillText(fmtTick(v), px - 6, Y(v));
  }
  ctx.strokeStyle = P.axis;
  ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle = P.ink; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillText(xlabel, px + pw / 2, r.y + r.h - 6);
  ctx.save();
  ctx.translate(r.x + 13, py + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(ylabel, 0, 0);
  ctx.restore();
  if (title) { ctx.font = "600 12px system-ui, sans-serif"; ctx.fillText(title, px + pw / 2, r.y + 16); }
  ctx.restore();
  return { X, Y, px, py, pw, ph };
}

/** Colour of the selected trace in the multi-trace preview (follows the page theme). */
export const highlightColor = () => pal().highlight;

/** Stroke one velocity trace inside the plot area, decimated to ~2 points per pixel (min/max kept per bucket). */
function strokeTrace(ctx, a, t, y) {
  ctx.beginPath();
  const buckets = Math.max(1, Math.floor(a.pw));
  if (t.length <= buckets * 2) {
    for (let i = 0; i < t.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, a.X(t[i]), a.Y(y[i]));
  } else {
    const per = t.length / buckets;
    for (let b = 0; b < buckets; b++) {
      const i0 = Math.floor(b * per), i1 = Math.min(t.length, Math.floor((b + 1) * per) + 1);
      let lo = i0, hi = i0;
      for (let i = i0; i < i1; i++) { if (y[i] < y[lo]) lo = i; if (y[i] > y[hi]) hi = i; }
      for (const i of lo < hi ? [lo, hi] : [hi, lo]) (b === 0 && i === i0 ? ctx.moveTo : ctx.lineTo).call(ctx, a.X(t[i]), a.Y(y[i]));
    }
  }
  ctx.stroke();
}

/** Several velocity traces on one set of axes: all in the usual blue, the selected one thick in a contrasting colour. traces: [{t, y, idx}] */
export function drawTraces(ctx, r, traces, active) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const { t, y } of traces) {
    xmin = Math.min(xmin, t[0]); xmax = Math.max(xmax, t[t.length - 1]);
    for (const v of y) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const padY = (ymax - ymin) * 0.06;
  const a = axes(ctx, r, [xmin, xmax], [Math.min(0, ymin - padY), ymax + padY], "Time (s)", "Angular velocity (rad/s)", `Generated velocity traces (${traces.length})`);
  ctx.save();
  ctx.beginPath(); ctx.rect(a.px, a.py, a.pw, a.ph); ctx.clip();
  ctx.lineJoin = "round";
  const ordered = [...traces.filter((tr) => tr.idx !== active), ...traces.filter((tr) => tr.idx === active)];
  for (const tr of ordered) {
    const on = tr.idx === active;
    ctx.strokeStyle = on ? pal().highlight : pal().line;
    ctx.globalAlpha = on ? 1 : 0.55;
    ctx.lineWidth = on ? 2.8 : 1.2;
    strokeTrace(ctx, a, tr.t, tr.y);
  }
  ctx.restore();
}

export function drawTrace(ctx, r, trace) {
  const t = trace.t, y = trace.y;
  let ymin = Infinity, ymax = -Infinity;
  for (const v of y) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const padY = (ymax - ymin) * 0.06;
  const a = axes(ctx, r, [t[0], t[t.length - 1]], [Math.min(0, ymin - padY), ymax + padY], "Time (s)", "Angular velocity (rad/s)", "Generated velocity trace");
  ctx.save();
  ctx.beginPath(); ctx.rect(a.px, a.py, a.pw, a.ph); ctx.clip();
  ctx.strokeStyle = pal().line; ctx.lineWidth = 1.6;
  strokeTrace(ctx, a, t, y);
  ctx.restore();
}

/** Training-dataset scatter with the user's input highlighted. dataset = {angVelMax[], angAccMax[] (rad/s2)} */
export function drawDataset(ctx, r, dataset, user) {
  const xs = dataset.angVelMax, ys = dataset.angAccMax.map((v) => v / 1000);
  const ux = user.angVelMax, uy = user.angAccMax / 1000;
  const xmax = Math.max(...xs, ux) * 1.05, ymax = Math.max(...ys, uy) * 1.05;
  const a = axes(ctx, r, [0, xmax], [0, ymax], "Angular velocity (rad/s)", "Angular acceleration (Krad/s²)", "Input compared with training dataset", false, 24);
  const P = pal();
  ctx.save();
  ctx.fillStyle = P.dot;
  for (let i = 0; i < xs.length; i++) { ctx.beginPath(); ctx.arc(a.X(xs[i]), a.Y(ys[i]), 2.4, 0, 7); ctx.fill(); }
  ctx.fillStyle = P.user; ctx.strokeStyle = P.userEdge; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(a.X(ux), a.Y(uy), 6, 0, 7); ctx.fill(); ctx.stroke();
  // legend: one row above the plot, centred
  ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const items = [["Training dataset", P.dotLegend, 3], ["User input", P.user, 4.5]];
  const gap = 22, widths = items.map(([t]) => ctx.measureText(t).width + 16);
  let lx = a.px + (a.pw - (widths[0] + widths[1] + gap)) / 2;
  const ly = r.y + 40;
  items.forEach(([text, color, rad], i) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx + 5, ly, rad, 0, 7); ctx.fill();
    if (i === 1) ctx.stroke();
    ctx.fillStyle = P.ink; ctx.fillText(text, lx + 16, ly);
    lx += widths[i] + gap;
  });
  ctx.restore();
}

/** MPS95 / MAS95 against their thresholds on a fixed 0-1 axis, plus an overall verdict. */
export function drawOverall(ctx, r, overall) {
  const rows = [
    ["MPS95", "Max. principal strain", overall.MPS95, MPS95_THRESHOLD],
    ["MAS95", "Max. axonal strain", overall.MAS95, MAS95_THRESHOLD],
  ];
  const left = r.x + 20, width = r.w - 40, barH = 26, rowH = 104, bannerH = 38;
  const total = rows.length * rowH + bannerH + 4;
  let y = r.y + Math.max(10, (r.h - total) / 2);
  const P = pal(), RED = P.red, GREEN = P.green, INK = P.ink, MUTED = P.muted;
  const X = (v) => left + width * Math.min(1, Math.max(0, v));
  const pill = (x, yy, w, h, rad) => { ctx.beginPath(); ctx.roundRect(x, yy, w, h, rad); };
  ctx.save();
  ctx.textBaseline = "alphabetic";
  for (const [name, sub, value, thr] of rows) {
    const flagged = value >= thr, col = flagged ? RED : GREEN;
    // title row: name + description on the left, predicted value on the right
    ctx.textAlign = "left"; ctx.fillStyle = INK; ctx.font = "700 15px system-ui, sans-serif";
    ctx.fillText(name, left, y + 14);
    const nameW = ctx.measureText(name).width;
    ctx.fillStyle = MUTED; ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(sub, left + nameW + 10, y + 14);
    ctx.textAlign = "right"; ctx.fillStyle = col; ctx.font = "700 22px system-ui, sans-serif";
    ctx.fillText(value.toFixed(4), left + width, y + 18);
    // bar
    const by = y + 38;
    ctx.fillStyle = P.track; pill(left, by, width, barH, barH / 2); ctx.fill();
    const fw = Math.max(barH, X(value) - left);
    if (value > 0) { ctx.fillStyle = col; pill(left, by, Math.min(fw, width), barH, barH / 2); ctx.fill(); }
    // threshold marker with its label above the bar
    ctx.strokeStyle = P.marker; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(X(thr), by - 5); ctx.lineTo(X(thr), by + barH + 5); ctx.stroke();
    ctx.font = "600 11px system-ui, sans-serif"; ctx.fillStyle = P.marker;
    const label = `Threshold ${thr.toFixed(2)}`;
    const lw = ctx.measureText(label).width;
    ctx.textAlign = "left";
    ctx.fillText(label, Math.min(Math.max(left, X(thr) - lw / 2), left + width - lw), by - 9);
    // axis ticks
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = MUTED;
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      ctx.textAlign = t === 0 ? "left" : t === 1 ? "right" : "center";
      ctx.fillText(String(t), X(t), by + barH + 20);
    }
    y += rowH;
  }
  const flagged = overall.MPS95_InjuryFlag || overall.MAS95_InjuryFlag;
  ctx.fillStyle = flagged ? P.badBg : P.okBg;
  pill(left, y, width, bannerH, 10); ctx.fill();
  ctx.fillStyle = flagged ? P.badInk : P.okInk; ctx.font = "700 13px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // use the longest wording that fits the banner (phones are narrow)
  const wording = flagged
    ? ["Injury threshold exceeded: predicted injury-level response", "Injury threshold exceeded", "Threshold exceeded"]
    : ["No injury threshold exceeded", "Below injury thresholds"];
  const text = wording.find((t) => ctx.measureText(t).width <= width - 16) || wording[wording.length - 1];
  ctx.fillText(text, left + width / 2, y + bannerH / 2);
  ctx.restore();
}

/** Colour bar for a spatial view, drawn vertically at rect r. */
export function drawColorbar(ctx, r, range, label) {
  const g = ctx.createLinearGradient(0, r.y + r.h, 0, r.y);
  for (let i = 0; i <= 20; i++) g.addColorStop(i / 20, jetCSS(i / 20));
  const P = pal();
  ctx.save();
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = P.axis; ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = P.ink; ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (const v of niceTicks(range[0], range[1], 5)) {
    const y = r.y + r.h - ((v - range[0]) / (range[1] - range[0])) * r.h;
    ctx.fillText(String(+v.toPrecision(3)), r.x + r.w + 5, y);
  }
  if (label) { ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(label, r.x + r.w / 2, r.y - 8); }
  ctx.restore();
}
