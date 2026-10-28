// Port of backend/feature_extraction.py: velocity trace -> the 15 kinematic input features.

export const FEATURE_NAMES = [
  "BRIC", "RIC", "BrIC", "RVCI", "ang_vel_max", "ang_acc_max", "Time_to_Peak_Vel", "Time_from_Peak_Vel",
  "Total_Curve_Duration", "max_vel_squared", "max_vel_cubed", "max_ang_squared", "max_ang_cubed",
  "Area_under_Velocity", "max_Jerk",
];

export const DIRECTIONS = ["Axial", "Sagittal", "Coronal"];

export function directionToCode(direction) {
  const d = String(direction).trim().toLowerCase();
  if (d === "axial") return 1;
  if (d === "sagittal") return 2;
  if (d === "coronal") return 3;
  throw new Error(`Unknown impact direction: ${direction}`);
}

/** np.gradient(f) with unit spacing. */
function gradient(f) {
  const n = f.length, g = new Float64Array(n);
  if (n < 2) throw new Error("Velocity trace needs at least two samples.");
  g[0] = f[1] - f[0];
  g[n - 1] = f[n - 1] - f[n - 2];
  for (let i = 1; i < n - 1; i++) g[i] = (f[i + 1] - f[i - 1]) / 2.0;
  return g;
}

/** np.trapezoid(y[i0:i1], x[i0:i1]) */
function trapz(y, x, i0 = 0, i1 = y.length) {
  let s = 0;
  for (let i = i0; i < i1 - 1; i++) s += ((x[i + 1] - x[i]) * (y[i + 1] + y[i])) / 2.0;
  return s;
}

/**
 * Sliding-window maximum used by RIC and RVCI. `term(i0, i1)` returns the value for the
 * window [i0, i1) or null to skip it; the window is every sample within `windowS` of start.
 */
function slidingMax(time, windowS, term, init) {
  const n = time.length;
  let best = init, start = 0, end = 0;
  while (start < n) {
    while (end < n && time[end] - time[start] <= windowS) end++;
    if (end - start > 1) {
      const v = term(start, end);
      if (v !== null && v > best) best = v;
    }
    start++;
    if (end < start) end = start;
  }
  return best;
}

export function extractFeatures(direction, trace) {
  const time = Float64Array.from(trace.t);
  let angVel = Float64Array.from(trace.y);
  if (!time.length) throw new Error("Velocity trace is empty.");

  const omegaBric = 42.05, alphaBric = 363268.91, lambda = 0.37;
  const omegaBricScaled = omegaBric / lambda, alphaBricScaled = alphaBric / lambda;
  const criticalOmega = [66.2, 59.1, 44.2].map((c) => c / lambda); // pig-scaled: axial, sagittal, coronal
  const omegaCr = criticalOmega[directionToCode(direction) - 1];

  let mn = Infinity, mx = -Infinity;
  for (const v of angVel) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (Math.abs(mn) > Math.abs(mx)) angVel = angVel.map((v) => -v);

  const gv = gradient(angVel), gt = gradient(time);
  const angAcc = gv.map((v, i) => v / gt[i]);
  const ga = gradient(angAcc);
  const angJerk = ga.map((v, i) => v / gt[i]);

  const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const maxVel = maxAbs(angVel), maxAcc = maxAbs(angAcc), maxJerk = maxAbs(angJerk);
  if (maxVel === 0) throw new Error("Velocity trace has zero peak velocity. Features cannot be extracted.");

  const BRIC = maxVel / omegaBricScaled + maxAcc / alphaBricScaled;
  const BrIC = maxVel / omegaCr;

  const n = time.length;
  const totalDuration = time[n - 1] - time[0];
  if (totalDuration <= 0) throw new Error("Velocity trace time duration must be greater than zero.");
  const accAbs = angAcc.map(Math.abs);

  let RIC;
  if (totalDuration <= 0.036) {
    const integral = trapz(accAbs, time);
    RIC = Math.pow(integral / totalDuration, 2.5) * totalDuration;
  } else {
    RIC = slidingMax(time, 0.036, (i0, i1) => {
      const dt = time[i1 - 1] - time[i0];
      if (!(dt > 0)) return null;
      return Math.pow(trapz(accAbs, time, i0, i1) / dt, 2.5) * dt;
    }, 0.0);
  }
  const RVCI = slidingMax(time, 0.01, (i0, i1) => Math.sqrt(1.0 * Math.pow(trapz(angAcc, time, i0, i1), 2)), 0.0);

  let peakIdx = 0, peakAbs = -1;
  for (let i = 0; i < n; i++) { const a = Math.abs(angVel[i]); if (a > peakAbs) { peakAbs = a; peakIdx = i; } }
  const peakTime = time[peakIdx];
  const threshold = 0.02 * maxVel;

  let accelerationTime = NaN, decelerationTime = NaN;
  let lastPre = -1;
  for (let i = 0; i <= peakIdx; i++) if (Math.abs(angVel[i]) <= threshold) lastPre = i;
  if (lastPre >= 0) accelerationTime = peakTime - time[lastPre];
  for (let i = peakIdx; i < n; i++) {
    if (Math.abs(angVel[i]) <= threshold) { decelerationTime = time[i] - peakTime; break; }
  }
  const totalCurve = accelerationTime + decelerationTime;
  const area = trapz(angVel, time);

  const vector = Float64Array.from([
    BRIC, RIC, BrIC, RVCI, maxVel, maxAcc, accelerationTime, decelerationTime, totalCurve,
    maxVel ** 2, maxVel ** 3, maxAcc ** 2, maxAcc ** 3, area, maxJerk,
  ]);
  return { vector, byName: Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, vector[i]])) };
}
