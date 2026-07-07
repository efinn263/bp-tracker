/* ── Importer: CSV / XLSX / JSON ── */
const Importer = (() => {

  function nk(k) { return String(k).toLowerCase().trim().replace(/[\s_\-]+/g, ''); }

  function normalize(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[nk(k)] = v;
    return out;
  }

  /* Fuzzy-match a metric/column name against systolic/diastolic/bpm,
     tolerating abbreviations and minor typos (e.g. "sis", "sys", "systolic",
     "sbp", "dia", "dbp", "pulse", "hr", "heart rate"). */
  function classifyMetric(raw) {
    const m = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!m) return null;
    if (/^(sys|sis|sbp|systo)/.test(m))          return 'systolic';
    if (/^(dia|dis|dbp|diasto)/.test(m))         return 'diastolic';
    if (/(bpm|puls|heart|^hr$)/.test(m))         return 'bpm';
    return null;
  }

  function classifyNote(raw) {
    const m = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    return /^(notes?|comments?|remarks?)$/.test(m);
  }

  /* Detect long format: has a "metric" column with sys/dia/bpm values */
  function isLong(rows) {
    if (!rows.length) return false;
    const keys = Object.keys(rows[0]).map(nk);
    return keys.includes('metric') && keys.includes('value');
  }

  /* Strip a stray trailing "Z" — some historical exports append a bogus "Z"
     that doesn't actually mean UTC. Drop it and read the date/time literally. */
  function stripStrayZ(s) {
    return s.replace(/\s*Z\s*$/i, '');
  }

  /* Parse timestamp from various common formats: ISO with space or T
     separator, 24-hour times, long day-name formats ("Monday, June 22,
     2026 14:30:00"), Excel serial dates, Unix timestamps, and a stray
     trailing "Z" that should just be discarded rather than forcing UTC. */
  function parseTs(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number') {
      // Could be an Excel serial date or a Unix timestamp
      if (val > 1e12) return val; // already ms
      if (val > 2e4 && val < 1e6) {
        // Excel serial date (days since 1900-01-01, with Lotus bug)
        return (val - 25569) * 86400000;
      }
      return val * 1000;
    }
    if (val instanceof Date) return isNaN(val) ? null : val.getTime();

    let s = stripStrayZ(String(val).trim());
    if (!s) return null;

    // yyyy-mm-dd HH:mm(:ss)? — treat the space as a literal separator and
    // read the date/time as-is (no timezone conversion).
    let d = new Date(s.replace(' ', 'T'));
    if (!isNaN(d)) return d.getTime();

    // Fallback to native parsing — handles long day-name / month-name
    // formats and anything else the substitution above didn't cover.
    d = new Date(s);
    if (!isNaN(d)) return d.getTime();

    return null;
  }

  /* Combine separate date + time columns if both are present and distinct,
     otherwise fall back to whichever single date/time-like column exists. */
  function extractTimestamp(r) {
    if (r.date != null && r.time != null && String(r.date) !== String(r.time)) {
      const combined = parseTs(`${r.date} ${r.time}`);
      if (combined != null) return combined;
    }
    return parseTs(r.time ?? r.datetime ?? r.date ?? r.timestamp);
  }

  /* Pivot long format → one reading per timestamp */
  function pivotLong(rows) {
    const map = {};
    for (const row of rows) {
      const r      = normalize(row);
      const type   = classifyMetric(r.metric);
      const val    = parseFloat(r.value);
      const ts     = extractTimestamp(r);
      if (!ts || !type || isNaN(val)) continue;

      if (!map[ts]) map[ts] = { timestamp: ts, systolic: null, diastolic: null, bpm: null };
      map[ts][type] = val;
    }
    return Object.values(map)
      .filter(r => r.systolic || r.diastolic || r.bpm)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /* Parse wide format: one row per reading with named value columns.
     Scans all column names for fuzzy sys/dia/bpm matches rather than a
     fixed alias list, so odd headers and minor typos still work. */
  function parseWide(rows) {
    return rows.map(row => {
      const r  = normalize(row);
      const ts = extractTimestamp(r);
      if (!ts) return null;

      const out = { timestamp: ts, systolic: null, diastolic: null, bpm: null, notes: null };
      for (const [k, v] of Object.entries(r)) {
        if (v === '' || v == null) continue;
        const type = classifyMetric(k);
        if (type) {
          const n = parseFloat(v);
          if (!isNaN(n)) out[type] = n;
        } else if (classifyNote(k)) {
          out.notes = String(v);
        }
      }
      return out;
    }).filter(r => r && (r.systolic || r.diastolic || r.bpm));
  }

  /* Drop exact duplicate readings (same timestamp + same values) */
  function dedupe(readings) {
    const seen = new Set();
    const out = [];
    let duplicatesSkipped = 0;
    for (const r of readings) {
      const key = `${r.timestamp}|${r.systolic}|${r.diastolic}|${r.bpm}`;
      if (seen.has(key)) { duplicatesSkipped++; continue; }
      seen.add(key);
      out.push(r);
    }
    return { readings: out, duplicatesSkipped };
  }

  function process(rows) {
    if (!rows.length) return { readings: [], duplicatesSkipped: 0 };
    const parsed = isLong(rows) ? pivotLong(rows) : parseWide(rows);
    return dedupe(parsed);
  }

  return {
    getType(file) {
      const n = file.name.toLowerCase();
      if (n.endsWith('.csv'))  return 'csv';
      if (n.endsWith('.xlsx') || n.endsWith('.xls')) return 'xlsx';
      if (n.endsWith('.json')) return 'json';
      return null;
    },

    /* Compare a batch of readings against an existing set and split out
       exact duplicates (same timestamp + same systolic/diastolic/bpm). */
    dedupeAgainst(newReadings, existingReadings) {
      const existingKeys = new Set(existingReadings.map(r =>
        `${r.timestamp}|${r.systolic}|${r.diastolic}|${r.bpm}`));
      const toAdd = [];
      let duplicatesSkipped = 0;
      for (const r of newReadings) {
        const key = `${r.timestamp}|${r.systolic}|${r.diastolic}|${r.bpm}`;
        if (existingKeys.has(key)) { duplicatesSkipped++; continue; }
        existingKeys.add(key);
        toAdd.push(r);
      }
      return { readings: toAdd, duplicatesSkipped };
    },

    fromCSV(file) {
      return new Promise((res, rej) => {
        Papa.parse(file, {
          header: true, skipEmptyLines: true,
          complete: r => res(process(r.data)),
          error: rej,
        });
      });
    },

    fromXLSX(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = e => {
          try {
            const wb   = XLSX.read(e.target.result, { type: 'array', cellDates: true });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { raw: false, dateNF: 'yyyy-mm-dd HH:mm:ss' });
            res(process(rows));
          } catch (err) { rej(err); }
        };
        fr.onerror = rej;
        fr.readAsArrayBuffer(file);
      });
    },

    fromJSON(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = e => {
          try { res(JSON.parse(e.target.result)); }
          catch (err) { rej(err); }
        };
        fr.onerror = rej;
        fr.readAsText(file);
      });
    },
  };
})();
