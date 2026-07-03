/* ── BP Tracker — Main App ── */
const App = (() => {

  const S = {
    view:        'dashboard',
    range:       '30d',
    customStart: null,
    customEnd:   null,
    chart:       null,
  };

  /* ─── Utilities ─── */

  function uuid()  { return crypto.randomUUID(); }
  function avg(arr, key) {
    const vals = arr.map(r => r[key]).filter(v => v != null && !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function round(v, d = 0) { return v == null ? null : +v.toFixed(d); }

  function fmtDT(ts) {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  function isoNow(ts) {
    const d = ts ? new Date(ts) : new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function getRangeTs() {
    const now = Date.now();
    const d   = { '7d':7,'14d':14,'30d':30,'90d':90 };
    if (S.range === 'all')    return { start: null, end: null };
    if (S.range === 'custom') return {
      start: S.customStart ? new Date(S.customStart).getTime() : null,
      end:   S.customEnd   ? new Date(S.customEnd).getTime()   : now,
    };
    return { start: now - (d[S.range] || 30) * 86400000, end: now };
  }

  function toast(msg, type = '') {
    const c  = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function svgX() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  }
  function svgChev() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`;
  }
  function svgDL() {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;
  }
  function svgTrash() {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ─── Navigation ─── */

  function setView(view) {
    S.view = view;
    document.querySelectorAll('.nav-item').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view)
    );
    render();
  }

  function render() {
    const main = document.getElementById('main');
    ({ dashboard: renderDashboard,
       add:       renderAdd,
       meds:      renderMeds,
       import:    renderImport,
       settings:  renderSettings,
    }[S.view] || renderDashboard)(main);
  }

  /* ─── Dashboard ─── */

  async function renderDashboard(main) {
    const { start, end } = getRangeTs();
    const [readings, medEvents, allR] = await Promise.all([
      DB.getReadings(start, end),
      DB.getMedEvents(start, end),
      DB.getReadings(),
    ]);

    const latest  = allR.sort((a,b) => a.timestamp - b.timestamp).at(-1);
    const avgSys  = round(avg(readings, 'systolic'));
    const avgDia  = round(avg(readings, 'diastolic'));
    const avgBpm  = round(avg(readings, 'bpm'));

    const ranges = ['7d','14d','30d','90d','all'];
    const rangeLbl = { '7d':'7D','14d':'14D','30d':'30D','90d':'90D','all':'All','custom':'Custom' };

    main.innerHTML = `
      <div class="range-tabs" id="range-tabs">
        ${ranges.map(r => `<button class="rtab${S.range===r?' active':''}" data-range="${r}">${rangeLbl[r]}</button>`).join('')}
      </div>

      <div class="sec">
        <div class="card">
          <div class="chart-wrap"><canvas id="chart"></canvas></div>
          <div class="chart-controls">
            <span class="chart-hint">Pinch or scroll to zoom · Drag to pan</span>
            <button class="zoom-reset" id="zoom-reset">Reset zoom</button>
          </div>
          <div class="legend">
            <div class="legend-item"><div class="l-line" style="background:var(--sys)"></div>Systolic</div>
            <div class="legend-item"><div class="l-line" style="background:var(--dia)"></div>Diastolic</div>
            <div class="legend-item"><div class="l-line" style="background:var(--bpm);border-top:2px dashed var(--bpm);height:0"></div>BPM</div>
            <div class="legend-item"><div class="l-dot"  style="background:var(--med)"></div>Medication</div>
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="stat-grid">
          <div class="stat-chip"><div class="stat-label">Systolic avg</div><div class="stat-val sys">${avgSys ?? '—'}</div></div>
          <div class="stat-chip"><div class="stat-label">Diastolic avg</div><div class="stat-val dia">${avgDia ?? '—'}</div></div>
          <div class="stat-chip"><div class="stat-label">BPM avg</div><div class="stat-val bpm">${avgBpm ?? '—'}</div></div>
        </div>
      </div>

      ${latest ? `
      <div class="sec">
        <div class="card">
          <div class="card-hdr">Latest Reading</div>
          <div class="card-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;color:var(--text-3);margin-bottom:3px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">SYS / DIA</div>
              <div style="font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1">
                <span style="color:var(--sys)">${latest.systolic ?? '—'}</span><span style="color:var(--text-3);font-size:20px;font-weight:400">/</span><span style="color:var(--dia)">${latest.diastolic ?? '—'}</span>
              </div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-3);margin-bottom:3px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">BPM</div>
              <div style="font-size:28px;font-weight:800;color:var(--bpm);line-height:1">${latest.bpm ?? '—'}</div>
            </div>
            <div style="flex:1;min-width:80px;text-align:right">
              <div style="font-size:12px;color:var(--text-2)">${fmtDT(latest.timestamp)}</div>
              ${latest.notes ? `<div style="font-size:11px;color:var(--text-3);margin-top:3px">${latest.notes}</div>` : ''}
            </div>
          </div>
        </div>
      </div>` : ''}

      <div class="sec">
        <div class="card">
          <div class="card-hdr">Readings (${readings.length})</div>
          ${readings.length ? `
          <div id="readings-list">
            ${[...readings].reverse().slice(0,60).map(r => `
            <div class="reading-row">
              <div class="reading-time">
                <div class="d">${fmtDate(r.timestamp)}</div>
                <div class="d">${fmtTime(r.timestamp)}</div>
              </div>
              <div class="reading-vals">
                <span class="rv sys">${r.systolic ?? '—'}<span class="u"> sys</span></span>
                <span class="rv dia">${r.diastolic ?? '—'}<span class="u"> dia</span></span>
                <span class="rv bpm">${r.bpm ?? '—'}<span class="u"> bpm</span></span>
              </div>
              ${r.notes ? `<div style="font-size:11px;color:var(--text-3);flex:0 0 100%">${r.notes}</div>` : ''}
              <button class="del-btn" data-del-reading="${r.id}" title="Delete">${svgX()}</button>
            </div>`).join('')}
            ${readings.length > 60 ? `<div style="padding:10px 16px;text-align:center;font-size:12px;color:var(--text-3)">Showing latest 60 of ${readings.length}</div>` : ''}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">📊</div>
            <div class="empty-title">No readings in this range</div>
            <div class="empty-text">Add a reading manually or import from your device</div>
          </div>`}
        </div>
      </div>
    `;

    initChart(readings, medEvents);

    document.getElementById('range-tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-range]');
      if (b) { S.range = b.dataset.range; renderDashboard(main); }
    });
    document.getElementById('zoom-reset')?.addEventListener('click', () => S.chart?.resetZoom());
    main.querySelectorAll('[data-del-reading]').forEach(btn =>
      btn.addEventListener('click', async () => {
        await DB.deleteReading(btn.dataset.delReading);
        toast('Reading deleted');
        renderDashboard(main);
      })
    );
  }

  /* ─── Chart ─── */

  function initChart(readings, medEvents) {
    const canvas = document.getElementById('chart');
    if (!canvas) return;
    if (S.chart) { S.chart.destroy(); S.chart = null; }

    const radius = readings.length < 80 ? 4 : 2;

    const sysD = readings.filter(r => r.systolic  != null).map(r => ({ x: r.timestamp, y: r.systolic  }));
    const diaD = readings.filter(r => r.diastolic != null).map(r => ({ x: r.timestamp, y: r.diastolic }));
    const bpmD = readings.filter(r => r.bpm       != null).map(r => ({ x: r.timestamp, y: r.bpm       }));
    const medD = medEvents.map(e => ({ x: e.timestamp, y: 185, label: e.medication || 'Med' }));

    const lineOpts = (color, dash = false) => ({
      borderColor: color,
      backgroundColor: color + '18',
      borderWidth: 2,
      borderDash: dash ? [6, 3] : [],
      pointRadius: radius,
      pointHoverRadius: radius + 3,
      pointBackgroundColor: color,
      tension: 0.3,
      fill: false,
    });

    S.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          { label: 'Systolic',  data: sysD, ...lineOpts('#c05252') },
          { label: 'Diastolic', data: diaD, ...lineOpts('#3b7bbf') },
          { label: 'BPM',       data: bpmD, ...lineOpts('#4a9068', true) },
          {
            label: 'Medication',
            data: medD,
            type: 'scatter',
            pointStyle: 'triangle',
            pointRadius: 9,
            pointHoverRadius: 12,
            backgroundColor: 'rgba(139,92,246,.75)',
            borderColor: 'rgba(139,92,246,1)',
            borderWidth: 1,
            showLine: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'time',
            time: {
              displayFormats: {
                minute: 'MMM d HH:mm',
                hour:   'MMM d HH:mm',
                day:    'MMM d',
                week:   'MMM d',
                month:  'MMM yy',
              },
            },
            grid:  { color: 'rgba(0,0,0,.04)' },
            ticks: { font: { family: 'system-ui,sans-serif', size: 10 }, color: '#9b9895', maxTicksLimit: 6, maxRotation: 0 },
          },
          y: {
            suggestedMin: 40,
            suggestedMax: 200,
            grid:  { color: 'rgba(0,0,0,.04)' },
            ticks: { font: { family: 'system-ui,sans-serif', size: 10 }, color: '#9b9895' },
            title: { display: true, text: 'mmHg / BPM', font: { size: 10 }, color: '#9b9895' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1916',
            titleFont: { family: 'system-ui,sans-serif', size: 11 },
            bodyFont:  { family: 'system-ui,sans-serif', size: 12 },
            padding: 10, cornerRadius: 8, displayColors: true,
            callbacks: {
              title: items => items.length
                ? new Date(items[0].raw.x).toLocaleString('en-US', { month:'short',day:'numeric',hour:'2-digit',minute:'2-digit' })
                : '',
              label: ctx => {
                if (ctx.dataset.label === 'Medication') return ` 💊 ${ctx.raw.label}`;
                return ` ${ctx.dataset.label}: ${ctx.raw.y}`;
              },
            },
          },
          zoom: {
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
            pan:  { enabled: true, mode: 'x' },
          },
        },
      },
    });
  }

  /* ─── Add Reading ─── */

  function renderAdd(main) {
    main.innerHTML = `
      <div class="vtitle">Add Reading</div>
      <div class="vsub">Enter your blood pressure and heart rate measurements</div>
      <div class="form">
        <div class="fg">
          <label class="flabel">Date &amp; Time</label>
          <input type="datetime-local" class="finput" id="r-dt" value="${isoNow()}">
        </div>
        <div class="frow-3">
          <div class="fg">
            <label class="flabel" style="color:var(--sys)">Systolic</label>
            <input type="number" class="finput" id="r-sys" placeholder="120" min="50" max="300">
          </div>
          <div class="fg">
            <label class="flabel" style="color:var(--dia)">Diastolic</label>
            <input type="number" class="finput" id="r-dia" placeholder="80" min="30" max="200">
          </div>
          <div class="fg">
            <label class="flabel" style="color:var(--bpm)">BPM</label>
            <input type="number" class="finput" id="r-bpm" placeholder="70" min="20" max="300">
          </div>
        </div>
        <div class="fg">
          <label class="flabel">Notes (optional)</label>
          <input type="text" class="finput" id="r-notes" placeholder="After exercise, feeling stressed…">
        </div>
        <button class="btn btn-primary btn-full" id="save-r">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
          Save Reading
        </button>
      </div>
    `;

    document.getElementById('save-r').addEventListener('click', async () => {
      const dt  = document.getElementById('r-dt').value;
      const sys = parseFloat(document.getElementById('r-sys').value);
      const dia = parseFloat(document.getElementById('r-dia').value);
      const bpm = parseFloat(document.getElementById('r-bpm').value);
      const notes = document.getElementById('r-notes').value.trim();

      if (!dt)                          { toast('Please enter a date and time', 'err'); return; }
      if (isNaN(sys) && isNaN(dia) && isNaN(bpm)) { toast('Enter at least one measurement', 'err'); return; }

      await DB.addReading({
        timestamp: new Date(dt).getTime(),
        systolic:  isNaN(sys) ? null : sys,
        diastolic: isNaN(dia) ? null : dia,
        bpm:       isNaN(bpm) ? null : bpm,
        notes:     notes || null,
      });
      toast('Reading saved!', 'ok');
      setView('dashboard');
    });
  }

  /* ─── Medications ─── */

  async function renderMeds(main) {
    const [medEvents, allReadings] = await Promise.all([
      DB.getMedEvents(), DB.getReadings()
    ]);

    const events = await Promise.all(medEvents.map(async ev => {
      const winBefore = (ev.baselineWindow  || 30) * 60000;
      const winAfter  = (ev.postDoseWindow  || 45) * 60000;
      const ts = ev.timestamp;

      const before = allReadings.filter(r => r.timestamp >= ts - winBefore && r.timestamp <= ts);
      const after  = allReadings.filter(r => r.timestamp >  ts && r.timestamp <= ts + winAfter);

      const bSys = round(avg(before, 'systolic'),  1);
      const bDia = round(avg(before, 'diastolic'), 1);
      const pSys = round(avg(after,  'systolic'),  1);
      const pDia = round(avg(after,  'diastolic'), 1);

      const sysRed = (bSys != null && pSys != null) ? round((bSys - pSys) / bSys * 100, 1) : null;
      const diaRed = (bDia != null && pDia != null) ? round((bDia - pDia) / bDia * 100, 1) : null;

      return { ...ev, bSys, bDia, pSys, pDia, sysRed, diaRed };
    }));

    function redBadge(val, label) {
      if (val == null) return '';
      const cls = val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu';
      const arrow = val > 0 ? '↓' : '↑';
      return `<span class="reduction ${cls}">${label} ${arrow}${Math.abs(val)}%</span>`;
    }

    main.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 16px 2px">
        <div style="font-size:22px;font-weight:800;letter-spacing:-.5px">Medications</div>
        <button class="btn btn-secondary btn-sm" id="toggle-med-form">+ Log Dose</button>
      </div>
      <div class="vsub">Track dose timing and measure BP reduction effect</div>

      <div class="sec" id="med-form-sec" style="display:none">
        <div class="form-panel">
          <div class="form-panel-body open">
            <div class="form">
              <div class="frow">
                <div class="fg">
                  <label class="flabel">Medication</label>
                  <input type="text" class="finput" id="m-med" placeholder="Lisinopril">
                </div>
                <div class="fg">
                  <label class="flabel">Dose</label>
                  <input type="text" class="finput" id="m-dose" placeholder="10mg">
                </div>
              </div>
              <div class="fg">
                <label class="flabel">Date &amp; Time Taken</label>
                <input type="datetime-local" class="finput" id="m-dt" value="${isoNow()}">
              </div>
              <div class="frow">
                <div class="fg">
                  <label class="flabel">Baseline window</label>
                  <input type="number" class="finput" id="m-before" value="30" min="5" max="480">
                  <span class="fhelp">Minutes before dose</span>
                </div>
                <div class="fg">
                  <label class="flabel">Post-dose window</label>
                  <input type="number" class="finput" id="m-after" value="45" min="5" max="720">
                  <span class="fhelp">Minutes after dose</span>
                </div>
              </div>
              <div class="fg">
                <label class="flabel">Notes (optional)</label>
                <input type="text" class="finput" id="m-notes" placeholder="Any observations…">
              </div>
              <button class="btn btn-primary btn-full" id="save-med">Save Medication Event</button>
            </div>
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="card">
          ${events.length ? `
          <div>
            ${[...events].reverse().map(ev => `
            <div class="med-event">
              <div class="med-hdr">
                <div>
                  <div class="med-name">${ev.medication || 'Medication'} <span class="med-dose">${ev.dose || ''}</span></div>
                  <div class="med-time">${fmtDT(ev.timestamp)} · ${ev.baselineWindow}min before / ${ev.postDoseWindow}min after</div>
                </div>
                <button class="del-btn" data-del-med="${ev.id}">${svgX()}</button>
              </div>
              <div class="med-bp-grid">
                <div class="med-bp-block">
                  <div class="med-bp-lbl">Baseline</div>
                  <div class="med-bp-val">
                    <span style="color:var(--sys)">${ev.bSys ?? '—'}</span>
                    <span style="color:var(--text-3)">/</span>
                    <span style="color:var(--dia)">${ev.bDia ?? '—'}</span>
                    <span style="font-size:10px;color:var(--text-3)"> mmHg</span>
                  </div>
                </div>
                <div class="med-bp-block">
                  <div class="med-bp-lbl">Post-dose</div>
                  <div class="med-bp-val">
                    <span style="color:var(--sys)">${ev.pSys ?? '—'}</span>
                    <span style="color:var(--text-3)">/</span>
                    <span style="color:var(--dia)">${ev.pDia ?? '—'}</span>
                    <span style="font-size:10px;color:var(--text-3)"> mmHg</span>
                  </div>
                </div>
              </div>
              <div class="med-reductions">
                ${ev.sysRed != null || ev.diaRed != null
                  ? redBadge(ev.sysRed, 'Sys') + redBadge(ev.diaRed, 'Dia')
                  : '<span class="reduction neu">No readings in windows</span>'}
              </div>
              ${ev.notes ? `<div style="margin-top:6px;font-size:12px;color:var(--text-2)">${ev.notes}</div>` : ''}
            </div>`).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">💊</div>
            <div class="empty-title">No medication events yet</div>
            <div class="empty-text">Log when you take medication to track how much it lowers your blood pressure</div>
          </div>`}
        </div>
      </div>
    `;

    document.getElementById('toggle-med-form').addEventListener('click', () => {
      const sec = document.getElementById('med-form-sec');
      const open = sec.style.display !== 'none';
      sec.style.display = open ? 'none' : 'block';
      document.getElementById('toggle-med-form').textContent = open ? '+ Log Dose' : '✕ Cancel';
    });

    document.getElementById('save-med')?.addEventListener('click', async () => {
      const med    = document.getElementById('m-med').value.trim();
      const dose   = document.getElementById('m-dose').value.trim();
      const dt     = document.getElementById('m-dt').value;
      const before = parseInt(document.getElementById('m-before').value) || 30;
      const after  = parseInt(document.getElementById('m-after').value)  || 45;
      const notes  = document.getElementById('m-notes').value.trim();

      if (!med || !dt) { toast('Enter medication name and time', 'err'); return; }

      await DB.addMedEvent({
        timestamp:      new Date(dt).getTime(),
        medication:     med,
        dose:           dose || null,
        baselineWindow: before,
        postDoseWindow: after,
        notes:          notes || null,
      });
      toast('Medication event saved!', 'ok');
      renderMeds(main);
    });

    main.querySelectorAll('[data-del-med]').forEach(btn =>
      btn.addEventListener('click', async () => {
        await DB.deleteMedEvent(btn.dataset.delMed);
        toast('Event deleted');
        renderMeds(main);
      })
    );
  }

  /* ─── Import ─── */

  function renderImport(main) {
    main.innerHTML = `
      <div class="vtitle">Import Data</div>
      <div class="vsub">Import readings from your device export or health app</div>

      <div class="sec">
        <div class="dropzone" id="dz">
          <input type="file" id="file-in" accept=".csv,.xlsx,.xls,.json">
          <div class="dz-icon">📂</div>
          <div class="dz-title">Tap to browse files</div>
          <div class="dz-sub">or drag &amp; drop here</div>
          <div class="dz-fmts">CSV · XLSX / XLS · JSON backup</div>
        </div>
      </div>

      <div id="import-preview" class="sec" style="padding-top:0"></div>

      <div class="sec" style="padding-top:0">
        <div class="card">
          <div class="card-hdr">Format Guide</div>
          <div class="card-body" style="font-size:13px;color:var(--text-2);line-height:1.7">
            <p><strong style="color:var(--text-1)">Long format (Pressure XS Pro export):</strong> Device, Metric, Value, Time columns — imported directly, no changes needed.</p>
            <p style="margin-top:8px"><strong style="color:var(--text-1)">Wide format:</strong> One row per reading with Systolic, Diastolic, BPM, Time columns.</p>
            <p style="margin-top:8px"><strong style="color:var(--text-1)">JSON backup:</strong> A backup file previously exported from this app (includes medication events).</p>
          </div>
        </div>
      </div>
    `;

    const dz = document.getElementById('dz');
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
    document.getElementById('file-in').addEventListener('change', e => handleFile(e.target.files[0]));

    async function handleFile(file) {
      if (!file) return;
      const preview = document.getElementById('import-preview');
      preview.innerHTML = `<div class="card"><div class="card-body" style="color:var(--text-2);font-size:13px">Reading <strong>${file.name}</strong>…</div></div>`;

      try {
        const type = Importer.getType(file);
        if (!type) { toast('Unsupported file type', 'err'); preview.innerHTML = ''; return; }

        let importData, readings = [], isBackup = false;

        if (type === 'json') {
          importData = await Importer.fromJSON(file);
          if (importData?.version && Array.isArray(importData.readings)) {
            isBackup = true;
            readings = importData.readings;
          } else {
            readings = Array.isArray(importData) ? importData : [];
          }
        } else {
          readings = type === 'csv'
            ? await Importer.fromCSV(file)
            : await Importer.fromXLSX(file);
          importData = { readings };
        }

        if (!readings.length) {
          toast('No valid readings found in file', 'err');
          preview.innerHTML = '';
          return;
        }

        const n = readings.length;
        preview.innerHTML = `
          <div class="card">
            <div class="card-body">
              <div style="font-size:15px;font-weight:700;margin-bottom:10px">
                Found <span style="color:var(--accent)">${n} reading${n!==1?'s':''}</span>${isBackup && importData.medEvents?.length ? ` + ${importData.medEvents.length} medication event${importData.medEvents.length!==1?'s':''}` : ''}
              </div>
              ${readings.slice(0,4).map(r => `
              <div class="import-row">
                ${new Date(r.timestamp).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                &nbsp;—&nbsp;
                <span style="color:var(--sys)">${r.systolic ?? '—'}</span>/<span style="color:var(--dia)">${r.diastolic ?? '—'}</span> mmHg
                &nbsp;<span style="color:var(--bpm)">${r.bpm ?? '—'}</span> bpm
              </div>`).join('')}
              ${n > 4 ? `<div style="font-size:12px;color:var(--text-3);padding-top:6px">…and ${n-4} more</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
                <button class="btn btn-primary" id="do-replace">Replace all &amp; import</button>
                <button class="btn btn-secondary" id="do-merge">Merge with existing</button>
              </div>
            </div>
          </div>
        `;

        document.getElementById('do-replace').addEventListener('click', async () => {
          await DB.importAll(importData, false);
          toast(`Imported ${n} readings`, 'ok');
          preview.innerHTML = '';
          setView('dashboard');
        });
        document.getElementById('do-merge').addEventListener('click', async () => {
          await DB.importAll(importData, true);
          toast(`Merged ${n} readings`, 'ok');
          preview.innerHTML = '';
          setView('dashboard');
        });

      } catch (err) {
        console.error(err);
        toast('Error reading file — check format', 'err');
        preview.innerHTML = '';
      }
    }
  }

  /* ─── Settings ─── */

  async function renderSettings(main) {
    const count = await DB.countReadings();
    main.innerHTML = `
      <div class="vtitle">Settings</div>

      <div class="sec">
        <div class="card">
          <div class="card-hdr">Export Data</div>
          <div class="setting-row" id="exp-csv">
            <div class="sr-info">
              <div class="sr-label">Export as CSV</div>
              <div class="sr-desc">Spreadsheet with all readings — open in Excel or Sheets</div>
            </div>${svgDL()}
          </div>
          <div class="setting-row" id="exp-json">
            <div class="sr-info">
              <div class="sr-label">Export full backup (JSON)</div>
              <div class="sr-desc">Includes readings + medication events — use to restore or migrate</div>
            </div>${svgDL()}
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="card">
          <div class="card-hdr">Storage</div>
          <div class="setting-row" style="cursor:default">
            <div class="sr-info">
              <div class="sr-label">Readings stored</div>
              <div class="sr-desc">All data is stored locally on this device</div>
            </div>
            <span class="badge">${count}</span>
          </div>
          <div class="setting-row" id="clear-data">
            <div class="sr-info">
              <div class="sr-label" style="color:var(--sys)">Clear all data</div>
              <div class="sr-desc">Permanently delete readings and medication events</div>
            </div>
            ${svgTrash()}
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="card">
          <div class="card-hdr">About</div>
          <div class="card-body" style="font-size:13px;color:var(--text-2);line-height:1.7">
            <p><strong style="color:var(--text-1)">BP Tracker</strong> — Blood pressure &amp; heart rate monitoring.</p>
            <p style="margin-top:6px">Data stays on your device. No account, no cloud, no tracking.</p>
            <p style="margin-top:6px;color:var(--text-3)">Version 1.0</p>
          </div>
        </div>
      </div>
    `;

    document.getElementById('exp-csv').addEventListener('click', async () => {
      const rows = await DB.getReadings();
      const header = 'Date,Time,Systolic,Diastolic,BPM,Notes';
      const lines = rows.map(r => {
        const d = new Date(r.timestamp);
        return [d.toLocaleDateString(), d.toLocaleTimeString(),
                r.systolic ?? '', r.diastolic ?? '', r.bpm ?? '', r.notes ?? '']
          .map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
      });
      download('bp-readings.csv', [header, ...lines].join('\n'), 'text/csv');
      toast('CSV exported', 'ok');
    });

    document.getElementById('exp-json').addEventListener('click', async () => {
      const data = await DB.exportAll();
      download('bp-backup.json', JSON.stringify(data, null, 2), 'application/json');
      toast('Backup exported', 'ok');
    });

    document.getElementById('clear-data').addEventListener('click', async () => {
      if (!confirm('Delete ALL readings and medication events? This cannot be undone.')) return;
      await DB.importAll({ readings: [], medEvents: [] }, false);
      toast('All data cleared');
      renderSettings(main);
    });
  }

  /* ─── Init ─── */

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(new URL('sw.js', location.href).pathname)
        .catch(() => {});
    }

    document.getElementById('nav').addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.dataset.view);
    });

    await renderDashboard(document.getElementById('main'));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
