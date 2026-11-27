// ---------- Schrittmodus & Animationen ----------
const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPEEDS = [['turbo', 'Turbo'], ['schnell', 'Schnell'], ['mittel', 'Mittel'], ['langsam', 'Langsam'], ['einzeln', 'Einzeln']];
const DELAY = { schnell: 75, mittel: 300, langsam: 800 };
const MOVE = { turbo: 50, schnell: 70, mittel: 170, langsam: 280, einzeln: 220 };
let animMode = LS.get('orasim.anim') || 'turbo';
let stepSpeed = LS.get('orasim.stepSpeed') || 'mittel';
let PL = null;
const hitIn = $('#hitIn'), fxIn = $('#fxIn'), watch = $('#watch'), hud = $('#hud'), fxLayer = $('#fx'), edEl = $('#ed');
let hitEls = new Map();
const lhPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 21;
let charW = 0;
function measureChar() { const s = document.createElement('span'); s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:var(--fs)/var(--lh) var(--mono)'; s.textContent = 'x'.repeat(40); $('.codewrap').appendChild(s); charW = s.getBoundingClientRect().width / 40 || 8.4; s.remove(); }
function clearHeat() { hitIn.innerHTML = ''; hitEls = new Map(); edEl.classList.remove('heat'); if (!PL) fxIn.innerHTML = ''; }
const SVG = {
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>',
  step: '<svg class="i" viewBox="0 0 24 24"><path d="M5 5l8 7-8 7zM16 5v14"/></svg>',
  end: '<svg class="i" viewBox="0 0 24 24"><path d="M4 5l7 7-7 7zM12 5l7 7-7 7zM20 5v14"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 3 3 5 1-1 1-3 0-9z"/></svg>',
};

function lineTop(l) { return 'calc(' + (l - 1) + ' * var(--lh))'; }
function setHit(line, n, bump) {
  let el = hitEls.get(line);
  if (!el) { el = document.createElement('div'); el.className = 'hit'; el.style.top = lineTop(line); hitIn.appendChild(el); hitEls.set(line, el); }
  el.textContent = n > 9999 ? '9999+' : String(n);
  el.classList.remove('cold');
  if (bump && !RM) el.animate([{ transform: 'scale(1.7)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.4)' });
}
function coolHits() { for (const el of hitEls.values()) el.classList.add('cold'); }
function pulse(line) {
  if (RM || !PL) return;
  if (fxIn.querySelectorAll('.glow').length > 24) return;
  const g = document.createElement('div'); g.className = 'glow'; g.style.top = lineTop(line);
  g.addEventListener('animationend', () => g.remove()); fxIn.appendChild(g);
}
function sweep(a, b, dur) {
  if (RM) return;
  const s = document.createElement('div'); s.className = 'sweep'; s.style.top = lineTop(a); s.style.height = 'calc(' + (b - a + 1) + ' * var(--lh))'; s.style.setProperty('--sw', dur + 'ms');
  fxIn.appendChild(s); setTimeout(() => s.remove(), dur + 60);
}
function chip(line, text, cls) {
  if (RM) return;
  const lt = (ta.value.split('\n')[line - 1] || '').replace(/\s+$/, '');
  const c = document.createElement('div'); c.className = 'chip' + (cls ? ' ' + cls : ''); c.textContent = text;
  c.style.top = 'calc(' + (line - 1) + ' * var(--lh) - 1px)'; c.style.left = 'calc(' + Math.min(lt.length, 70) + ' * 1ch + 18px)';
  c.addEventListener('animationend', () => c.remove()); fxIn.appendChild(c);
}
function setCur(line, err) {
  if (!PL.bar) { PL.bar = document.createElement('div'); PL.bar.className = 'curbar'; fxIn.appendChild(PL.bar); }
  PL.bar.style.setProperty('--mv', MOVE[PL.speed] + 'ms');
  PL.bar.style.top = lineTop(line); PL.bar.classList.toggle('err', !!err); PL.bar.classList.remove('off');
  PL.curLine = line;
  if (PL.speed !== 'turbo') keepVisible(line);
}
function keepVisible(line) {
  const lh = lhPx(); const y = (line - 1) * lh; const h = ta.clientHeight;
  if (y < ta.scrollTop + lh || y > ta.scrollTop + h - 3 * lh) { ta.scrollTop = Math.max(0, y - h / 3); sync(); }
}
function hideHud() { hud.hidden = true; watch.hidden = true; hud.innerHTML = ''; }
function renderWatch(vars) {
  if (!vars || !vars.length) { if (PL.watchShown && !PL.rows.size) watch.hidden = true; if (!PL.watchShown) return; }
  if (!PL.watchShown) { watch.hidden = false; PL.watchShown = true; watch.innerHTML = '<h5><span>Variablen</span><span id="wStep"></span></h5><div id="wRows"></div>'; PL.rows = new Map(); }
  const box = $('#wRows'); const seen = new Set();
  for (const [n, v] of vars) {
    seen.add(n);
    let r = PL.rows.get(n);
    if (!r) { r = document.createElement('div'); r.className = 'wv'; r.innerHTML = '<b></b><span></span>'; r.firstChild.textContent = n; box.appendChild(r); PL.rows.set(n, r); r.dataset.v = ''; if (!RM) r.animate([{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' }); }
    if (r.dataset.v !== v) { r.dataset.v = v; r.lastChild.textContent = v; r.title = n + ' = ' + v; if (!RM) { r.classList.remove('chg'); void r.offsetWidth; r.classList.add('chg'); } }
  }
  for (const [n, r] of PL.rows) if (!seen.has(n)) { r.remove(); PL.rows.delete(n); }
  watch.hidden = !PL.rows.size;
}
function particles(ev) {
  const sign = ev.op === 'INSERT' ? 1 : ev.op === 'DELETE' ? -1 : 0;
  const apply = () => {
    if (sign && PL && PL.counts[ev.table] !== undefined) {
      PL.counts[ev.table] += sign * ev.n;
      const m = document.querySelector('.obj[data-kind="table"][data-name="' + ev.table + '"] .meta');
      if (m) { const c = PL.counts[ev.table]; m.textContent = c + (c === 1 ? ' Zeile' : ' Zeilen'); }
    }
    const o = document.querySelector('.obj[data-kind="table"][data-name="' + ev.table + '"]');
    if (o) { o.classList.remove('ping'); void o.offsetWidth; o.classList.add('ping'); }
  };
  if (RM || !PL || !PL.fx) { apply(); return; }
  const now = performance.now();
  if (PL.speed === 'turbo' && now - PL.lastBurst < 45) { setTimeout(apply, 380); return; }
  PL.lastBurst = now;
  if (fxLayer.childElementCount > 60) { apply(); return; }
  if (!charW) measureChar();
  const cw = $('.codewrap').getBoundingClientRect(); const lh = lhPx();
  const lt = (ta.value.split('\n')[(PL.curLine || 1) - 1] || '').replace(/\s+$/, '');
  let x0 = cw.left + 14 + Math.min(lt.length, 60) * charW - ta.scrollLeft, y0 = cw.top + 10 + ((PL.curLine || 1) - 1) * lh - ta.scrollTop + lh / 2;
  x0 = Math.max(cw.left + 20, Math.min(cw.right - 30, x0)); y0 = Math.max(cw.top + 10, Math.min(cw.bottom - 10, y0));
  let tgt = document.querySelector('.obj[data-kind="table"][data-name="' + ev.table + '"]');
  let tr = tgt && tgt.getBoundingClientRect();
  if (!tr || !tr.width || tr.bottom < 0 || tr.top > innerHeight) { tgt = $('#tabOut'); tr = tgt.getBoundingClientRect(); }
  const x1 = tr.left + Math.min(tr.width - 40, 150), y1 = tr.top + tr.height / 2;
  const dur = PL.speed === 'turbo' ? 520 : PL.speed === 'schnell' ? 650 : 900;
  const count = Math.min(ev.n, PL.speed === 'turbo' ? 3 : 7) + 1;
  for (let k = 0; k < count; k++) {
    const p = document.createElement('div');
    p.className = 'pt' + (ev.op === 'DELETE' ? ' del' : ev.op === 'UPDATE' ? ' upd' : '') + (k === 0 ? ' lbl' : '');
    if (k === 0) p.textContent = (ev.op === 'INSERT' ? '+' : ev.op === 'DELETE' ? '−' : '~') + ev.n + ' ' + ev.table.toLowerCase();
    fxLayer.appendChild(p);
    const jx = (Math.random() - .5) * 60, jy = (Math.random() - .5) * 30;
    const mx = (x0 + x1) / 2 + jx, my = Math.min(y0, y1) - 70 - Math.random() * 60;
    const a = p.animate([
      { transform: 'translate(' + x0 + 'px,' + y0 + 'px) scale(.3)', opacity: 0 },
      { transform: 'translate(' + (x0 + jx * .4) + 'px,' + (y0 - 18 + jy) + 'px) scale(1.15)', opacity: 1, offset: .16 },
      { transform: 'translate(' + mx + 'px,' + my + 'px) scale(1)', opacity: 1, offset: .55 },
      { transform: 'translate(' + x1 + 'px,' + y1 + 'px) scale(.35)', opacity: .15 },
    ], { duration: dur + k * 40, delay: k * 35, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'both' });
    a.onfinish = () => p.remove();
  }
  setTimeout(apply, dur);
}
function outLine(text) {
  const art = PL.art; if (!art) return;
  let con = art.querySelector('.console');
  if (!con) { con = document.createElement('div'); con.className = 'console'; art.querySelector('.rb').appendChild(con); }
  const sp = document.createElement('span'); sp.textContent = text || ' ';
  if (PL.speed !== 'turbo' && !RM) { sp.className = 'typed'; sp.style.setProperty('--ty', (PL.speed === 'langsam' ? 700 : PL.speed === 'mittel' ? 380 : 180) + 'ms'); }
  else sp.style.display = 'block';
  con.appendChild(sp); con.scrollTop = con.scrollHeight;
  outBody.scrollTop = outBody.scrollHeight;
}
function startArt(ev) {
  if (PL.art) finishArt(PL.artIdx);
  const r = PL.run.results[ev.i] || {};
  const first = (r.text || '').split('\n').find(l => l.trim()) || '';
  const a = document.createElement('article'); a.className = 'res live';
  a.innerHTML = '<header><button class="ln" data-line="' + r.line + '">Z. ' + r.line + '</button><code>' + esc(first.trim().slice(0, 140)) + '</code></header><div class="rb"></div>';
  outBody.appendChild(a); PL.art = a; PL.artIdx = ev.i;
  outBody.scrollTop = outBody.scrollHeight;
}
function finishArt(i) {
  const a = PL.art; if (!a || PL.artIdx !== i) return;
  const r = PL.run.results[i]; PL.art = null; PL.fin.add(i);
  if (!r || (r.silent && !r.error)) { a.remove(); return; }
  const tmp = document.createElement('div'); tmp.innerHTML = resHTML(r);
  const n = tmp.firstElementChild; if (!PL.instant && !RM) n.classList.add('reveal');
  a.replaceWith(n);
  if (!PL.instant) { const step = PL.speed === 'turbo' ? 10 : 28; n.querySelectorAll('.grid tr').forEach((tr, k) => { tr.style.animationDelay = Math.min(k, 40) * step + 'ms'; }); }
  outBody.scrollTop = outBody.scrollHeight;
}
function hudHTML() {
  return '<button class="hb main" data-h="play" aria-label="Pause/Weiter">' + (PL.paused ? SVG.play : SVG.pause) + '</button>' +
    '<button class="hb" data-h="step" aria-label="Nächster Schritt" title="Nächster Schritt (→ oder F10)">' + SVG.step + '</button>' +
    '<button class="hb" data-h="end" aria-label="Zum Ende springen" title="Zum Ende (Esc)">' + SVG.end + '</button>' +
    '<div class="seg" role="group" aria-label="Tempo">' + SPEEDS.map(([k, n]) => '<button data-sp="' + k + '"' + (k === PL.speed ? ' class="on"' : '') + '>' + n + '</button>').join('') + '</div>' +
    '<div class="hudinfo"><span class="t" id="hStep"></span><span class="prog"><i id="hProg"></i></span></div>' +
    '<span class="combo" id="hCombo" hidden></span><span class="trunc" id="hTrunc" hidden></span>' +
    '<button class="hb" data-h="close" aria-label="Schließen" hidden id="hClose">' + SVG.x + '</button>';
}
function updHud() {
  if (!PL) return;
  const st = $('#hStep'); if (st) st.innerHTML = 'Schritt <em>' + PL.stepNo + '</em> / ' + PL.steps;
  const pr = $('#hProg'); if (pr) pr.style.width = (PL.steps ? PL.stepNo / PL.steps * 100 : 100) + '%';
  const pb = hud.querySelector('[data-h="play"]'); if (pb) pb.innerHTML = PL.paused ? SVG.play : SVG.pause;
  const ws = $('#wStep'); if (ws) ws.textContent = 'Schritt ' + PL.stepNo;
}
function combo(line) {
  const n = PL.hits.get(line) || 0; const c = $('#hCombo'); if (!c) return;
  if (n >= 3) { c.hidden = false; c.textContent = '×' + n; if (PL.speed !== 'turbo' || n % 10 === 0) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); } }
}
function applyEv(ev, fx) {
  switch (ev.t) {
    case 'stmt': {
      PL.stepNo++;
      startArt(ev);
      if (fx) { setCur(ev.line); sweep(ev.line, ev.end, PL.speed === 'turbo' ? 380 : Math.min(900, 120 + (ev.end - ev.line + 1) * 60)); }
      else PL.curLine = ev.line;
      break;
    }
    case 'pl': {
      PL.stepNo++;
      const n = (PL.hits.get(ev.line) || 0) + 1; PL.hits.set(ev.line, n); PL.dirty.add(ev.line);
      PL.lastVars = ev.vars;
      if (fx) {
        setCur(ev.line);
        const now = performance.now();
        if (PL.speed !== 'turbo' || now - PL.lastPulse > 28) { pulse(ev.line); PL.lastPulse = now; }
        if (PL.speed !== 'turbo') { flushHits(true); renderWatch(ev.vars); combo(ev.line); }
      } else PL.curLine = ev.line;
      break;
    }
    case 'out': if (PL.art) outLine(ev.text); break;
    case 'dml': if (fx) particles(ev); else if (PL.counts[ev.table] !== undefined) PL.counts[ev.table] += (ev.op === 'INSERT' ? ev.n : ev.op === 'DELETE' ? -ev.n : 0); break;
    case 'call': if (fx) chip(PL.curLine || 1, '↳ ' + ev.name.toLowerCase(), ''); break;
    case 'ret': if (fx && ev.value !== null && ev.value !== undefined) chip(PL.curLine || 1, ev.name.toLowerCase() + ' = ' + ev.value, 'ret'); break;
    case 'err': {
      PL.errors++;
      if (fx) { setCur(ev.line || PL.curLine || 1, true); if (!RM) { edEl.classList.remove('shake'); void edEl.offsetWidth; edEl.classList.add('shake'); } }
      break;
    }
    case 'done': finishArt(ev.i); break;
    case 'trunc': PL.trunc = true; { const t = $('#hTrunc'); if (t) { t.hidden = false; t.textContent = 'ab Schritt ' + PL.stepNo + ' im Zeitraffer'; } } break;
  }
}
function flushHits(bump) {
  for (const l of PL.dirty) setHit(l, PL.hits.get(l), bump);
  PL.dirty.clear();
}
function advance(maxSteps, fx) {
  let steps = 0;
  while (PL.i < PL.trace.length) {
    const ev = PL.trace[PL.i];
    if ((ev.t === 'pl' || ev.t === 'stmt') && steps >= maxSteps) break;
    if (ev.t === 'pl' || ev.t === 'stmt') steps++;
    PL.i++;
    applyEv(ev, fx);
    if (ev.t === 'trunc') return 'trunc';
  }
  if (PL.speed === 'turbo') { flushHits(false); renderWatch(PL.lastVars); if (PL.curLine) combo(PL.curLine); }
  updHud();
  return PL.i >= PL.trace.length ? 'end' : 'more';
}
function schedule() {
  if (!PL || PL.done) return;
  clearTimeout(PL.timer); cancelAnimationFrame(PL.raf);
  if (PL.paused) return;
  if (PL.speed === 'turbo') PL.raf = requestAnimationFrame(() => { const r = advance(PL.perFrame, true); if (r === 'more') schedule(); else finishPlay(r === 'trunc'); });
  else PL.timer = setTimeout(() => { const r = advance(1, true); if (r === 'more') schedule(); else finishPlay(r === 'trunc'); }, DELAY[PL.speed]);
}
function stepOnce() { if (!PL || PL.done) return; PL.paused = true; clearTimeout(PL.timer); cancelAnimationFrame(PL.raf); const r = advance(1, true); if (r !== 'more') finishPlay(r === 'trunc'); }
function setSpeed(s) {
  PL.speed = s; PL.paused = s === 'einzeln';
  if (PL.manual) { stepSpeed = s; LS.set('orasim.stepSpeed', s); } else if (s === 'turbo' || s === 'schnell') { animMode = s; LS.set('orasim.anim', s); }
  if (s === 'turbo') PL.perFrame = Math.max(1, Math.ceil((PL.steps - PL.stepNo) / 60));
  hud.querySelectorAll('[data-sp]').forEach(b => b.classList.toggle('on', b.dataset.sp === s));
  updHud(); schedule();
}
hud.addEventListener('click', ev => {
  if (!PL) { if (ev.target.closest('[data-h="close"]')) { hud.hidden = true; watch.hidden = true; } return; }
  const sp = ev.target.closest('[data-sp]'); if (sp) { setSpeed(sp.dataset.sp); return; }
  const h = ev.target.closest('[data-h]'); if (!h) return;
  if (h.dataset.h === 'play') { if (PL.speed === 'einzeln') setSpeed(stepSpeed === 'einzeln' ? 'mittel' : stepSpeed); else { PL.paused = !PL.paused; updHud(); schedule(); } }
  else if (h.dataset.h === 'step') stepOnce();
  else if (h.dataset.h === 'end') finishPlay(true);
});
function playTrace(run, opts) {
  return new Promise(resolve => {
    const trace = run.trace;
    const steps = trace.filter(e => e.t === 'pl' || e.t === 'stmt').length;
    clearHeat(); fxIn.innerHTML = '';
    PL = { run, trace, i: 0, steps, stepNo: 0, speed: opts.speed, manual: !!opts.manual, paused: opts.speed === 'einzeln', resolve, hits: new Map(), dirty: new Set(),
      counts: Object.assign({}, opts.counts || {}), art: null, artIdx: -1, fin: new Set(), errors: 0, lastPulse: 0, lastBurst: 0, fx: !RM, curLine: null, lastVars: null, watchShown: false,
      perFrame: Math.max(1, Math.ceil(steps / Math.min(90, Math.max(22, steps * 1.2)))) };
    edEl.classList.add('playing'); ta.readOnly = true;
    outBody.innerHTML = ''; $('#summary').innerHTML = '<span class="running"><span class="spin"></span>' + (PL.manual ? 'Schrittmodus' : 'Wiedergabe') + '</span>';
    outTab = 'out'; $('#tabOut').classList.add('act'); $('#tabObj').classList.remove('act');
    watch.hidden = true; watch.innerHTML = '';
    hud.classList.remove('fade'); hud.hidden = !(PL.manual || steps > 40 || opts.speed !== 'turbo'); hud.innerHTML = hudHTML(); updHud();
    if (PL.paused) { const r = advance(1, true); if (r !== 'more') finishPlay(r === 'trunc'); } else schedule();
  });
}
function finishPlay(skip) {
  if (!PL || PL.done) return;
  const P = PL; P.done = true; clearTimeout(P.timer); cancelAnimationFrame(P.raf);
  if (skip) { P.instant = true; while (P.i < P.trace.length) applyEv(P.trace[P.i++], false); }
  flushHits(false);
  if (P.lastVars) renderWatch(P.lastVars);
  if (P.art) finishArt(P.artIdx);
  P.run.results.forEach((r, i) => { if (!P.fin.has(i) && !(r.silent && !r.error)) { const tmp = document.createElement('div'); tmp.innerHTML = resHTML(r); outBody.appendChild(tmp.firstElementChild); } });
  P.stepNo = P.steps; updHud();
  edEl.classList.remove('playing'); if (hitEls.size) edEl.classList.add('heat'); coolHits();
  ta.readOnly = false;
  if (P.bar) { const b = P.bar; setTimeout(() => { b.classList.add('off'); setTimeout(() => b.remove(), 500); }, P.errors ? 1600 : 500); }
  const nErr = P.run.results.filter(r => r.error).length;
  if (P.manual) { const c = $('#hClose'); if (c) c.hidden = false; const pb = hud.querySelector('[data-h="play"]'); if (pb) pb.disabled = true; }
  else { setTimeout(() => { if (!PL) { hud.classList.add('fade'); setTimeout(() => { if (!PL) hud.hidden = true; }, 600); } }, 1100); setTimeout(() => { if (!PL) watch.hidden = true; }, 2600); }
  PL = null;
  renderSummary();
  if (!nErr) celebrate(P); else renderSummary();
  P.resolve();
}
function renderSummary() {
  if (!lastRun) return;
  const res = lastRun.results.filter(r => !r.silent || r.error); const nErr = res.filter(r => r.error).length;
  const nAll = lastRun.total || res.length;
  $('#summary').innerHTML = nAll.toLocaleString('de-DE') + (nAll === 1 ? ' Anweisung' : ' Anweisungen') + (nErr ? ' · <b>' + nErr + ' Fehler</b>' : ' · ohne Fehler') + ' · ' + (lastRun.ms || 0) + ' ms';
}
function celebrate(P) {
  renderSummary();
  if (RM) return;
  edEl.classList.remove('win'); void edEl.offsetWidth; edEl.classList.add('win');
  const sm = $('#summary'); if (!sm) return;
  const m = document.createElement('span'); m.className = 'okmark'; m.setAttribute('aria-hidden', 'true');
  m.innerHTML = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.2"/><path d="M6 10.4l2.7 2.7L14.2 7.4"/></svg>';
  sm.prepend(m);
}
function playerKeys(ev) {
  if (!PL) return false;
  if (ev.key === ' ' ) { ev.preventDefault(); if (PL.speed === 'einzeln') stepOnce(); else { PL.paused = !PL.paused; updHud(); schedule(); } return true; }
  if (ev.key === 'ArrowRight' || ev.key === 'F10' || ev.key === 'ArrowDown') { ev.preventDefault(); stepOnce(); return true; }
  if (ev.key === 'Escape') { ev.preventDefault(); finishPlay(true); return true; }
  if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Enter') { ev.preventDefault(); return true; }
  return false;
}
