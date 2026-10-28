// Python-compatible number formatting so exported CSVs match the desktop app byte for byte.

/** repr(float) as Python prints it: shortest round-trip digits, exponent only when exp < -4 or >= 16. */
export function pyFloat(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = x.toExponential().split("e"); // shortest unique digits
  const exp = parseInt(expStr, 10);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let s;
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const e = Math.abs(exp);
    s = m + "e" + (exp < 0 ? "-" : "+") + (e < 10 ? "0" + e : String(e));
  } else if (exp >= 0) {
    if (digits.length <= exp + 1) s = digits.padEnd(exp + 1, "0") + ".0";
    else s = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  } else {
    s = "0." + "0".repeat(-exp - 1) + digits;
  }
  return neg ? "-" + s : s;
}

/** Quote a CSV cell the way Python's csv.writer does (QUOTE_MINIMAL). */
export function csvCell(v) {
  const s = typeof v === "number" ? pyFloat(v) : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\r\n"; // csv.writer default line terminator
}
