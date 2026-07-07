/* ── BP Tracker v2 ── */

/* ═══ Custom Chart.js Plugins ═══ */

/* Plugin 1: Faint dotted yellow vertical lines for medication doses */
const MedLinesPlugin = {
  id: 'medLines',
  afterDraw(chart) {
    const opts = chart.options.plugins?.medLines;
    if (!opts?.timestamps?.length) return;
    const { ctx, chartArea: { left, right, top, bottom }, scales: { x } } = chart;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(180, 120, 4, 0.75)';
    for (const ts of opts.timestamps) {
      const px = x.getPixelForValue(ts);
      if (px < left || px > right) continue;
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
    }
    ctx.restore();
  }
};

/* Plugin 2: Tooltip only appears on a single-finger tap (or click) — pinch-zoom
   never triggers it — and fades away automatically after 2 seconds. */
const TapTooltipPlugin = {
  id: 'tapTooltip',
  afterInit(chart) {
    const canvas = chart.canvas;
    const hide = () => {
      clearTimeout(chart._tapTtTimer);
      if (chart.tooltip?.getActiveElements()?.length) {
        chart.tooltip.setActiveElements([], { x:0, y:0 });
        chart.update('none');
      }
    };
    const show = nativeEvent => {
      const points = chart.getElementsAtEventForMode(nativeEvent, 'index', { intersect:false }, true);
      if (!points.length) return;
      chart.tooltip.setActiveElements(points, { x:0, y:0 });
      chart.update('none');
      clearTimeout(chart._tapTtTimer);
      chart._tapTtTimer = setTimeout(hide, 2000);
    };
    const onTouchStart = e => { if (e.touches.length !== 1) hide(); else show(e); };
    const onClick = e => show(e);
    canvas.addEventListener('touchstart', onTouchStart, { passive:true });
    canvas.addEventListener('click', onClick);
    chart._tapTooltipCleanup = () => {
      clearTimeout(chart._tapTtTimer);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('click', onClick);
    };
  },
  beforeDestroy(chart){ chart._tapTooltipCleanup?.(); }
};

/* Plugin 3: Animated baseline vs post-dose average reference lines
   ("baseline reduction" infographic) — one horizontal line per data
   population, wiping in left-to-right with a fade-in label. */
const BaselineShiftPlugin = {
  id: 'baselineShift',
  afterDraw(chart) {
    const opts = chart.options.plugins?.baselineShift;
    if (!opts?.lines?.length) return;
    const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
    const progress = chart._bsProgress ?? 1;
    ctx.save();
    ctx.font = '700 10px system-ui,sans-serif';
    for (const line of opts.lines) {
      if (line.value == null) continue;
      const py = y.getPixelForValue(line.value);
      if (py < top || py > bottom) continue;
      const endX = left + (right - left) * progress;
      ctx.beginPath();
      ctx.setLineDash(line.dash);
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.5;
      ctx.moveTo(left, py);
      ctx.lineTo(endX, py);
      ctx.stroke();
      if (progress > 0.85) {
        ctx.setLineDash([]);
        ctx.globalAlpha = Math.min(1, (progress - 0.85) / 0.15);
        ctx.fillStyle = line.color;
        ctx.textAlign = 'right';
        ctx.fillText(line.label, right - 3, py - 4);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }
};

function animateBaselineShift(chart){
  const start = performance.now(), dur = 700;
  function step(now){
    if (!chart.ctx) return; // destroyed mid-animation
    const t = Math.min(1, (now - start) / dur);
    chart._bsProgress = 1 - Math.pow(1 - t, 3);
    chart.update('none');
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

Chart.register(MedLinesPlugin, TapTooltipPlugin, BaselineShiftPlugin);

/* ═══ App ═══ */
const App = (() => {

  const S = {
    view: 'dashboard',
    range: '8h',
    chart: null,
    showBpm: true,
    reductionUnit: 'pct',
  };

  /* ── Utilities ── */
  function avg(arr, key) {
    const v = arr.map(r => r[key]).filter(v => v != null && !isNaN(+v));
    return v.length ? v.reduce((a,b)=>+a+(+b),0)/v.length : null;
  }
  function round(v,d=0){ return v==null?null:+v.toFixed(d); }
  function fmtDT(ts){ return new Date(ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
  function fmtDate(ts){ return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
  function fmtTime(ts){ return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); }
  function isoNow(ts){
    const d=ts?new Date(ts):new Date();
    d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
    return d.toISOString().slice(0,16);
  }
  function getRangeTs(){
    const now=Date.now(), map={'7d':7,'14d':14,'30d':30};
    if(S.range==='all')    return {start:null,end:null};
    if(S.range==='custom') return {start:S.customStart?new Date(S.customStart).getTime():null, end:S.customEnd?new Date(S.customEnd).getTime():now};
    if(S.range==='8h')     return {start:now-8*3600000, end:now};
    return {start:now-(map[S.range]||7)*86400000, end:now};
  }
  function toast(msg,type=''){
    const c=document.getElementById('toasts');
    const el=document.createElement('div');
    el.className=`toast ${type==='ok'?'ok':type==='err'?'err':''}`;
    el.textContent=msg;
    c.appendChild(el);
    setTimeout(()=>el.remove(),3200);
  }
  function download(name,content,type){
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([content],{type}));
    a.download=name; a.click();
    URL.revokeObjectURL(a.href);
  }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const svgX    = ()=>`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  const svgEdit = ()=>`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const svgDL   = ()=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9b9895" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const svgTrash= ()=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--sys)" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;

  /* ── Navigation ── */
  function setView(v){
    S.view=v;
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
    render();
  }
  function render(){
    const m=document.getElementById('main');
    ({dashboard:renderDashboard,add:renderAdd,notes:renderNotes,meds:renderMeds,import:renderImport,settings:renderSettings}[S.view]||renderDashboard)(m);
  }

  /* ── Baseline: up to 3 most recent readings within window ── */
  function getBaselineReadings(allReadings, doseTs, maxMin=120){
    const maxMs=maxMin*60000;
    return allReadings
      .filter(r=>r.timestamp<doseTs && r.timestamp>=doseTs-maxMs)
      .sort((a,b)=>b.timestamp-a.timestamp)
      .slice(0,3);
  }

  /* ── Peak reduction: biggest single-reading drop from baseline avg, with elapsed time ── */
  function peakReduction(baselineAvg, afterReadings, key, doseTs){
    if(baselineAvg==null) return null;
    let best=null;
    for(const r of afterReadings){
      const v=r[key];
      if(v==null) continue;
      if(best==null || v<best.v) best={v,ts:r.timestamp};
    }
    if(!best) return null;
    const mmhg=round(baselineAvg-best.v,1);
    const pct=round(mmhg/baselineAvg*100,1);
    const hours=round((best.ts-doseTs)/3600000,1);
    return {mmhg,pct,hours};
  }

  /* ── Shared reduction badge / peak-line renderers (used by Meds list + graph modal) ── */
  function rbadge(pct,mmhg,lbl){
    const val = S.reductionUnit==='mmhg'?mmhg:pct;
    if(val==null) return '';
    const cls=val>0?'pos':val<0?'neg':'neu';
    const unit=S.reductionUnit==='mmhg'?'mmHg':'%';
    return `<span class="reduction ${cls}">${lbl} ${val>0?'↓':'↑'}${Math.abs(val)}${unit}</span>`;
  }
  function peakLine(peak,lbl){
    if(!peak) return '';
    const val = S.reductionUnit==='mmhg' ? `${Math.abs(peak.mmhg)} mmHg` : `${Math.abs(peak.pct)}%`;
    const dir = peak.mmhg>0?'reduction':peak.mmhg<0?'increase':'change';
    const hrs = Math.abs(peak.hours);
    return `<div class="peak-line">${lbl}: <strong>${val} peak ${dir}</strong> in ${hrs} hour${hrs!==1?'s':''}</div>`;
  }
  function unitToggle(id){
    return `<div class="unit-toggle" id="${id}">
      <button class="ut-btn${S.reductionUnit==='pct'?' active':''}" data-unit="pct">%</button>
      <button class="ut-btn${S.reductionUnit==='mmhg'?' active':''}" data-unit="mmhg">mmHg</button>
    </div>`;
  }
  function bindUnitToggle(id,onChange){
    document.getElementById(id)?.addEventListener('click',e=>{
      const b=e.target.closest('[data-unit]'); if(!b) return;
      S.reductionUnit=b.dataset.unit; onChange();
    });
  }

  /* ═══════════════════════════
     DASHBOARD
  ═══════════════════════════ */
  async function renderDashboard(main){
    const {start,end}=getRangeTs();
    const [readings,medEvents,allR]=await Promise.all([
      DB.getReadings(start,end), DB.getMedEvents(start,end), DB.getReadings()
    ]);
    const latest=allR.sort((a,b)=>a.timestamp-b.timestamp).at(-1);
    const avgSys=round(avg(readings,'systolic'));
    const avgDia=round(avg(readings,'diastolic'));
    const avgBpm=round(avg(readings,'bpm'));
    const rlbl={'8h':'8H','7d':'7D','14d':'14D','30d':'30D','all':'All'};

    main.innerHTML=`
      <div class="range-tabs" id="range-tabs">
        ${['8h','7d','14d','30d','all'].map(r=>`<button class="rtab${S.range===r?' active':''}" data-range="${r}">${rlbl[r]}</button>`).join('')}
      </div>
      <div class="sec">
        <div class="card">
          <div class="chart-wrap"><canvas id="chart"></canvas></div>
          <div class="chart-controls">
            <span class="chart-hint">Tap a point for details · Pinch or scroll to zoom · Drag to pan</span>
            <label class="bpm-toggle">
              <input type="checkbox" id="bpm-cb" ${S.showBpm?'checked':''}> BPM
            </label>
            <button class="zoom-reset" id="zoom-reset">Reset</button>
          </div>
          <div class="legend">
            <div class="legend-item"><div class="l-line" style="background:var(--sys)"></div>Systolic</div>
            <div class="legend-item"><div class="l-line" style="background:var(--dia)"></div>Diastolic</div>
            ${S.showBpm?'<div class="legend-item"><div class="l-line" style="background:var(--bpm);border-top:2px dashed var(--bpm);height:0"></div>BPM</div>':''}
            <div class="legend-item"><div class="l-vdash"></div>Medication</div>
          </div>
        </div>
      </div>
      <div class="sec">
        <div class="stat-grid">
          <div class="stat-chip"><div class="stat-label">Systolic avg</div><div class="stat-val sys">${avgSys??'—'}</div></div>
          <div class="stat-chip"><div class="stat-label">Diastolic avg</div><div class="stat-val dia">${avgDia??'—'}</div></div>
          <div class="stat-chip"><div class="stat-label">BPM avg</div><div class="stat-val bpm">${avgBpm??'—'}</div></div>
        </div>
      </div>
      ${latest?`
      <div class="sec">
        <div class="card">
          <div class="card-hdr">Latest Reading</div>
          <div class="card-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;color:var(--text-3);margin-bottom:3px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">SYS / DIA</div>
              <div style="font-size:28px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums">
                <span style="color:var(--sys)">${latest.systolic??'—'}</span><span style="color:var(--text-3);font-size:20px;font-weight:400">/</span><span style="color:var(--dia)">${latest.diastolic??'—'}</span>
              </div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-3);margin-bottom:3px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">BPM</div>
              <div style="font-size:28px;font-weight:800;color:var(--bpm);line-height:1">${latest.bpm??'—'}</div>
            </div>
            <div style="flex:1;min-width:80px;text-align:right">
              <div style="font-size:12px;color:var(--text-2)">${fmtDT(latest.timestamp)}</div>
              ${latest.notes?`<div style="font-size:11px;color:var(--text-3);margin-top:3px">${esc(latest.notes)}</div>`:''}
            </div>
          </div>
        </div>
      </div>`:''}
      <div class="sec">
        <div class="card">
          <div class="card-hdr">Readings (${readings.length})</div>
          ${readings.length?`
          <div id="readings-list">
            ${[...readings].reverse().slice(0,60).map(r=>`
            <div class="reading-row">
              <div class="reading-time">
                <div class="d">${fmtDate(r.timestamp)}</div>
                <div class="d">${fmtTime(r.timestamp)}</div>
              </div>
              <div class="reading-vals">
                <span class="rv sys">${r.systolic??'—'}<span class="u"> sys</span></span>
                <span class="rv dia">${r.diastolic??'—'}<span class="u"> dia</span></span>
                <span class="rv bpm">${r.bpm??'—'}<span class="u"> bpm</span></span>
              </div>
              ${r.notes?`<div style="font-size:11px;color:var(--text-3);flex:0 0 100%;padding-top:2px">${esc(r.notes)}</div>`:''}
              <div style="display:flex;gap:2px;flex-shrink:0">
                <button class="icon-btn" data-edit="${r.id}" title="Edit">${svgEdit()}</button>
                <button class="icon-btn del" data-del="${r.id}" title="Delete">${svgX()}</button>
              </div>
            </div>`).join('')}
            ${readings.length>60?`<div style="padding:10px 16px;text-align:center;font-size:12px;color:var(--text-3)">Showing latest 60 of ${readings.length}</div>`:''}
          </div>`:
          `<div class="empty"><div class="empty-icon">📊</div><div class="empty-title">No readings in this range</div><div class="empty-text">Add a reading or import from your device</div></div>`}
        </div>
      </div>
    `;

    initChart(readings, medEvents);

    document.getElementById('range-tabs').addEventListener('click', e=>{
      const b=e.target.closest('[data-range]');
      if(b){S.range=b.dataset.range; renderDashboard(main);}
    });
    document.getElementById('zoom-reset')?.addEventListener('click',()=>S.chart?.resetZoom());
    document.getElementById('bpm-cb').addEventListener('change',e=>{
      S.showBpm=e.target.checked;
      const ds=S.chart?.data.datasets.find(d=>d.label==='BPM');
      if(ds){ ds.hidden=!S.showBpm; S.chart.options.scales.y1.display=S.showBpm; S.chart.update(); }
    });

    main.querySelectorAll('[data-edit]').forEach(btn=>
      btn.addEventListener('click', async()=>{
        const all=await DB.getReadings();
        const r=all.find(x=>x.id===btn.dataset.edit);
        if(r) showEditModal(r, ()=>renderDashboard(main));
      })
    );
    main.querySelectorAll('[data-del]').forEach(btn=>
      btn.addEventListener('click', async()=>{
        if(!confirm('Delete this reading?')) return;
        await DB.deleteReading(btn.dataset.del);
        toast('Reading deleted');
        renderDashboard(main);
      })
    );
  }

  /* ── Chart (dual Y-axis) ── */
  function initChart(readings, medEvents){
    const canvas=document.getElementById('chart');
    if(!canvas) return;
    if(S.chart){S.chart.destroy(); S.chart=null;}

    const r=readings.length<80?4:2;
    const mkDs=(label,data,color,dash,yid)=>({
      label, data,
      borderColor:color, backgroundColor:color+'15',
      borderWidth:2, borderDash:dash?[6,3]:[],
      pointRadius:r, pointHoverRadius:r+3, pointBackgroundColor:color,
      tension:0.3, fill:false, yAxisID:yid,
    });

    S.chart=new Chart(canvas,{
      type:'line',
      data:{datasets:[
        mkDs('Systolic',  readings.filter(x=>x.systolic !=null).map(x=>({x:x.timestamp,y:x.systolic })), '#c05252', false,'y'),
        mkDs('Diastolic', readings.filter(x=>x.diastolic!=null).map(x=>({x:x.timestamp,y:x.diastolic})), '#3b7bbf', false,'y'),
        mkDs('BPM',       readings.filter(x=>x.bpm      !=null).map(x=>({x:x.timestamp,y:x.bpm      })), '#4a9068', true, 'y1'),
      ]},
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        events:[],
        scales:{
          x:{
            type:'time',
            time:{displayFormats:{minute:'MMM d HH:mm',hour:'MMM d HH:mm',day:'MMM d',week:'MMM d',month:'MMM yy'}},
            grid:{color:'rgba(0,0,0,.04)'},
            ticks:{font:{family:'system-ui,sans-serif',size:10},color:'#9b9895',maxTicksLimit:6,maxRotation:0},
          },
          y:{
            position:'left',
            suggestedMin:50, suggestedMax:200,
            grid:{color:'rgba(0,0,0,.04)'},
            ticks:{font:{family:'system-ui,sans-serif',size:10},color:'#9b9895'},
            title:{display:true,text:'mmHg',font:{size:10},color:'#9b9895'},
          },
          y1:{
            position:'right',
            display:S.showBpm,
            suggestedMin:40, suggestedMax:130,
            grid:{drawOnChartArea:false},
            ticks:{font:{family:'system-ui,sans-serif',size:10},color:'#4a9068'},
            title:{display:true,text:'BPM',font:{size:10},color:'#4a9068'},
          },
        },
        plugins:{
          legend:{display:false},
          medLines:{timestamps:medEvents.map(e=>e.timestamp)},
          tooltip:{
            backgroundColor:'#1a1916',
            titleFont:{family:'system-ui,sans-serif',size:11},
            bodyFont:{family:'system-ui,sans-serif',size:12},
            padding:10, cornerRadius:8, displayColors:true,
            callbacks:{
              title:items=>items.length?new Date(items[0].raw.x).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'',
              label:ctx=>` ${ctx.dataset.label}: ${ctx.raw.y}${ctx.dataset.yAxisID==='y'?' mmHg':' bpm'}`,
            },
          },
          zoom:{
            zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},
            pan:{enabled:true,mode:'x'},
          },
        },
      },
    });
    S.chart.data.datasets[2].hidden=!S.showBpm;
    S.chart.update('none');
  }

  /* ── Edit Reading Modal ── */
  function showEditModal(reading, onSave){
    const modal=document.createElement('div');
    modal.className='modal-overlay';
    modal.innerHTML=`
      <div class="modal-sheet">
        <div class="modal-hdr">
          <span>Edit Reading</span>
          <button class="modal-close" id="ec">Close</button>
        </div>
        <div class="form">
          <div class="fg"><label class="flabel">Date &amp; Time</label>
            <input type="datetime-local" class="finput" id="e-dt" value="${isoNow(reading.timestamp)}">
          </div>
          <div class="frow-3">
            <div class="fg"><label class="flabel" style="color:var(--sys)">Systolic</label>
              <input type="number" class="finput" id="e-sys" value="${reading.systolic??''}" placeholder="120">
            </div>
            <div class="fg"><label class="flabel" style="color:var(--dia)">Diastolic</label>
              <input type="number" class="finput" id="e-dia" value="${reading.diastolic??''}" placeholder="80">
            </div>
            <div class="fg"><label class="flabel" style="color:var(--bpm)">BPM</label>
              <input type="number" class="finput" id="e-bpm" value="${reading.bpm??''}" placeholder="70">
            </div>
          </div>
          <div class="fg"><label class="flabel">Notes</label>
            <input type="text" class="finput" id="e-notes" value="${esc(reading.notes||'')}" placeholder="Optional notes">
          </div>
          <button class="btn btn-primary btn-full" id="e-save">Save Changes</button>
          <div style="height:8px"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close=()=>modal.remove();
    document.getElementById('ec').addEventListener('click',close);
    modal.addEventListener('click',e=>{if(e.target===modal)close();});
    document.getElementById('e-save').addEventListener('click',async()=>{
      const dt=document.getElementById('e-dt').value;
      const sys=parseFloat(document.getElementById('e-sys').value);
      const dia=parseFloat(document.getElementById('e-dia').value);
      const bpm=parseFloat(document.getElementById('e-bpm').value);
      const notes=document.getElementById('e-notes').value.trim();
      if(!dt){toast('Date required','err');return;}
      await DB.addReading({id:reading.id, timestamp:new Date(dt).getTime(),
        systolic:isNaN(sys)?null:sys, diastolic:isNaN(dia)?null:dia,
        bpm:isNaN(bpm)?null:bpm, notes:notes||null});
      toast('Reading updated','ok'); close(); onSave?.();
    });
  }

  /* ═══════════════════════════
     ADD READING
  ═══════════════════════════ */
  function renderAdd(main){
    main.innerHTML=`
      <div class="vtitle">Add Reading</div>
      <div class="vsub">Enter your blood pressure and heart rate measurements</div>
      <div class="form">
        <div class="fg"><label class="flabel">Date &amp; Time</label>
          <input type="datetime-local" class="finput" id="r-dt" value="${isoNow()}">
        </div>
        <div class="frow-3">
          <div class="fg"><label class="flabel" style="color:var(--sys)">Systolic</label>
            <input type="number" class="finput" id="r-sys" placeholder="120" min="50" max="300">
          </div>
          <div class="fg"><label class="flabel" style="color:var(--dia)">Diastolic</label>
            <input type="number" class="finput" id="r-dia" placeholder="80" min="30" max="200">
          </div>
          <div class="fg"><label class="flabel" style="color:var(--bpm)">BPM</label>
            <input type="number" class="finput" id="r-bpm" placeholder="70" min="20" max="300">
          </div>
        </div>
        <div class="fg"><label class="flabel">Notes (optional)</label>
          <input type="text" class="finput" id="r-notes" placeholder="After exercise, feeling stressed…">
        </div>
        <button class="btn btn-primary btn-full" id="save-r">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><path d="M5 13l4 4L19 7"/></svg>
          Save Reading
        </button>
      </div>
    `;
    document.getElementById('save-r').addEventListener('click',async()=>{
      const dt=document.getElementById('r-dt').value;
      const sys=parseFloat(document.getElementById('r-sys').value);
      const dia=parseFloat(document.getElementById('r-dia').value);
      const bpm=parseFloat(document.getElementById('r-bpm').value);
      const notes=document.getElementById('r-notes').value.trim();
      if(!dt){toast('Please enter a date and time','err');return;}
      if(isNaN(sys)&&isNaN(dia)&&isNaN(bpm)){toast('Enter at least one measurement','err');return;}
      await DB.addReading({timestamp:new Date(dt).getTime(),
        systolic:isNaN(sys)?null:sys, diastolic:isNaN(dia)?null:dia,
        bpm:isNaN(bpm)?null:bpm, notes:notes||null});
      toast('Reading saved!','ok');
      setView('dashboard');
    });
  }

  /* ═══════════════════════════
     NOTES
  ═══════════════════════════ */
  async function renderNotes(main){
    const notes=await DB.getNotes();
    main.innerHTML=`
      <div class="vtitle">Notes</div>
      <div class="vsub">General observations, reminders, and health context</div>
      <div class="sec">
        <div class="card">
          <div class="card-body">
            <textarea class="finput" id="note-txt" placeholder="Write a note… symptoms, lifestyle changes, doctor's advice, medication side effects…" rows="4"></textarea>
            <button class="btn btn-primary btn-full" id="save-note" style="margin-top:10px">Add Note</button>
          </div>
        </div>
      </div>
      <div class="sec">
        ${notes.length?`
        <div id="notes-list">
          ${[...notes].reverse().map(n=>`
          <div class="note-card">
            <div class="note-text">${esc(n.text)}</div>
            <div class="note-meta">
              <span>${fmtDT(n.timestamp)}</span>
              <button class="del-note" data-del-note="${n.id}">Delete</button>
            </div>
          </div>`).join('')}
        </div>`:
        `<div class="empty"><div class="empty-icon">📝</div><div class="empty-title">No notes yet</div>
        <div class="empty-text">Jot down observations, reminders, or anything relevant to your blood pressure health</div></div>`}
      </div>
    `;
    document.getElementById('save-note').addEventListener('click',async()=>{
      const txt=document.getElementById('note-txt').value.trim();
      if(!txt){toast('Write something first','err');return;}
      await DB.addNote({timestamp:Date.now(),text:txt});
      toast('Note saved','ok'); renderNotes(main);
    });
    main.querySelectorAll('[data-del-note]').forEach(btn=>
      btn.addEventListener('click',async()=>{
        if(!confirm('Delete this note?')) return;
        await DB.deleteNote(btn.dataset.delNote);
        toast('Note deleted'); renderNotes(main);
      })
    );
  }

  /* ═══════════════════════════
     MEDICATIONS
  ═══════════════════════════ */
  async function renderMeds(main){
    const [medEvents,allReadings]=await Promise.all([DB.getMedEvents(),DB.getReadings()]);

    const events=medEvents.map(ev=>{
      const winBef=ev.baselineWindow||120, winAft=ev.postDoseWindow||150;
      const baseline=getBaselineReadings(allReadings,ev.timestamp,winBef);
      const after=allReadings.filter(r=>r.timestamp>ev.timestamp&&r.timestamp<=ev.timestamp+winAft*60000);
      const bSys=round(avg(baseline,'systolic'),1), bDia=round(avg(baseline,'diastolic'),1);
      const pSys=round(avg(after,'systolic'),1),    pDia=round(avg(after,'diastolic'),1);
      const sysRed=(bSys!=null&&pSys!=null)?round((bSys-pSys)/bSys*100,1):null;
      const diaRed=(bDia!=null&&pDia!=null)?round((bDia-pDia)/bDia*100,1):null;
      const sysMmhg=(bSys!=null&&pSys!=null)?round(bSys-pSys,1):null;
      const diaMmhg=(bDia!=null&&pDia!=null)?round(bDia-pDia,1):null;
      const sysPeak=peakReduction(bSys,after,'systolic',ev.timestamp);
      const diaPeak=peakReduction(bDia,after,'diastolic',ev.timestamp);
      return {...ev,bSys,bDia,pSys,pDia,sysRed,diaRed,sysMmhg,diaMmhg,sysPeak,diaPeak,bCount:baseline.length,pCount:after.length};
    });

    main.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 16px 2px">
        <div style="font-size:22px;font-weight:800;letter-spacing:-.5px">Medications</div>
        <div style="display:flex;align-items:center;gap:8px">
          ${unitToggle('unit-toggle')}
          <button class="btn btn-secondary btn-sm" id="toggle-mf">+ Log Dose</button>
        </div>
      </div>
      <div class="vsub">Tap any event to see the BP response graph</div>

      <div class="sec" id="mf-sec" style="display:none">
        <div class="form-panel"><div class="form-panel-body open"><div class="form">
          <div class="frow">
            <div class="fg"><label class="flabel">Medication</label>
              <input type="text" class="finput" id="m-med" placeholder="Lisinopril">
            </div>
            <div class="fg"><label class="flabel">Dose</label>
              <input type="text" class="finput" id="m-dose" placeholder="10mg">
            </div>
          </div>
          <div class="fg"><label class="flabel">Date &amp; Time Taken</label>
            <input type="datetime-local" class="finput" id="m-dt" value="${isoNow()}">
          </div>
          <div class="frow">
            <div class="fg"><label class="flabel">Baseline window</label>
              <input type="number" class="finput" id="m-before" value="120" min="5" max="480">
              <span class="fhelp">Minutes before (up to 3 closest readings)</span>
            </div>
            <div class="fg"><label class="flabel">Post-dose window</label>
              <input type="number" class="finput" id="m-after" value="150" min="5" max="720">
              <span class="fhelp">Minutes after dose (2.5 hrs default)</span>
            </div>
          </div>
          <div class="fg"><label class="flabel">Notes (optional)</label>
            <input type="text" class="finput" id="m-notes" placeholder="Any observations…">
          </div>
          <button class="btn btn-primary btn-full" id="save-med">Save Medication Event</button>
        </div></div></div>
      </div>

      <div class="sec">
        <div class="card">
          ${events.length?`<div>
          ${[...events].reverse().map(ev=>`
          <div class="med-event clickable-event" data-ev-id="${ev.id}">
            <div class="med-hdr">
              <div>
                <div class="med-name">${esc(ev.medication||'Medication')} <span class="med-dose">${esc(ev.dose||'')}</span></div>
                <div class="med-time">${fmtDT(ev.timestamp)} · tap to view graph</div>
              </div>
              <button class="del-btn" data-del-med="${ev.id}" title="Delete">${svgX()}</button>
            </div>
            <div class="med-bp-grid">
              <div class="med-bp-block">
                <div class="med-bp-lbl">Baseline (${ev.bCount} reading${ev.bCount!==1?'s':''}, ${ev.baselineWindow||120}min)</div>
                <div class="med-bp-val">
                  <span style="color:var(--sys)">${ev.bSys??'—'}</span><span style="color:var(--text-3)">/</span><span style="color:var(--dia)">${ev.bDia??'—'}</span>
                  <span style="font-size:10px;color:var(--text-3)"> mmHg</span>
                </div>
              </div>
              <div class="med-bp-block">
                <div class="med-bp-lbl">Post-dose (${ev.pCount} reading${ev.pCount!==1?'s':''}, ${ev.postDoseWindow||150}min)</div>
                <div class="med-bp-val">
                  <span style="color:var(--sys)">${ev.pSys??'—'}</span><span style="color:var(--text-3)">/</span><span style="color:var(--dia)">${ev.pDia??'—'}</span>
                  <span style="font-size:10px;color:var(--text-3)"> mmHg</span>
                </div>
              </div>
            </div>
            <div class="med-reductions">
              ${ev.sysRed!=null||ev.diaRed!=null
                ? rbadge(ev.sysRed,ev.sysMmhg,'Sys')+rbadge(ev.diaRed,ev.diaMmhg,'Dia')
                : '<span class="reduction neu">No readings in windows</span>'}
            </div>
            ${ev.sysPeak||ev.diaPeak?`<div class="peak-lines">${peakLine(ev.sysPeak,'Sys')}${peakLine(ev.diaPeak,'Dia')}</div>`:''}
            ${ev.notes?`<div style="margin-top:6px;font-size:12px;color:var(--text-2)">${esc(ev.notes)}</div>`:''}
          </div>`).join('')}
          </div>`:
          `<div class="empty"><div class="empty-icon">💊</div><div class="empty-title">No medication events yet</div>
          <div class="empty-text">Log when you take medication to track its effect on your blood pressure</div></div>`}
        </div>
      </div>
    `;

    bindUnitToggle('unit-toggle',()=>renderMeds(main));
    document.getElementById('toggle-mf').addEventListener('click',()=>{
      const sec=document.getElementById('mf-sec');
      const open=sec.style.display!=='none';
      sec.style.display=open?'none':'block';
      document.getElementById('toggle-mf').textContent=open?'+ Log Dose':'✕ Cancel';
    });
    document.getElementById('save-med')?.addEventListener('click',async()=>{
      const med=document.getElementById('m-med').value.trim();
      const dose=document.getElementById('m-dose').value.trim();
      const dt=document.getElementById('m-dt').value;
      const before=parseInt(document.getElementById('m-before').value)||120;
      const after=parseInt(document.getElementById('m-after').value)||150;
      const notes=document.getElementById('m-notes').value.trim();
      if(!med||!dt){toast('Enter medication name and time','err');return;}
      await DB.addMedEvent({timestamp:new Date(dt).getTime(),
        medication:med, dose:dose||null,
        baselineWindow:before, postDoseWindow:after, notes:notes||null});
      toast('Medication event saved!','ok');
      renderMeds(main);
    });
    main.querySelectorAll('.clickable-event').forEach(card=>
      card.addEventListener('click',e=>{
        if(e.target.closest('[data-del-med]')) return;
        const ev=events.find(x=>x.id===card.dataset.evId);
        if(ev) showMedGraph(ev,allReadings);
      })
    );
    main.querySelectorAll('[data-del-med]').forEach(btn=>
      btn.addEventListener('click',async e=>{
        e.stopPropagation();
        if(!confirm('Delete this medication event?')) return;
        await DB.deleteMedEvent(btn.dataset.delMed);
        toast('Event deleted'); renderMeds(main);
      })
    );
  }

  /* ── Medication Event Graph Modal ── */
  function showMedGraph(ev, allReadings){
    const winBef=(ev.baselineWindow||120)*60000;
    const winAft=(ev.postDoseWindow||150)*60000;
    const ts=ev.timestamp;
    const wStart=ts-winBef, wEnd=ts+winAft;

    const inWin=allReadings.filter(r=>r.timestamp>=wStart&&r.timestamp<=wEnd);
    const sysD=inWin.filter(r=>r.systolic !=null).map(r=>({x:r.timestamp,y:r.systolic }));
    const diaD=inWin.filter(r=>r.diastolic!=null).map(r=>({x:r.timestamp,y:r.diastolic}));

    const baseline=getBaselineReadings(allReadings,ts,ev.baselineWindow||120);
    const after=allReadings.filter(r=>r.timestamp>ts&&r.timestamp<=ts+winAft);
    const bSys=round(avg(baseline,'systolic'),1), bDia=round(avg(baseline,'diastolic'),1);
    const pSys=round(avg(after,'systolic'),1),    pDia=round(avg(after,'diastolic'),1);
    const sysRed=(bSys!=null&&pSys!=null)?round((bSys-pSys)/bSys*100,1):null;
    const diaRed=(bDia!=null&&pDia!=null)?round((bDia-pDia)/bDia*100,1):null;
    const sysMmhg=(bSys!=null&&pSys!=null)?round(bSys-pSys,1):null;
    const diaMmhg=(bDia!=null&&pDia!=null)?round(bDia-pDia,1):null;
    const sysPeak=peakReduction(bSys,after,'systolic',ts);
    const diaPeak=peakReduction(bDia,after,'diastolic',ts);

    function reductionHTML(){
      return `
        <div style="padding:0 16px;display:flex;justify-content:flex-end">${unitToggle('mg-unit-toggle')}</div>
        <div style="padding:6px 16px 0;display:flex;gap:8px;flex-wrap:wrap">
          ${sysRed!=null||diaRed!=null
            ? rbadge(sysRed,sysMmhg,'Sys')+rbadge(diaRed,diaMmhg,'Dia')
            : '<span class="reduction neu">Not enough readings to calculate reduction</span>'}
        </div>
        ${sysPeak||diaPeak?`<div class="peak-lines" style="padding:8px 16px 18px">${peakLine(sysPeak,'Sys')}${peakLine(diaPeak,'Dia')}</div>`:'<div style="height:12px"></div>'}
      `;
    }

    const modal=document.createElement('div');
    modal.className='modal-overlay';
    modal.innerHTML=`
      <div class="modal-sheet">
        <div class="modal-hdr">
          <span>${esc(ev.medication)}${ev.dose?' '+esc(ev.dose):''}</span>
          <button class="modal-close" id="mg-close">Close</button>
        </div>
        <div style="padding:10px 16px 0;font-size:11px;color:var(--text-3)">${fmtDT(ts)} · dashed vertical line = dose time · dashed horizontal lines = baseline/post-dose averages</div>
        <div style="padding:8px 16px 0"><div style="height:220px;position:relative"><canvas id="med-chart"></canvas></div></div>
        <div style="padding:10px 16px 4px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="stat-chip">
            <div class="stat-label">Baseline (${baseline.length} reading${baseline.length!==1?'s':''})</div>
            <div style="font-size:18px;font-weight:800;line-height:1.3;margin-top:2px">
              <span style="color:var(--sys)">${bSys??'—'}</span><span style="color:var(--text-3)">/</span><span style="color:var(--dia)">${bDia??'—'}</span>
            </div>
          </div>
          <div class="stat-chip">
            <div class="stat-label">Post-dose (${after.length} reading${after.length!==1?'s':''})</div>
            <div style="font-size:18px;font-weight:800;line-height:1.3;margin-top:2px">
              <span style="color:var(--sys)">${pSys??'—'}</span><span style="color:var(--text-3)">/</span><span style="color:var(--dia)">${pDia??'—'}</span>
            </div>
          </div>
        </div>
        <div id="mg-reduction">${reductionHTML()}</div>
      </div>
    `;
    document.body.appendChild(modal);

    function bindReductionToggle(){
      bindUnitToggle('mg-unit-toggle',()=>{
        document.getElementById('mg-reduction').innerHTML=reductionHTML();
        bindReductionToggle();
      });
    }
    bindReductionToggle();

    let medChart=null;
    setTimeout(()=>{
      const canvas=document.getElementById('med-chart');
      if(!canvas) return;
      medChart=new Chart(canvas,{
        type:'line',
        data:{datasets:[
          {label:'Systolic',data:sysD,borderColor:'#c05252',backgroundColor:'#c0525215',borderWidth:2,pointRadius:4,tension:0.3,fill:false},
          {label:'Diastolic',data:diaD,borderColor:'#3b7bbf',backgroundColor:'#3b7bbf15',borderWidth:2,pointRadius:4,tension:0.3,fill:false},
        ]},
        options:{
          responsive:true, maintainAspectRatio:false,
          interaction:{mode:'index',intersect:false},
          events:[],
          scales:{
            x:{type:'time', time:{displayFormats:{minute:'HH:mm',hour:'MMM d HH:mm'}},
              min:wStart, max:wEnd,
              ticks:{font:{size:10},color:'#9b9895',maxTicksLimit:5,maxRotation:0},
              grid:{color:'rgba(0,0,0,.04)'}},
            y:{suggestedMin:50,suggestedMax:180,
              ticks:{font:{size:10},color:'#9b9895'},grid:{color:'rgba(0,0,0,.04)'},
              title:{display:true,text:'mmHg',font:{size:10},color:'#9b9895'}},
          },
          plugins:{
            legend:{display:false},
            medLines:{timestamps:[ts]},
            baselineShift:{lines:[]},
            tooltip:{backgroundColor:'#1a1916',titleFont:{size:11},bodyFont:{size:12},padding:10,cornerRadius:8},
            zoom:{zoom:{wheel:{enabled:false},pinch:{enabled:false}},pan:{enabled:false}},
          },
        },
      });
      medChart._bsProgress=0;
      medChart.options.plugins.baselineShift.lines=[
        {value:bSys, color:'rgba(192,82,82,.5)',  dash:[3,3], label:'Baseline'},
        {value:pSys, color:'rgba(192,82,82,.95)', dash:[8,3], label:'Post-dose'},
        {value:bDia, color:'rgba(59,123,191,.5)', dash:[3,3], label:'Baseline'},
        {value:pDia, color:'rgba(59,123,191,.95)',dash:[8,3], label:'Post-dose'},
      ];
      animateBaselineShift(medChart);
    }, 50);

    const close=()=>{medChart?.destroy(); modal.remove();};
    document.getElementById('mg-close').addEventListener('click',close);
    modal.addEventListener('click',e=>{if(e.target===modal)close();});
  }

  /* ═══════════════════════════
     IMPORT
  ═══════════════════════════ */
  function renderImport(main){
    main.innerHTML=`
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
        <div class="card"><div class="card-hdr">Format Guide</div>
          <div class="card-body" style="font-size:13px;color:var(--text-2);line-height:1.7">
            <p><strong style="color:var(--text-1)">Long format (Pressure XS Pro):</strong> Device, Metric, Value, Time columns — imported directly, no changes needed.</p>
            <p style="margin-top:8px"><strong style="color:var(--text-1)">Wide format:</strong> Systolic, Diastolic, BPM, Time columns per row.</p>
            <p style="margin-top:8px"><strong style="color:var(--text-1)">JSON backup:</strong> Previously exported from this app (includes meds &amp; notes).</p>
            <p style="margin-top:8px">Column/metric names are matched flexibly — "sys", "sis", "systolic", "SBP" etc. all work, as do most date formats (24-hour, long day names, and stray trailing "Z" letters are handled automatically). Duplicate entries are skipped automatically.</p>
          </div>
        </div>
      </div>
    `;
    const dz=document.getElementById('dz');
    dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag-over');});
    dz.addEventListener('dragleave',()=>dz.classList.remove('drag-over'));
    dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag-over');handleFile(e.dataTransfer.files[0]);});
    document.getElementById('file-in').addEventListener('change',e=>handleFile(e.target.files[0]));

    async function handleFile(file){
      if(!file) return;
      const preview=document.getElementById('import-preview');
      preview.innerHTML=`<div class="card"><div class="card-body" style="font-size:13px;color:var(--text-2)">Reading <strong>${esc(file.name)}</strong>…</div></div>`;
      try{
        const type=Importer.getType(file);
        if(!type){toast('Unsupported file type','err');preview.innerHTML='';return;}
        let importData,readings=[],isBackup=false,fileDupes=0;
        if(type==='json'){
          importData=await Importer.fromJSON(file);
          if(importData?.version&&Array.isArray(importData.readings)){isBackup=true;readings=importData.readings;}
          else readings=Array.isArray(importData)?importData:[];
        } else {
          const result=type==='csv'?await Importer.fromCSV(file):await Importer.fromXLSX(file);
          readings=result.readings; fileDupes=result.duplicatesSkipped;
          importData={readings};
        }
        if(!readings.length){toast('No valid readings found','err');preview.innerHTML='';return;}
        const n=readings.length;
        preview.innerHTML=`<div class="card"><div class="card-body">
          <div style="font-size:15px;font-weight:700;margin-bottom:10px">Found <span style="color:var(--accent)">${n} reading${n!==1?'s':''}</span>
          ${isBackup&&importData.medEvents?.length?` + ${importData.medEvents.length} med event${importData.medEvents.length!==1?'s':''}`:''}</div>
          ${fileDupes?`<div style="font-size:12px;color:var(--text-3);margin:-6px 0 10px">${fileDupes} duplicate${fileDupes!==1?'s':''} within the file were ignored</div>`:''}
          ${readings.slice(0,3).map(r=>`<div class="import-row">
            ${new Date(r.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} —
            <span style="color:var(--sys)">${r.systolic??'—'}</span>/<span style="color:var(--dia)">${r.diastolic??'—'}</span> mmHg
            <span style="color:var(--bpm)">${r.bpm??'—'}</span> bpm
          </div>`).join('')}
          ${n>3?`<div style="font-size:12px;color:var(--text-3);padding-top:6px">…and ${n-3} more</div>`:''}
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
            <button class="btn btn-primary" id="do-replace">Replace all &amp; import</button>
            <button class="btn btn-secondary" id="do-merge">Merge with existing</button>
          </div>
        </div></div>`;
        document.getElementById('do-replace').addEventListener('click',async()=>{
          await DB.importAll(importData,false);
          toast(`Imported ${n} reading${n!==1?'s':''}${fileDupes?` (${fileDupes} duplicate${fileDupes!==1?'s':''} ignored)`:''}`,'ok');
          preview.innerHTML=''; setView('dashboard');
        });
        document.getElementById('do-merge').addEventListener('click',async()=>{
          const existing=await DB.getReadings();
          const {readings:toAdd,duplicatesSkipped:mergeDupes}=Importer.dedupeAgainst(readings,existing);
          const totalDupes=fileDupes+mergeDupes;
          await DB.importAll({...importData,readings:toAdd},true);
          toast(`Merged ${toAdd.length} reading${toAdd.length!==1?'s':''}${totalDupes?` (${totalDupes} duplicate${totalDupes!==1?'s':''} ignored)`:''}`,'ok');
          preview.innerHTML=''; setView('dashboard');
        });
      } catch(err){console.error(err);toast('Error reading file','err');preview.innerHTML='';}
    }
  }

  /* ═══════════════════════════
     SETTINGS
  ═══════════════════════════ */
  async function renderSettings(main){
    const count=await DB.countReadings();
    main.innerHTML=`
      <div class="vtitle">Settings</div>
      <div class="sec"><div class="card">
        <div class="card-hdr">Export Data</div>
        <div class="setting-row" id="exp-csv">
          <div class="sr-info"><div class="sr-label">Export as CSV</div><div class="sr-desc">Spreadsheet with all readings</div></div>${svgDL()}
        </div>
        <div class="setting-row" id="exp-json">
          <div class="sr-info"><div class="sr-label">Export full backup (JSON)</div><div class="sr-desc">Includes readings, medications &amp; notes</div></div>${svgDL()}
        </div>
      </div></div>
      <div class="sec"><div class="card">
        <div class="card-hdr">Storage</div>
        <div class="setting-row" style="cursor:default">
          <div class="sr-info"><div class="sr-label">Readings stored</div><div class="sr-desc">All data is stored locally on this device</div></div>
          <span class="badge">${count}</span>
        </div>
        <div class="setting-row" id="clear-data">
          <div class="sr-info"><div class="sr-label" style="color:var(--sys)">Clear all data</div><div class="sr-desc">Permanently delete all readings, medications &amp; notes</div></div>
          ${svgTrash()}
        </div>
      </div></div>
      <div class="sec"><div class="card">
        <div class="card-hdr">About</div>
        <div class="card-body" style="font-size:13px;color:var(--text-2);line-height:1.7">
          <p><strong style="color:var(--text-1)">BP Tracker v2</strong> — Blood pressure &amp; heart rate monitoring.</p>
          <p style="margin-top:6px">Data stays on your device. No account, no cloud, no tracking.</p>
        </div>
      </div></div>
    `;
    document.getElementById('exp-csv').addEventListener('click',async()=>{
      const rows=await DB.getReadings();
      const hdr='Date,Time,Systolic,Diastolic,BPM,Notes';
      const lines=rows.map(r=>{const d=new Date(r.timestamp);
        return [d.toLocaleDateString(),d.toLocaleTimeString(),r.systolic??'',r.diastolic??'',r.bpm??'',r.notes??'']
          .map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',');
      });
      download('bp-readings.csv',[hdr,...lines].join('\n'),'text/csv');
      toast('CSV exported','ok');
    });
    document.getElementById('exp-json').addEventListener('click',async()=>{
      download('bp-backup.json',JSON.stringify(await DB.exportAll(),null,2),'application/json');
      toast('Backup exported','ok');
    });
    document.getElementById('clear-data').addEventListener('click',async()=>{
      if(!confirm('Delete ALL data — readings, medication events, and notes? This cannot be undone.')) return;
      await DB.importAll({readings:[],medEvents:[],notes:[]},false);
      toast('All data cleared'); renderSettings(main);
    });
  }

  /* ── Init ── */
  async function init(){
    if('serviceWorker' in navigator)
      navigator.serviceWorker.register(new URL('sw.js',location.href).pathname).catch(()=>{});
    document.getElementById('nav').addEventListener('click',e=>{
      const b=e.target.closest('[data-view]');
      if(b) setView(b.dataset.view);
    });
    await renderDashboard(document.getElementById('main'));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded',()=>App.init());
