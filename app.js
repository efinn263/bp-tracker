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

/* Plugin 2: Tooltip only appears on a momentary single-finger tap (or click) —
   a swipe/drag (used for panning) never triggers it — and fades away
   automatically after 2 seconds. */
const TapTooltipPlugin = {
  id: 'tapTooltip',
  afterInit(chart) {
    const canvas = chart.canvas;
    const TAP_MOVE_PX = 10;
    const TAP_MAX_MS  = 500;
    let start = null; // {x, y, t, event}
    let moved = false;
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
    const onTouchStart = e => {
      if (e.touches.length !== 1) { start = null; hide(); return; }
      const t = e.touches[0];
      start = { x:t.clientX, y:t.clientY, t:Date.now(), event:e };
      moved = false;
    };
    const onTouchMove = e => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX-start.x, t.clientY-start.y) > TAP_MOVE_PX) {
        if (!moved) hide(); // swipe/pan started — cancel the tap and dismiss any tooltip
        moved = true;
      }
    };
    const onTouchEnd = () => {
      if (start && !moved && (Date.now()-start.t) <= TAP_MAX_MS) show(start.event);
      start = null; moved = false;
    };
    const onClick = e => show(e);
    canvas.addEventListener('touchstart', onTouchStart, { passive:true });
    canvas.addEventListener('touchmove', onTouchMove, { passive:true });
    canvas.addEventListener('touchend', onTouchEnd, { passive:true });
    canvas.addEventListener('click', onClick);
    chart._tapTooltipCleanup = () => {
      clearTimeout(chart._tapTtTimer);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
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
    const now=Date.now(), map={'7d':7,'30d':30};
    if(S.range==='all')    return {start:null,end:null};
    if(S.range==='custom') return {start:S.customStart?new Date(S.customStart).getTime():null, end:S.customEnd?new Date(S.customEnd).getTime():now};
    if(S.range==='8h')     return {start:now-8*3600000, end:now};
    if(S.range==='24h')    return {start:now-24*3600000, end:now};
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
    const [readings,allR,medEvents]=await Promise.all([
      DB.getReadings(start,end), DB.getReadings(), DB.getMedEvents()
    ]);
    const latest=allR.sort((a,b)=>a.timestamp-b.timestamp).at(-1);
    const avgSys=round(avg(readings,'systolic'));
    const avgDia=round(avg(readings,'diastolic'));
    const avgBpm=round(avg(readings,'bpm'));
    const rlbl={'8h':'8H','24h':'24H','7d':'7D','30d':'30D','all':'All'};

    main.innerHTML=`
      <div class="range-tabs" id="range-tabs">
        ${['8h','24h','7d','30d','all'].map(r=>`<button class="rtab${S.range===r?' active':''}" data-range="${r}">${rlbl[r]}</button>`).join('')}
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

    initChart(allR, medEvents, start, end);

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

  /* ── BP y-axis bounds: a fixed reference range (50-200mmHg), widened only
     if actual data falls outside it — kept a hard min/max (not "suggested")
     so the BPM axis math below can rely on exactly where the axis sits. ── */
  const BP_AXIS_MIN=50, BP_AXIS_MAX=200;
  function getBpAxisRange(readings){
    const vals=[...readings.map(r=>r.systolic),...readings.map(r=>r.diastolic)].filter(v=>v!=null);
    const min=vals.length?Math.min(BP_AXIS_MIN, Math.floor(Math.min(...vals)/10)*10):BP_AXIS_MIN;
    const max=vals.length?Math.max(BP_AXIS_MAX, Math.ceil(Math.max(...vals)/10)*10):BP_AXIS_MAX;
    return {min,max};
  }

  /* ── BPM axis range: push the BPM line into a band clearly below wherever
     the diastolic data actually sits, so it never visually crosses through
     the systolic/diastolic zone even when raw bpm/dia values are similar. ── */
  function getBpmAxisRange(readings, bpAxisMin, bpAxisMax){
    const bpmVals=readings.map(r=>r.bpm).filter(v=>v!=null);
    const diaVals=readings.map(r=>r.diastolic).filter(v=>v!=null);
    const bpmMin=bpmVals.length?Math.min(...bpmVals):50, bpmMax=bpmVals.length?Math.max(...bpmVals):100;
    const diaFloor=diaVals.length?Math.min(...diaVals):70;
    const diaFloorFrac=(diaFloor-bpAxisMin)/(bpAxisMax-bpAxisMin);
    // Target: bpm's highest value maps to well under half of where the
    // diastolic band starts, with a small floor so the axis math stays sane.
    const targetFrac=Math.max(0.02, Math.min(0.28, diaFloorFrac*0.55));
    const min=Math.max(0, Math.floor((bpmMin-10)/10)*10);
    const span=Math.max(bpmMax-min, 15);
    const max=Math.ceil((min+span/targetFrac)/10)*10;
    return {min,max,dataMax:bpmMax};
  }

  /* ── Chart (dual Y-axis). `readings`/`medEvents` are the FULL dataset —
     viewStart/viewEnd only set the chart's initial zoom window; panning
     beyond it still reveals the rest of the data, nothing is hidden. ── */
  function initChart(readings, medEvents, viewStart, viewEnd){
    const canvas=document.getElementById('chart');
    if(!canvas) return;
    if(S.chart){S.chart.destroy(); S.chart=null;}

    const visible=(viewStart&&viewEnd)?readings.filter(x=>x.timestamp>=viewStart&&x.timestamp<=viewEnd):readings;
    const r=visible.length<80?4:2;
    const mkDs=(label,data,color,dash,yid)=>({
      label, data,
      borderColor:color, backgroundColor:color+'15',
      borderWidth:2, borderDash:dash?[6,3]:[],
      pointRadius:r, pointHoverRadius:r+3, pointBackgroundColor:color,
      tension:0.3, fill:false, yAxisID:yid,
    });
    const bpAxis=getBpAxisRange(readings);
    const bpmAxis=getBpmAxisRange(readings, bpAxis.min, bpAxis.max);

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
            min: viewStart ?? undefined, max: viewEnd ?? undefined,
            time:{displayFormats:{minute:'MMM d HH:mm',hour:'MMM d HH:mm',day:'MMM d',week:'MMM d',month:'MMM yy'}},
            grid:{color:'rgba(0,0,0,.04)'},
            ticks:{font:{family:'system-ui,sans-serif',size:10},color:'#9b9895',maxTicksLimit:6,maxRotation:0},
          },
          y:{
            position:'left',
            min:bpAxis.min, max:bpAxis.max,
            grid:{color:'rgba(0,0,0,.04)'},
            ticks:{font:{family:'system-ui,sans-serif',size:10},color:'#9b9895'},
            title:{display:true,text:'mmHg',font:{size:10},color:'#9b9895'},
          },
          y1:{
            position:'right',
            display:S.showBpm,
            min:bpmAxis.min, max:bpmAxis.max,
            grid:{drawOnChartArea:false},
            ticks:{
              font:{family:'system-ui,sans-serif',size:10},color:'#4a9068',
              maxTicksLimit:5,
              callback:v=> v<=bpmAxis.dataMax+15 ? v : '',
            },
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
            <div class="note-hdr">
              <span class="note-date">${fmtDT(n.timestamp)}</span>
              <div style="display:flex;gap:2px">
                <button class="icon-btn" data-edit-note="${n.id}" title="Edit">${svgEdit()}</button>
                <button class="icon-btn del" data-del-note="${n.id}" title="Delete">${svgX()}</button>
              </div>
            </div>
            <div class="note-text">${esc(n.text)}</div>
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
    main.querySelectorAll('[data-edit-note]').forEach(btn=>
      btn.addEventListener('click',()=>{
        const n=notes.find(x=>x.id===btn.dataset.editNote);
        if(n) showEditNoteModal(n, ()=>renderNotes(main));
      })
    );
    main.querySelectorAll('[data-del-note]').forEach(btn=>
      btn.addEventListener('click',async()=>{
        if(!confirm('Delete this note?')) return;
        await DB.deleteNote(btn.dataset.delNote);
        toast('Note deleted'); renderNotes(main);
      })
    );
  }

  /* ── Edit Note Modal (preserves original timestamp) ── */
  function showEditNoteModal(note, onSave){
    const modal=document.createElement('div');
    modal.className='modal-overlay';
    modal.innerHTML=`
      <div class="modal-sheet">
        <div class="modal-hdr">
          <span>Edit Note</span>
          <button class="modal-close" id="en-close">Close</button>
        </div>
        <div class="form">
          <div class="fg"><label class="flabel">${fmtDT(note.timestamp)}</label>
            <textarea class="finput" id="en-txt" rows="4">${esc(note.text)}</textarea>
          </div>
          <button class="btn btn-primary btn-full" id="en-save">Save Changes</button>
          <div style="height:8px"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close=()=>modal.remove();
    document.getElementById('en-close').addEventListener('click',close);
    modal.addEventListener('click',e=>{if(e.target===modal)close();});
    document.getElementById('en-save').addEventListener('click',async()=>{
      const txt=document.getElementById('en-txt').value.trim();
      if(!txt){toast('Write something first','err');return;}
      await DB.addNote({id:note.id, timestamp:note.timestamp, text:txt});
      toast('Note updated','ok'); close(); onSave?.();
    });
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
        <div class="card">
          <div class="card-hdr">Sync from Device</div>
          <div class="card-body" id="oxiline-sync-body"></div>
        </div>
      </div>
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

    renderOxilineSyncCard();
    function renderOxilineSyncCard(){
      const body=document.getElementById('oxiline-sync-body');
      if(!OxilineSync.isSupported()){
        body.innerHTML=`<div style="font-size:13px;color:var(--text-2);line-height:1.6">Sync needs Chrome on Android. It isn't supported in this browser (e.g. iPhone/Safari).</div>`;
        return;
      }
      body.innerHTML=`
        <div id="ox-status" style="font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:12px">Wake the cuff and keep it on, then tap Sync.</div>
        <button class="btn btn-primary" id="ox-sync-btn">Sync from Oxiline Pressure XS Pro</button>
      `;
      const statusEl=document.getElementById('ox-status');
      const btn=document.getElementById('ox-sync-btn');
      const setStatus=(msg,type='')=>{
        statusEl.textContent=msg;
        statusEl.style.color = type==='err' ? 'var(--sys)' : type==='ok' ? 'var(--bpm)' : 'var(--text-2)';
      };

      btn.addEventListener('click', async ()=>{
        btn.disabled=true;
        setStatus('Connecting to Oxiline Pressure XS Pro…');
        let imported=0, dupes=0;
        try{
          const existing=new Set((await DB.getReadings()).map(r=>r.timestamp));
          await OxilineSync.sync({
            onStatus(stage, info){
              if(stage==='in-progress') setStatus(`Syncing… retrieved ${info.count} reading${info.count!==1?'s':''}`);
            },
            async onRecord(rec){
              if(existing.has(rec.timestamp)){ dupes++; return; }
              existing.add(rec.timestamp);
              await DB.addReading({ timestamp:rec.timestamp, systolic:rec.systolic, diastolic:rec.diastolic, bpm:rec.bpm, deviceFlag:rec.deviceFlag });
              imported++;
            },
          });
          if(imported===0){
            setStatus('Already up to date — no new readings found.','ok');
          } else {
            setStatus(`Sync complete — imported ${imported} new reading${imported!==1?'s':''} (${dupes} already on file).`,'ok');
            toast(`Imported ${imported} reading${imported!==1?'s':''} from Oxiline`,'ok');
          }
        } catch(err){
          if(err?.code==='cancelled'){
            setStatus('Wake the cuff and keep it on, then tap Sync.');
          } else if(err?.code==='unsupported'){
            setStatus("Sync needs Chrome on Android. It isn't supported in this browser (e.g. iPhone/Safari).",'err');
          } else if(err?.code==='connect-failed'){
            setStatus("Couldn't connect. Make sure the cuff is awake and nearby, and not connected to the Oxiline app.",'err');
          } else if(err?.code==='mid-run-failure'){
            const n=err.partialCount||0;
            setStatus(n>0 ? `Connection dropped after ${n} reading${n!==1?'s':''}. Those ${n} were saved — tap Sync to resume.` : "Couldn't connect. Make sure the cuff is awake and nearby, and not connected to the Oxiline app.",'err');
          } else {
            console.error(err);
            setStatus('Something went wrong during sync. Tap Sync to try again.','err');
          }
        } finally {
          btn.disabled=false;
        }
      });
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
        <div class="card-hdr">PDF Report</div>
        <div class="card-body">
          <div class="vsub" style="padding:0 0 10px">Dashboard summary, blood pressure log, medication events with graphs, and notes for a chosen period</div>
          <div class="range-tabs" id="report-range-tabs" style="padding:0 0 12px">
            <button class="rtab active" data-rrange="1d">1 Day</button>
            <button class="rtab" data-rrange="3d">3 Days</button>
            <button class="rtab" data-rrange="7d">Week</button>
            <button class="rtab" data-rrange="all">All</button>
            <button class="rtab" data-rrange="custom">Custom</button>
          </div>
          <div class="frow" id="report-custom-range" style="display:none;margin-bottom:12px">
            <div class="fg"><label class="flabel">Start</label><input type="datetime-local" class="finput" id="report-start"></div>
            <div class="fg"><label class="flabel">End</label><input type="datetime-local" class="finput" id="report-end" value="${isoNow()}"></div>
          </div>
          <button class="btn btn-primary btn-full" id="gen-report">Generate PDF Report</button>
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

    let reportRange='1d';
    document.getElementById('report-range-tabs').addEventListener('click',e=>{
      const b=e.target.closest('[data-rrange]'); if(!b) return;
      reportRange=b.dataset.rrange;
      main.querySelectorAll('#report-range-tabs .rtab').forEach(x=>x.classList.toggle('active',x===b));
      document.getElementById('report-custom-range').style.display=reportRange==='custom'?'grid':'none';
    });
    document.getElementById('gen-report').addEventListener('click',async()=>{
      const now=Date.now();
      let start,end;
      if(reportRange==='1d'){ start=now-1*86400000; end=now; }
      else if(reportRange==='3d'){ start=now-3*86400000; end=now; }
      else if(reportRange==='7d'){ start=now-7*86400000; end=now; }
      else if(reportRange==='all'){ start=null; end=now; }
      else {
        const s=document.getElementById('report-start').value, e2=document.getElementById('report-end').value;
        if(!s||!e2){ toast('Select a custom start and end date','err'); return; }
        start=new Date(s).getTime(); end=new Date(e2).getTime();
        if(start>=end){ toast('Start must be before end','err'); return; }
      }
      const btn=document.getElementById('gen-report');
      btn.disabled=true; const orig=btn.textContent; btn.textContent='Generating…';
      try{
        await generatePdfReport(start,end);
        toast('Report downloaded','ok');
      } catch(err){
        console.error(err);
        toast('Failed to generate report','err');
      }
      btn.disabled=false; btn.textContent=orig;
    });
  }

  /* ═══════════════════════════
     PDF REPORT
  ═══════════════════════════ */

  /* Render an offscreen (never-attached) chart to a PNG data URL */
  function chartImageURL(config, pxWidth, pxHeight){
    const canvas=document.createElement('canvas');
    canvas.width=pxWidth; canvas.height=pxHeight;
    const chart=new Chart(canvas, config);
    chart.update('none');
    const url=canvas.toDataURL('image/png');
    chart.destroy();
    return url;
  }

  function reportDashboardChartImage(readings, medEvents, pxWidth, pxHeight){
    const bpAxis=getBpAxisRange(readings);
    const bpmAxis=getBpmAxisRange(readings, bpAxis.min, bpAxis.max);
    const hasBpm=readings.some(r=>r.bpm!=null);
    const mkDs=(label,data,color,dash,yid)=>({
      label,data,borderColor:color,backgroundColor:color+'15',
      borderWidth:2,borderDash:dash?[6,3]:[],pointRadius:2,pointBackgroundColor:color,
      tension:0.3,fill:false,yAxisID:yid,
    });
    const datasets=[
      mkDs('Systolic',  readings.filter(x=>x.systolic !=null).map(x=>({x:x.timestamp,y:x.systolic })), '#c05252', false,'y'),
      mkDs('Diastolic', readings.filter(x=>x.diastolic!=null).map(x=>({x:x.timestamp,y:x.diastolic})), '#3b7bbf', false,'y'),
    ];
    if(hasBpm) datasets.push(mkDs('BPM', readings.filter(x=>x.bpm!=null).map(x=>({x:x.timestamp,y:x.bpm})), '#4a9068', true, 'y1'));
    return chartImageURL({
      type:'line',
      data:{datasets},
      options:{
        responsive:false, animation:false,
        scales:{
          x:{type:'time', time:{displayFormats:{minute:'MMM d HH:mm',hour:'MMM d HH:mm',day:'MMM d'}},
            ticks:{font:{size:11},color:'#6b6862',maxTicksLimit:7,maxRotation:0}, grid:{color:'rgba(0,0,0,.06)'}},
          y:{position:'left', min:bpAxis.min, max:bpAxis.max,
            ticks:{font:{size:11},color:'#6b6862'}, grid:{color:'rgba(0,0,0,.06)'},
            title:{display:true,text:'mmHg',font:{size:11},color:'#6b6862'}},
          y1:{position:'right', display:hasBpm, min:bpmAxis.min, max:bpmAxis.max,
            grid:{drawOnChartArea:false},
            ticks:{font:{size:11},color:'#4a9068',callback:v=>v<=bpmAxis.dataMax+15?v:''},
            title:{display:true,text:'BPM',font:{size:11},color:'#4a9068'}},
        },
        plugins:{
          legend:{display:true,position:'top',labels:{font:{size:11},boxWidth:12,color:'#1a1916'}},
          medLines:{timestamps:medEvents.map(e=>e.timestamp)},
          tooltip:{enabled:false},
        },
      },
    }, pxWidth, pxHeight);
  }

  function reportMedChartImage(sysD, diaD, ts, wStart, wEnd, lines, pxWidth, pxHeight){
    return chartImageURL({
      type:'line',
      data:{datasets:[
        {label:'Systolic',data:sysD,borderColor:'#c05252',backgroundColor:'#c0525215',borderWidth:2,pointRadius:3,tension:0.3,fill:false},
        {label:'Diastolic',data:diaD,borderColor:'#3b7bbf',backgroundColor:'#3b7bbf15',borderWidth:2,pointRadius:3,tension:0.3,fill:false},
      ]},
      options:{
        responsive:false, animation:false,
        scales:{
          x:{type:'time', time:{displayFormats:{minute:'HH:mm',hour:'MMM d HH:mm'}}, min:wStart, max:wEnd,
            ticks:{font:{size:10},color:'#6b6862',maxTicksLimit:5,maxRotation:0}, grid:{color:'rgba(0,0,0,.06)'}},
          y:{suggestedMin:50,suggestedMax:180,
            ticks:{font:{size:10},color:'#6b6862'}, grid:{color:'rgba(0,0,0,.06)'},
            title:{display:true,text:'mmHg',font:{size:10},color:'#6b6862'}},
        },
        plugins:{
          legend:{display:true,position:'top',labels:{font:{size:10},boxWidth:10,color:'#1a1916'}},
          medLines:{timestamps:[ts]},
          baselineShift:{lines},
          tooltip:{enabled:false},
        },
      },
    }, pxWidth, pxHeight);
  }

  async function generatePdfReport(start,end){
    const [readings, medEventsAll, notesAll, allReadings]=await Promise.all([
      DB.getReadings(start,end), DB.getMedEvents(), DB.getNotes(), DB.getReadings()
    ]);
    const inRange=ts=>(start==null||ts>=start)&&(end==null||ts<=end);
    const medEvents=medEventsAll.filter(e=>inRange(e.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);
    const notes=notesAll.filter(n=>inRange(n.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);

    const avgSys=round(avg(readings,'systolic'));
    const avgDia=round(avg(readings,'diastolic'));
    const avgBpm=round(avg(readings,'bpm'));
    const dashUrl=reportDashboardChartImage(readings, medEvents, 900, 320);

    const eventReports=medEvents.map(ev=>{
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
      const wStart=ev.timestamp-winBef*60000, wEnd=ev.timestamp+winAft*60000;
      const inWin=allReadings.filter(r=>r.timestamp>=wStart&&r.timestamp<=wEnd);
      const sysD=inWin.filter(r=>r.systolic !=null).map(r=>({x:r.timestamp,y:r.systolic }));
      const diaD=inWin.filter(r=>r.diastolic!=null).map(r=>({x:r.timestamp,y:r.diastolic}));
      const lines=[
        {value:bSys, color:'rgba(192,82,82,.5)',  dash:[3,3], label:'Baseline'},
        {value:pSys, color:'rgba(192,82,82,.95)', dash:[8,3], label:'Post-dose'},
        {value:bDia, color:'rgba(59,123,191,.5)', dash:[3,3], label:'Baseline'},
        {value:pDia, color:'rgba(59,123,191,.95)',dash:[8,3], label:'Post-dose'},
      ];
      const img=reportMedChartImage(sysD,diaD,ev.timestamp,wStart,wEnd,lines,680,260);
      return {ev,bSys,bDia,pSys,pDia,sysRed,diaRed,sysMmhg,diaMmhg,sysPeak,diaPeak,
        bCount:baseline.length,pCount:after.length,img};
    });

    buildPdf({start,end,avgSys,avgDia,avgBpm,readings,dashUrl,eventReports,notes});
  }

  function buildPdf({start,end,avgSys,avgDia,avgBpm,readings,dashUrl,eventReports,notes}){
    const { jsPDF } = window.jspdf;
    const doc=new jsPDF({unit:'mm',format:'a4'});
    const PW=210, PH=297, MX=14;
    let y=0;

    const C={
      accent:[99,102,241], sys:[192,82,82], dia:[59,123,191], bpm:[74,144,104],
      text1:[26,25,22], text2:[107,104,98], text3:[155,152,149], border:[227,225,218],
    };

    const fmtFull=ts=>new Date(ts).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const rangeLabel = start==null
      ? `All time  ·  through ${fmtFull(end)}`
      : `${fmtFull(start)} – ${fmtFull(end)}`;

    function drawHeader(){
      doc.setFillColor(...C.accent);
      doc.rect(0,0,PW,24,'F');
      doc.setTextColor(255,255,255);
      doc.setFont('helvetica','bold'); doc.setFontSize(16);
      doc.text('BP Tracker Report', MX, 14);
      doc.setFont('helvetica','normal'); doc.setFontSize(9);
      doc.text(rangeLabel, MX, 20);
      y=32;
    }
    function checkBreak(need, onNewPage){
      if(y+need>PH-16){
        doc.addPage();
        doc.setDrawColor(...C.accent); doc.setLineWidth(1);
        doc.line(0,10,PW,10);
        y=18;
        onNewPage?.();
      }
    }
    function sectionTitle(text){
      checkBreak(12);
      doc.setTextColor(...C.text1); doc.setFont('helvetica','bold'); doc.setFontSize(12);
      doc.text(text, MX, y);
      doc.setDrawColor(...C.border); doc.setLineWidth(0.3);
      doc.line(MX, y+2, PW-MX, y+2);
      y+=9;
    }

    drawHeader();

    // Summary
    sectionTitle('Summary');
    const stats=[['Systolic avg',avgSys,C.sys],['Diastolic avg',avgDia,C.dia],['BPM avg',avgBpm,C.bpm]];
    const boxW=(PW-2*MX-2*6)/3;
    stats.forEach(([label,val,color],i)=>{
      const bx=MX+i*(boxW+6);
      doc.setDrawColor(...C.border); doc.setLineWidth(0.3);
      doc.roundedRect(bx,y,boxW,20,2,2);
      doc.setTextColor(...C.text3); doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
      doc.text(label.toUpperCase(), bx+4, y+7);
      doc.setTextColor(...color); doc.setFont('helvetica','bold'); doc.setFontSize(15);
      doc.text(val!=null?String(val):'—', bx+4, y+16);
    });
    y+=26;
    doc.setTextColor(...C.text2); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`${readings.length} reading${readings.length!==1?'s':''} in this range`, MX, y);
    y+=8;

    // Dashboard chart
    sectionTitle('Blood Pressure & Heart Rate');
    const imgW=PW-2*MX, imgH=imgW*(320/900);
    checkBreak(imgH+4);
    doc.addImage(dashUrl,'PNG',MX,y,imgW,imgH);
    y+=imgH+10;

    // Blood Pressure Log (individual readings)
    if(readings.length){
      checkBreak(14);
      sectionTitle(`Blood Pressure Log (${readings.length})`);

      const logCols=[
        {label:'DATE', w:24},
        {label:'TIME', w:16},
        {label:'SYS',  w:13},
        {label:'DIA',  w:13},
        {label:'BPM',  w:13},
        {label:'NOTES',w:0},
      ];
      logCols[5].w=(PW-2*MX)-logCols.slice(0,5).reduce((s,c)=>s+c.w,0);

      const truncateToWidth=(text,maxWidth)=>{
        if(!text) return '';
        if(doc.getTextWidth(text)<=maxWidth) return text;
        let t=text;
        while(t.length>0 && doc.getTextWidth(t+'…')>maxWidth) t=t.slice(0,-1);
        return t+'…';
      };
      const drawLogHead=()=>{
        doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.text3);
        let x=MX;
        for(const c of logCols){ doc.text(c.label, x, y); x+=c.w; }
        y+=2.5;
        doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
        doc.line(MX,y,PW-MX,y);
        y+=4.5;
      };
      drawLogHead();

      const sortedReadings=[...readings].sort((a,b)=>b.timestamp-a.timestamp);
      sortedReadings.forEach((r,i)=>{
        checkBreak(5, drawLogHead);
        if(i%2===1){ doc.setFillColor(248,247,244); doc.rect(MX,y-3.3,PW-2*MX,4.6,'F'); }
        let x=MX;
        doc.setFont('helvetica','normal'); doc.setFontSize(8);
        doc.setTextColor(...C.text2);
        doc.text(new Date(r.timestamp).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}), x, y); x+=logCols[0].w;
        doc.text(new Date(r.timestamp).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}), x, y); x+=logCols[1].w;
        doc.setTextColor(...C.sys); doc.text(r.systolic!=null?String(r.systolic):'—', x, y); x+=logCols[2].w;
        doc.setTextColor(...C.dia); doc.text(r.diastolic!=null?String(r.diastolic):'—', x, y); x+=logCols[3].w;
        doc.setTextColor(...C.bpm); doc.text(r.bpm!=null?String(r.bpm):'—', x, y); x+=logCols[4].w;
        if(r.notes){
          doc.setTextColor(...C.text2);
          doc.text(truncateToWidth(r.notes, logCols[5].w-2), x, y);
        }
        y+=4.6;
      });
      y+=6;
    }

    // Medications
    if(eventReports.length){
      checkBreak(14);
      sectionTitle(`Medication Events (${eventReports.length})`);
      for(const r of eventReports){
        checkBreak(60);
        doc.setTextColor(...C.text1); doc.setFont('helvetica','bold'); doc.setFontSize(11);
        doc.text(`${r.ev.medication||'Medication'}${r.ev.dose?' — '+r.ev.dose:''}`, MX, y);
        doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.text2);
        doc.text(new Date(r.ev.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}), MX, y+5);
        y+=9;

        doc.setFontSize(9); doc.setTextColor(...C.text2);
        doc.text(`Baseline (${r.bCount}): ${r.bSys??'—'}/${r.bDia??'—'} mmHg`, MX, y);
        doc.text(`Post-dose (${r.pCount}): ${r.pSys??'—'}/${r.pDia??'—'} mmHg`, MX+95, y);
        y+=6;

        const parts=[];
        if(r.sysRed!=null) parts.push(`Sys ${Math.abs(r.sysRed)}% (${Math.abs(r.sysMmhg)} mmHg) ${r.sysRed>=0?'reduction':'increase'}`);
        if(r.diaRed!=null) parts.push(`Dia ${Math.abs(r.diaRed)}% (${Math.abs(r.diaMmhg)} mmHg) ${r.diaRed>=0?'reduction':'increase'}`);
        if(parts.length){
          doc.setTextColor(...C.text1); doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
          doc.text(parts.join('    '), MX, y);
          y+=6;
        }
        if(r.sysPeak||r.diaPeak){
          const pk=[];
          if(r.sysPeak) pk.push(`Sys: ${Math.abs(r.sysPeak.mmhg)} mmHg peak ${r.sysPeak.mmhg>=0?'reduction':'increase'} in ${Math.abs(r.sysPeak.hours)}h`);
          if(r.diaPeak) pk.push(`Dia: ${Math.abs(r.diaPeak.mmhg)} mmHg peak ${r.diaPeak.mmhg>=0?'reduction':'increase'} in ${Math.abs(r.diaPeak.hours)}h`);
          doc.setFont('helvetica','normal'); doc.setTextColor(...C.text2); doc.setFontSize(8.5);
          doc.text(pk.join('    '), MX, y);
          y+=7;
        }

        const imW2=PW-2*MX-40, imH2=imW2*(260/680);
        checkBreak(imH2+8);
        doc.addImage(r.img,'PNG',MX+20,y,imW2,imH2);
        y+=imH2+4;

        if(r.ev.notes){
          doc.setFont('helvetica','italic'); doc.setFontSize(8.5); doc.setTextColor(...C.text2);
          const lines=doc.splitTextToSize(r.ev.notes, PW-2*MX);
          checkBreak(lines.length*4+2);
          doc.text(lines, MX, y); y+=lines.length*4+2;
        }

        doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
        doc.line(MX,y,PW-MX,y); y+=8;
      }
    }

    // Notes
    if(notes.length){
      checkBreak(14);
      sectionTitle(`Notes (${notes.length})`);
      for(const n of notes){
        checkBreak(16);
        doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...C.text1);
        doc.text(new Date(n.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}), MX, y);
        y+=5;
        doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(...C.text1);
        const lines=doc.splitTextToSize(n.text, PW-2*MX);
        checkBreak(lines.length*4.2+6);
        doc.text(lines, MX, y);
        y+=lines.length*4.2+7;
      }
    }

    const pageCount=doc.internal.getNumberOfPages();
    for(let i=1;i<=pageCount;i++){
      doc.setPage(i);
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...C.text3);
      doc.text(`Page ${i} of ${pageCount}`, PW-MX, PH-8, {align:'right'});
    }

    const fname = start==null
      ? `bp-report-all-time_to_${new Date(end).toISOString().slice(0,10)}.pdf`
      : `bp-report-${new Date(start).toISOString().slice(0,10)}_to_${new Date(end).toISOString().slice(0,10)}.pdf`;
    doc.save(fname);
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
