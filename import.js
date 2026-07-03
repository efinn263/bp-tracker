/* ── Importer: CSV / XLSX / JSON ── */
const Importer = (() => {

  function nk(k) { return String(k).toLowerCase().trim().replace(/[\s_\-]+/g, ''); }

  function normalize(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[nk(k)] = v;
    return out;
  }

  /* Detect long format: has a "metric" column with sys/dia/bpm values */
  function isLong(rows) {
    if (!rows.length) return false;
    const keys = Object.keys(rows[0]).map(nk);
    return keys.includes('metric') && keys.includes('value');
  }

  /* Parse timestamp from various common formats */
  function parseTs(val) {
    if (!val) return null;
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
    const d = new Date(String(val).replace(' ', 'T').replace('Z','').endsWith('Z') ? val : val + 'Z');
    if (!isNaN(d)) return d.getTime();
    const d2 = new Date(String(val));
    return isNaN(d2) ? null : d2.getTime();
  }

  /* Pivot long format → one reading per timestamp */
  function pivotLong(rows) {
    const map = {};
    for (const row of rows) {
      const r      = normalize(row);
      const metric = String(r.metric || '').toLowerCase().trim();
      const val    = parseFloat(r.value);
      const ts     = parseTs(r.time || r.datetime || r.date || r.timestamp);
      if (!ts || isNaN(val)) continue;

      if (!map[ts]) map[ts] = { timestamp: ts, systolic: null, diastolic: null, bpm: null };
      if (['sys','systolic','sbp'].includes(metric))        map[ts].systolic  = val;
      else if (['dia','diastolic','dbp'].includes(metric))  map[ts].diastolic = val;
      else if (['bpm','pulse','hr','heartrate','heart rate'].includes(metric)) map[ts].bpm = val;
    }
    return Object.values(map)
      .filter(r => r.systolic || r.diastolic || r.bpm)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /* Parse wide format: one row per reading with named value columns */
  function parseWide(rows) {
    return rows.map(row => {
      const r  = normalize(row);
      const ts = parseTs(r.time || r.datetime || r.date || r.timestamp);
      if (!ts) return null;
      return {
        timestamp: ts,
        systolic:  parseFloat(r.systolic  || r.sys || r.sbp) || null,
        diastolic: parseFloat(r.diastolic || r.dia || r.dbp) || null,
        bpm:       parseFloat(r.bpm       || r.pulse || r.hr || r.heartrate) || null,
        notes:     r.notes || r.note || null,
      };
    }).filter(r => r && (r.systolic || r.diastolic || r.bpm));
  }

  function process(rows) {
    if (!rows.length) return [];
    return isLong(rows) ? pivotLong(rows) : parseWide(rows);
  }

  return {
    getType(file) {
      const n = file.name.toLowerCase();
      if (n.endsWith('.csv'))  return 'csv';
      if (n.endsWith('.xlsx') || n.endsWith('.xls')) return 'xlsx';
      if (n.endsWith('.json')) return 'json';
      return null;
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
