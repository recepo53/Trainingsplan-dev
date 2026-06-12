// ═══════════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════════
const SB_URL = 'https://xepdnsanjpsamhrilbaz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGRuc2FuanBzYW1ocmlsYmF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzkxOTcsImV4cCI6MjA5MTMxNTE5N30.o8X7oPIaRxtAwROrnDmJ5MI4bbKf77XGJuzDnr6lf6Y';

// ── Session / Login ──────────────────────────────
let SESSION = null; // { access_token, refresh_token, user_id }

function loadSession(){ try { return JSON.parse(localStorage.getItem('recep_session')||'null'); } catch(e){ return null; } }
function saveSession(s){ SESSION = s; localStorage.setItem('recep_session', JSON.stringify(s)); }
function clearSession(){ SESSION = null; localStorage.removeItem('recep_session'); }

async function sbLogin(email, password){
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const d = await r.json();
  if(!r.ok || !d.access_token){ throw new Error(d.error_description || d.msg || d.error || 'Login fehlgeschlagen'); }
  saveSession({ access_token: d.access_token, refresh_token: d.refresh_token, user_id: d.user.id });
  return SESSION;
}

async function sbRefresh(){
  const s = loadSession();
  if(!s || !s.refresh_token) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    const d = await r.json();
    if(!r.ok || !d.access_token){ clearSession(); return null; }
    saveSession({ access_token: d.access_token, refresh_token: d.refresh_token, user_id: d.user.id });
    return SESSION;
  } catch(e){ return null; }
}

function sbLogout(){ clearSession(); location.reload(); }

// ── Daten lesen / schreiben (nur mit Login) ──────
// Fetch mit automatischem Login-Refresh, falls der Token abgelaufen ist (401)
async function sbFetch(path, options = {}, retry = true) {
  if(!SESSION) throw new Error('no session');
  const headers = Object.assign({
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SESSION.access_token
  }, options.headers || {});
  const r = await fetch(`${SB_URL}${path}`, Object.assign({}, options, { headers }));
  if(r.status === 401 && retry){
    const s = await sbRefresh();
    if(s) return sbFetch(path, options, false);
  }
  return r;
}

async function sbGet() {
  if(!SESSION) return null;
  try {
    const r = await sbFetch(`/rest/v1/trainingsplan?user_id=eq.${SESSION.user_id}&select=data&order=updated_at.desc&limit=1`);
    if(!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) && d[0] ? d[0].data : null;
  } catch(e) { return null; }
}

// Gibt true zurueck, wenn das Speichern in die Cloud geklappt hat, sonst false
async function sbSet(data) {
  if(!SESSION) return false;
  try {
    const r = await sbFetch(`/rest/v1/trainingsplan?on_conflict=user_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: SESSION.user_id, data, updated_at: new Date().toISOString() })
    });
    return r.ok;
  } catch(e) { return false; }
}

// ═══════════════════════════════════════════════
// BACKGROUND TIMER (Web Worker via Blob)
// ═══════════════════════════════════════════════
let startTime = null;
let interval = null;
let tmrOn = false;
let elapsed = 0;

function timerStart() {
  if (tmrOn) return;
  tmrOn = true;

  if (!startTime) {
    startTime = Date.now();
  } else {
    startTime = Date.now() - elapsed * 1000;
  }

  interval = setInterval(updateTimer, 500);
}

function timerStop() {
  tmrOn = false;
  clearInterval(interval);
}

function timerReset() {
  timerStop();
  // Trainingszeit speichern wenn > 60 Sekunden
  if (elapsed > 60) {
    const today = getToday();
    if (!S.workoutDurations) S.workoutDurations = {};
    // Längste Session des Tages behalten
    if (!S.workoutDurations[today] || elapsed > S.workoutDurations[today]) {
      S.workoutDurations[today] = elapsed;
    }
  }
  // Session-Reset-Zeitstempel setzen → Übungen werden zurückgesetzt
  S.sessionResetTime = new Date().toISOString();
  save();
  if (curTab === 'p') renderProgress(); else if (curTab === 'h') renderHistory();
  startTime = null;
  elapsed = 0;
  document.getElementById('timerDisp').textContent = '00:00:00';
  document.getElementById('btnStart').classList.remove('on');
  renderExercises();
  toast('Workout gespeichert & zurückgesetzt ✓');
}

function updateTimer() {
  if (!startTime) return;

  elapsed = Math.floor((Date.now() - startTime) / 1000);

  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;

  document.getElementById('timerDisp').textContent =
    String(h).padStart(2,'0') + ':' +
    String(m).padStart(2,'0') + ':' +
    String(s).padStart(2,'0');
}

// ═══════════════════════════════════════════════
// BACKGROUND REST TIMER (Web Worker)
// ═══════════════════════════════════════════════
let restEndTime = null;
let restInterval = null;
let restDuration = 120;

function startRest(sec = 120) {
  restDuration = sec;
  restEndTime = Date.now() + sec * 1000;

  document.getElementById('restBar').classList.add('show');
  const ring = document.getElementById('restRing');
  if (ring) ring.style.strokeDashoffset = '0';

  clearInterval(restInterval);
  updateRest();
  restInterval = setInterval(updateRest, 500);
}

function updateRest() {
  if (!restEndTime) return;

  const remaining = Math.max(0, Math.floor((restEndTime - Date.now()) / 1000));

  if (remaining <= 0) {
    clearInterval(restInterval);
    document.getElementById('restBar').classList.remove('show');
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
    return;
  }

  const m = Math.floor(remaining / 60);
  const s = remaining % 60;

  document.getElementById('restNum').textContent =
    m + ':' + String(s).padStart(2,'0');

  const frac = remaining / restDuration;
  document.getElementById('restProgBar').style.width = (frac * 100) + '%';
  const ring = document.getElementById('restRing');
  if (ring) ring.style.strokeDashoffset = (138.2 * (1 - frac)).toFixed(1);
}

function restSkip() {
  clearInterval(restInterval);
  document.getElementById('restBar').classList.remove('show');
}

  //NEW
  
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    updateTimer();
    updateRest();
  }
});
  

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
const DEFAULT_DAYS = [
  { key:'push',  title:'PUSH',       badge:'BRUST'   },
  { key:'pull',  title:'PULL',       badge:'RÜCKEN'  },
  { key:'push2', title:'PUSH 2',     badge:'VOLUMEN' },
  { key:'ganz',  title:'GANZKÖRPER', badge:'ARME'    },
];
// DAYS zeigt immer auf S.days (migrateData hält beides synchron)
let DAYS = DEFAULT_DAYS.map(d=>({...d, cls:'c1', sel:'sel-c1'}));

const DEF = {
  push: [
    {id:'pu1',name:'Bankdrücken',desc:'Langhantel oder Maschine',sets:4,reps:'8-10'},
    {id:'pu2',name:'Schulterdrücken',desc:'Kurzhanteln · 27,5 kg',sets:4,reps:'10'},
    {id:'pu3',name:'Schrägbankdrücken',desc:'Kurzhanteln · 27,5 kg',sets:3,reps:'10-12'},
    {id:'pu4',name:'Seitheben',desc:'14 kg · saubere Technik',sets:3,reps:'15'},
    {id:'pu5',name:'Trizepsdrücken (Seil)',desc:'60 kg · Ellenbogen fest',sets:3,reps:'12-15'},
    {id:'pu6',name:'Crunches + Beinheben',desc:'Bauch · abwechselnd',sets:3,reps:'15-20'},
  ],
  pull: [
    {id:'pl1',name:'Klimmzüge / Latzug',desc:'86 kg · weiter Griff',sets:4,reps:'8'},
    {id:'pl2',name:'Rudern (Maschine/KH)',desc:'66 kg · unilateral 65 kg',sets:3,reps:'10'},
    {id:'pl3',name:'T-Bar Row',desc:'50 kg · Rücken gerade',sets:3,reps:'10'},
    {id:'pl4',name:'Face Pulls / Reverse Fly',desc:'54 kg · Außenrotation',sets:3,reps:'12'},
    {id:'pl5',name:'Bizepscurls (Doppel)',desc:'45 kg · langsam runter',sets:3,reps:'12'},
    {id:'pl6',name:'Planks + Russian Twists',desc:'Core · je 3 Runden',sets:3,reps:'3 Runden'},
  ],
  push2: [
    {id:'p2a',name:'Dips / Butterfly',desc:'102,5 kg · volle Bewegung',sets:4,reps:'12-15'},
    {id:'p2b',name:'Arnold Press',desc:'Volle Rotation · kontrolliert',sets:3,reps:'12'},
    {id:'p2c',name:'KH Fliegende',desc:'Weiter Bogen · Dehnung',sets:3,reps:'15'},
    {id:'p2d',name:'Seitheben (Drop-Sätze)',desc:'Bis Muskelversagen',sets:3,reps:'max'},
    {id:'p2e',name:'Trizeps Kickbacks',desc:'21 kg · Ellenbogen oben',sets:3,reps:'15'},
    {id:'p2f',name:'Cable Crunches',desc:'Kabel · Rücken rund',sets:3,reps:'15'},
  ],
  ganz: [
    {id:'ga1',name:'Supersätze: Bizeps + Trizeps',desc:'Curl + Drücken · kein Pause',sets:3,reps:'15'},
    {id:'ga2',name:'Hammer Curl',desc:'Alternierend · neutral Griff',sets:2,reps:'12'},
    {id:'ga3',name:'Trizeps Seil am Hals (Unil.)',desc:'Einarmig · Ellenbogen oben',sets:2,reps:'12'},
    {id:'ga4',name:'Bizepscurls (Seil)',desc:'Kabel · volle Streckung',sets:3,reps:'12'},
    {id:'ga5',name:'Trizeps über Kopf drücken',desc:'Kabel oder SZ-Stange',sets:3,reps:'12'},
    {id:'ga6',name:'Bauchzirkel',desc:'3 Übungen am Stück',sets:3,reps:'3 Runden'},
  ],
};

let S = {
  exercises: { push:[...DEF.push], pull:[...DEF.pull], push2:[...DEF.push2], ganz:[...DEF.ganz] },
  logs: {}, streak: { cur:0, best:0, lastDate:null, dates:[] },
  stats: { trainings:0, sets:0 },
  weights: [], // [{date:'2025-01-01', kg:82.5}]
  workoutDurations: {}, // {date: seconds}
  sessionResetTime: null // ISO-Timestamp des letzten Resets
};

let curDay=0, curTab='w', logId=null, editId=null, delId=null;
let syncTimer=null, pendingSync=false;

// ═══════════════════════════════════════════════
// SUPABASE SYNC
// ═══════════════════════════════════════════════
function setSyncStatus(status, text) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncTxt');
  dot.className = 'sync-dot ' + status;
  txt.textContent = text;
}

async function loadFromSupabase() {
  setSyncStatus('syncing', 'Lade Daten...');
  const remote = await sbGet();

  // Lokales Backup lesen (kann neuer sein als Supabase wenn Debounce noch lief)
  let local = null;
  try { local = JSON.parse(localStorage.getItem('recep_backup') || 'null'); } catch(e) {}

  if (remote) {
    S = { ...S, ...remote };
    if (!S.weights) S.weights = [];

    // Gewichte zusammenfuehren: lokale Eintraege gewinnen (neuere)
    if (local && local.weights && local.weights.length) {
      const wMap = new Map();
      S.weights.forEach(w => wMap.set(w.date, w));
      local.weights.forEach(w => wMap.set(w.date, w));
      S.weights = [...wMap.values()].sort((a,b) => a.date.localeCompare(b.date));
    }

    // Logs zusammenfuehren: lokale Eintraege gewinnen (neuere)
    if (local && local.logs) {
      S.logs = S.logs || {};
      Object.keys(local.logs).forEach(exId => {
        if (!S.logs[exId]) S.logs[exId] = [];
        const lMap = new Map();
        S.logs[exId].forEach(l => lMap.set(l.date, l));
        local.logs[exId].forEach(l => lMap.set(l.date, l));
        S.logs[exId] = [...lMap.values()].sort((a,b) => a.date.localeCompare(b.date));
      });
    }

    migrateData();
    setSyncStatus('ok', 'Synchronisiert');
    save();
  } else {
    migrateData();
    setSyncStatus('ok', 'Bereit (Offline)');
  }
  renderStats();
  selectDay(0);
}

function save() {
  localStorage.setItem('recep_backup', JSON.stringify(S));
  setSyncStatus('syncing', 'Speichert...');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const ok = await sbSet(S);
    setSyncStatus(ok ? 'ok' : 'err', ok ? 'Gespeichert ✓' : 'Nur lokal gespeichert');
  }, 1000);
}

// ═══════════════════════════════════════════════
// RENDER EXERCISES
// ═══════════════════════════════════════════════
function renderExercises() {
  const k = DAYS[curDay].key;
  const col = DAYS[curDay].cls;
  const exs = S.exercises[k] || [];
  const list = document.getElementById('exList');

  let doneCount = 0;
  DAYS.forEach(d => {
    (S.exercises[d.key]||[]).forEach(ex => {
      const last = (S.logs[ex.id]||[]).slice(-1)[0];
      if (last) {
        const today = getToday();
        if (last.date && last.date.startsWith(today)) doneCount++;
      }
    });
  });
  document.getElementById('exCountVal').textContent = doneCount;

  updateSessionUI();
  if (SES && SES.day === curDay) { renderSession(list); return; }

  const q=(document.getElementById('exSearch')?.value||'').trim().toLowerCase();
  if(q){ renderSearch(list,q); return; }

  if (!exs.length) { list.innerHTML='<div class="empty">Keine Übungen</div>'; return; }

  list.innerHTML = exs.map((ex,i)=>{
    const logs = S.logs[ex.id]||[];
    const pr = getPR(ex.id);
    const last = logs.slice(-1)[0];
    const today = getToday();
    // Nur Logs nach dem letzten Reset (aktive Session) für Sterne zählen
    const sessionStart = S.sessionResetTime || '2000-01-01';
    const activeLog = logs.find(l => l.date === today && l.updatedAt && l.updatedAt > sessionStart);
    const num = String(i+1).padStart(2,'0');
    const stars = Array.from({length:ex.sets},(_,j)=>`<div class="ex-star${j<(activeLog?activeLog.sets.length:0)?' lit':''}"></div>`).join('');
    let logStrip = '';
    if (last && last.sets && last.sets.length) {
      const chips = last.sets.map(s=>{
        const isPR = s.weight && parseFloat(s.weight)>=pr && pr>0;
        return `<span class="set-chip${isPR?' pr':''}">${fmtSet(s)}</span>`;
      }).join('');
      logStrip = `<div class="ex-log-strip"><span class="ex-log-date">${fmtDate(last.date)}</span>${chips}</div>`;
    }
    return `
      <div class="ex-row ${col}${pr>0?' pr-row':''}">
        <div class="ex-num">${num}</div>
        <div class="ex-body">
          <div class="ex-name">${ex.name}</div>
          ${ex.desc?`<div class="ex-sub">${ex.desc}</div>`:''}
          <div class="ex-stars">${stars}</div>
          ${logStrip}
        </div>
        <div class="ex-right">
          <div class="ex-rep-block">
            <div class="ex-reps">${ex.reps}</div>
            <div class="ex-rir">${ex.sets} Sätze</div>
            ${pr>0?`<div class="ex-pr-badge">PR: ${pr}kg</div>`:''}
          </div>
          <div class="ex-btns-wrap">
            <button class="log-btn" onclick="openLog('${ex.id}')">LOG</button>
            <button class="edit-btn" onclick="openEdit('${ex.id}')">✎</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderStats() {
  document.getElementById('streakVal').textContent = S.streak.cur;
}

// ═══════════════════════════════════════════════
// FORTSCHRITT
// ═══════════════════════════════════════════════
function renderProgress() {
  renderWeek();
  renderExChart();
  renderMuscleVolume();
  document.getElementById('sbTrainings').textContent = S.stats.trainings;
  document.getElementById('sbSets').textContent = getSessionSets();
  document.getElementById('sbStreak').textContent = S.streak.cur;
  document.getElementById('sbBest').textContent = S.streak.best;
}

function renderHistory() {
  renderCalHeat();
  renderExHistory();
  renderTrainingHistory();
}

// ═══════════════════════════════════════════════
// TRAININGS-KALENDER (Heatmap, GitHub-Stil)
// ═══════════════════════════════════════════════
function renderCalHeat(){
  const grid=document.getElementById('calGrid');
  const monthsEl=document.getElementById('calMonths');
  if(!grid) return;

  // Sätze pro Tag zählen (Intensität der Färbung)
  const setsPerDay={};
  Object.values(S.logs||{}).forEach(arr=>arr.forEach(l=>{
    if(l.date&&l.sets&&l.sets.length){
      setsPerDay[l.date]=(setsPerDay[l.date]||0)+l.sets.length;
    }
  }));
  // Auch Streak-Tage ohne Satz-Logs zählen als trainiert (Stufe 1)
  (S.streak.dates||[]).forEach(d=>{ if(!setsPerDay[d]) setsPerDay[d]=1; });

  const WEEKS=18;
  const todayStr=getToday();
  const today=new Date(todayStr+'T12:00:00');
  // Auf Montag dieser Woche zurückgehen, dann (WEEKS-1) Wochen zurück
  const start=new Date(today);
  const dow=(today.getDay()+6)%7; // 0=Mo … 6=So
  start.setDate(today.getDate()-dow-(WEEKS-1)*7);

  const monthNames=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  let cells='', months='', lastMonth=-1;

  for(let w=0;w<WEEKS;w++){
    // Monatslabel über der Spalte, wenn ein neuer Monat beginnt
    const colDate=new Date(start); colDate.setDate(start.getDate()+w*7);
    const m=colDate.getMonth();
    months+=`<span style="width:15px;overflow:visible;white-space:nowrap;">${m!==lastMonth?monthNames[m]:''}</span>`;
    lastMonth=m;
    for(let d=0;d<7;d++){
      const cd=new Date(start); cd.setDate(start.getDate()+w*7+d);
      const ds=cd.toISOString().split('T')[0];
      if(ds>todayStr){ cells+=`<div class="cal-cell future"></div>`; continue; }
      const n=setsPerDay[ds]||0;
      const lvl=n===0?'':(n<10?' l1':(n<20?' l2':' l3'));
      const isToday=ds===todayStr?' today':'';
      const tip=fmtDate(ds)+(n?` · ${n} Sätze`:' · kein Training');
      cells+=`<div class="cal-cell${lvl}${isToday}" title="${tip}"></div>`;
    }
  }
  grid.innerHTML=cells;
  monthsEl.innerHTML=months;
  document.getElementById('calStreak').innerHTML=
    `🔥 ${S.streak.cur||0} Tage · <span>Best: ${S.streak.best||0}</span>`;

  // Beim Öffnen automatisch ganz nach rechts scrollen (heute sichtbar)
  const sc=grid.closest('.cal-scroll');
  if(sc) sc.scrollLeft=sc.scrollWidth;
}

function renderExHistory() {
  const all = [];
  DAYS.forEach((d,i)=>{ (S.exercises[d.key]||[]).forEach(ex=>all.push({...ex,dayIdx:i})); });
  const wl = all.filter(ex=>(S.logs[ex.id]||[]).length>0);
  const list = document.getElementById('progList');
  if(!wl.length){ list.innerHTML='<div class="empty">Noch keine Logs</div>'; return; }
  list.innerHTML = wl.map(ex=>{
    const logs = S.logs[ex.id]||[];
    const pr = getPR(ex.id);
    const dc = DAYS[ex.dayIdx];
    const rows = logs.slice().reverse().slice(0,5).map(log=>{
      const chips = log.sets.map(s=>{
        const isPR=s.weight&&parseFloat(s.weight)>=pr&&pr>0;
        return `<span class="hist-chip${isPR?' pr':''}">${fmtSet(s)}</span>`;
      }).join('');
      return `<div class="hist-row"><span class="hist-date">${fmtDate(log.date)}</span><div class="hist-chips">${chips}</div></div>`;
    }).join('');
    return `
      <div class="prog-ex-card">
        <div class="prog-ex-hdr" onclick="tHist('h${ex.id}')">
          <div><div class="prog-ex-name">${ex.name}</div><div class="prog-ex-day" style="color:var(--${dc.cls})">${dc.title}</div></div>
          <div class="prog-ex-pr">${pr>0?pr+' kg PR':'—'}</div>
        </div>
        <div class="prog-ex-hist open" id="h${ex.id}">${rows}</div>
      </div>`;
  }).join('');
}

function renderWeek() {
  const grid = document.getElementById('weekGrid');
  const today = new Date();
  const dayNames=['SO','MO','DI','MI','DO','FR','SA'];
  const cells=[];
  for(let i=6;i>=0;i--){
    const d=new Date(today); d.setDate(today.getDate()-i);
    const str=d.toISOString().split('T')[0];
    const dn=dayNames[d.getDay()];
    const isToday=i===0;
    const trained=S.streak.dates&&S.streak.dates.includes(str);
    cells.push(`<div class="week-cell${trained?' trained':''}${isToday?' today':''}"><div class="week-cell-dot"></div><div class="week-cell-day">${dn}</div></div>`);
  }
  grid.innerHTML=cells.join('');
}

function renderTrainingHistory() {
  const container = document.getElementById('trainingHistory');
  if (!container) return;
  const dur = S.workoutDurations || {};
  const dates = S.streak.dates || [];
  // Merge: all days that either have a streak date or a duration
  const allDays = [...new Set([...dates, ...Object.keys(dur)])].sort().reverse().slice(0,30);
  if (!allDays.length) {
    container.innerHTML = '<div class="empty">Noch keine Trainings</div>';
    return;
  }

  // Übungsname-Lookup aufbauen
  const exNameMap = {};
  DAYS.forEach(d => {
    (S.exercises[d.key]||[]).forEach(ex => { exNameMap[ex.id] = ex.name; });
  });

  const dayNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  container.innerHTML = allDays.map(dateStr => {
    const d = new Date(dateStr);
    const dow = dayNames[d.getDay()];
    const sec = dur[dateStr] || 0;
    const durStr = sec > 0 ? fmtDur(sec) : '—';

    // Übungen und Sets für diesen Tag sammeln
// Übungen und Sets für diesen Tag sammeln
    let setsOnDay = 0;
    const exMap = {}; // Map zum sauberen Gruppieren der Übungen

    Object.entries(S.logs).forEach(([exId, logArr]) => {
      logArr.forEach(l => {
        // Prüfen, ob das Log zum aktuellen Datum (dateStr) gehört
        if (l.date && l.date.startsWith(dateStr)) {
          const cnt = (l.sets || []).length;
          if (cnt > 0) { // Nur berücksichtigen, wenn auch Sets gemacht wurden
            setsOnDay += cnt;
            const name = exNameMap[exId] || '—';
            
            // Sets zusammenrechnen, falls die Übung mehrfach geloggt wurde
            if (!exMap[name]) exMap[name] = 0;
            exMap[name] += cnt; 
          }
        }
      });
    });

    // Aus der Map wieder ein Array für die Anzeige machen
    const exOnDay = Object.keys(exMap).map(name => ({ name, cnt: exMap[name] }));

    const exChips = exOnDay.length
      ? `<div class="train-day-exs">${exOnDay.map(e =>
          `<span class="train-day-ex-chip">${e.name} <span class="train-day-ex-sets">${e.cnt}×</span></span>`
        ).join('')}</div>`
      : '';

    return `<div class="train-day-card" style="flex-direction:column;align-items:stretch;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div class="train-day-left">
          <div class="train-day-date">${fmtDate(dateStr)}</div>
          <div class="train-day-dow">${dow}${setsOnDay > 0 ? ' · ' + setsOnDay + ' Sets' : ''}</div>
        </div>
        <div class="train-day-right">
          <div class="train-day-dur">${durStr}</div>
        </div>
      </div>
      ${exChips}
    </div>`;
  }).join('');
}
function fmtDur(sec) {
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  if (h > 0) return h+'h ' + String(m).padStart(2,'0')+'m';
  if (m > 0) return m+'m ' + String(s).padStart(2,'0')+'s';
  return s+'s';
}
function tHist(id){ const el=document.getElementById(id); if(el) el.classList.toggle('open'); }

// ═══════════════════════════════════════════════
// GEWICHT TRACKING
// ═══════════════════════════════════════════════
function saveWeight() {
  const inp = document.getElementById('weightInp');
  const val = parseFloat(inp.value);
  if (!val || val < 30 || val > 250) { toast('Gültiges Gewicht eingeben!'); return; }
  const today = getToday();
  if (!S.weights) S.weights = [];
  const existing = S.weights.findIndex(w => w.date === today);
  if (existing >= 0) { S.weights[existing].kg = val; }
  else { S.weights.push({ date: today, kg: val }); }
  S.weights.sort((a,b)=>a.date.localeCompare(b.date));
  // Sofort zu Supabase speichern (kein Debounce) damit Reload sicher klappt
  localStorage.setItem('recep_backup', JSON.stringify(S));
  setSyncStatus('syncing', 'Speichert...');
  sbSet(S).then(ok => setSyncStatus(ok ? 'ok' : 'err', ok ? 'Gespeichert \u2713' : 'Nur lokal gespeichert'));
  inp.value = '';
  renderWeight();
  toast('Gewicht gespeichert!');
}

function deleteWeight(date) {
  S.weights = (S.weights||[]).filter(w => w.date !== date);
  save();
  renderWeight();
  toast('Eintrag gelöscht');
}

function renderWeight() {
  if (!S.weights) S.weights = [];
  const weights = S.weights;
  const today = getToday();
  const todayEntry = weights.find(w => w.date === today);

  // Today display
  const todayWrap = document.getElementById('weightTodayWrap');
  if (todayEntry) {
    todayWrap.style.display = 'block';
    document.getElementById('weightTodayVal').textContent = todayEntry.kg + ' kg';
    document.getElementById('weightTodayDate').textContent = fmtDate(today);
  } else {
    todayWrap.style.display = 'none';
  }

  if (!weights.length) {
    document.getElementById('wsStart').textContent = '—';
    document.getElementById('wsCurrent').textContent = '—';
    document.getElementById('wsTotal').textContent = '—';
    document.getElementById('chartWrap').style.display = 'none';
    document.getElementById('weeklyTable').style.display = 'none';
    document.getElementById('weightHistCard').style.display = 'none';
    return;
  }

  const first = weights[0].kg;
  const last = weights[weights.length-1].kg;
  const diff = +(last - first).toFixed(1);
  const diffStr = (diff > 0 ? '+' : '') + diff + ' kg';
  const diffCls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neu';

  document.getElementById('wsStart').textContent = first + ' kg';
  document.getElementById('wsCurrent').textContent = last + ' kg';
  const totalEl = document.getElementById('wsTotal');
  totalEl.textContent = diffStr;
  totalEl.className = 'ws-val ' + diffCls;

  // Chart (last 30)
  const recent = weights.slice(-30);
  if (recent.length >= 2) {
    document.getElementById('chartWrap').style.display = 'block';
    drawChart(recent);
  }

  // Weekly summary
  renderWeeklyTable(weights);

  // History list (last 20, newest first)
  document.getElementById('weightHistCard').style.display = 'block';
  const histList = document.getElementById('weightHistList');
  histList.innerHTML = weights.slice().reverse().slice(0,20).map(w => `
    <div class="wh-row">
      <div class="wh-date">${fmtDate(w.date)}</div>
      <div class="wh-right">
        <div class="wh-val">${w.kg} kg</div>
        <button class="wh-del" onclick="deleteWeight('${w.date}')">×</button>
      </div>
    </div>`).join('');
}

function drawChart(data) {
  const svg = document.getElementById('weightChartSvg');
  const W = 300, H = 110, pad = 8;
  const vals = data.map(d => d.kg);
  const minV = Math.min(...vals) - 1;
  const maxV = Math.max(...vals) + 1;
  const range = maxV - minV || 1;
  const pts = data.map((d,i) => {
    const x = pad + (i / (data.length-1||1)) * (W - pad*2);
    const y = H - pad - ((d.kg - minV) / range) * (H - pad*2);
    return {x,y,kg:d.kg,date:d.date};
  });
  const polyline = pts.map(p=>`${p.x},${p.y}`).join(' ');
  const areaPath = `M${pts[0].x},${H-pad} ` + pts.map(p=>`L${p.x},${p.y}`).join(' ') + ` L${pts[pts.length-1].x},${H-pad} Z`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#CCFF00" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#CCFF00" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#wg)"/>
    <polyline points="${polyline}" fill="none" stroke="#CCFF00" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((p,i)=> i===0||i===pts.length-1||i===pts.length-1?
      `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#CCFF00"/>
       <text x="${p.x}" y="${p.y-6}" text-anchor="middle" fill="#CCFF00" font-size="8" font-family="JetBrains Mono,monospace">${p.kg}</text>`
      :''
    ).join('')}
  `;
}

// ═══════════════════════════════════════════════
// ÜBUNGS-FORTSCHRITT (Gewicht / Volumen / 1RM)
// ═══════════════════════════════════════════════
let exChart = { id: null, metric: 'weight' };

// Pro Trainingstag einen Wert berechnen
// weight = schwerster Satz · volume = Summe kg×Wdh · orm = bestes geschätztes 1RM (Epley)
function exChartData(id, metric){
  const logs=(S.logs[id]||[]).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const out=[];
  logs.forEach(l=>{
    let v=0;
    (l.sets||[]).forEach(s=>{
      if(s.type==='w') return;
      const w=parseFloat(s.weight)||0, r=parseInt(s.reps)||0;
      if(metric==='weight'){ if(w>v) v=w; }
      else if(metric==='volume'){ v+=w*r; }
      else { const orm=r>0? w*(1+r/30) : w; if(orm>v) v=orm; }
    });
    if(v>0) out.push({date:l.date, y:v});
  });
  return out.slice(-30); // letzte 30 Trainings reichen fürs Bild
}

function fmtVal(v){
  return v>=1000 ? Math.round(v).toLocaleString('de-DE') : (Math.round(v*10)/10).toLocaleString('de-DE');
}

function fillExSelect(){
  const sel=document.getElementById('exchSel');
  let html='';
  DAYS.forEach(d=>{
    const exs=(S.exercises[d.key]||[]).filter(e=>(S.logs[e.id]||[]).some(l=>l.sets&&l.sets.length));
    if(!exs.length) return;
    html+=`<optgroup label="${d.title}">`+exs.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')+`</optgroup>`;
  });
  sel.innerHTML=html;
  if(exChart.id && sel.querySelector(`option[value="${exChart.id}"]`)) sel.value=exChart.id;
  else exChart.id=sel.value||null;
}

function selectExChart(id){ exChart.id=id; renderExChart(); }
function setExMetric(m){
  exChart.metric=m;
  ['segW','segV','seg1'].forEach(i=>document.getElementById(i).classList.remove('active'));
  document.getElementById(m==='weight'?'segW':(m==='volume'?'segV':'seg1')).classList.add('active');
  renderExChart();
}

function drawExSvg(svg, data){
  const W=300, H=120, pad=12;
  const vals=data.map(d=>d.y);
  let minV=Math.min(...vals), maxV=Math.max(...vals);
  if(minV===maxV){ minV-=1; maxV+=1; }
  const range=maxV-minV;
  const pts=data.map((d,i)=>({
    x: pad + (i/(data.length-1||1))*(W-pad*2),
    y: H-pad - ((d.y-minV)/range)*(H-pad*2),
    v: d.y
  }));
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  if(pts.length===1){
    const p=pts[0];
    svg.innerHTML=`<circle cx="${W/2}" cy="${H/2}" r="4" fill="#CCFF00"/>
      <text x="${W/2}" y="${H/2-10}" text-anchor="middle" fill="#CCFF00" font-size="9" font-family="JetBrains Mono,monospace">${fmtVal(p.v)}</text>`;
    return;
  }
  const polyline=pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area=`M${pts[0].x},${H-pad} `+pts.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+` L${pts[pts.length-1].x},${H-pad} Z`;
  // Ersten, höchsten und letzten Punkt beschriften
  let bestI=0; pts.forEach((p,i)=>{ if(p.v>pts[bestI].v) bestI=i; });
  const marks=[...new Set([0,bestI,pts.length-1])];
  svg.innerHTML=`
    <defs><linearGradient id="exg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#CCFF00" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#CCFF00" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#exg)"/>
    <polyline points="${polyline}" fill="none" stroke="#CCFF00" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${marks.map(i=>{const p=pts[i];return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#CCFF00"/>
      <text x="${p.x.toFixed(1)}" y="${(p.y-7).toFixed(1)}" text-anchor="${i===0?'start':(i===pts.length-1?'end':'middle')}" fill="#CCFF00" font-size="8" font-family="JetBrains Mono,monospace">${fmtVal(p.v)}</text>`;}).join('')}
  `;
}

function renderExChart(){
  fillExSelect();
  const svg=document.getElementById('exChartSvg');
  const empty=document.getElementById('exchEmpty');
  const d0=document.getElementById('exchD0'), d1=document.getElementById('exchD1');
  const sBest=document.getElementById('exchBest'), sLast=document.getElementById('exchLast'), sDelta=document.getElementById('exchDelta');
  const data = exChart.id ? exChartData(exChart.id, exChart.metric) : [];
  if(!data.length){
    svg.innerHTML=''; empty.style.display='block';
    d0.textContent=''; d1.textContent='';
    sBest.textContent='—'; sLast.textContent='—'; sDelta.textContent='—';
    sDelta.className='exch-sv';
    renderExRecords();
    return;
  }
  empty.style.display='none';
  const best=Math.max(...data.map(p=>p.y));
  const last=data[data.length-1].y;
  const delta=last-data[0].y;
  sBest.textContent=fmtVal(best)+' kg';
  sLast.textContent=fmtVal(last)+' kg';
  sDelta.textContent=(delta>0?'+':'')+fmtVal(delta)+' kg';
  sDelta.className='exch-sv'+(delta>0?' up':(delta<0?' down':''));
  d0.textContent=fmtDate(data[0].date);
  d1.textContent=fmtDate(data[data.length-1].date);
  drawExSvg(svg, data);
  renderExRecords();
}

function renderWeeklyTable(weights) {
  if (!weights.length) { document.getElementById('weeklyTable').style.display='none'; return; }
  document.getElementById('weeklyTable').style.display = 'block';

  // Group by week (Mon-Sun)
  const weeks = {};
  weights.forEach(w => {
    const d = new Date(w.date);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const mon = new Date(d); mon.setDate(d.getDate() + diff);
    const weekKey = mon.toISOString().split('T')[0];
    if (!weeks[weekKey]) weeks[weekKey] = [];
    weeks[weekKey].push(w.kg);
  });

  const weekKeys = Object.keys(weeks).sort().reverse().slice(0, 8);
  let rows = '';
  for (let i = 0; i < weekKeys.length; i++) {
    const key = weekKeys[i];
    const vals = weeks[key];
    const avg = +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1);
    const mon = new Date(key);
    const sun = new Date(key); sun.setDate(mon.getDate()+6);
    const rangeStr = `${mon.getDate().toString().padStart(2,'0')}.${(mon.getMonth()+1).toString().padStart(2,'0')} – ${sun.getDate().toString().padStart(2,'0')}.${(sun.getMonth()+1).toString().padStart(2,'0')}`;

    let changeHtml = '';
    if (i < weekKeys.length-1) {
      const prevVals = weeks[weekKeys[i+1]];
      const prevAvg = +(prevVals.reduce((a,b)=>a+b,0)/prevVals.length).toFixed(1);
      const diff = +(avg - prevAvg).toFixed(1);
      const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neu';
      const prefix = diff > 0 ? '+' : '';
      changeHtml = `<div class="wr-change ${cls}">${prefix}${diff} kg</div>`;
    }

    rows += `
      <div class="wh-row">
        <div><div class="wr-week">KW ${getWeekNumber(key)}</div><div class="wr-range">${rangeStr}</div></div>
        <div class="wr-right"><div class="wr-avg">${avg} kg</div>${changeHtml}</div>
      </div>`;
  }
  document.getElementById('weeklyRows').innerHTML = rows;
}

function getWeekNumber(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - (d.getDay()+6)%7);
  const week1 = new Date(d.getFullYear(),0,4);
  return 1 + Math.round(((d.getTime()-week1.getTime())/86400000 - 3 + (week1.getDay()+6)%7)/7);
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function getPR(id){
  let m=0;
  (S.logs[id]||[]).forEach(l=>l.sets.forEach(s=>{
    if(s.type==='w') return; // Aufwärmsätze zählen nicht als PR
    if(s.weight&&parseFloat(s.weight)>m) m=parseFloat(s.weight);
  }));
  return m;
}
// Einheitliche Satz-Anzeige: W = Aufwärm, D = Drop-Set, @n = RPE
function fmtSet(s){
  const t=s.type==='w'?'W ':(s.type==='d'?'D ':'');
  const r=s.rpe?(' @'+s.rpe):'';
  return t+(s.weight?s.weight+'kg':'—')+' × '+(s.reps||'—')+r;
}
const MUSCLES=['Brust','Rücken','Schultern','Bizeps','Trizeps','Beine','Bauch','Sonstige'];
function getSessionSets() {
  const sessionStart = S.sessionResetTime || '2000-01-01';
  let total = 0;
  Object.values(S.logs).forEach(logArr => {
    logArr.forEach(log => {
      // Nur Logs, die nach dem letzten Reset erstellt/geändert wurden
      if (log.updatedAt && log.updatedAt > sessionStart) {
        total += (log.sets || []).length;
      }
    });
  });
  return total;
}

function getToday(){ 
  return new Date().toISOString().split('T')[0]; }
function fmtDate(iso){
  if(!iso) return '—';
  const d=new Date(iso);
  return d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'2-digit'});
}
function uid(){ return 'x'+Date.now()+'_'+Math.random().toString(36).slice(2,5); }
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2200);
}

// ═══════════════════════════════════════════════
// DAY / TAB
// ═══════════════════════════════════════════════
function renderDayTabs(){
  const el=document.getElementById('dayTabs');
  el.innerHTML = DAYS.map((d,j)=>
    `<div class="d-tab${j===curDay?' '+d.sel:''}" id="dt${j}" onclick="selectDay(${j})">`+
    `<div class="d-tab-name">${d.title}</div><div class="d-tab-sub">${d.badge||''}</div></div>`
  ).join('') + `<button class="d-mgr" onclick="openDayMgr()" title="Einheiten verwalten" aria-label="Einheiten verwalten">⚙</button>`;
}
function selectDay(i){
  if(i>=DAYS.length) i=DAYS.length-1;
  if(i<0) i=0;
  curDay=i;
  renderDayTabs();
  const c=DAYS[i];
  document.getElementById('dayTitle').textContent=c.title;
  const b=document.getElementById('dayBadge');
  b.textContent=c.badge||''; b.className='day-badge '+c.cls;
  renderExercises();
}

function switchTab(t){
  curTab=t;
  document.getElementById('workoutPanel').style.display=t==='w'?'block':'none';
  document.getElementById('dayTabs').style.display=t==='w'?'flex':'none';
  document.getElementById('progPanel').classList.toggle('show',t==='p');
  document.getElementById('histPanel').classList.toggle('show',t==='h');
  document.getElementById('weightPanel').classList.toggle('show',t==='g');
  document.getElementById('navW').classList.toggle('on',t==='w');
  document.getElementById('navP').classList.toggle('on',t==='p');
  document.getElementById('navH').classList.toggle('on',t==='h');
  document.getElementById('navG').classList.toggle('on',t==='g');
  if(t==='p') renderProgress();
  if(t==='h') renderHistory();
  if(t==='g') renderWeight();
}

// ═══════════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════════
function openLog(id){
  logId = id;

  const k = DAYS[curDay].key;
  const ex = (S.exercises[k]||[]).find(e=>e.id===id);
  if(!ex) return;

  document.getElementById('logTtl').textContent =
    ex.name.length>20 ? ex.name.slice(0,18)+'…' : ex.name.toUpperCase();

  const rows = document.getElementById('setRows');
  rows.innerHTML = '';

  // Letztes Gewicht & Wiederholungen vorausfüllen (heute → sonst letztes Training)
  const today = getToday();
  const existingLogs = S.logs[id] || [];
  const todayLog = existingLogs.find(l => l.date === today);
  const lastLog = existingLogs.slice(-1)[0];

  let prefillWeight = '';
  let prefillReps = '';
  if (todayLog && todayLog.sets && todayLog.sets.length) {
    const lastSet = todayLog.sets[todayLog.sets.length - 1];
    prefillWeight = lastSet.weight || '';
    prefillReps   = lastSet.reps   || '';
  } else if (lastLog && lastLog.sets && lastLog.sets.length) {
    const lastSet = lastLog.sets[lastLog.sets.length - 1];
    prefillWeight = lastSet.weight || '';
    prefillReps   = lastSet.reps   || '';
  }

  // Heute bereits geloggte Sets als Referenz anzeigen
  const todayStrip  = document.getElementById('logTodayStrip');
  const todayChips  = document.getElementById('logTodayChips');
  if (todayLog && todayLog.sets && todayLog.sets.length) {
    todayChips.innerHTML = todayLog.sets.map((s,i) =>
      `<span class="set-chip">S${i+1} ${fmtSet(s)}</span>`
    ).join('');
    todayStrip.style.display = 'block';
  } else {
    todayStrip.style.display = 'none';
  }

  addSetRow(prefillWeight, prefillReps);

  document.getElementById('logOv').classList.add('open');
}

function closeLog(){ 
  document.getElementById('logOv').classList.remove('open'); 
  logId=null;
}

function addSetRow(w='',r=''){
  const rows=document.getElementById('setRows');
  const n=rows.children.length+1;
  const div=document.createElement('div');
  div.className='set-row';
  div.innerHTML=`
    <div class="s-num">S${n}</div>
    <input class="s-inp" type="number" inputmode="decimal" step="0.5" min="0" placeholder="0" value="${w}">
    <input class="s-inp" type="number" inputmode="numeric" min="0" placeholder="0" value="${r}">
    <button class="s-rm" onclick="this.parentElement.remove();renum()">×</button>`;
  rows.appendChild(div);
}
function renum(){
  document.querySelectorAll('#setRows .set-row').forEach((r,i)=>{
    const n=r.querySelector('.s-num'); if(n) n.textContent='S'+(i+1);
  });
}
function saveLog(){
  if(!logId) return;

  const rows = [...document.querySelectorAll('#setRows .set-row')];

  const sets = rows.map(r => {
    const ins = r.querySelectorAll('input');
    return {
      weight: ins[0].value.trim(),
      reps: ins[1].value.trim()
    };
  }).filter(s => s.weight !== '' || s.reps !== '');

  if(!sets.length){
    toast('Mindestens 1 Satz!');
    return;
  }

  const today = getToday();
  const oldPR = getPR(logId);
  const now = new Date();
  const timeString = now.toTimeString().split(' ')[0];


  if(!S.logs[logId]) S.logs[logId] = [];

  // 🔥 suche ob heute schon ein Log existiertf
  let todayLog = S.logs[logId].find(l => l.date && l.date.startsWith(today));
if(todayLog){
    // 👉 FALL 1: es gibt schon ein Log → neue Sets ANHÄNGEN
    todayLog.sets.push(...sets);
    todayLog.updatedAt = today + 'T' + timeString;
  } else {
    // 👉 FALL 2: noch kein Log → neu erstellen
    // Wir bauen den Zeitstempel manuell mit getToday(), damit es 100% matcht
 // z.B. "14:30:00"

    S.logs[logId].push({
      date: today,
      updatedAt: today + 'T' + timeString, // Kombiniert lokales Datum + lokale Uhrzeit
      sets: sets
    });
  }
  const newPR = getPR(logId);

  S.stats.sets += sets.length;

  updateStreak();
  save();
  if (curTab === 'p') renderProgress(); else if (curTab === 'h') renderHistory();
  closeLog();
  renderExercises();
  renderStats();
  startRest(getRestSec(logId));

  toast(newPR > oldPR ? 'PR gebrochen! ' + newPR + ' kg 🔥' : 'Gespeichert!');
}
function updateStreak(){
  const today=getToday();
  if(!S.streak.dates) S.streak.dates=[];
  if(S.streak.dates.includes(today)) return;
  S.streak.dates.push(today);
  const y=new Date(); y.setDate(y.getDate()-1);
  const ys=y.toISOString().split('T')[0];
  if(S.streak.lastDate===ys){ S.streak.cur++; } else { S.streak.cur=1; S.stats.trainings++; }
  S.streak.best=Math.max(S.streak.best,S.streak.cur);
  S.streak.lastDate=today;
}

// ═══════════════════════════════════════════════
// LIVE SESSION
// ═══════════════════════════════════════════════
// Muskelgruppen automatisch erkennen (für spätere Auswertungen)
const MUSCLE_MAP = [
  [/klimm|latzug|rudern|row|face pull|reverse fly|\brücken/i,'Rücken'],
  [/trizeps|kickback|pushdown|french|dips/i,'Trizeps'],
  [/bizeps|curl|hammer/i,'Bizeps'],
  [/seithe|arnold|schulter|overhead/i,'Schultern'],
  [/bank|butterfly|fliegende|fly|brust/i,'Brust'],
  [/kniebeuge|squat|beinpresse|ausfall|wade|bein/i,'Beine'],
  [/crunch|plank|russian|bauch|core|beinheben/i,'Bauch'],
];
function guessMuscle(name){
  for(const [re,m] of MUSCLE_MAP){ if(re.test(name)) return m; }
  return 'Sonstige';
}
function migrateData(){
  // Einheiten: aus den Daten laden oder Standard übernehmen
  if(!Array.isArray(S.days)||!S.days.length){
    S.days = DEFAULT_DAYS.map(d=>({...d}));
  }
  DAYS = S.days;
  DAYS.forEach((d,i)=>{
    d.cls='c'+((i%4)+1); d.sel='sel-'+d.cls;           // Farben rotieren
    if(!S.exercises[d.key]) S.exercises[d.key]=[];      // Übungsliste sicherstellen
  });
  const fixOld = S.muscleV!==2; // einmalig: früher falsch geratene Muskeln korrigieren
  DAYS.forEach(d=>{
    (S.exercises[d.key]||[]).forEach(ex=>{
      if(fixOld||!ex.muscle) ex.muscle = guessMuscle(ex.name||'');
      if(!ex.restSec) ex.restSec = 120;
    });
  });
  S.muscleV=2;
}

let SES = null; // { day, start, ex:{id:{sets:[{weight,reps,done,saved}]}}, prs:{}, oldPR:{}, vol, done }

// ═══════════════════════════════════════════════
// EINHEITEN VERWALTEN (erstellen / umbenennen / löschen)
// ═══════════════════════════════════════════════
let dayEditKey = null;

function openDayMgr(){
  if(SES){ toast('Beende erst dein Training'); return; }
  renderDayMgr();
  document.getElementById('dayMgrOv').classList.add('open');
}
function closeDayMgr(){ document.getElementById('dayMgrOv').classList.remove('open'); }

function renderDayMgr(){
  document.getElementById('dmList').innerHTML = DAYS.map(d=>{
    const n=(S.exercises[d.key]||[]).length;
    return `<div class="dm-row">
      <div class="dm-dot" style="background:var(--${d.cls})"></div>
      <div class="dm-body"><div class="dm-name">${d.title}</div><div class="dm-sub">${d.badge?d.badge+' · ':''}${n} Übung${n===1?'':'en'}</div></div>
      <button class="edit-btn" onclick="openDayEdit('${d.key}')">✎ Bearbeiten</button>
    </div>`;
  }).join('');
}

function openDayEdit(key){
  dayEditKey = key;
  const d = key ? DAYS.find(x=>x.key===key) : null;
  document.getElementById('deTtl').textContent = d ? 'EINHEIT BEARBEITEN' : 'NEUE EINHEIT';
  document.getElementById('deName').value = d ? d.title : '';
  document.getElementById('deBadge').value = d ? (d.badge||'') : '';
  document.getElementById('deDel').style.display = (d && DAYS.length>1) ? 'block' : 'none';
  document.getElementById('dayEditOv').classList.add('open');
}
function closeDayEdit(){ document.getElementById('dayEditOv').classList.remove('open'); dayEditKey=null; }

function saveDayEdit(){
  const n=document.getElementById('deName').value.trim();
  if(!n){ toast('Bitte Namen eingeben'); return; }
  const b=document.getElementById('deBadge').value.trim();
  if(dayEditKey){
    const d=DAYS.find(x=>x.key===dayEditKey);
    if(d){ d.title=n.toUpperCase(); d.badge=b; }
  } else {
    if(DAYS.length>=8){ toast('Maximal 8 Einheiten'); return; }
    const key=uid();
    S.days.push({ key, title:n.toUpperCase(), badge:b });
    S.exercises[key]=[];
  }
  migrateData();
  save();
  closeDayEdit(); renderDayMgr();
  selectDay(Math.min(curDay, DAYS.length-1));
  toast('Gespeichert ✓');
}

function askDelDay(){
  if(DAYS.length<=1){ toast('Mindestens eine Einheit nötig'); return; }
  document.getElementById('confTtl').textContent='Einheit löschen?';
  document.getElementById('confMsg').textContent='Alle Übungen dieser Einheit werden entfernt. Bereits geloggte Trainings bleiben in deiner Historie erhalten.';
  document.getElementById('confYes').onclick=doDelDay;
  document.getElementById('confOv').classList.add('open');
}
function doDelDay(){
  const i=DAYS.findIndex(x=>x.key===dayEditKey);
  if(i>=0){
    delete S.exercises[DAYS[i].key];
    S.days.splice(i,1);
  }
  migrateData();
  save();
  closeConf(); closeDayEdit();
  selectDay(Math.min(curDay, DAYS.length-1));
  renderDayMgr();
  toast('Einheit gelöscht');
}
function saveSes(){ try{ localStorage.setItem('recep_active_session', JSON.stringify(SES)); }catch(e){} }
function clearSes(){ SES=null; try{ localStorage.removeItem('recep_active_session'); }catch(e){} }
function findEx(id){
  for(const d of DAYS){ const e=(S.exercises[d.key]||[]).find(x=>x.id===id); if(e) return e; }
  return null;
}
function getRestSec(id){ const e=findEx(id); return (e&&e.restSec)?e.restSec:120; }

// Letzter Log VOR heute (für "Letztes Mal" & Auto-Ausfüllen)
function lastPrevLog(id){
  const today=getToday();
  const logs=(S.logs[id]||[]).filter(l=>l.date&&!l.date.startsWith(today));
  return logs.slice(-1)[0]||null;
}

function startSession(){
  if(SES){ toast('Session läuft bereits'); return; }
  const day=curDay, k=DAYS[day].key;
  const exs=S.exercises[k]||[];
  if(!exs.length){ toast('Keine Übungen an diesem Tag'); return; }
  const ex={};
  exs.forEach(e=>{
    const prev=lastPrevLog(e.id);
    const sets=Array.from({length:e.sets||4},(_,i)=>{
      const ps=prev&&prev.sets&&prev.sets.length?(prev.sets[i]||prev.sets[prev.sets.length-1]):null;
      return { weight: ps?String(ps.weight||''):'', reps: ps?String(ps.reps||''):'', type: ps?(ps.type||''):'', rpe:'', done:false, saved:null };
    });
    ex[e.id]={sets};
  });
  SES={ day, start: Date.now(), ex, prs:{}, oldPR:{}, vol:0, done:0 };
  exs.forEach(e=>SES.oldPR[e.id]=getPR(e.id));
  saveSes();
  // Workout-Timer oben mitstarten
  timerStop();
  startTime = SES.start; elapsed = 0;
  tmrOn = true; interval = setInterval(updateTimer, 500);
  document.getElementById('btnStart').classList.add('on');
  renderExercises();
  toast('Training gestartet 💪');
}

function sesInput(id,i,el,field){
  if(!SES||!SES.ex[id]) return;
  SES.ex[id].sets[i][field]=el.value;
  saveSes();
}

function toggleSet(id,i){
  if(!SES||!SES.ex[id]) return;
  const st=SES.ex[id].sets[i];
  const today=getToday(), now=new Date(), ts=today+'T'+now.toTimeString().split(' ')[0];
  if(!S.logs[id]) S.logs[id]=[];
  let tl=S.logs[id].find(l=>l.date&&l.date.startsWith(today));
  if(!st.done){
    if(String(st.weight).trim()===''&&String(st.reps).trim()===''){ toast('Gewicht oder Wdh. eingeben'); return; }
    st.done=true;
    const entry={weight:String(st.weight).trim(),reps:String(st.reps).trim()};
    if(st.type) entry.type=st.type;
    const rpeV=parseFloat(st.rpe);
    if(rpeV>=1&&rpeV<=10) entry.rpe=rpeV;
    st.saved=entry;
    if(tl){ tl.sets.push(entry); tl.updatedAt=ts; }
    else { S.logs[id].push({date:today,updatedAt:ts,sets:[entry]}); }
    SES.done++;
    const w=parseFloat(entry.weight)||0, r=parseInt(entry.reps)||0;
    if(st.type!=='w'){
      SES.vol+=w*r;
      if(w>(SES.oldPR[id]||0) && w>0){ SES.prs[id]=Math.max(SES.prs[id]||0,w); }
    }
    updateStreak();
    S.stats.sets+=1;
    if(navigator.vibrate) navigator.vibrate(30);
    startRest(getRestSec(id));
    save();
  } else {
    // Zurücknehmen: nur möglich, solange es der zuletzt gespeicherte Satz ist
    if(tl&&tl.sets.length&&st.saved&&tl.sets[tl.sets.length-1].weight===st.saved.weight&&tl.sets[tl.sets.length-1].reps===st.saved.reps){
      tl.sets.pop();
      SES.done=Math.max(0,SES.done-1);
      const w=parseFloat(st.saved.weight)||0, r=parseInt(st.saved.reps)||0;
      if(st.saved.type!=='w') SES.vol=Math.max(0,SES.vol-w*r);
      S.stats.sets=Math.max(0,S.stats.sets-1);
      st.done=false; st.saved=null;
      save();
    } else { toast('Nur der letzte Satz kann zurückgenommen werden'); return; }
  }
  saveSes();
  renderExercises();
}

function addSesSet(id){
  if(!SES||!SES.ex[id]) return;
  const sets=SES.ex[id].sets;
  const last=sets[sets.length-1];
  sets.push({weight:last?last.weight:'',reps:last?last.reps:'',type:'',rpe:'',done:false,saved:null});
  saveSes(); renderExercises();
}

function fmtDurShort(sec){
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return h>0? h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0') : m+':'+String(s).padStart(2,'0');
}

// Zahlen weich hochzählen
function animateNum(el,target){
  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce||target<=0){ el.textContent=Math.round(target).toLocaleString('de-DE'); return; }
  const dur=800,t0=performance.now();
  (function step(t){
    const p=Math.min(1,(t-t0)/dur), e=1-Math.pow(1-p,3);
    el.textContent=Math.round(target*e).toLocaleString('de-DE');
    if(p<1) requestAnimationFrame(step);
  })(t0);
}

function endSession(){
  if(!SES) return;
  const secs=Math.floor((Date.now()-SES.start)/1000);
  const today=getToday();
  if(secs>60){
    if(!S.workoutDurations) S.workoutDurations={};
    if(!S.workoutDurations[today]||secs>S.workoutDurations[today]) S.workoutDurations[today]=secs;
  }
  S.sessionResetTime=new Date().toISOString();
  save();
  // Timer oben zurücksetzen
  timerStop(); startTime=null; elapsed=0;
  document.getElementById('timerDisp').textContent='00:00:00';
  document.getElementById('btnStart').classList.remove('on');
  // Zusammenfassung füllen
  const prIds=Object.keys(SES.prs);
  document.getElementById('sumDay').textContent=DAYS[SES.day].title+' · '+DAYS[SES.day].badge;
  document.getElementById('sumDur').textContent=fmtDurShort(secs);
  animateNum(document.getElementById('sumVol'),SES.vol);
  animateNum(document.getElementById('sumSets'),SES.done);
  document.getElementById('sumPR').textContent=prIds.length?(prIds.length+' 🔥'):'—';
  const prList=document.getElementById('sumPrList');
  if(prIds.length){
    prList.innerHTML=prIds.map(id=>{const e=findEx(id);return '🏆 '+(e?e.name:'Übung')+' — neuer PR: '+SES.prs[id]+' kg';}).join('<br>');
    prList.style.display='block';
  } else prList.style.display='none';
  document.getElementById('sumOv').classList.add('open');
  if(prIds.length) launchConfetti();
  if(navigator.vibrate) navigator.vibrate([80,40,80]);
  clearSes();
  if(curTab==='p') renderProgress(); else if(curTab==='h') renderHistory();
  renderExercises(); renderStats();
}
function closeSum(){ document.getElementById('sumOv').classList.remove('open'); }

// Leichtgewichtiges Canvas-Konfetti (nur bei PR)
function launchConfetti(){
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv=document.getElementById('confettiCv');
  const ctx=cv.getContext&&cv.getContext('2d');
  if(!ctx) return;
  cv.width=innerWidth; cv.height=innerHeight; cv.style.display='block';
  const cols=['#CCFF00','#3D85FF','#00CCCC','#FF26A0','#FF66BB','#ffffff'];
  const P=Array.from({length:130},()=>({
    x:Math.random()*cv.width, y:-20-Math.random()*cv.height*.3,
    w:5+Math.random()*6, h:8+Math.random()*8,
    vy:2.2+Math.random()*3.2, vx:-1.5+Math.random()*3,
    rot:Math.random()*Math.PI, vr:-.12+Math.random()*.24,
    c:cols[Math.floor(Math.random()*cols.length)]
  }));
  const t0=performance.now();
  (function frame(t){
    ctx.clearRect(0,0,cv.width,cv.height);
    P.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr; p.vy+=.03;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=p.c; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    });
    if(t-t0<2400) requestAnimationFrame(frame);
    else { ctx.clearRect(0,0,cv.width,cv.height); cv.style.display='none'; }
  })(t0);
}

// Sichtbarkeit Start-Button / Live-Banner
function updateSessionUI(){
  const startBtn=document.getElementById('sesStartBtn');
  const banner=document.getElementById('sesBanner');
  const sf=document.getElementById('exSearch');
  if(SES){
    startBtn.style.display='none';
    if(sf) sf.style.display='none';
    banner.classList.add('show');
    document.getElementById('sesBannerTxt').textContent='Live · '+((DAYS[SES.day]||{}).title||'');
  } else {
    startBtn.style.display='block';
    if(sf) sf.style.display='block';
    banner.classList.remove('show');
  }
}

// Übungsliste im Session-Modus rendern
function renderSession(list){
  const col=DAYS[SES.day].cls, k=DAYS[SES.day].key;
  const exs=S.exercises[k]||[];
  list.innerHTML=exs.map((ex,i)=>{
    const sd=SES.ex[ex.id]; if(!sd) return '';
    const prev=lastPrevLog(ex.id);
    const rows=sd.sets.map((st,j)=>{
      const ps=prev&&prev.sets&&prev.sets.length?(prev.sets[j]||null):null;
      const lastTxt=ps?((ps.weight||'—')+'×'+(ps.reps||'—')):'—';
      const isPR=st.done&&st.saved&&(parseFloat(st.saved.weight)||0)>(SES.oldPR[ex.id]||0);
      const tCls=st.type==='w'?' tw':(st.type==='d'?' td':'');
      const tLbl=st.type==='w'?'W'+(j+1):(st.type==='d'?'D'+(j+1):'S'+(j+1));
      return `<div class="ses-set${st.done?' done':''}">
        <button class="ses-no${tCls}" onclick="cycleSetType('${ex.id}',${j})" title="Satz-Typ: Normal / Aufwärm / Drop">${tLbl}</button>
        <div class="ses-last">${lastTxt}${isPR?'<span class="ses-prtag">PR</span>':''}</div>
        <input class="ses-inp" type="number" step="0.5" inputmode="decimal" placeholder="kg" value="${st.weight}" ${st.done?'disabled':''} oninput="sesInput('${ex.id}',${j},this,'weight')">
        <input class="ses-inp" type="number" inputmode="numeric" placeholder="Wdh" value="${st.reps}" ${st.done?'disabled':''} oninput="sesInput('${ex.id}',${j},this,'reps')">
        <input class="ses-rpe" type="number" inputmode="decimal" min="1" max="10" placeholder="RPE" value="${st.rpe||''}" ${st.done?'disabled':''} oninput="sesInput('${ex.id}',${j},this,'rpe')">
        <button class="ses-chk${st.done?' done':''}" onclick="toggleSet('${ex.id}',${j})">✓</button>
      </div>`;
    }).join('');
    return `<div class="ses-card ${col}">
      <div class="ses-card-hdr">
        <div class="ses-card-name">${String(i+1).padStart(2,'0')} · ${ex.name}</div>
        <div style="display:flex;align-items:center;gap:8px;"><div class="ses-card-meta">Pause ${ex.restSec||120}s</div><button class="plate-btn" onclick="openPlateFor('${ex.id}')" title="Plate-Rechner">⚖</button></div>
      </div>
      ${rows}
      <button class="ses-addset" onclick="addSesSet('${ex.id}')">+ Satz</button>
    </div>`;
  }).join('');
}

// Laufende Session nach Reload wiederherstellen (nur am selben Tag)
(function restoreSes(){
  try {
    const s=JSON.parse(localStorage.getItem('recep_active_session')||'null');
    if(s&&s.start){
      if(new Date(s.start).toDateString()===new Date().toDateString()){
        SES=s;
        startTime=SES.start; tmrOn=true; interval=setInterval(updateTimer,500);
        document.getElementById('btnStart').classList.add('on');
      } else {
        localStorage.removeItem('recep_active_session'); // Sätze sind ohnehin schon gespeichert
      }
    }
  } catch(e){}
})();

// ═══════════════════════════════════════════════
// SATZ-TYP · PLATE-RECHNER · REKORDE · MUSKEL-VOLUMEN · SUCHE
// ═══════════════════════════════════════════════

// Satz-Typ durchschalten: Normal → Aufwärm (W) → Drop-Set (D) → Normal
function cycleSetType(id,i){
  if(!SES||!SES.ex[id]) return;
  const st=SES.ex[id].sets[i];
  if(st.done){ toast('Satz erst zurücknehmen'); return; }
  st.type = st.type==='' ? 'w' : (st.type==='w' ? 'd' : '');
  saveSes(); renderExercises();
}

// Plate-Rechner (Stange 20 kg · Scheiben pro Seite)
const PLATES=[20,15,10,5,2.5,1.25];
function openPlateFor(id){
  const sd=SES&&SES.ex[id];
  let kg='';
  if(sd){
    const open=sd.sets.find(s=>!s.done&&s.weight);
    kg=open?open.weight:(sd.sets.length?sd.sets[sd.sets.length-1].weight:'');
  }
  document.getElementById('plateKg').value=kg||'';
  calcPlates();
  document.getElementById('plateOv').classList.add('open');
}
function closePlate(){ document.getElementById('plateOv').classList.remove('open'); }
function calcPlates(){
  const out=document.getElementById('plateOut');
  const v=parseFloat(document.getElementById('plateKg').value);
  if(!v||v<=0){ out.innerHTML='<div class="plate-none">Gewicht eingeben …</div>'; return; }
  if(v<20){ out.innerHTML='<div class="plate-none">Unter Stangengewicht (20 kg) — nutze Kurzhanteln.</div>'; return; }
  let side=(v-20)/2, html='', used=false;
  PLATES.forEach(p=>{
    const n=Math.floor(side/p+1e-9);
    if(n>0){ html+=`<div class="plate-chip${p<5?' small':''}">${n}× ${p}</div>`; side=Math.round((side-n*p)*100)/100; used=true; }
  });
  let res=used?`<div class="plate-chips">${html}</div>`:'<div class="plate-none">Nur die leere Stange (20 kg).</div>';
  if(side>0.01) res+=`<div class="plate-rest">⚠ ${side.toFixed(2).replace('.',',')} kg pro Seite nicht stapelbar — nächstmöglich: ${(v-side*2).toFixed(1).replace('.',',')} kg</div>`;
  out.innerHTML=res;
}

// Rekorde der gewählten Übung (ohne Aufwärmsätze)
function renderExRecords(){
  const grid=document.getElementById('recGrid');
  if(!grid) return;
  const logs=exChart.id?(S.logs[exChart.id]||[]):[];
  let mw={v:0,d:null}, mo={v:0,d:null}, mv={v:0,d:null}, mr={v:0,w:0,d:null};
  logs.forEach(l=>{
    let dayVol=0;
    (l.sets||[]).forEach(s=>{
      if(s.type==='w') return;
      const w=parseFloat(s.weight)||0, r=parseInt(s.reps)||0;
      dayVol+=w*r;
      if(w>mw.v){ mw={v:w,d:l.date}; }
      const orm=r>0?w*(1+r/30):w;
      if(orm>mo.v){ mo={v:orm,d:l.date}; }
      if(r>mr.v||(r===mr.v&&w>mr.w)){ mr={v:r,w,d:l.date}; }
    });
    if(dayVol>mv.v){ mv={v:dayVol,d:l.date}; }
  });
  const cell=(val,lbl,date)=>`<div class="rec-cell"><div class="rec-val">${val}</div><div class="rec-lbl">${lbl}</div><div class="rec-date">${date?fmtDate(date):'—'}</div></div>`;
  grid.innerHTML = mw.v
    ? cell(fmtVal(mw.v)+' kg','Schwerster Satz',mw.d)
      + cell(fmtVal(mo.v)+' kg','Bestes 1RM (gesch.)',mo.d)
      + cell(fmtVal(mv.v)+' kg','Bestes Tagesvolumen',mv.d)
      + cell(mr.v+' × '+fmtVal(mr.w)+' kg','Meiste Wdh.',mr.d)
    : '<div class="mus-empty" style="grid-column:1/-1;">Noch keine Daten für diese Übung.</div>';
}

// Wöchentliche Sätze pro Muskelgruppe (Mo–So, ohne Aufwärmsätze)
function renderMuscleVolume(){
  const card=document.getElementById('musCard');
  if(!card) return;
  const todayStr=getToday();
  const t=new Date(todayStr+'T12:00:00');
  const monday=new Date(t); monday.setDate(t.getDate()-((t.getDay()+6)%7));
  const monStr=monday.toISOString().split('T')[0];
  const counts={};
  Object.entries(S.logs||{}).forEach(([id,arr])=>{
    const ex=findEx(id);
    const m=ex?(ex.muscle||'Sonstige'):'Sonstige';
    arr.forEach(l=>{
      if(!l.date||l.date<monStr||l.date>todayStr) return;
      (l.sets||[]).forEach(s=>{ if(s.type!=='w') counts[m]=(counts[m]||0)+1; });
    });
  });
  const entries=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  if(!entries.length){ card.innerHTML='<div class="mus-empty">Diese Woche noch keine Sätze geloggt.</div>'; return; }
  const max=Math.max(10,...entries.map(e=>e[1]));
  card.innerHTML=entries.map(([m,n])=>
    `<div class="mus-row"><div class="mus-name">${m}</div><div class="mus-track"><div class="mus-fill" style="width:${Math.round(n/max*100)}%"></div></div><div class="mus-n">${n}</div></div>`
  ).join('');
}

// Globale Übungs-Suche (Name oder Muskelgruppe)
function renderSearch(list,q){
  const hits=[];
  DAYS.forEach((d,di)=>{
    (S.exercises[d.key]||[]).forEach(ex=>{
      if((ex.name||'').toLowerCase().includes(q)||(ex.muscle||'').toLowerCase().includes(q)){
        hits.push({ex,d,di});
      }
    });
  });
  if(!hits.length){ list.innerHTML='<div class="empty">Keine Treffer</div>'; return; }
  list.innerHTML=hits.map(h=>
    `<div class="search-hit" onclick="goToSearchHit(${h.di})">
      <div><div class="sh-name">${h.ex.name}</div><div class="sh-sub">${h.ex.muscle||'Sonstige'}${h.ex.desc?' · '+h.ex.desc:''}</div></div>
      <div class="sh-day" style="color:var(--${h.d.cls})">${h.d.title}</div>
    </div>`).join('');
}
function goToSearchHit(di){
  document.getElementById('exSearch').value='';
  selectDay(di);
}

// ═══════════════════════════════════════════════
// EDIT / ADD / CONFIRM
// ═══════════════════════════════════════════════
function openEdit(id){
  editId=id;
  const k=DAYS[curDay].key;
  const ex=(S.exercises[k]||[]).find(e=>e.id===id);
  if(!ex) return;
  document.getElementById('editName').value=ex.name;
  document.getElementById('editDesc').value=ex.desc||'';
  document.getElementById('editSets').value=ex.sets;
  document.getElementById('editReps').value=ex.reps;
  document.getElementById('editRest').value=ex.restSec||120;
  document.getElementById('editMuscle').innerHTML=MUSCLES.map(m=>`<option${(ex.muscle||'Sonstige')===m?' selected':''}>${m}</option>`).join('');
  document.getElementById('editOv').classList.add('open');
}
function closeEdit(){ document.getElementById('editOv').classList.remove('open'); editId=null; }
function saveEdit(){
  if(!editId) return;
  const k=DAYS[curDay].key;
  const exs=S.exercises[k]||[];
  const i=exs.findIndex(e=>e.id===editId);
  if(i===-1) return;
  const n=document.getElementById('editName').value.trim();
  if(!n){ toast('Name eingeben'); return; }
  exs[i]={...exs[i],name:n,desc:document.getElementById('editDesc').value.trim(),sets:parseInt(document.getElementById('editSets').value)||4,reps:document.getElementById('editReps').value.trim()||'10-12',restSec:Math.min(600,Math.max(15,parseInt(document.getElementById('editRest').value)||120)),muscle:document.getElementById('editMuscle').value||guessMuscle(n)};
  save(); closeEdit(); renderExercises(); toast('Gespeichert');
}
function askDel(){
  delId=editId;
  document.getElementById('confTtl').textContent='Sicher?';
  document.getElementById('confMsg').textContent='Diese Übung und alle gespeicherten Logs werden gelöscht.';
  document.getElementById('confYes').onclick=doDel;
  document.getElementById('confOv').classList.add('open');
}
function doDel(){
  if(!delId) return;
  const k=DAYS[curDay].key;
  S.exercises[k]=(S.exercises[k]||[]).filter(e=>e.id!==delId);
  delete S.logs[delId];
  save(); closeConf(); closeEdit(); renderExercises(); toast('Gelöscht');
}
function openAdd(){
  document.getElementById('addName').value='';
  document.getElementById('addDesc').value='';
  document.getElementById('addSets').value='4';
  document.getElementById('addReps').value='10-12';
  document.getElementById('addMuscle').innerHTML='<option value="auto">Automatisch erkennen</option>'+MUSCLES.map(m=>`<option>${m}</option>`).join('');
  document.getElementById('addOv').classList.add('open');
  setTimeout(()=>document.getElementById('addName').focus(),100);
}
function closeAdd(){ document.getElementById('addOv').classList.remove('open'); }
function saveAdd(){
  const n=document.getElementById('addName').value.trim();
  if(!n){ toast('Name eingeben'); return; }
  const k=DAYS[curDay].key;
  if(!S.exercises[k]) S.exercises[k]=[];
  S.exercises[k].push({id:uid(),name:n,desc:document.getElementById('addDesc').value.trim(),sets:parseInt(document.getElementById('addSets').value)||4,reps:document.getElementById('addReps').value.trim()||'10-12',restSec:Math.min(600,Math.max(15,parseInt(document.getElementById('addRest').value)||120)),muscle:(document.getElementById('addMuscle').value==='auto'?guessMuscle(n):document.getElementById('addMuscle').value)});
  save(); closeAdd(); renderExercises(); toast('Hinzugefügt');
}
function closeConf(){ document.getElementById('confOv').classList.remove('open'); delId=null; }

// ═══════════════════════════════════════════════
// OVERLAY CLOSE ON BACKDROP
// ═══════════════════════════════════════════════
['logOv','editOv','addOv'].forEach(id=>{
  document.getElementById(id).addEventListener('click',function(e){
    if(e.target===this){ if(id==='logOv')closeLog(); else if(id==='editOv')closeEdit(); else closeAdd(); }
  });
});
document.getElementById('confOv').addEventListener('click',function(e){ if(e.target===this)closeConf(); });
document.getElementById('dayMgrOv').addEventListener('click',function(e){ if(e.target===this)closeDayMgr(); });
document.getElementById('dayEditOv').addEventListener('click',function(e){ if(e.target===this)closeDayEdit(); });
document.getElementById('plateOv').addEventListener('click',function(e){ if(e.target===this)closePlate(); });

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
// Load local backup first for instant display
const backup = localStorage.getItem('recep_backup');
if (backup) {
  try {
    const b = JSON.parse(backup);
    S = { ...S, ...b };
    if (!S.weights) S.weights = [];
    migrateData();
    renderStats();
    selectDay(0);
  } catch(e) {}
}
// Then load from Supabase

// ── Login-Gate ───────────────────────────────────
function showApp(){
  document.getElementById('loginOv').style.display = 'none';
  document.getElementById('logoutBtn').style.display = 'block';
}
function showLogin(){
  document.getElementById('loginOv').style.display = 'flex';
  document.getElementById('logoutBtn').style.display = 'none';
  const eEl = document.getElementById('loginEmail'); if(eEl) eEl.focus();
}

async function doLogin(){
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginErr');
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  err.textContent = '';
  if(!email || !pass){ err.textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  btn.disabled = true; btn.textContent = 'Anmelden…';
  try {
    await sbLogin(email, pass);
    showApp();
    loadFromSupabase();
  } catch(e){
    err.textContent = 'Login fehlgeschlagen. E-Mail/Passwort prüfen.';
  } finally {
    btn.disabled = false; btn.textContent = 'Einloggen';
  }
}

document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPass').addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });

// Beim Start: bestehende Sitzung wiederherstellen
// Beim Start: gespeicherte Sitzung sofort nutzen (auch offline), Login nur im Hintergrund erneuern
(async function boot(){
  const stored = loadSession();
  if(stored && stored.user_id){
    SESSION = stored;        // sofort eingeloggt starten, auch ohne Netz
    showApp();
    loadFromSupabase();      // synct wenn online; offline bleiben die lokalen Daten
    sbRefresh();             // Token im Hintergrund auffrischen, wenn Netz da ist
  } else {
    showLogin();
  }
})();

// ═══════════════════════════════════════════════
// PWA
// ═══════════════════════════════════════════════
(function setupPWA(){
  const canvas=document.createElement('canvas');
  canvas.width=512;canvas.height=512;
  const ctx=canvas.getContext&&canvas.getContext('2d');
  if(!ctx) return;
  ctx.fillStyle='#111111';ctx.beginPath();ctx.roundRect(0,0,512,512,80);ctx.fill();
  ctx.strokeStyle='#CCFF00';ctx.lineWidth=16;ctx.beginPath();ctx.roundRect(8,8,496,496,76);ctx.stroke();
  ctx.fillStyle='#CCFF00';ctx.font='bold 320px Impact,Anton,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('R',256,270);
  const icon=canvas.toDataURL('image/png');
  const lnk=document.createElement('link');lnk.rel='apple-touch-icon';lnk.href=icon;document.head.appendChild(lnk);
  const manifest={name:'RECEP — Trainingsplan',short_name:'RECEP',description:'4er Split · Body Recomp',start_url:'./',display:'standalone',orientation:'portrait',background_color:'#111111',theme_color:'#111111',icons:[{src:icon,sizes:'512x512',type:'image/png',purpose:'any maskable'}]};
  const ml=document.createElement('link');ml.rel='manifest';ml.href='data:application/manifest+json,'+encodeURIComponent(JSON.stringify(manifest));document.head.appendChild(ml);
})();
