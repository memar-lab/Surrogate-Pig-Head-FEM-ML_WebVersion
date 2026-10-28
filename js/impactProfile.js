// Port of backend/impact_profile.py: any supported input -> velocity trace [time (s), angular velocity (rad/s)].
import { readNamedColumns } from "./csv.js";

export const INPUT_TYPES = ["VelocityTrace", "AccelerationTrace", "PeakValues"];
export const VEL_COLS = ["time_(s)", "Angular_velocity_(rad/s)"];
export const ACC_COLS = ["time_(s)", "Angular_Acceleration_(rad/s2)"];
export const PEAK_COLS = ["Peak_Acceleration_(rad/s2)", "Peak_Velocity_(rad/s)"];

/** A trace is {t: Float64Array, y: Float64Array}. */
function validateTrace(t, y, label) {
  if (!t.length) throw new Error(`${label} is empty.`);
  for (let i = 0; i < t.length; i++) {
    if (Number.isNaN(t[i]) || Number.isNaN(y[i])) throw new Error(`${label} contains NaN values.`);
    if (!Number.isFinite(t[i]) || !Number.isFinite(y[i])) throw new Error(`${label} contains Inf values.`);
  }
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] <= 0) throw new Error(`${label} time column must be strictly increasing.`);
  return { t, y };
}

export function readVelocityCSV(text) {
  const c = readNamedColumns(text, VEL_COLS, "File");
  return validateTrace(c[VEL_COLS[0]], c[VEL_COLS[1]], "Angular Velocity Trace");
}

export function readAccelerationCSV(text) {
  const c = readNamedColumns(text, ACC_COLS, "File");
  return validateTrace(c[ACC_COLS[0]], c[ACC_COLS[1]], "Angular Acceleration Trace");
}

/** Read the single row of a PeakValues CSV: returns {peakAcceleration, peakVelocity}. */
export function readPeakValuesCSV(text) {
  const c = readNamedColumns(text, PEAK_COLS, "File");
  const a = c[PEAK_COLS[0]], v = c[PEAK_COLS[1]];
  if (!a.length || !v.length) throw new Error("PeakValues file has no data row.");
  if (a.length > 1 || v.length > 1) throw new Error("PeakValues file must contain exactly one data row.");
  return { peakAcceleration: a[0], peakVelocity: v[0] };
}

/** np.spacing(x) for x > 0. */
function spacing(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  dv.setBigUint64(0, dv.getBigUint64(0) + 1n);
  return dv.getFloat64(0) - Math.abs(x);
}

export function generateIdealizedProfiles(peakAcceleration, peakVelocity) {
  const a = Number(peakAcceleration), v = Number(peakVelocity);
  if (Number.isNaN(a) || Number.isNaN(v)) throw new Error("Peak acceleration and peak velocity cannot be NaN.");
  if (!Number.isFinite(a) || !Number.isFinite(v)) throw new Error("Peak acceleration and peak velocity cannot be Inf.");
  if (a <= 0 || v <= 0) throw new Error("Peak acceleration and peak velocity must be positive.");
  const alphaMax = a, dt = 1e-5, extra = 0.02;
  const T = (Math.PI * v) / alphaMax;
  if (T <= 0) throw new Error("Computed pulse duration must be positive.");
  const total = T + extra;

  // np.arange(0.0, total + 0.5*dt, dt): element i is i*dt, length ceil((stop-start)/step)
  const n0 = Math.ceil((total + 0.5 * dt) / dt);
  const list = new Array(n0);
  for (let i = 0; i < n0; i++) list[i] = i * dt;
  if (Math.abs(list[list.length - 1] - total) > spacing(total)) list.push(total);
  list.push(T, total);
  list.sort((x, y) => x - y);
  const time = [];
  for (const x of list) if (!time.length || x !== time[time.length - 1]) time.push(x); // np.unique

  const t = Float64Array.from(time);
  const acc = new Float64Array(t.length), vel = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= 0 && t[i] <= T) {
      const arg = (2 * Math.PI * t[i]) / T;
      acc[i] = alphaMax * Math.sin(arg);
      vel[i] = ((alphaMax * T) / (2 * Math.PI)) * (1 - Math.cos(arg));
    }
  }
  return {
    velocity: validateTrace(t, vel, "Idealized Sinusoidal Angular Velocity Trace"),
    acceleration: validateTrace(t, acc, "Idealized Sinusoidal Angular Acceleration Trace"),
    pulse: { alphaMax, peakVelocity: v, dt, pulseDuration: T, extraDuration: extra, totalDuration: total },
  };
}

function cumtrapz(t, y) {
  const out = new Float64Array(t.length);
  let acc = 0;
  for (let i = 1; i < t.length; i++) {
    acc += ((y[i] + y[i - 1]) * (t[i] - t[i - 1])) / 2.0;
    out[i] = acc;
  }
  return out;
}

export function accelerationToVelocity(trace) {
  return validateTrace(trace.t, cumtrapz(trace.t, trace.y), "Converted Velocity Trace");
}

/**
 * cfg: {inputType, text?, peakAcceleration?, peakVelocity?}
 * `text` is the CSV content for the trace types.
 */
export function getVelocityTrace(cfg) {
  switch (String(cfg.inputType)) {
    case "VelocityTrace": return readVelocityCSV(cfg.text);
    case "AccelerationTrace": return accelerationToVelocity(readAccelerationCSV(cfg.text));
    case "PeakValues": return generateIdealizedProfiles(cfg.peakAcceleration, cfg.peakVelocity).velocity;
    default: throw new Error(`Unknown impact profile input type: ${cfg.inputType}`);
  }
}
