// UI controller: pages, single run, results, batch mode and downloads.
import { getVelocityTrace, readPeakValuesCSV, checkPeakRange } from "./impactProfile.js";
import { ModelStore, modelLabel } from "./models.js";
import {
  runSimulation, overallCSV, spatialCSV, traceCSV, loadCentroids, batchConfigFor, safeFolderName,
  BATCH_SUMMARY_HEADER, MPS95_THRESHOLD, MAS95_THRESHOLD,
} from "./pipeline.js";
import { csvRow } from "./pyfmt.js";
import { DirectionView, DIRECTION_TEXT } from "./dirview.js";
import { buildReportHTML, buildMultiReportHTML } from "./report.js";
import { SpatialViewer, loadMeshes, loadBrainMesh, MPS_RANGE, MAS_RANGE } from "./viewer3d.js";
import { prepCanvas, drawTrace, drawTraces, drawDataset, drawOverall, drawColorbar, withLightTheme } from "./plots.js";

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
const state = { species: "Pig", current: null, runs: [], activeRun: 0, viewers: {}, page: "species", batchView: false };
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
const MAX_FILES = 20; // regular mode; batch mode has no limit
const loaded = { VelocityTrace: [], AccelerationTrace: [], PeakValues: [] }; // [{name, text, id}]
let lastTraces = [];      // [{idx, t, y}] previews of the selected files (first MAX_PREVIEW)
let previewIdx = 0;       // file whose trace is highlighted
let previewErrors = [];
const MAX_PREVIEW = 50;
let batchMode = false;

const inputType = () => document.querySelector('input[name="itype"]:checked').value;
const filesOf = (type = inputType()) => loaded[type] || [];
/** More than one file selected for the current input type: every file is its own simulation. */
/** Peak values: typed traces (Add trace) or two or more files run from the list. Other types: two or more files. */
const usesList = (type = inputType()) => type === "PeakValues" ? (loaded.PeakValues.length >= 2 || loaded.PeakValues.some((e) => e.manual)) : filesOf(type).length > 1;
const isMulti = () => usesList();

// Simulation ID default: the loaded file's name for trace inputs, SIM_001 for peak values; the user may overwrite it.
let idEdited = false;
$("sim-id").addEventListener("input", () => { idEdited = true; });
const fileBaseName = (name) => name.replace(/\.csv$/i, "");
function defaultSimId() {
  const t = inputType();
  if (t === "PeakValues") return nextSimId("");
  const f = filesOf(t)[0];
  return f ? fileBaseName(f.name) : "SIM_001";
}
/** Next free ID for a typed peak-values trace: SIM_001 → SIM_002 (any other name starts again at SIM_001), skipping IDs already in the list. */
function nextSimId(id) {
  const taken = new Set(loaded.PeakValues.map((e) => e.id.trim().toLowerCase()));
  const m = /^SIM_(\d+)$/i.exec(String(id).trim());
  const width = m ? m[1].length : 3;
  const make = (k) => `SIM_${String(k).padStart(width, "0")}`;
  let n = m ? Number(m[1]) + 1 : 1;
  while (taken.has(make(n).toLowerCase())) n++;
  return make(n);
}
function setDefaultSimId(force) {
  if (force || !idEdited) { $("sim-id").value = defaultSimId(); idEdited = false; }
}

/** One editable Simulation ID per selected file (shown only when several files are selected). */
function renderSimList() {
  const multi = isMulti(), box = $("sim-list"), peakType = inputType() === "PeakValues";
  $("sim-id-field").hidden = multi && !peakType; // with peak values the ID box names the next trace to add
  box.hidden = !multi;
  if (!multi) { box.textContent = ""; return; }
  box.textContent = "";
  const head = document.createElement("div");
  head.className = "sim-head";
  head.textContent = peakType
    ? `${filesOf().length} trace${filesOf().length === 1 ? "" : "s"} will run together. Values in the boxes above only count when you press Add trace; edit an ID here if you like.`
    : `${filesOf().length} simulations will run together. Each Simulation ID defaults to its file name; edit it if you like.`;
  box.appendChild(head);
  filesOf().forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "sim-row" + (i === previewIdx ? " sel" : "");
    const name = document.createElement("span");
    name.className = "sim-file"; name.title = `${f.name} (click to highlight its trace)`;
    if (i < MAX_PREVIEW) {
      const sw = document.createElement("span");
      sw.className = "sw";
      name.appendChild(sw);
    }
    name.append(document.createTextNode(f.name));
    name.addEventListener("click", () => selectPreview(i));
    const input = document.createElement("input");
    input.type = "text"; input.value = f.id; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", `Simulation ID for ${f.name}`);
    input.addEventListener("input", () => { f.id = input.value; });
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.title = `Remove ${f.name} from this run`; del.setAttribute("aria-label", del.title);
    del.addEventListener("click", () => removeFile(i));
    row.append(name, input, del);
    box.appendChild(row);
  });
}

/** Drop one selected file (picked by mistake) and refresh the list, the preview and the single-ID field. */
function removeFile(i) {
  const type = inputType();
  loaded[type].splice(i, 1);
  previewIdx = Math.max(0, Math.min(previewIdx > i ? previewIdx - 1 : previewIdx, loaded[type].length - 1));
  if (type === "PeakValues" && loaded[type].length === 1 && !loaded[type][0].manual) {
    try {
      const p = readPeakValuesCSV(loaded[type][0].text);
      $("peak-acc").value = p.peakAcceleration;
      $("peak-vel").value = p.peakVelocity;
    } catch (e) { toast(e.message, true); }
  }
  if (!usesList()) setDefaultSimId(true);
  renderSimList();
  autoTrace();
}

function updateInputMode() {
  const t = inputType();
  setDefaultSimId(false);
  renderSimList();
  $$(".sub").forEach((s) => (s.hidden = s.dataset.for !== t));
  autoTrace();
}
$$('input[name="itype"]').forEach((r) => r.addEventListener("change", updateInputMode));

async function readFileInto(input, key) {
  let list = Array.from(input.files || []);
  input.value = ""; // so the same files can be picked again after removing some
  if (!batchMode && list.length > MAX_FILES) {
    toast(`Only the first ${MAX_FILES} files are used. Turn on Batch mode to run more.`, true);
    list = list.slice(0, MAX_FILES);
  }
  loaded[key] = await Promise.all(list.map(async (f) => ({ name: f.name, text: await f.text(), id: fileBaseName(f.name) })));
  previewIdx = 0;
  if (key === "PeakValues" && loaded[key].length) {
    try {
      const p = readPeakValuesCSV(loaded[key][0].text);
      $("peak-acc").value = p.peakAcceleration;
      $("peak-vel").value = p.peakVelocity;
    } catch (e) { toast(e.message, true); }
  }
  setDefaultSimId(true);
  renderSimList();
  autoTrace();
  if (!batchMode && loaded[key].length > 10) suggestBatch(loaded[key].length);
}
$("file-vel").addEventListener("change", (e) => readFileInto(e.target, "VelocityTrace"));
$("file-acc").addEventListener("change", (e) => readFileInto(e.target, "AccelerationTrace"));
$("file-peak").addEventListener("change", (e) => readFileInto(e.target, "PeakValues"));

$("add-trace").addEventListener("click", () => {
  try {
    const a = $("peak-acc").value.trim(), v = $("peak-vel").value.trim();
    if (a === "" || v === "") throw new Error("Enter peak acceleration and peak velocity first.");
    checkPeakRange(Number(a), Number(v));
    const id = $("sim-id").value.trim();
    if (!id) throw new Error("Simulation ID is required.");
    const list = loaded.PeakValues;
    // a single loaded file is what the boxes show: adding commits it, rather than listing it twice
    const others = list.length === 1 && !list[0].manual ? [] : list;
    if (others.some((e) => e.id.trim().toLowerCase() === id.toLowerCase())) throw new Error(`Simulation ID "${id}" is already in the list. Change it first.`);
    if (!batchMode && others.length >= MAX_FILES) throw new Error(`Regular mode runs up to ${MAX_FILES} traces. Turn on Batch mode to run more.`);
    loaded.PeakValues = others;
    loaded.PeakValues.push({
      manual: true, id, name: `${Number(a).toLocaleString("en-US")} rad/s², ${Number(v)} rad/s`,
      text: `Peak_Acceleration_(rad/s2),Peak_Velocity_(rad/s)
${Number(a)},${Number(v)}
`,
    });
    previewIdx = loaded.PeakValues.length - 1;
    $("sim-id").value = nextSimId(id);
    idEdited = false;
    renderSimList();
    autoTrace();
    if (!batchMode && loaded.PeakValues.length === 11) suggestBatch(11);
  } catch (e) { toast(e.message, true); }
});

/** Settings for the file at `idx` (several files), or for the single simulation. */
function getCfg(forTrace = false, idx = 0) {
  const type = inputType(), multi = isMulti(), file = filesOf(type)[idx];
  const simulationId = (multi ? file.id : $("sim-id").value).trim() || (forTrace ? "SIM" : "");
  if (!simulationId) throw new Error(multi ? `Simulation ID is required for ${file.name}.` : "Simulation ID is required.");
  const cfg = {
    simulationId, inputType: type, direction: $("direction").value, modelType: $("model").value,
    visual: $("visual").value === "ON",
  };
  if (type === "PeakValues") {
    if (multi) {
      let p;
      try { p = readPeakValuesCSV(file.text); } catch (e) { throw new Error(`${file.name}: ${e.message}`); }
      cfg.peakAcceleration = p.peakAcceleration;
      cfg.peakVelocity = p.peakVelocity;
      if (!file.manual) cfg.fileName = file.name;
    } else {
      const a = $("peak-acc").value.trim(), v = $("peak-vel").value.trim();
      if (a === "" || v === "") throw new Error("Peak acceleration and peak velocity are required.");
      cfg.peakAcceleration = Number(a);
      cfg.peakVelocity = Number(v);
    }
    checkPeakRange(cfg.peakAcceleration, cfg.peakVelocity);
  } else {
    if (!file) throw new Error("No input file was selected.");
    cfg.text = file.text;
    cfg.fileName = file.name;
  }
  return cfg;
}
/** All simulations to run; Simulation IDs must be unique. */
function getCfgs(lenient = false) {
  const n = isMulti() ? filesOf().length : 1;
  const failed = [];
  const cfgs = [];
  for (let i = 0; i < n; i++) {
    try { cfgs.push(getCfg(false, i)); }
    catch (e) {
      if (!lenient) throw e;
      const f = filesOf()[i];
      failed.push({ i, id: (isMulti() ? f.id : $("sim-id").value).trim() || (f ? fileBaseName(f.name) : "SIM"), file: f ? f.name : "", error: e.message });
    }
  }
  const seen = new Set();
  for (const c of cfgs) {
    const key = c.simulationId.toLowerCase();
    if (seen.has(key)) throw new Error(`Simulation ID "${c.simulationId}" is used more than once. Give every simulation its own ID.`);
    seen.add(key);
  }
  return lenient ? { cfgs, failed } : cfgs;
}

function redrawTrace() {
  const canvas = $("trace-canvas");
  if (!canvas.offsetParent) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (lastTraces.length > 1) drawTraces(ctx, { x: 0, y: 0, w, h }, lastTraces, previewIdx);
  else if (lastTraces.length === 1) drawTrace(ctx, { x: 0, y: 0, w, h }, lastTraces[0]);
  else {
    ctx.fillStyle = "#9aa3af"; ctx.font = "13px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("No trace to show yet", w / 2, h / 2);
  }
}
window.addEventListener("resize", () => { redrawTrace(); if (state.page === "run" && state.current) drawRunPlots(); });

// ---------------------------------------------------------------- theme
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) { /* storage unavailable */ }
  redrawTrace(); renderLegend(); renderSimList();
  if (state.current && !$("run-body").hidden) drawRunPlots();
  Object.values(state.viewers).forEach((v) => v.setTheme(next === "dark"));
  if (dirView) dirView.setTheme(next === "dark");
});

// ---------------------------------------------------------------- impact-direction picture
let dirView = null;
try { dirView = new DirectionView($("dir-view"), loadBrainMesh(fetchBuffer)); } catch (e) { console.warn("Direction picture unavailable:", e); }
function updateDirectionPicture() {
  const d = $("direction").value;
  $("dir-view").title = DIRECTION_TEXT[d] || "";
  if (dirView) dirView.ready.then(() => dirView.setDirection(d));
}
$("direction").addEventListener("change", updateDirectionPicture);
updateDirectionPicture();

/** Rebuild the velocity-trace preview from the current input (called whenever the input changes). */
function autoTrace() {
  const type = inputType(), files = filesOf(type);
  lastTraces = []; previewErrors = [];
  if (type !== "PeakValues" && !files.length) {
    redrawTrace(); renderLegend();
    setStatus($("trace-status"), "Choose an input file to preview the velocity trace.");
    return;
  }
  const n = isMulti() ? Math.min(files.length, MAX_PREVIEW) : 1;
  for (let i = 0; i < n; i++) {
    try {
      const tr = getVelocityTrace(getCfg(true, i));
      lastTraces.push({ idx: i, t: tr.t, y: tr.y });
    } catch (e) { previewErrors.push(isMulti() ? `${files[i].name}: ${e.message}` : e.message); }
  }
  if (previewIdx >= n) previewIdx = 0;
  showPreview();
}
function selectPreview(i) {
  previewIdx = i;
  showPreview();
}
/** Draw the traces, the colour legend, the highlighted list row and the status line. */
function showPreview() {
  redrawTrace();
  renderLegend();
  $$(".sim-row").forEach((r, i) => r.classList.toggle("sel", i === previewIdx));
  const act = lastTraces.find((t) => t.idx === previewIdx) || lastTraces[0];
  if (!act) { setStatus($("trace-status"), previewErrors[0] || "No trace to show.", "err"); return; }
  let peak = 0;
  for (const v of act.y) peak = Math.max(peak, Math.abs(v));
  let msg = `Peak velocity = ${peak.toFixed(3)} rad/s`;
  if (isMulti()) msg += ` (${filesOf()[act.idx].id}; click a name to highlight another trace)`;
  if (isMulti() && filesOf().length > MAX_PREVIEW) msg += ` · previewing the first ${MAX_PREVIEW} of ${filesOf().length} files`;
  if (previewErrors.length) msg += ` · ${previewErrors.length} could not be previewed: ${previewErrors[0]}`;
  setStatus($("trace-status"), msg, previewErrors.length ? "err" : "ok");
}
function renderLegend() {
  const box = $("trace-legend");
  box.textContent = "";
  box.hidden = lastTraces.length < 2;
  if (box.hidden) return;
  for (const tr of lastTraces) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "leg"; b.setAttribute("aria-pressed", String(tr.idx === previewIdx));
    const sw = document.createElement("span");
    sw.className = "sw";
    b.append(sw, document.createTextNode(filesOf()[tr.idx].id));
    b.addEventListener("click", () => selectPreview(tr.idx));
    box.appendChild(b);
  }
}
let traceTimer = null;
for (const id of ["peak-acc", "peak-vel"]) $(id).addEventListener("input", () => { clearTimeout(traceTimer); traceTimer = setTimeout(autoTrace, 350); });

function resetForm() {
  idEdited = false;
  previewIdx = 0;
  setBatchMode(false);
  document.querySelector('input[name="itype"][value="VelocityTrace"]').checked = true;
  $("direction").value = "Sagittal";
  updateDirectionPicture();
  $("model").value = "DNN";
  $("visual").value = "ON";
  $("peak-acc").value = 150000;
  $("peak-vel").value = 100;
  for (const id of ["file-vel", "file-acc", "file-peak"]) $(id).value = "";
  for (const k of Object.keys(loaded)) loaded[k] = [];
  updateInputMode();
}
$("reset-form").addEventListener("click", resetForm);
$("load-example").addEventListener("click", () => {
  document.querySelector('input[name="itype"][value="PeakValues"]').checked = true;
  $("peak-acc").value = 150000;
  $("peak-vel").value = 100;
  updateInputMode();
});

// ---------------------------------------------------------------- single run
$("run").addEventListener("click", runPrediction);

async function runPrediction() {
  if (batchMode) return runBatchMode();
  let cfgs;
  try { cfgs = getCfgs(); } catch (e) { toast(e.message, true); return; }
  const n = cfgs.length, runs = [];
  try {
    const [dataset, centroids] = await Promise.all([getDataset(), getCentroids()]);
    for (let i = 0; i < n; i++) {
      const cfg = cfgs[i], tag = n > 1 ? `Simulation ${i + 1} of ${n} (${cfg.simulationId}): ` : "";
      try {
        busy(`${tag}reading or generating velocity trace…`); await tick();
        const trace = getVelocityTrace(cfg);
        busy(`${tag}loading ${modelLabel(cfg.modelType)} models (${cfg.direction})…`); await tick();
        const res = await runSimulation(cfg, store, { spatial: true });
        runs.push({ id: cfg.simulationId, cur: { cfg, res, dataset, centroids, png: null } });
      } catch (e) {
        if (n === 1) throw e;
        console.error(e);
        runs.push({ id: cfg.simulationId, error: e.message });
      }
    }
    if (!runs.some((r) => r.cur)) throw new Error(runs.map((r) => `${r.id}: ${r.error}`).join("\n"));
    if (cfgs[0].visual) {
      busy("Loading 3D meshes…"); await tick();
      const meshes = await loadMeshes(fetchBuffer);
      runs.forEach((r) => { if (r.cur) r.cur.meshes = meshes; });
    }
    state.runs = runs;
    setRunMode(false);
    show("run");
    busy(null);
    await tick();
    renderTabs();
    selectRun(runs.findIndex((r) => r.cur));
  } catch (e) {
    busy(null);
    console.error(e);
    toast(`Backend Error: ${e.message}`, true, 9000);
  }
}

// ---------------------------------------------------------------- batch mode on the input page
function setBatchMode(on) {
  batchMode = on;
  const t = $("batch-toggle");
  t.setAttribute("aria-pressed", String(on));
  t.textContent = `Batch mode: ${on ? "On" : "Off"}`;
  $("run").textContent = on ? "Run Batch" : "Run Prediction";
  $("visual").disabled = on;
  $("batch-hint").hidden = !on;
}
$("batch-toggle").addEventListener("click", () => setBatchMode(!batchMode));

function suggestBatch(n) {
  $("bs-text").textContent = `You selected ${n} files. Batch mode is better suited for this many: it skips the plots and 3D views, saves the results straight to a folder you choose and shows a summary table. Turn it on?`;
  const dlg = $("batch-suggest");
  if (typeof dlg.showModal !== "function") { toast(`${n} files selected. Consider turning on Batch mode.`); return; }
  dlg.returnValue = "";
  dlg.showModal();
}
$("batch-suggest").addEventListener("close", () => { if ($("batch-suggest").returnValue === "batch") setBatchMode(true); });

/** Show the summary table (batch mode) or the normal results (regular mode) on the Run / Results page. */
function setRunMode(batchView) {
  state.batchView = batchView;
  for (const id of ["reset-views", "report-btn", "download-zip"]) $(id).hidden = batchView;
  $("batch-panel").hidden = !batchView;
  if (batchView) for (const id of ["run-body", "run-empty", "run-tabs", "download-all", "report-all"]) $(id).hidden = true;
}

/** Where batch results go: straight into a folder the user picks, or (browsers without folder access) one zip. */
async function openSink() {
  const ts = stamp();
  if (typeof window.showDirectoryPicker === "function") {
    const root = await window.showDirectoryPicker({ mode: "readwrite" });
    return {
      ts, label: `the folder "${root.name}"`,
      async write(path, data) {
        const parts = path.split("/");
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        await w.write(data);
        await w.close();
      },
      async finish() {},
    };
  }
  toast("This browser cannot save to a folder, so the results will be downloaded as one .zip instead.", false, 7000);
  const zip = new JSZip();
  return { ts, label: "the downloaded .zip", async write(path, data) { zip.file(path, data); }, async finish() { download(await zipBlob(zip), `FEMML_BatchResults_${ts}.zip`); } };
}

function summaryCSV(rows) {
  let out = csvRow(BATCH_SUMMARY_HEADER);
  for (const r of rows) {
    out += csvRow([r.SimulationID, r.InputFile, r.Status, r.ErrorMessage, r.MPS95 === "" ? "" : fmt6(r.MPS95), r.MAS95 === "" ? "" : fmt6(r.MAS95), r.f1, r.f2, r.folder, r.overall, r.smps, r.smas]);
  }
  return out;
}

function addResultRow(tbl, r, message) {
  const tr = tbl.insertRow();
  const cell = (text, cls) => { const c = tr.insertCell(); c.textContent = text; if (cls) c.className = cls; return c; };
  const failed = r.Status === "FAILED", injured = r.f1 === 1 || r.f2 === 1;
  cell(r.SimulationID);
  cell(failed ? "Failed" : injured ? "Injured" : "Not Injured", failed ? "st-fail" : injured ? "st-injured" : "st-ok");
  cell(failed ? "" : Number(r.MPS95).toFixed(4), "num");
  cell(failed ? "" : Number(r.MAS95).toFixed(4), "num");
  cell(failed ? "" : r.f1 ? "Yes" : "No");
  cell(failed ? "" : r.f2 ? "Yes" : "No");
  cell(message, "msg");
}

/** Batch mode: no plots, no 3D, no big arrays kept; every simulation is written out as soon as it is done. */
async function runBatchMode() {
  let cfgs, bad;
  try { ({ cfgs, failed: bad } = getCfgs(true)); } catch (e) { toast(e.message, true); return; }
  if (!cfgs.length && !bad.length) return;
  let sink;
  try { sink = await openSink(); } // must be the first await: the folder picker needs the click's permission
  catch (e) {
    if (e.name !== "AbortError") toast(`Could not open the output folder: ${e.message}`, true, 8000);
    return;
  }
  const n = cfgs.length + bad.length, rows = [], log = [], used = new Set();
  $("run").disabled = true;
  state.current = null; state.runs = [];
  setRunMode(true);
  show("run");
  const dirName = $("direction").value, modelName = $("model").value;
  $("run-chip").textContent = `Batch · ${n} simulation${n === 1 ? "" : "s"} · ${dirName} · ${modelLabel(modelName)}`;
  const tbl = $("bp-table"), prog = $("bp-progress"), status = $("bp-status");
  tbl.textContent = "";
  const head = tbl.insertRow();
  for (const c of ["SimulationID", "Status", "MPS95", "MAS95", "MPS95 flag", "MAS95 flag", "Message"]) head.insertCell().outerHTML = `<th>${c}</th>`;
  prog.max = n; prog.value = 0;
  let ok = 0;
  try {
    setStatus(status, `Loading ${modelLabel(modelName)} models (${dirName})…`);
    let centroids = null;
    if (cfgs.length) {
      await store.loadOverall(modelName, dirName);
      await store.loadSpatial(modelName, dirName);
      centroids = await getCentroids();
    }
    log.push(`Memar Lab batch run  ${new Date().toISOString()}`, `Input type   : ${inputType()}`, `Direction    : ${dirName}`, `Model type   : ${modelName}`, `Simulations  : ${n}`, "");
    for (const b of bad) {
      let id = safeFolderName(b.id);
      while (used.has(id)) id += "_2";
      used.add(id);
      const row = { SimulationID: b.id, InputFile: b.file, Status: "FAILED", ErrorMessage: b.error, MPS95: "", MAS95: "", f1: "", f2: "", folder: "", overall: "", smps: "", smas: "" };
      log.push(`FAIL  ${id.padEnd(24)} ${b.error}`);
      rows.push(row);
      addResultRow(tbl, row, b.error);
    }
    prog.value = bad.length;
    for (let i = 0; i < cfgs.length; i++) {
      const cfg = cfgs[i];
      let id = safeFolderName(cfg.simulationId);
      while (used.has(id)) id += "_2";
      used.add(id);
      setStatus(status, `Running ${bad.length + i + 1} of ${n}: ${cfg.simulationId}`);
      await tick();
      const row = { SimulationID: cfg.simulationId, InputFile: cfg.fileName || "", Status: "OK", ErrorMessage: "", MPS95: "", MAS95: "", f1: "", f2: "", folder: id, overall: "", smps: "", smas: "" };
      let message;
      try {
        const res = await runSimulation({ ...cfg, simulationId: id }, store, { spatial: true });
        await sink.write(`${id}/${id}_OverallPredictions.csv`, overallCSV(res));
        await sink.write(`${id}/${id}_SpatialMPS.csv`, spatialCSV("MPS", res.spatial.MPS, centroids));
        await sink.write(`${id}/${id}_SpatialMAS.csv`, spatialCSV("MAS", res.spatial.MAS, centroids));
        row.overall = `${id}/${id}_OverallPredictions.csv`; row.smps = `${id}/${id}_SpatialMPS.csv`; row.smas = `${id}/${id}_SpatialMAS.csv`;
        row.MPS95 = res.overall.MPS95; row.MAS95 = res.overall.MAS95;
        row.f1 = res.overall.MPS95_InjuryFlag ? 1 : 0; row.f2 = res.overall.MAS95_InjuryFlag ? 1 : 0;
        message = `Saved in ${id}/`;
        ok++;
        log.push(`OK    ${id.padEnd(24)} MPS95=${res.overall.MPS95.toFixed(4)}  MAS95=${res.overall.MAS95.toFixed(4)}`);
      } catch (e) {
        console.error(e);
        row.Status = "FAILED"; row.ErrorMessage = e.message; row.folder = "";
        message = e.message;
        log.push(`FAIL  ${id.padEnd(24)} ${e.message}`);
      }
      rows.push(row);
      addResultRow(tbl, row, message);
      prog.value = bad.length + i + 1;
    }
    log.push("", `Done. ${ok} of ${n} succeeded.`);
    await sink.write(`_BatchSummaries/BatchSummary_${sink.ts}.csv`, summaryCSV(rows));
    await sink.write("batch_log.txt", log.join("\n") + "\n");
    await sink.finish();
    setStatus(status, `Done. ${ok} of ${n} succeeded. Results were saved to ${sink.label}.`, ok === n ? "ok" : "err");
  } catch (e) {
    console.error(e);
    setStatus(status, `Batch stopped: ${e.message}`, "err");
  } finally {
    $("run").disabled = false;
  }
}

// ---------------------------------------------------------------- result tabs (several simulations)
function renderTabs() {
  const bar = $("run-tabs"), runs = state.runs;
  bar.textContent = "";
  bar.hidden = runs.length < 2;
  $("download-all").hidden = $("report-all").hidden = runs.filter((r) => r.cur).length < 2;
  runs.forEach((r, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "run-tab" + (r.cur ? "" : " failed"); b.setAttribute("role", "tab");
    b.dataset.i = i; b.title = r.cur ? r.id : `${r.id}: failed`;
    b.append(document.createTextNode(r.id));
    if (r.cur && (r.cur.res.overall.MPS95_InjuryFlag || r.cur.res.overall.MAS95_InjuryFlag)) {
      const dot = document.createElement("span");
      dot.className = "dot"; dot.title = "Injury threshold exceeded";
      b.appendChild(dot);
    }
    b.addEventListener("click", () => selectRun(i));
    bar.appendChild(b);
  });
}
function selectRun(i) {
  const r = state.runs[i];
  if (!r) return;
  state.activeRun = i;
  $$(".run-tab").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.i) === i)));
  if (r.cur) {
    state.current = r.cur;
    renderResults();
    return;
  }
  state.current = null;
  $("run-body").hidden = true;
  const empty = $("run-empty");
  empty.hidden = false;
  empty.textContent = "";
  const t = document.createElement("div");
  t.className = "run-error"; t.textContent = `${r.id} could not be run:\n${r.error}`;
  empty.appendChild(t);
  $("run-chip").textContent = `${r.id} · failed`;
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
  $("run-chip").textContent = `${res.simulationId} · ${cfg.direction} · ${modelLabel(cfg.modelType)}`;

  drawRunPlots();

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
  cur.notesText = notes.length ? "Caution: the surrogate is only trained on its dataset, so this prediction is an extrapolation. " + notes.join("; ") + "." : "";
  if (notes.length) warn.textContent = cur.notesText;

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
  $("cut-panel").hidden = !cfg.visual;
  applyCuts();
  // rotating, zooming or panning one view moves the other the same way
  if (state.viewers.MPS && state.viewers.MAS && !state.viewers.MPS.peer) state.viewers.MPS.link(state.viewers.MAS);
}

// ---------------------------------------------------------------- cut planes (shared by the MPS and MAS views)
function applyCuts() {
  for (const row of $$(".cut-row")) {
    const axis = row.dataset.axis, on = row.querySelector(".cut-on").checked;
    const t = Number(row.querySelector(".cut-slider").value) / 1000, flip = row.querySelector(".cut-flip").checked;
    const v = Object.values(state.viewers)[0];
    row.querySelector(".cut-slider").disabled = !on;
    row.querySelector(".cut-val").textContent = v && on ? `${axis} = ${v.cutOffset(axis, t).toFixed(1)} mm` : "";
    for (const viewer of Object.values(state.viewers)) viewer.setCut(axis, on, t, flip);
  }
}
$$(".cut-row input").forEach((el) => el.addEventListener("input", applyCuts));

$("reset-views").addEventListener("click", () => Object.values(state.viewers).forEach((v) => v.resetView()));

// PNG composites for the download
const spatialPNG = (kind) => withLightTheme(() => spatialPNGLight(kind));
const resultsPageCanvas = () => withLightTheme(resultsPageCanvasLight);
const resultsPagePNG = async () => canvasBlob(resultsPageCanvas());

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

function resultsPageCanvasLight() {
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
  return c;
}

// ---------------------------------------------------------------- report (.html)
const THRESHOLDS = { MPS95: MPS95_THRESHOLD, MAS95: MAS95_THRESHOLD };
$("report-btn").addEventListener("click", async () => {
  const cur = state.current;
  if (!cur) return;
  try {
    busy("Building report…"); await tick();
    const html = buildReportHTML(cur, THRESHOLDS, resultsPageCanvas().toDataURL("image/png"), cur.notesText);
    download(new Blob([html], { type: "text/html" }), `${cur.res.folder}_Report.html`);
    busy(null);
  } catch (e) {
    busy(null);
    console.error(e);
    toast(`Could not build report: ${e.message}`, true, 8000);
  }
});

$("report-all").addEventListener("click", async () => {
  const keep = state.activeRun;
  try {
    const items = [], ok = state.runs.map((r, i) => [r, i]).filter(([r]) => r.cur);
    for (let k = 0; k < ok.length; k++) {
      busy(`Building report: simulation ${k + 1} of ${ok.length}…`); await tick();
      selectRun(ok[k][1]);   // each figure includes the 3D views, so draw every simulation in turn
      await tick();
      const cur = ok[k][0].cur;
      items.push({ info: cur, figure: resultsPageCanvas().toDataURL("image/png"), notes: cur.notesText });
    }
    download(new Blob([buildMultiReportHTML(items, THRESHOLDS)], { type: "text/html" }), `FEMML_Report_${stamp()}.html`);
    busy(null);
  } catch (e) {
    busy(null);
    console.error(e);
    toast(`Could not build report: ${e.message}`, true, 8000);
  } finally {
    selectRun(keep);
  }
});

/** Add one simulation's files (the current result, drawn in the viewers) to a zip. */
async function addRunToZip(zip, cur) {
  const { res, cfg, centroids } = cur;
  const dir = zip.folder(res.folder);
  const id = res.simulationId;
  dir.file(`${id}_OverallPredictions.csv`, overallCSV(res));
  dir.file(`${id}_SpatialMPS.csv`, spatialCSV("MPS", res.spatial.MPS, centroids));
  dir.file(`${id}_SpatialMAS.csv`, spatialCSV("MAS", res.spatial.MAS, centroids));
  dir.file(`${id}_VelocityTrace.csv`, traceCSV(res.trace));
  dir.file(`${id}_InputSettings.json`, JSON.stringify({
    simulationId: id, species: "Pig", inputType: cfg.inputType, direction: cfg.direction, modelType: cfg.modelType,
    peakAcceleration: cfg.peakAcceleration, peakVelocity: cfg.peakVelocity, inputFile: cfg.fileName,
    thresholds: { MPS95: MPS95_THRESHOLD, MAS95: MAS95_THRESHOLD },
  }, null, 2));
  if (cfg.visual && state.viewers.MPS && state.viewers.MAS) {
    dir.file(`${id}_SpatialMPSPreview.png`, await spatialPNG("MPS"));
    dir.file(`${id}_SpatialMASPreview.png`, await spatialPNG("MAS"));
    dir.file(`${id}_RunResultsPage.png`, await resultsPagePNG());
  }
}
const zipBlob = (zip) => zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } });

$("download-zip").addEventListener("click", async () => {
  const cur = state.current;
  if (!cur) return;
  try {
    busy("Building ZIP…"); await tick();
    const zip = new JSZip();
    await addRunToZip(zip, cur);
    download(await zipBlob(zip), `${cur.res.folder}_results.zip`);
    busy(null);
  } catch (e) {
    busy(null);
    toast(`Could not build ZIP: ${e.message}`, true, 8000);
  }
});

$("download-all").addEventListener("click", async () => {
  const keep = state.activeRun;
  try {
    const zip = new JSZip(), ok = state.runs.map((r, i) => [r, i]).filter(([r]) => r.cur);
    for (let k = 0; k < ok.length; k++) {
      busy(`Building ZIP: simulation ${k + 1} of ${ok.length}…`); await tick();
      selectRun(ok[k][1]);   // the PNG previews come from the 3D views, so draw each simulation in turn
      await tick();
      await addRunToZip(zip, ok[k][0].cur);
    }
    download(await zipBlob(zip), `FEMML_Results_${stamp()}.zip`);
    busy(null);
  } catch (e) {
    busy(null);
    toast(`Could not build ZIP: ${e.message}`, true, 8000);
  } finally {
    selectRun(keep);
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
    const summary = summaryCSV(rows);
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
  state.runs = []; state.activeRun = 0;
  setRunMode(false);
  $("run-tabs").hidden = true; $("download-all").hidden = true; $("report-all").hidden = true;
  $("run-body").hidden = true; $("run-empty").hidden = false; $("run-chip").textContent = "No results yet";
  $("run-empty").innerHTML = "Prediction not run yet. Go to <b>Input Parameters</b> and press <b>Run Prediction</b>.";
  resetForm();
  show("species");
});

if (location.protocol === "file:") {
  toast("This page must be served over http(s) so the browser can load the model files. Run  python -m http.server  in this folder and open http://localhost:8000", true, 0);
}
resetForm();
show("species");
