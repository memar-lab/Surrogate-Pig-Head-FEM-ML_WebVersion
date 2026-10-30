// Prediction pipeline (port of backend/prediction_export.py + batch_runner.py) without any DOM or file-system code.
import { getVelocityTrace, readPeakValuesCSV, checkPeakRange } from "./impactProfile.js";
import { extractFeatures } from "./features.js";
import { parseFEMB } from "./models.js";
import { csvRow } from "./pyfmt.js";

export const MPS95_THRESHOLD = 0.3;
export const MAS95_THRESHOLD = 0.13;

export function safeFolderName(id) {
  return String(id).replace(/[^\p{L}\p{N}_-]/gu, "_");
}

/** Load the element/fibre centroids used only for the spatial CSV exports. */
export async function loadCentroids(fetchBuffer, url = "data/mesh/centroids.bin") {
  const { arrays } = parseFEMB(await fetchBuffer(url));
  return { MPS: arrays.element, MAS: arrays.fiber }; // flat [N*3]
}

/**
 * One simulation end to end.
 * cfg: {simulationId, inputType, text?, peakAcceleration?, peakVelocity?, direction, modelType}
 * opts.spatial=false skips the large spatial models (used by batch mode when spatial CSVs are not wanted).
 */
export async function runSimulation(cfg, store, { spatial = true } = {}) {
  const simulationId = String(cfg.simulationId ?? "").trim();
  if (!simulationId) throw new Error("Simulation ID is required.");

  const trace = getVelocityTrace(cfg);
  const features = extractFeatures(cfg.direction, trace);
  if (Array.from(features.vector).some((v) => !Number.isFinite(v))) {
    throw new Error("Feature extraction produced a non-finite value (the velocity trace may never fall below 2% of its peak).");
  }
  const overallModels = await store.loadOverall(cfg.modelType, cfg.direction);
  const MPS95 = overallModels.MPS.predictReal(features.vector)[0];
  const MAS95 = overallModels.MAS.predictReal(features.vector)[0];

  let spatialValues = null;
  if (spatial) {
    const sm = await store.loadSpatial(cfg.modelType, cfg.direction);
    spatialValues = { MPS: sm.MPS.predictReal(features.vector), MAS: sm.MAS.predictReal(features.vector) };
  }
  return {
    simulationId,
    folder: safeFolderName(simulationId),
    trace,
    features,
    overall: {
      MPS95, MAS95,
      MPS95_Threshold: MPS95_THRESHOLD, MAS95_Threshold: MAS95_THRESHOLD,
      MPS95_InjuryFlag: MPS95 >= MPS95_THRESHOLD, MAS95_InjuryFlag: MAS95 >= MAS95_THRESHOLD,
    },
    spatial: spatialValues,
  };
}

export function overallCSV(res) {
  const o = res.overall;
  return (
    csvRow(["SimulationID", "Peak_Angular_Velocity_(rad/s)", "Peak_Angular_Acceleration_(rad/s2)", "MPS95", "MAS95", "MPS95_Threshold", "MAS95_Threshold", "MPS95_InjuryFlag", "MAS95_InjuryFlag"]) +
    csvRow([res.simulationId, res.features.byName.ang_vel_max, res.features.byName.ang_acc_max, o.MPS95, o.MAS95, o.MPS95_Threshold, o.MAS95_Threshold, o.MPS95_InjuryFlag ? "1" : "0", o.MAS95_InjuryFlag ? "1" : "0"])
  );
}

/** kind: "MPS" (elements) or "MAS" (fibres). */
export function spatialCSV(kind, values, centroids) {
  const label = kind === "MPS" ? "Element" : "Fiber";
  const c = centroids[kind];
  if (c.length !== values.length * 3) throw new Error(`centroids rows (${c.length / 3}) != predicted ${kind} length (${values.length}).`);
  const out = [csvRow([`${label}ID`, `${label}Centroid_X`, `${label}Centroid_Y`, `${label}Centroid_Z`, "Value"])];
  for (let i = 0; i < values.length; i++) out.push(csvRow([String(i + 1), c[3 * i], c[3 * i + 1], c[3 * i + 2], values[i]]));
  return out.join("");
}

export function traceCSV(trace) {
  const out = [csvRow(["time_(s)", "Angular_velocity_(rad/s)"])];
  for (let i = 0; i < trace.t.length; i++) out.push(csvRow([trace.t[i], trace.y[i]]));
  return out.join("");
}

/** Build a cfg for one batch file. `file` = {name, text}. */
export function batchConfigFor(file, inputType, direction, modelType) {
  const id = file.name.replace(/\.csv$/i, "");
  const cfg = { simulationId: id, inputType, direction, modelType };
  if (inputType === "PeakValues") {
    Object.assign(cfg, readPeakValuesCSV(file.text));
    checkPeakRange(cfg.peakAcceleration, cfg.peakVelocity);
  }
  else cfg.text = file.text;
  return cfg;
}

export const BATCH_SUMMARY_HEADER = [
  "SimulationID", "InputFile", "Status", "ErrorMessage", "MPS95", "MAS95", "MPS95_InjuryFlag", "MAS95_InjuryFlag",
  "OutputFolder", "OverallCSV", "SpatialMPS_CSV", "SpatialMAS_CSV",
];
