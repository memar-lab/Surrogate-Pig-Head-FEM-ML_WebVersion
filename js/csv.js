// Minimal RFC-4180 CSV reader plus the named-column loader used by the input traces.

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Read the requested columns as Float64Arrays; blank rows and blank cells are skipped. */
export function readNamedColumns(text, wanted, label = "File") {
  const rows = parseCSV(text).filter((r) => r.length > 0 && r.some((c) => c.trim() !== ""));
  if (!rows.length) throw new Error(`${label} is empty.`);
  const header = rows[0].map((h) => h.trim());
  const out = {};
  for (const name of wanted) {
    const idx = header.indexOf(name);
    if (idx < 0) throw new Error(`${label} is missing the required column: ${name}`);
    const vals = [];
    for (const r of rows.slice(1)) {
      if (r.length >= idx + 1) {
        const cell = r[idx].trim();
        if (cell !== "") {
          const v = Number(cell);
          if (Number.isNaN(v) && !/^nan$/i.test(cell)) throw new Error(`${label}: cannot read "${cell}" as a number in column ${name}.`);
          vals.push(v);
        }
      }
    }
    out[name] = Float64Array.from(vals);
  }
  return out;
}
