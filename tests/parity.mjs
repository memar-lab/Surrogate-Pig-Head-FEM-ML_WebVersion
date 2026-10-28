// Parity test: the browser code must reproduce the desktop app's numbers.
// tests/fixtures/reference.json was produced by running the desktop app's own backend on the same inputs.
//   node tests/parity.mjs                      (summary checks, needs only the repo)
//   FULL_SPATIAL=<dir> node tests/parity.mjs   (also compare complete spatial arrays from <dir>/*.bin)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVelocityTrace } from "../js/impactProfile.js";
import { extractFeatures } from "../js/features.js";
import { ModelStore, MODEL_LABELS } from "../js/models.js";
import { pyFloat } from "../js/pyfmt.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ref = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/reference.json"), "utf8"));
const fetchBuffer = async (p) => {
  const b = fs.readFileSync(path.join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const store = new ModelStore(fetchBuffer);

let checks = 0, failures = 0, worst = 0;
function close(label, got, want, tol = 1e-9) {
  checks++;
  const err = Math.abs(got - want) / Math.max(1, Math.abs(want));
  worst = Math.max(worst, err);
  if (!(err <= tol) && !(Number.isNaN(got) && Number.isNaN(want))) {
    failures++;
    if (failures <= 25) console.log(`FAIL ${label}: got ${got} want ${want} (rel err ${err.toExponential(2)})`);
  }
}

// pyFloat must match Python's repr
const reprCases = [[75.0, "75.0"], [0.0001, "0.0001"], [0.00001, "1e-05"], [1e16, "1e+16"], [123456789012345680, "1.2345678901234568e+17"],
  [0.37632807222572273, "0.37632807222572273"], [-133.5, "-133.5"], [0.3, "0.3"], [1, "1.0"], [100, "100.0"], [1.5e-7, "1.5e-07"]];
for (const [x, s] of reprCases) { checks++; if (pyFloat(x) !== s) { failures++; console.log(`FAIL pyFloat(${x}) = ${pyFloat(x)} want ${s}`); } }

const traces = {
  vel1: fs.readFileSync(path.join(root, "tests/fixtures/velocity_trace.csv"), "utf8"),
  acc1: fs.readFileSync(path.join(root, "tests/fixtures/acceleration_trace.csv"), "utf8"),
};
const full = process.env.FULL_SPATIAL;

for (const [id, c] of Object.entries(ref)) {
  const cfg = { ...c.cfg };
  if (cfg.inputType !== "PeakValues") cfg.text = traces[id];
  const trace = getVelocityTrace(cfg);
  close(`${id} trace length`, trace.t.length, c.n, 0);
  close(`${id} trace end time`, trace.t[trace.t.length - 1], c.t_end);
  close(`${id} trace velocity sum`, trace.y.reduce((a, b) => a + b, 0), c.vt_sum, 1e-9);
  for (const dir of ["Axial", "Sagittal", "Coronal"]) {
    const f = extractFeatures(dir, trace).vector;
    c.features[dir].forEach((w, i) => close(`${id} ${dir} feature[${i}]`, f[i], w, 1e-9));
    for (const m of MODEL_LABELS) {
      const { MPS, MAS } = await store.loadOverall(m, dir);
      const [wMps, wMas] = c.pred[`${dir}|${m}`];
      close(`${id} ${dir} ${m} MPS95`, MPS.predictReal(f)[0], wMps, 1e-9);
      close(`${id} ${dir} ${m} MAS95`, MAS.predictReal(f)[0], wMas, 1e-9);
    }
    for (const [key, s] of Object.entries(c.spatial || {})) {
      const [d, m] = key.split("|");
      if (d !== dir) continue;
      const sm = await store.loadSpatial(m, dir);
      for (const kind of ["MPS", "MAS"]) {
        const got = sm[kind].predictReal(f), w = s[kind];
        close(`${id} ${key} spatial ${kind} length`, got.length, w.n, 0);
        close(`${id} ${key} spatial ${kind} sum`, got.reduce((a, b) => a + b, 0), w.sum, 1e-9);
        close(`${id} ${key} spatial ${kind} min`, Math.min(...got), w.min);
        close(`${id} ${key} spatial ${kind} max`, Math.max(...got), w.max);
        for (const [i, v] of w.samples) close(`${id} ${key} spatial ${kind}[${i}]`, got[i], v);
        if (full) {
          const tag = `${id}_${d}_${m.replace(/ /g, "").replace(/-/g, "")}_${kind.toLowerCase()}.bin`;
          const b = fs.readFileSync(path.join(full, tag));
          const want = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
          let maxErr = 0;
          for (let i = 0; i < want.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - want[i]));
          close(`${id} ${key} FULL ${kind} max abs err`, maxErr, 0, 1e-9);
        }
      }
    }
  }
}

console.log(`${checks} checks, ${failures} failures, worst relative error ${worst.toExponential(2)}`);
process.exit(failures ? 1 : 0);
