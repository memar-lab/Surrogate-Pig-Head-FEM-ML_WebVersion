// UI controller: pages, single run, results, batch mode and downloads.
import { getVelocityTrace, readPeakValuesCSV, checkPeakRange } from "./impactProfile.js";
import { ModelStore } from "./models.js";
import {
  runSimulation, overallCSV, spatialCSV, traceCSV, loadCentroids, batchConfigFor, safeFolderName,
  BATCH_SUMMARY_HEADER, MPS95_THRESHOLD, MAS95_THRESHOLD,
} from "./pipeline.js";
import { csvRow } from "./pyfmt.js";
import { FEATURE_NAMES } from "./features.js";
import { SpatialViewer, loadMeshes, MPS_RANGE, MAS_RANGE } from "./viewer3d.js";
import { prepCanvas, drawTrace, drawDataset, drawOverall, drawColorbar, withLightTheme } from "./plots.js";

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

const store = new ModelStore(fetchBuffer);
let centroidsPromise = null;
const getCentroids = () => (centroidsPromise ??= loadCentroids(fetchBuffer).catch((e) => { centroidsPromise = null; throw e; }));
let datasetPromise = null;
const getDataset = () => (datasetPromise ??= fetchJSON("data/dataset.json").catch((e) => { datasetPromise = null; throw e; }));

// ---------------------------------------------------------------- helpers
function toast(msg, isErr = false, ms = 4500) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
}
function busy(msg) {
  $("busy").hidden = !msg;
  if (msg) $("busy-msg").textContent = msg;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = "status " + (kind || "muted");
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const canvasBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const fmt6 = (v) => v.toFixed(6);

// ---------------------------------------------------------------- navigation
const state = { species: "Pig", current: null, viewers: {}, page: "species" };

function show(page) {
  state.page = page;
  $$(".page").forEach((p) => (p.hidden = p.id !== `page-${page}`));
  $$(".step").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  if (page === "input") requestAnimationFrame(redrawTrace);
  if (page === "run" && state.current) requestAnimationFrame(renderResults);
  window.scrollTo({ top: 0 });
}
$$(".step").forEach((b) => b.addEventListener("click", () => show(b.dataset.page)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => show(b.dataset.goto)));
$("to-input").addEventListener("click", () => show("input"));

// ---------------------------------------------------------------- input form
const loaded = { VelocityTrace: null, AccelerationTrace: null, PeakValues: null }; // {name, text}
let lastTrace = null;

const inputType = () => document.querySelector('input[name="itype"]:checked').value;

function updateInputMode() {
  const t = inputType();
  $$(".sub").forEach((s) => (s.hidden = s.dataset.for !== t));
  lastTrace = null;
  redrawTrace();
  setStatus($("trace-status"), "Select an input type, then Generate Trace.");
}
$$('input[name="itype"]').forEach((r) => r.addEventListener("change", updateInputMode));

async function readFileInto(input, key) {
  const f = input.files && input.files[0];
  loaded[key] = f ? { name: f.name, text: await f.text() } : null;
  lastTrace = null;
  if (key === "PeakValues" && f) {
    try {
      const p = readPeakValuesCSV(loaded[key].text);
      $("peak-acc").value = p.peakAcceleration;
      $("peak-vel").value = p.peakVelocity;
    } catch (e) { toast(e.message, true); }
  }
}
$("file-vel").addEventListener("change", (e) => readFileInto(e.target, "VelocityTrace"));
$("file-acc").addEventListener("change", (e) => readFileInto(e.target, "AccelerationTrace"));
$("file-peak").addEventListener("change", (e) => readFileInto(e.target, "PeakValues"));

function getCfg() {
  const simulationId = $("sim-id").value.trim();
  if (!simulationId) throw new Error("Simulation ID is required.");
  const type = inputType();
  const cfg = {
    simulationId, inputType: type, direction: $("direction").value, modelType: $("model").value,
    visual: $("visual").value === "ON",
  };
  if (type === "PeakValues") {
    const a = $("peak-acc").value.trim(), v = $("peak-vel").value.trim();
    if (a === "" || v === "") throw new Error("Peak acceleration and peak velocity are required.");
    cfg.peakAcceleration = Number(a);
    cfg.peakVelocity = Number(v);
    checkPeakRange(cfg.peakAcceleration, cfg.peakVelocity);
  } else {
    const f = loaded[type];
    if (!f) throw new Error("No input file was selected.");
    cfg.text = f.text;
    cfg.fileName = f.name;
  }
  return cfg;
}

function redrawTrace() {
  const canvas = $("trace-canvas");
  if (!canvas.offsetParent) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (lastTrace) drawTrace(ctx, { x: 0, y: 0, w, h }, lastTrace);
  else {
    ctx.fillStyle = "#9aa3af"; ctx.font = "13px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("No trace generated yet", w / 2, h / 2);
  }
}
window.addEventListener("resize", () => { redrawTrace(); if (state.page === "run" && state.current) drawRunPlots(); });

// ---------------------------------------------------------------- theme
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) { /* storage unavailable */ }
  redrawTrace();
  if (state.current && !$("run-body").hidden) drawRunPlots();
  Object.values(state.viewers).forEach((v) => v.setTheme(next === "dark"));
});

function generateTrace() {
  try {
    const cfg = getCfg();
    lastTrace = getVelocityTrace(cfg);
    redrawTrace();
    let peak = 0;
    for (const v of lastTrace.y) peak = Math.max(peak, Math.abs(v));
    setStatus($("trace-status"), `Trace generated. Peak velocity = ${peak.toFixed(3)} rad/s`, "ok");
  } catch (e) {
    lastTrace = null;
    redrawTrace();
    setStatus($("trace-status"), e.message, "err");
  }
}
$("gen-trace").addEventListener("click", generateTrace);

function resetForm() {
  $("sim-id").value = "SIM_001";
  document.querySelector('input[name="itype"][value="VelocityTrace"]').checked = true;
  $("direction").value = "Sagittal";
  $("model").value = "DNN";
  $("visual").value = "ON";
  $("peak-acc").value = 150000;
  $("peak-vel").value = 100;
  for (const id of ["file-vel", "file-acc", "file-peak"]) $(id).value = "";
  for (const k of Object.keys(loaded)) loaded[k] = null;
  updateInputMode();
}
$("reset-form").addEventListener("click", resetForm);
$("load-example").addEventListener("click", () => {
  document.querySelector('input[name="itype"][value="PeakValues"]').checked = true;
  $("peak-acc").value = 150000;
  $("peak-vel").value = 100;
  updateInputMode();
  generateTrace();
});

// ---------------------------------------------------------------- single run
$("run").addEventListener("click", runPrediction);

async function runPrediction() {
  let cfg;
  try { cfg = getCfg(); } catch (e) { toast(e.message, true); return; }
  try {
    busy("Reading or generating velocity trace…"); await tick();
    const trace = getVelocityTrace(cfg);
    lastTrace = trace; redrawTrace();
    busy(`Loading ${cfg.modelType} models (${cfg.direction})…`); await tick();
    const res = await runSimulation(cfg, store, { spatial: true });
    busy("Preparing result plots…"); await tick();
    const [dataset, centroids] = await Promise.all([getDataset(), getCentroids()]);
    state.current = { cfg, res, dataset, centroids, png: null };
    if (cfg.visual) {
      busy("Loading 3D meshes…"); await tick();
      state.current.meshes = await loadMeshes(fetchBuffer);
    }
    show("run");
    busy(null);
    await tick();
    renderResults();
  } catch (e) {
    busy(null);
    console.error(e);
    toast(`Backend Error: ${e.message}`, true, 9000);
  }
}

// ---------------------------------------------------------------- results page
function drawRunPlots() {
  const { res, dataset } = state.current;
  const f = res.features.byName;
  let c = $("dataset-canvas"), p = prepCanvas(c);
  drawDataset(p.ctx, { x: 0, y: 0, w: p.w, h: p.h }, dataset, { angVelMax: f.ang_vel_max, angAccMax: f.ang_acc_max });
  c = $("overall-canvas"); p = prepCanvas(c);
  drawOverall(p.ctx, { x: 0, y: 0, w: p.w, h: p.h }, res.overall);
  for (const [kind, range] of [["MPS", MPS_RANGE], ["MAS", MAS_RANGE]]) {
    const bar = $(`bar-${kind.toLowerCase()}`);
    const q = prepCanvas(bar);
    drawColorbar(q.ctx, { x: 6, y: 28, w: 16, h: q.h - 56 }, range, kind === "MPS" ? "MPS" : "MAS");
  }
}

function renderResults() {
  const cur = state.current;
  if (!cur) return;
  const { res, cfg } = cur;
  $("run-empty").hidden = true;
  $("run-body").hidden = false;
  $("run-chip").textContent = `${res.simulationId} · ${cfg.direction} · ${cfg.modelType}`;

  drawRunPlots();

  // feature table
  const tbl = $("feature-table");
  tbl.innerHTML = "";
  const head = tbl.insertRow();
  for (const h of ["Feature", "Value"]) head.insertCell().outerHTML = `<th>${h}</th>`;
  FEATURE_NAMES.forEach((name, i) => {
    const r = tbl.insertRow();
    r.insertCell().textContent = name;
    const c = r.insertCell(); c.className = "num"; c.textContent = Number(res.features.vector[i]).toPrecision(8);
  });

  // out-of-range caution (added in the web version; does not change any number)
  const f = res.features.byName, ds = cur.dataset;
  const lo = (a) => Math.min(...a), hi = (a) => Math.max(...a);
  const notes = [];
  if (f.ang_vel_max < lo(ds.angVelMax) || f.ang_vel_max > hi(ds.angVelMax))
    notes.push(`peak angular velocity ${f.ang_vel_max.toFixed(1)} rad/s is outside the training range (${lo(ds.angVelMax).toFixed(0)}–${hi(ds.angVelMax).toFixed(0)} rad/s)`);
  if (f.ang_acc_max < lo(ds.angAccMax) || f.ang_acc_max > hi(ds.angAccMax))
    notes.push(`peak angular acceleration ${Math.round(f.ang_acc_max).toLocaleString()} rad/s² is outside the training range (${Math.round(lo(ds.angAccMax)).toLocaleString()}–${Math.round(hi(ds.angAccMax)).toLocaleString()} rad/s²)`);
  if (res.overall.MPS95 < 0 || res.overall.MAS95 < 0) notes.push("a predicted strain is negative, which is not physical");
  const warn = $("range-warning");
  warn.hidden = notes.length === 0;
  if (notes.length) warn.textContent = "Caution: the surrogate is only trained on its dataset, so this prediction is an extrapolation. " + notes.join("; ") + ".";

  // 3D views
  for (const kind of ["MPS", "MAS"]) {
    const msg = $(`msg-${kind.toLowerCase()}`), host = $(`view-${kind.toLowerCase()}`);
    if (!cfg.visual) {
      host.hidden = true; $(`bar-${kind.toLowerCase()}`).hidden = true;
      setStatus(msg, "Spatial preview skipped (Visual is OFF). Spatial values are still in the downloadable CSV files.");
      continue;
    }
    host.hidden = false; $(`bar-${kind.toLowerCase()}`).hidden = false;
    setStatus(msg, "");
    try {
      if (!state.viewers[kind]) state.viewers[kind] = new SpatialViewer(host, kind, cur.meshes);
      state.viewers[kind].resize();
      state.viewers[kind].setValues(res.spatial[kind]);
    } catch (e) {
      console.error(e);
      setStatus(msg, `Could not render ${kind} preview:\n${e.message}`, "err");
    }
  }
}

$("reset-views").addEventListener("click", () => Object.values(state.viewers).forEach((v) => v.resetView()));

// PNG composites for the download
const spatialPNG = (kind) => withLightTheme(() => spatialPNGLight(kind));
const resultsPagePNG = () => withLightTheme(resultsPagePNGLight);

function spatialPNGLight(kind) {
  const v = state.viewers[kind];
  const W = 640, H = 560, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  const src = v.snapshot(), scale = Math.min((W - 110) / src.width, (H - 20) / src.height);
  ctx.drawImage(src, 8, (H - src.height * scale) / 2, src.width * scale, src.height * scale);
  drawColorbar(ctx, { x: W - 90, y: 60, w: 18, h: H - 130 }, kind === "MPS" ? MPS_RANGE : MAS_RANGE, kind);
  return canvasBlob(c);
}

function resultsPagePNGLight() {
  const { res, dataset } = state.current;
  const f = res.features.byName;
  const W = 1500, H = 1180, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1f2933"; ctx.font = "600 22px system-ui, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(`Run Results - ${res.simulationId}`, W / 2, 36);
  const cells = [[20, 56], [W / 2 + 10, 56], [20, 56 + 560], [W / 2 + 10, 56 + 560]];
  const cw = W / 2 - 30, ch = 540;
  ctx.textAlign = "left"; ctx.font = "600 15px system-ui, sans-serif";
  ["1. Dataset Distribution", "2. Overall Prediction", "3. Spatial MPS Distribution", "4. Spatial MAS Distribution"].forEach((t, i) => {
    ctx.fillStyle = "#1f2933"; ctx.fillText(t, cells[i][0], cells[i][1] + 14);
    ctx.strokeStyle = "#e1e5ea"; ctx.strokeRect(cells[i][0], cells[i][1] + 24, cw, ch - 28);
  });
  drawDataset(ctx, { x: cells[0][0], y: cells[0][1] + 24, w: cw, h: 360 }, dataset, { angVelMax: f.ang_vel_max, angAccMax: f.ang_acc_max });
  drawOverall(ctx, { x: cells[1][0], y: cells[1][1] + 40, w: cw, h: ch - 60 }, res.overall);
  [["MPS", cells[2]], ["MAS", cells[3]]].forEach(([kind, [x, y]]) => {
    const v = state.viewers[kind];
    if (!v) return;
    const src = v.snapshot(), area = { w: cw - 100, h: ch - 40 }, s = Math.min(area.w / src.width, area.h / src.height);
    ctx.drawImage(src, x + 6, y + 28 + (area.h - src.height * s) / 2, src.width * s, src.height * s);
    drawColorbar(ctx, { x: x + cw - 78, y: y + 80, w: 16, h: ch - 160 }, kind === "MPS" ? MPS_RANGE : MAS_RANGE, kind);
  });
  return canvasBlob(c);
}

$("download-zip").addEventListener("click", async () => {
  const cur = state.current;
  if (!cur) return;
  try {
    busy("Building ZIP…"); await tick();
    const { res, cfg, centroids } = cur;
    const zip = new JSZip();
    const dir = zip.folder(res.folder);
    const id = res.simulationId;
    dir.file(`${id}_OverallPredictions.csv`, overallCSV(res));
    dir.file(`${id}_SpatialMPS.csv`, spatialCSV("MPS", res.spatial.MPS, centroids));
    dir.file(`${id}_SpatialMAS.csv`, spatialCSV("MAS", res.spatial.MAS, centroids));
    dir.file(`${id}_VelocityTrace.csv`, traceCSV(res.trace));
    dir.file(`${id}_InputSettings.json`, JSON.stringify({
      simulationId: id, species: "Pig", inputType: cfg.inputType, direction: cfg.direction, modelType: cfg.modelType,
      peakAcceleration: cfg.peakAcceleration, peakVelocity: cfg.peakVelocity, inputFile: cfg.fileName,
      features: res.features.byName, thresholds: { MPS95: MPS95_THRESHOLD, MAS95: MAS95_THRESHOLD },
    }, null, 2));
    if (cfg.visual && state.viewers.MPS && state.viewers.MAS) {
      dir.file(`${id}_SpatialMPSPreview.png`, await spatialPNG("MPS"));
      dir.file(`${id}_SpatialMASPreview.png`, await spatialPNG("MAS"));
      dir.file(`${id}_RunResultsPage.png`, await resultsPagePNG());
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } });
    download(blob, `${res.folder}_results.zip`);
    busy(null);
  } catch (e) {
    busy(null);
    toast(`Could not build ZIP: ${e.message}`, true, 8000);
  }
});

// ---------------------------------------------------------------- batch mode
const batch = { files: [], zip: null, running: false };

function renderBatchList() {
  const el = $("b-list");
  if (!batch.files.length) { el.textContent = "No files selected."; $("b-run").disabled = true; return; }
  const usable = batch.files.filter((f) => !/template/i.test(f.name));
  const skipped = batch.files.length - usable.length;
  el.textContent = `${usable.length} file${usable.length === 1 ? "" : "s"} ready: ${usable.slice(0, 6).map((f) => f.name).join(", ")}${usable.length > 6 ? ", …" : ""}` +
    (skipped ? ` (${skipped} template file${skipped === 1 ? "" : "s"} skipped)` : "");
  $("b-run").disabled = batch.running || !usable.length;
}
async function addBatchFiles(fileList) {
  for (const f of fileList) {
    if (!/\.csv$/i.test(f.name)) continue;
    batch.files.push({ name: f.name, text: await f.text() });
  }
  renderBatchList();
}
$("b-files").addEventListener("change", async (e) => { await addBatchFiles(e.target.files); e.target.value = ""; });
const dz = $("dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => addBatchFiles(e.dataTransfer.files));
$("b-clear").addEventListener("click", () => {
  batch.files = []; batch.zip = null; $("b-results").hidden = true; $("b-progress").hidden = true; setStatus($("b-status"), "");
  renderBatchList();
});
$("b-example").addEventListener("click", async () => {
  try {
    $("b-type").value = "PeakValues";
    for (const n of ["SIM_001", "SIM_002", "SIM_003"]) {
      const r = await fetch(`ExampleBatchFolder/${n}.csv`);
      if (!r.ok) throw new Error(`Could not load example ${n}`);
      batch.files.push({ name: `${n}.csv`, text: await r.text() });
    }
    renderBatchList();
  } catch (e) { toast(e.message, true); }
});

$("b-run").addEventListener("click", runBatch);

async function runBatch() {
  const type = $("b-type").value, direction = $("b-direction").value, model = $("b-model").value;
  const withSpatial = $("b-spatial").checked;
  const files = batch.files.filter((f) => !/template/i.test(f.name));
  if (!files.length) return;
  batch.running = true; $("b-run").disabled = true;
  const prog = $("b-progress"); prog.hidden = false; prog.max = files.length; prog.value = 0;
  $("b-results").hidden = true;
  const zip = new JSZip(), ts = stamp();
  const rows = [], log = [];
  const used = new Set();
  let ok = 0;
  try {
    setStatus($("b-status"), `Loading ${model} models…`);
    await store.loadOverall(model, direction);
    let centroids = null;
    if (withSpatial) { await store.loadSpatial(model, direction); centroids = await getCentroids(); }
    log.push(`FEM-ML Surrogate batch run  ${new Date().toISOString()}`, `Input type   : ${type}`, `Direction    : ${direction}`, `Model type   : ${model}`, `Files        : ${files.length}`, "");

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      let id = safeFolderName(f.name.replace(/\.csv$/i, ""));
      while (used.has(id)) id += "_2";
      used.add(id);
      setStatus($("b-status"), `Running ${i + 1} of ${files.length}: ${f.name}`);
      await tick();
      const row = { SimulationID: id, InputFile: f.name, Status: "OK", ErrorMessage: "", MPS95: "", MAS95: "", f1: "", f2: "", folder: id, overall: "", smps: "", smas: "" };
      try {
        const cfg = batchConfigFor(f, type, direction, model);
        cfg.simulationId = id;
        const res = await runSimulation(cfg, store, { spatial: withSpatial });
        const dir = zip.folder(id);
        dir.file(`${id}_OverallPredictions.csv`, overallCSV(res));
        row.overall = `${id}/${id}_OverallPredictions.csv`;
        if (withSpatial) {
          dir.file(`${id}_SpatialMPS.csv`, spatialCSV("MPS", res.spatial.MPS, centroids));
          dir.file(`${id}_SpatialMAS.csv`, spatialCSV("MAS", res.spatial.MAS, centroids));
          row.smps = `${id}/${id}_SpatialMPS.csv`; row.smas = `${id}/${id}_SpatialMAS.csv`;
        }
        row.MPS95 = res.overall.MPS95; row.MAS95 = res.overall.MAS95;
        row.f1 = res.overall.MPS95_InjuryFlag ? 1 : 0; row.f2 = res.overall.MAS95_InjuryFlag ? 1 : 0;
        ok++;
        log.push(`OK    ${id.padEnd(24)} MPS95=${res.overall.MPS95.toFixed(4)}  MAS95=${res.overall.MAS95.toFixed(4)}`);
      } catch (e) {
        row.Status = "FAILED"; row.ErrorMessage = e.message; row.folder = "";
        log.push(`FAIL  ${id.padEnd(24)} ${e.message}`);
      }
      rows.push(row);
      prog.value = i + 1;
    }
    log.push("", `Done. ${ok} of ${files.length} succeeded.`);
    let summary = csvRow(BATCH_SUMMARY_HEADER);
    for (const r of rows) {
      summary += csvRow([r.SimulationID, r.InputFile, r.Status, r.ErrorMessage, r.MPS95 === "" ? "" : fmt6(r.MPS95), r.MAS95 === "" ? "" : fmt6(r.MAS95), r.f1, r.f2, r.folder, r.overall, r.smps, r.smas]);
    }
    zip.file(`_BatchSummaries/BatchSummary_${ts}.csv`, summary);
    zip.file("batch_log.txt", log.join("\n") + "\n");
    batch.zip = { zip, ts };
    renderBatchTable(rows);
    setStatus($("b-status"), `Done. ${ok} of ${files.length} succeeded.`, ok === files.length ? "ok" : "err");
  } catch (e) {
    console.error(e);
    setStatus($("b-status"), `Batch stopped: ${e.message}`, "err");
  } finally {
    batch.running = false;
    renderBatchList();
  }
}

function renderBatchTable(rows) {
  const t = $("b-table");
  t.innerHTML = "";
  const h = t.insertRow();
  for (const c of ["SimulationID", "Status", "MPS95", "MAS95", "MPS95 flag", "MAS95 flag", "Message"]) h.insertCell().outerHTML = `<th>${c}</th>`;
  for (const r of rows) {
    const tr = t.insertRow();
    tr.insertCell().textContent = r.SimulationID;
    const s = tr.insertCell(); s.textContent = r.Status; s.className = r.Status === "OK" ? "ok" : "fail";
    const num = (v) => { const c = tr.insertCell(); c.className = "num"; c.textContent = v === "" ? "" : Number(v).toFixed(4); };
    num(r.MPS95); num(r.MAS95);
    for (const f of [r.f1, r.f2]) { const c = tr.insertCell(); c.className = "num"; c.textContent = f === "" ? "" : f ? "yes" : "no"; }
    tr.insertCell().textContent = r.ErrorMessage;
  }
  $("b-results").hidden = false;
}

$("b-download").addEventListener("click", async () => {
  if (!batch.zip) return;
  busy("Building ZIP…"); await tick();
  try {
    const blob = await batch.zip.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } });
    download(blob, `FEMML_BatchResults_${batch.zip.ts}.zip`);
  } catch (e) { toast(`Could not build ZIP: ${e.message}`, true); }
  busy(null);
});

// ---------------------------------------------------------------- restart / boot
$("restart").addEventListener("click", () => {
  if (state.current && !confirm("Reset the app and return to the Species page?\nAny unsaved results in the window will be cleared.")) return;
  Object.values(state.viewers).forEach((v) => v.dispose());
  state.viewers = {};
  state.current = null;
  $("run-body").hidden = true; $("run-empty").hidden = false; $("run-chip").textContent = "No results yet";
  resetForm();
  show("species");
});

if (location.protocol === "file:") {
  toast("This page must be served over http(s) so the browser can load the model files. Run  python -m http.server  in this folder and open http://localhost:8000", true, 0);
}
resetForm();
show("species");
