// Small 2D canvas plots. Every function draws into a rectangle of a ctx so the same code serves the
// on-screen panels and the exported "Run Results" PNG.
import { jetCSS } from "./viewer3d.js";
import { MPS95_THRESHOLD, MAS95_THRESHOLD } from "./pipeline.js";

const INK = "#1f2933", MUTED = "#6b7280", GRID = "#e5e7eb";

/** Size a canvas for the device pixel ratio and return a ctx in CSS pixels. */
export function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
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

function axes(ctx, r, xr, yr, xlabel, ylabel, title) {
  const pad = { l: 52, r: 12, t: title ? 26 : 10, b: 40 };
  const px = r.x + pad.l, py = r.y + pad.t, pw = r.w - pad.l - pad.r, ph = r.h - pad.t - pad.b;
  const X = (v) => px + ((v - xr[0]) / (xr[1] - xr[0])) * pw;
  const Y = (v) => py + ph - ((v - yr[0]) / (yr[1] - yr[0])) * ph;
  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = MUTED; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const v of niceTicks(...xr)) {
    ctx.beginPath(); ctx.moveTo(X(v), py); ctx.lineTo(X(v), py + ph); ctx.stroke();
    ctx.fillText(fmtTick(v), X(v), py + ph + 4);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of niceTicks(...yr)) {
    ctx.beginPath(); ctx.moveTo(px, Y(v)); ctx.lineTo(px + pw, Y(v)); ctx.stroke();
    ctx.fillText(fmtTick(v), px - 6, Y(v));
  }
  ctx.strokeStyle = "#9ca3af";
  ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillText(xlabel, px + pw / 2, r.y + r.h - 6);
  ctx.save();
  ctx.translate(r.x + 13, py + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(ylabel, 0, 0);
  ctx.restore();
  if (title) { ctx.font = "600 12px system-ui, sans-serif"; ctx.fillText(title, px + pw / 2, r.y + 16); }
  ctx.restore();
  return { X, Y, px, py, pw, ph };
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
  ctx.strokeStyle = "#0a66e6"; ctx.lineWidth = 1.6; ctx.beginPath();
  // decimate to ~2 points per pixel; keep min/max per bucket so peaks survive
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
  ctx.restore();
}

/** Training-dataset scatter with the user's input highlighted. dataset = {angVelMax[], angAccMax[] (rad/s2)} */
export function drawDataset(ctx, r, dataset, user) {
  const xs = dataset.angVelMax, ys = dataset.angAccMax.map((v) => v / 1000);
  const ux = user.angVelMax, uy = user.angAccMax / 1000;
  const xmax = Math.max(...xs, ux) * 1.05, ymax = Math.max(...ys, uy) * 1.05;
  const a = axes(ctx, r, [0, xmax], [0, ymax], "Angular velocity (rad/s)", "Angular acceleration (Krad/s²)", "Input compared with training dataset");
  ctx.save();
  ctx.fillStyle = "rgba(140,146,156,0.65)";
  for (let i = 0; i < xs.length; i++) { ctx.beginPath(); ctx.arc(a.X(xs[i]), a.Y(ys[i]), 2.4, 0, 7); ctx.fill(); }
  ctx.fillStyle = "#e11d1d"; ctx.strokeStyle = "#500000"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(a.X(ux), a.Y(uy), 6, 0, 7); ctx.fill(); ctx.stroke();
  // legend
  ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const lx = a.px + a.pw - 118, ly = a.py + 10;
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(lx - 6, ly - 8, 122, 40);
  ctx.fillStyle = "rgba(140,146,156,0.9)"; ctx.beginPath(); ctx.arc(lx + 4, ly + 2, 3, 0, 7); ctx.fill();
  ctx.fillStyle = INK; ctx.fillText("Training dataset", lx + 14, ly + 2);
  ctx.fillStyle = "#e11d1d"; ctx.beginPath(); ctx.arc(lx + 4, ly + 20, 4.5, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillText("User input", lx + 14, ly + 20);
  ctx.restore();
}

/** Horizontal bars for MPS95 / MAS95 against their thresholds. */
export function drawOverall(ctx, r, overall) {
  ctx.save();
  // Same layout as the desktop app: fixed 0-1 axis, dashed threshold line, red/green bar.
  const rows = [
    ["MPS95", overall.MPS95, MPS95_THRESHOLD],
    ["MAS95", overall.MAS95, MAS95_THRESHOLD],
  ];
  const left = r.x + 16, width = r.w - 32;
  let y = r.y + 14;
  ctx.font = "600 12px system-ui, sans-serif"; ctx.textBaseline = "alphabetic";
  for (const [name, value, thr] of rows) {
    const flagged = value >= thr;
    const X = (v) => left + width * Math.min(1, Math.max(0, v));
    ctx.fillStyle = flagged ? "#e51a1a" : "#19a640"; ctx.textAlign = "left";
    ctx.fillText(`${name}        Predicted: ${value.toFixed(4)}`, left, y);
    y += 10;
    ctx.fillStyle = "#ececec"; ctx.fillRect(left, y, width, 22);
    ctx.fillStyle = flagged ? "#e51a1a" : "#19a640"; ctx.fillRect(left, y, X(value) - left, 22);
    ctx.strokeStyle = "#555"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(thr), y - 6); ctx.lineTo(X(thr), y + 28); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = MUTED; ctx.textAlign = "center";
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) ctx.fillText(String(t), X(t), y + 42);
    ctx.textAlign = "left"; ctx.fillStyle = INK;
    ctx.fillText(`Threshold ${thr.toFixed(2)}`, X(thr) + 4, y - 8);
    ctx.font = "600 12px system-ui, sans-serif";
    y += 78;
  }
  const flagged = overall.MPS95_InjuryFlag || overall.MAS95_InjuryFlag;
  ctx.textAlign = "left";
  ctx.fillStyle = flagged ? "#c00000" : "#0a7a24";
  ctx.fillText(flagged ? "Injury threshold exceeded: predicted injury-level response." : "No injury threshold exceeded.", left, y);
  ctx.restore();
}

/** Colour bar for a spatial view, drawn vertically at rect r. */
export function drawColorbar(ctx, r, range, label) {
  const g = ctx.createLinearGradient(0, r.y + r.h, 0, r.y);
  for (let i = 0; i <= 20; i++) g.addColorStop(i / 20, jetCSS(i / 20));
  ctx.save();
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "#9ca3af"; ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = INK; ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (const v of niceTicks(range[0], range[1], 5)) {
    const y = r.y + r.h - ((v - range[0]) / (range[1] - range[0])) * r.h;
    ctx.fillText(String(+v.toPrecision(3)), r.x + r.w + 5, y);
  }
  if (label) { ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(label, r.x + r.w / 2, r.y - 8); }
  ctx.restore();
}
