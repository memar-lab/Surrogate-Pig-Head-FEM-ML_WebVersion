// Port of backend/model_loader.py: load the exported surrogate models and run them.
// Models live in data/models/<Overall|Spatial>_<Family>_<MPS|MAS>_<Direction>.bin (see tools/export_assets.py).

export const MODEL_TYPES = {
  DNN: "DNN",
  Lasso: "Lasso",
  Ridge: "Ridge",
  "Random Forest - Linear": "RF_Linear",
  "Random Forest - Curvature": "RF_Curvature",
};
export const MODEL_LABELS = Object.keys(MODEL_TYPES);
/** Name shown to users; the internal key (and model files) keep the original "Random Forest - Linear". */
export const modelLabel = (m) => (m === "Random Forest - Linear" ? "Random Forest - CART" : m);

const DTYPES = {
  "<f8": Float64Array, "<f4": Float32Array, "<i4": Int32Array, "<i2": Int16Array,
  "<u4": Uint32Array, "<u2": Uint16Array, "|u1": Uint8Array,
};

/** Parse the FEMB container written by tools/export_assets.py. Arrays are zero-copy views into `buffer`. */
export function parseFEMB(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "FEMB") throw new Error("Not a FEMB model file.");
  const hdrLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, hdrLen)));
  const arrays = {};
  for (const [name, a] of Object.entries(header.arrays)) {
    const T = DTYPES[a.dtype];
    if (!T) throw new Error(`Unsupported dtype ${a.dtype}`);
    const len = a.shape.reduce((p, q) => p * q, 1);
    arrays[name] = new T(buffer, a.offset, len);
  }
  return { meta: header.meta, arrays };
}

const TRANSFER = {
  poslin: (x) => (x > 0 ? x : 0),
  purelin: (x) => x,
  tansig: (x) => 2 / (1 + Math.exp(-2 * x)) - 1,
  logsig: (x) => 1 / (1 + Math.exp(-x)),
  radbas: (x) => Math.exp(-(x * x)),
};

function layer(W, rows, cols, x, b, tf) {
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const o = i * cols;
    for (let j = 0; j < cols; j++) s += W[o + j] * x[j];
    out[i] = tf(s + b[i]);
  }
  return out;
}

function rfPredict(arrays, comp, x) {
  const children = arrays[`c${comp}_children`], cutvar = arrays[`c${comp}_cutvar`];
  const cutpoint = arrays[`c${comp}_cutpoint`], nodeval = arrays[`c${comp}_nodeval`];
  const start = arrays[`c${comp}_tree_start`];
  const nt = start.length;
  let total = 0.0;
  for (let t = 0; t < nt; t++) {
    let node = start[t];
    while (children[node * 2] !== -1) {
      node = x[cutvar[node] - 1] < cutpoint[node] ? children[node * 2] : children[node * 2 + 1];
    }
    total += nodeval[node];
  }
  return total / nt;
}

export class SurrogateModel {
  constructor({ meta, arrays }) {
    this.meta = meta;
    this.a = arrays;
    this.nComp = meta.nComp;
  }

  normalize(fv) {
    if (fv.length !== 15) throw new Error("featureVector must contain exactly 15 features.");
    const { mu_input, std_input } = this.a;
    return Float64Array.from(fv, (v, i) => (v - mu_input[i]) / std_input[i]);
  }

  /** PCA scores (length nComp) for a normalised feature vector. */
  predictScores(x) {
    const n = this.nComp, { family } = this.meta, a = this.a;
    let s = new Float64Array(n);
    if (family === "Linear") {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < 15; k++) acc += a.lin_Beta[j * 15 + k] * x[k];
        s[j] = acc + a.lin_Bias[j];
      }
    } else if (family === "DNN") {
      const [t1, t2, t3] = this.meta.tf.map((name) => TRANSFER[name] || TRANSFER.purelin);
      const n1 = a.b1.length, n2 = a.b2.length, n3 = a.b3.length;
      const a1 = layer(a.IW, n1, 15, x, a.b1, t1);
      const a2 = layer(a.LW21, n2, n1, a1, a.b2, t2);
      const y = layer(a.LW32, n3, n2, a2, a.b3, t3);
      if (this.meta.WScalar) s = Float64Array.from(y, (v) => v / this.meta.WValue);
      else {
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let j = 0; j < n; j++) acc += a.Winv[i * n + j] * y[j];
          s[i] = acc;
        }
      }
    } else if (family === "RF") {
      for (let j = 0; j < n; j++) s[j] = rfPredict(a, j, x);
    } else throw new Error(`Unknown family: ${family}`);
    return s;
  }

  /** Back-transform scores to real units: inverse PCA, then un-standardise the output. */
  predictRealFromNorm(x) {
    const s = this.predictScores(x), m = this.meta, a = this.a;
    const N = a.mu_pca.length, out = new Float64Array(N);
    if (m.coeffScalar) {
      for (let i = 0; i < N; i++) out[i] = (s[0] * m.coeffValue + a.mu_pca[i]) * m.std_output + m.mu_output;
    } else {
      const k = this.nComp;
      for (let i = 0; i < N; i++) {
        let acc = 0;
        for (let j = 0; j < k; j++) acc += a.coeff[i * k + j] * s[j];
        out[i] = (acc + a.mu_pca[i]) * m.std_output + m.mu_output;
      }
    }
    return out;
  }

  predictReal(fv) {
    return this.predictRealFromNorm(this.normalize(fv));
  }
}

export function normalizeDirection(d) {
  const key = String(d).trim().toLowerCase();
  const map = { axial: "Axial", sagittal: "Sagittal", coronal: "Coronal" };
  if (!(key in map)) throw new Error(`Unknown impact direction selected: ${d}`);
  return map[key];
}

export function modelTag(modelType) {
  const tag = MODEL_TYPES[String(modelType)];
  if (!tag) throw new Error(`Unknown model type selected: ${modelType}`);
  return tag;
}

/**
 * Loads models on demand. `fetchBuffer(path) -> Promise<ArrayBuffer>` is injected so the same code runs
 * in the browser (fetch) and in the Node test-suite (fs).
 */
export class ModelStore {
  constructor(fetchBuffer, baseUrl = "data/models/") {
    this.fetchBuffer = fetchBuffer;
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  load(scope, tag, output, direction) {
    const key = `${scope}_${tag}_${output}_${direction}`;
    if (!this.cache.has(key)) {
      const p = this.fetchBuffer(`${this.baseUrl}${key}.bin`)
        .then((buf) => new SurrogateModel(parseFEMB(buf)))
        .catch((e) => { this.cache.delete(key); throw new Error(`Could not load model ${key}: ${e.message}`); });
      this.cache.set(key, p);
    }
    return this.cache.get(key);
  }

  /** Overall models only: small and fast, used by batch mode. */
  async loadOverall(modelType, direction) {
    const tag = modelTag(modelType), dir = normalizeDirection(direction);
    const [MPS, MAS] = await Promise.all([this.load("Overall", tag, "MPS", dir), this.load("Overall", tag, "MAS", dir)]);
    return { MPS, MAS };
  }

  async loadSpatial(modelType, direction) {
    const tag = modelTag(modelType), dir = normalizeDirection(direction);
    const [MPS, MAS] = await Promise.all([this.load("Spatial", tag, "MPS", dir), this.load("Spatial", tag, "MAS", dir)]);
    return { MPS, MAS };
  }
}
