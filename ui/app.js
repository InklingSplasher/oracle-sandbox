{
const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};
const ENGINE_SRC = document.getElementById('engine-src').textContent;
const ENG = new Function(ENGINE_SRC + '\n;return { splitStatements, runScript, catalog, saveState, loadState, resetDB, exportSQL, doCommit, parseScript };')();
const WORKER_GLUE = `
self.onmessage = function (ev) {
  const m = ev.data; const reply = (o) => self.postMessage(Object.assign({ id: m.id }, o));
  try {
    if (m.cmd === 'init') {
      let warn = null;
      if (m.state) { try { loadState(m.state); } catch (e) { warn = 'Der gespeicherte Zustand war beschädigt – die Datenbank wurde neu angelegt.'; resetDB(); if (m.seed) { runScript(m.seed); doCommit(); } } }
      else { resetDB(); if (m.seed) { runScript(m.seed); doCommit(); } }
      reply({ catalog: catalog(), state: saveState(), warn });
    } else if (m.cmd === 'run') {
      const t0 = Date.now(); const r = runScript(m.sql, { trace: m.trace, progress: (d, n) => self.postMessage({ id: m.id, progress: { done: d, total: n } }) });
      reply({ results: r.results, trace: r.trace, hidden: r.hidden, total: r.total, ms: Date.now() - t0, catalog: catalog(), state: saveState() });
    } else if (m.cmd === 'import') {
      const t0 = Date.now(); const files = []; let results = []; let hidden = 0, total = 0;
      if (m.fresh) resetDB();
      m.files.forEach((f, fi) => {
        const r = runScript(f.text, { compactOver: 0, progress: (d, n) => self.postMessage({ id: m.id, progress: { file: fi, files: m.files.length, name: f.name, done: d, total: n } }) });
        doCommit();
        const errs = r.results.filter(x => x.error);
        files.push({ name: f.name, total: r.total, errors: errs.length });
        results = results.concat(r.results.slice(0, 300).map(x => Object.assign(x, { file: f.name })));
        hidden += r.hidden; total += r.total;
      });
      reply({ results, files, hidden, total, ms: Date.now() - t0, catalog: catalog(), state: saveState() });
    } else if (m.cmd === 'reset') {
      resetDB(); if (m.seed) { runScript(m.seed); doCommit(); }
      reply({ catalog: catalog(), state: saveState() });
    } else if (m.cmd === 'export') reply({ sql: exportSQL() });
  } catch (e) { reply({ fatal: String(e && e.stack || e) }); }
};`;

// ---------- Elemente & Zustand ----------
const ta = $('#ta'), hlIn = $('#hlIn'), gutIn = $('#gutIn'), marksIn = $('#marksIn'), sqIn = $('#sqIn'), outBody = $('#outBody'), work = $('#work');
let sheets = [], activeId = null, shownId = null, lastState = null, catalog = null, lastRun = null, selected = null, outTab = 'out';
let treeCounts = null, dbList = [], activeDb = null;
let lintOn = LS.get('orasim.lint') !== '0', lintIssues = [], lintTimer = null, caseMode = LS.get('orasim.case') || 'upper';
let running = false, errLines = new Map(), ranRange = null, worker = null, pending = new Map(), msgId = 0, useWorker = true, stopTimer = null;

const ICON = {
  chev: '<svg class="i chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------- Syntax-Hervorhebung ----------
const KW = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING GROUP BY HAVING ORDER ASC DESC NULLS FIRST LAST ' +
  'DISTINCT UNIQUE ALL ANY SOME UNION INTERSECT MINUS EXCEPT INSERT INTO VALUES UPDATE SET DELETE MERGE MATCHED THEN WHEN ELSE END CASE CREATE OR REPLACE TABLE VIEW ' +
  'INDEX SEQUENCE TRIGGER PROCEDURE FUNCTION PACKAGE BODY TYPE DROP ALTER ADD MODIFY RENAME COLUMN TO CONSTRAINT PRIMARY FOREIGN KEY REFERENCES CHECK DEFAULT CASCADE ' +
  'CONSTRAINTS TRUNCATE COMMIT ROLLBACK SAVEPOINT GRANT REVOKE WITH RECURSIVE FETCH NEXT ROWS ROW ONLY OFFSET PERCENT TIES OVER PARTITION ROWNUM LEVEL CONNECT PRIOR START ' +
  'SIBLINGS DECLARE BEGIN EXCEPTION IF ELSIF LOOP WHILE FOR EXIT CONTINUE RETURN RETURNING RAISE IS OUT NOCOPY CURSOR OPEN CLOSE BULK COLLECT LIMIT FORALL EXECUTE IMMEDIATE ' +
  'PRAGMA EXCEPTION_INIT RECORD OF INDEX REF REVERSE GENERATED ALWAYS IDENTITY BEFORE AFTER INSTEAD EACH REFERENCING NEW OLD ENABLE DISABLE CONSTANT SUBTYPE WITHIN ' +
  'TRUE FALSE NULL EXEC CALL DESC DESCRIBE COMMENT SESSION FORCE READ WRITE OPTION TEMPORARY GLOBAL PRESERVE DETERMINISTIC AUTHID CURRENT_USER UNBOUNDED PRECEDING FOLLOWING CURRENT RANGE ' +
  'ROLLUP CUBE GROUPING SETS NOCYCLE DATE TIMESTAMP INTERVAL OTHERS SQL WORK PURGE IF EXISTS NOT PROMPT SERVEROUTPUT').split(' '));
const TY = new Set('NUMBER INTEGER INT SMALLINT DECIMAL NUMERIC FLOAT REAL VARCHAR2 VARCHAR NVARCHAR2 CHAR NCHAR CLOB BLOB NCLOB BOOLEAN PLS_INTEGER BINARY_INTEGER NATURAL POSITIVE SIMPLE_INTEGER BINARY_DOUBLE BINARY_FLOAT RAW LONG ROWID SYS_REFCURSOR VARRAY TABLE RECORD'.split(' '));
const FN = new Set(('COUNT SUM AVG MIN MAX LISTAGG MEDIAN STDDEV VARIANCE ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE UPPER LOWER INITCAP LENGTH SUBSTR INSTR CONCAT LPAD RPAD TRIM LTRIM RTRIM REPLACE TRANSLATE ' +
  'ASCII CHR NVL NVL2 COALESCE NULLIF DECODE GREATEST LEAST ABS CEIL FLOOR ROUND TRUNC MOD POWER SQRT EXP LN LOG SIGN TO_CHAR TO_NUMBER TO_DATE TO_TIMESTAMP CAST EXTRACT ADD_MONTHS ' +
  'MONTHS_BETWEEN LAST_DAY NEXT_DAY SYSDATE SYSTIMESTAMP USER SYS_GUID REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR REGEXP_INSTR REGEXP_COUNT SQLCODE SQLERRM DBMS_OUTPUT PUT_LINE PUT NEW_LINE ' +
  'RAISE_APPLICATION_ERROR NEXTVAL CURRVAL DBMS_RANDOM DBMS_SQL RETURN_RESULT SYS_CONNECT_BY_PATH CONNECT_BY_ROOT INSERTING UPDATING DELETING DBMS_UTILITY').split(' '));
function hlHTML(src) {
  let out = '', i = 0; const n = src.length;
  const span = (c, t) => '<span class="' + c + '">' + esc(t) + '</span>';
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') { let j = src.indexOf('\n', i); if (j < 0) j = n; out += span('t-com', src.slice(i, j)); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; out += span('t-com', src.slice(i, j)); i = j; continue; }
    if (c === "'" || ((c === 'q' || c === 'Q') && src[i + 1] === "'")) {
      let j = i + (c === "'" ? 1 : 2);
      if (c !== "'") { const open = src[j]; const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] || open; const e = src.indexOf(close + "'", j + 1); j = e < 0 ? n : e + 2; }
      else { while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; } j++; } }
      out += span('t-str', src.slice(i, j)); i = j; continue;
    }
    if (c === '"') { let j = src.indexOf('"', i + 1); j = j < 0 ? n : j + 1; out += span('t-qid', src.slice(i, j)); i = j; continue; }
    if (/[0-9]/.test(c) && !/[A-Za-z_$#]/.test(src[i - 1] || '')) { let j = i; while (j < n && /[0-9.]/.test(src[j]) && !(src[j] === '.' && src[j + 1] === '.')) j++; out += span('t-num', src.slice(i, j)); i = j; continue; }
    if (c === ':' && /[A-Za-z]/.test(src[i + 1] || '')) { let j = i + 1; while (j < n && /[\w$#]/.test(src[j])) j++; out += span('t-bind', src.slice(i, j)); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (j < n && /[\w$#]/.test(src[j])) j++;
      const w = src.slice(i, j), u = w.toUpperCase();
      out += KW.has(u) ? span('t-kw', w) : TY.has(u) ? span('t-ty', w) : FN.has(u) ? span('t-fn', w) : esc(w);
      i = j; continue;
    }
    if (/[|=<>!+*\/;:%(),.-]/.test(c)) { out += span('t-op', c); i++; continue; }
    out += esc(c); i++;
  }
  return out;
}

// ---------- Editor ----------
const lineOf = (text, pos) => { let n = 1; for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };
let rafPending = false;
function paint() {
  rafPending = false;
  const text = ta.value;
  hlIn.innerHTML = (text.length > 200000 ? esc(text) : hlHTML(text)) + '\n ';
  const lineArr = text.split('\n'); const lines = lineArr.length;
  const lintMap = new Map(); if (lintOn) for (const x of lintIssues) if (!lintMap.has(x.line)) lintMap.set(x.line, x);
  let g = '';
  for (let i = 1; i <= lines; i++) {
    const li = lintMap.get(i);
    const cls = errLines.has(i) ? 'err' : li ? 'warn' : (ranRange && i >= ranRange[0] && i <= ranRange[1] ? 'ran' : '');
    const tip = errLines.has(i) ? errLines.get(i) : li ? li.code + ': ' + li.msg : '';
    g += '<div' + (cls ? ' class="' + cls + '"' : '') + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + i + '</div>';
  }
  gutIn.innerHTML = g;
  let m = '';
  if (ranRange) m += '<div class="mk ran" style="top:calc(' + (ranRange[0] - 1) + ' * var(--lh));height:calc(' + (ranRange[1] - ranRange[0] + 1) + ' * var(--lh))"></div>';
  for (const l of errLines.keys()) m += '<div class="mk err" style="top:calc(' + (l - 1) + ' * var(--lh))"></div>';
  let sq = '';
  for (const [l, x] of lintMap) {
    if (errLines.has(l)) continue;
    m += '<div class="mk lint" style="top:calc(' + (l - 1) + ' * var(--lh))"></div>';
    const lt = lineArr[l - 1] || ''; const c = Math.max(1, Math.min(x.col || 1, lt.length + 1));
    const tokLen = Math.max(2, Math.min(24, ((lt.slice(c - 1).match(/^(\w+|'[^']*'?|"[^"]*"?|:=|\S)/) || [' '])[0]).length));
    sq += '<div class="sq" style="top:calc(' + l + ' * var(--lh) - 3px);left:calc(' + (c - 1) + ' * 1ch);width:calc(' + tokLen + ' * 1ch)"></div>';
  }
  marksIn.innerHTML = m; sqIn.innerHTML = sq;
  renderLintPill();
  sync();
}
function schedulePaint() { if (!rafPending) { rafPending = true; requestAnimationFrame(paint); } }
function sync() {
  const x = ta.scrollLeft, y = ta.scrollTop;
  hlIn.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
  marksIn.style.transform = 'translateY(' + (-y) + 'px)';
  gutIn.style.transform = 'translateY(' + (-y) + 'px)';
  sqIn.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
  fxIn.style.transform = 'translateY(' + (-y) + 'px)';
  hitIn.style.transform = 'translateY(' + (-y) + 'px)';
}

// ---------- Live-Syntaxprüfung ----------
function lintText(text) {
  let items;
  try { items = ENG.parseScript(text); } catch (e) { return [{ line: e.line || 1, col: e.col || 1, code: e.code || 'ORA-00900', msg: String(e.message || e).replace(/^Zeile \d+, Spalte \d+:\n/, ''), hint: e.hint || null }]; }
  return items.filter(i => i.error).map(i => ({ line: i.error.line || i.line, col: i.error.col || 1, code: i.error.code, msg: i.error.message.replace(/^Zeile \d+, Spalte \d+:\n/, ''), hint: i.error.hint || null }));
}
function runLint() { clearTimeout(lintTimer); lintIssues = lintOn && ta.value.length < 200000 ? lintText(ta.value) : []; schedulePaint(); }
function scheduleLint() { if (!lintOn) return; clearTimeout(lintTimer); lintTimer = setTimeout(runLint, 450); }
function renderLintPill() {
  const pill = $('#lintPill');
  if (!lintOn) { pill.hidden = true; return; }
  pill.hidden = false;
  if (!lintIssues.length) { pill.classList.remove('bad'); $('#lintText').textContent = ta.value.trim() ? 'Syntax in Ordnung' : 'Live-Prüfung aktiv'; pill.title = 'Live-Syntaxprüfung – abschaltbar im Menü'; return; }
  const x = lintIssues[0];
  pill.classList.add('bad');
  $('#lintText').textContent = (lintIssues.length > 1 ? lintIssues.length + ' Syntaxfehler · ' : '') + 'Z. ' + x.line + ': ' + x.msg.split('\n').pop();
  pill.title = lintIssues.map(i => 'Zeile ' + i.line + ', Spalte ' + i.col + ' – ' + i.code + ': ' + i.msg + (i.hint ? '\nTipp: ' + i.hint : '')).join('\n\n');
}
$('#lintPill').addEventListener('click', () => { const x = lintIssues[0]; if (!x) return; gotoLine(x.line, x.col); if (x.hint) toast(x.hint); });
function setLint(on) { lintOn = on; LS.set('orasim.lint', on ? '1' : '0'); runLint(); }

// ---------- Formatieren ----------
function doFormat() {
  const full = ta.value; let s = ta.selectionStart, e = ta.selectionEnd;
  const sel = s !== e;
  if (!sel) { s = 0; e = full.length; }
  const src = full.slice(s, e);
  if (!src.trim()) { toast('Nichts zu formatieren.'); return; }
  let out;
  try { out = FMT.format(src, { caseMode, keywords: new Set([...KW, ...FN, ...TY]) }); } catch (x) { toast('Formatieren fehlgeschlagen.'); return; }
  if (!FMT.sameTokens(src, out)) { toast('Formatierung abgebrochen – das Ergebnis wäre nicht gleichwertig.'); return; }
  if (sel && !/\n$/.test(src)) out = out.replace(/\n+$/, '');
  if (out === src) { toast('Bereits formatiert.'); return; }
  const lineBefore = lineOf(full, ta.selectionStart);
  ta.focus(); ta.setSelectionRange(s, e); insertText(out);
  if (sel) ta.setSelectionRange(s, s + out.length); else { gotoLine(Math.min(lineBefore, out.split('\n').length)); }
  toast(sel ? 'Markierung formatiert.' : 'Blatt formatiert – Strg+Z macht es rückgängig.');
}
$('#fmtBtn').onclick = doFormat;
ta.addEventListener('scroll', sync);
let saveTimer = null;
ta.addEventListener('input', () => {
  if (errLines.size || ranRange) { errLines = new Map(); ranRange = null; }
  schedulePaint(); scheduleLint(); if (hitEls.size) clearHeat();
  const sh = sheets.find(s => s.id === activeId); if (sh) sh.text = ta.value;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveSheets, 400);
});
function insertText(t) {
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, t); } catch (e) { }
  if (!ok) { const s = ta.selectionStart; ta.setRangeText(t, s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
}
function lineBounds(text, a, b) {
  const s = text.lastIndexOf('\n', a - 1) + 1;
  let e = text.indexOf('\n', b > a && text[b - 1] === '\n' ? b - 1 : b); if (e < 0) e = text.length;
  return [s, e];
}
function replaceLines(fn) {
  const text = ta.value; const [s, e] = lineBounds(text, ta.selectionStart, ta.selectionEnd);
  const block = text.slice(s, e); const nb = block.split('\n').map(fn).join('\n');
  ta.setSelectionRange(s, e); insertText(nb); ta.setSelectionRange(s, s + nb.length);
}
ta.addEventListener('keydown', ev => {
  if (playerKeys(ev)) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'F8') { ev.preventDefault(); run(ev.shiftKey ? 'all' : 'stmt', true); return; }
  if (ev.key === 'Enter' && mod) { ev.preventDefault(); run(ev.shiftKey ? 'all' : 'stmt'); return; }
  if (ev.key === 'F5' || ev.key === 'F9') { ev.preventDefault(); run(ev.key === 'F9' ? 'stmt' : 'all'); return; }
  if ((mod || ev.altKey) && ev.shiftKey && (ev.key === 'F' || ev.key === 'f')) { ev.preventDefault(); doFormat(); return; }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
    if (ev.shiftKey) replaceLines(l => l.replace(/^( {1,2}|\t)/, ''));
    else if (multi) replaceLines(l => '  ' + l);
    else insertText('  ');
    return;
  }
  if (ev.key === 'Enter' && !mod && !ev.shiftKey && !ev.altKey) {
    const text = ta.value; const s = text.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const ind = (text.slice(s, ta.selectionStart).match(/^[ \t]*/) || [''])[0];
    ev.preventDefault(); insertText('\n' + ind); return;
  }
  if (mod && (ev.key === '/' || ev.key === '7' && ev.shiftKey)) {
    ev.preventDefault();
    const text = ta.value; const [s, e] = lineBounds(text, ta.selectionStart, ta.selectionEnd);
    const all = text.slice(s, e).split('\n').filter(l => l.trim()).every(l => /^\s*--/.test(l));
    replaceLines(l => all ? l.replace(/^(\s*)-- ?/, '$1') : (l.trim() ? '-- ' + l : l));
  }
});
document.addEventListener('keydown', ev => {
  if (document.activeElement !== ta && PL && playerKeys(ev)) return;
  if (ev.key === 'F5') { ev.preventDefault(); if (document.activeElement !== ta) run('all'); }
  if (ev.key === 'F8' && document.activeElement !== ta) { ev.preventDefault(); run('stmt', true); }
  if (ev.key === 'Escape') { closePop(); if (!$('#modal').hidden) closeModal(); work.classList.remove('side-open'); if (innerWidth <= 1180) setCheat(false); }
});

// ---------- Arbeitsblätter ----------
function saveSheets() { LS.set('orasim.sheets', JSON.stringify({ sheets, activeId })); }
function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function renderTabs() {
  const el = $('#sheetTabs');
  el.innerHTML = sheets.map(s => '<div class="tab' + (s.id === activeId ? ' act' : '') + '" role="tab" aria-selected="' + (s.id === activeId) + '" data-id="' + s.id + '"><span class="tn" title="Doppelklick zum Umbenennen">' + esc(s.name) + '</span>' + (sheets.length > 1 ? '<button class="x" data-close="' + s.id + '" aria-label="Blatt schließen">' + ICON.x + '</button>' : '') + '</div>').join('') +
    '<button class="tabadd" id="tabAdd" aria-label="Neues Arbeitsblatt" title="Neues Arbeitsblatt">' + ICON.plus + '</button>';
}
function openSheet(id) {
  const cur = shownId && sheets.find(s => s.id === shownId); if (cur) { cur.text = ta.value; cur.sel = ta.selectionStart; cur.scroll = ta.scrollTop; }
  activeId = id; shownId = id; const s = sheets.find(x => x.id === id);
  ta.value = s.text; errLines = new Map(); ranRange = null;
  try { ta.setSelectionRange(s.sel || 0, s.sel || 0); } catch (e) { }
  lintIssues = lintOn && s.text.length < 200000 ? lintText(s.text) : [];
  renderTabs(); paint();
  ta.scrollTop = s.scroll || 0; sync();
  saveSheets();
}
function addSheet(name, text) {
  let n = name; let k = 2; while (sheets.some(s => s.name === n)) n = name + ' (' + (k++) + ')';
  const s = { id: newId(), name: n, text: text || '' }; sheets.push(s); openSheet(s.id); ta.focus();
}
$('#sheetTabs').addEventListener('click', ev => {
  const c = ev.target.closest('[data-close]');
  if (c) { ev.stopPropagation(); const id = c.dataset.close; const s = sheets.find(x => x.id === id);
    const doClose = () => { const i = sheets.indexOf(s); sheets.splice(i, 1); if (activeId === id) { shownId = null; } if (activeId === id) openSheet(sheets[Math.max(0, i - 1)].id); else { renderTabs(); saveSheets(); } };
    if (s.text.trim()) confirmBox('Blatt „' + s.name + '“ schließen?', 'Der Inhalt dieses Arbeitsblatts geht verloren.', 'Schließen', doClose); else doClose();
    return; }
  if (ev.target.closest('#tabAdd')) { addSheet('Blatt ' + (sheets.length + 1), ''); return; }
  const t = ev.target.closest('.tab'); if (t && t.dataset.id !== activeId) openSheet(t.dataset.id);
});
$('#sheetTabs').addEventListener('dblclick', ev => {
  const t = ev.target.closest('.tab'); if (!t) return;
  const s = sheets.find(x => x.id === t.dataset.id); const sp = t.querySelector('.tn');
  sp.innerHTML = '<input value="' + esc(s.name) + '" aria-label="Name des Blatts">';
  const inp = sp.querySelector('input'); inp.focus(); inp.select();
  const done = () => { s.name = inp.value.trim() || s.name; renderTabs(); saveSheets(); };
  inp.addEventListener('blur', done); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = s.name; inp.blur(); } });
});

// ---------- Engine / Worker ----------
function makeWorker() {
  try {
    const url = URL.createObjectURL(new Blob([ENGINE_SRC + '\n' + WORKER_GLUE], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = ev => { const p = pending.get(ev.data.id); if (!p) return; if (ev.data.progress) { if (p.onProgress) p.onProgress(ev.data.progress); return; } pending.delete(ev.data.id); p.resolve(ev.data); };
    w.onerror = ev => { ev.preventDefault && ev.preventDefault(); if (!worker) return; useWorker = false; for (const [id, p] of pending) { pending.delete(id); p.resolve(localCall(p.msg)); } };
    return w;
  } catch (e) { useWorker = false; return null; }
}
function localCall(m) {
  try {
    if (m.cmd === 'init') { let warn = null; if (m.state) { try { ENG.loadState(m.state); } catch (e) { warn = 'Zustand beschädigt – neu angelegt.'; ENG.resetDB(); if (m.seed) { ENG.runScript(m.seed); ENG.doCommit(); } } } else { ENG.resetDB(); if (m.seed) { ENG.runScript(m.seed); ENG.doCommit(); } } return { catalog: ENG.catalog(), state: ENG.saveState(), warn }; }
    if (m.cmd === 'run') { const t0 = Date.now(); const r = ENG.runScript(m.sql, { trace: m.trace }); return { results: r.results, trace: r.trace, hidden: r.hidden, total: r.total, ms: Date.now() - t0, catalog: ENG.catalog(), state: ENG.saveState() }; }
    if (m.cmd === 'import') { const t0 = Date.now(); if (m.fresh) ENG.resetDB(); let results = [], hidden = 0, total = 0; const files = []; for (const f of m.files) { const r = ENG.runScript(f.text, { compactOver: 0 }); ENG.doCommit(); files.push({ name: f.name, total: r.total, errors: r.results.filter(x => x.error).length }); results = results.concat(r.results.slice(0, 300).map(x => Object.assign(x, { file: f.name }))); hidden += r.hidden; total += r.total; } return { results, files, hidden, total, ms: Date.now() - t0, catalog: ENG.catalog(), state: ENG.saveState() }; }
    if (m.cmd === 'reset') { ENG.resetDB(); if (m.seed) { ENG.runScript(m.seed); ENG.doCommit(); } return { catalog: ENG.catalog(), state: ENG.saveState() }; }
    if (m.cmd === 'export') return { sql: ENG.exportSQL() };
  } catch (e) { return { fatal: String(e && e.stack || e) }; }
}
function call(m, onProgress) {
  m.id = ++msgId;
  if (useWorker && worker) return new Promise(resolve => { pending.set(m.id, { resolve, msg: m, onProgress }); worker.postMessage(m); });
  return new Promise(resolve => setTimeout(() => resolve(localCall(m)), 0));
}
function persistState(st) {
  if (!st) return; lastState = st;
  const meta = dbList.find(d => d.id === activeDb); if (meta && catalog) { meta.tables = catalog.tables.length; meta.size = st.length; saveDbMeta(); }
  KV.set('db:' + activeDb, st).then(ok => { if (!ok) toast('Speichern im Browser fehlgeschlagen – sichere die Datenbank per Export.'); });
}
function stopRun() {
  if (isRemote()) { remoteStop(); return; }
  if (!running || !useWorker) return;
  worker.terminate(); worker = null;
  for (const [id, p] of pending) { pending.delete(id); p.resolve({ aborted: true }); }
  worker = makeWorker();
  call({ cmd: 'init', state: lastState }).then(r => { if (r.catalog) { catalog = r.catalog; renderTree(); renderTx(); } });
}

// ---------- Ausführen ----------
function pickStatement(text, pos) {
  const items = ENG.splitStatements(text);
  if (!items.length) return null;
  let best = null;
  for (const it of items) { if (it.start <= pos) best = it; }
  for (const it of items) if (pos >= it.start && pos <= it.end + 2) return it;
  if (best) {
    const after = text.slice(best.end, pos);
    const next = items[items.indexOf(best) + 1];
    if (/\n\s*\n/.test(after) && next) return next;
    return best;
  }
  return items[0];
}
async function run(mode, stepMode) {
  if (PL) finishPlay(true);
  if (running) return;
  if (isRemote()) { if (stepMode) toast('Den Schrittmodus gibt es nur in der Simulation – auf dem Server läuft das Skript normal.'); return remoteRun(stepMode ? 'stmt' : mode); }
  hideHud();
  const text = ta.value; let sql, range;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s !== e) { const l0 = lineOf(text, s); sql = '\n'.repeat(l0 - 1) + text.slice(s, e); range = [l0, lineOf(text, e)]; }
  else if (mode === 'stmt') {
    const it = pickStatement(text, s);
    if (!it) { toast('Keine Anweisung gefunden.'); return; }
    let end = it.end; const rest = text.slice(end); const m = rest.match(/^\s*(;|\n\s*\/[ \t]*(?=\n|$))/); if (m) end += m[0].length;
    sql = '\n'.repeat(it.line - 1) + text.slice(it.start, end); range = [it.line, lineOf(text, end)];
  } else { sql = text; range = null; }
  if (!sql.trim()) { toast('Der Editor ist leer.'); return; }
  running = true; errLines = new Map(); ranRange = range; paint();
  const firstLine = range ? range[0] : 1;
  $('#summary').innerHTML = '<span class="running"><span class="spin"></span>läuft …</span>';
  clearTimeout(stopTimer); stopTimer = setTimeout(() => { if (running && useWorker) $('#stopBtn').hidden = false; }, 350);
  const wantAnim = stepMode || (animMode !== 'aus' && !RM);
  const prevCounts = {}; if (catalog) for (const t of catalog.tables) prevCounts[t.name] = t.count;
  const r = await call({ cmd: 'run', sql, trace: wantAnim });
  running = false; clearTimeout(stopTimer); $('#stopBtn').hidden = true;
  if (wantAnim && r.trace && r.trace.length > 1 && !r.aborted && !r.fatal) {
    lastRun = r; catalog = r.catalog; persistState(r.state);
    for (const t of catalog.tables) if (prevCounts[t.name] === undefined) prevCounts[t.name] = 0;
    renderTree(prevCounts); renderTx();
    await playTrace(r, { speed: stepMode ? stepSpeed : animMode, manual: !!stepMode, counts: prevCounts });
    for (const x of lastRun.results) if (x.error && x.error.line) errLines.set(x.error.line, x.error.code + ': ' + x.error.message);
    renderTree(); paint();
    if (selected && catalog) refreshSelected();
    return;
  }
  if (r.aborted) { lastRun = { results: [{ line: firstLine, text: sql.trim().split('\n')[0], error: { code: 'ABBRUCH', message: 'Die Ausführung wurde gestoppt. Änderungen der laufenden Anweisung wurden verworfen.', stack: [], line: null } }], ms: 0 }; }
  else if (r.fatal) { lastRun = { results: [{ line: firstLine, text: '', error: { code: 'INTERN', message: 'Interner Fehler der Sandbox: ' + r.fatal.split('\n')[0], stack: [], line: null } }], ms: 0 }; }
  else { lastRun = r; catalog = r.catalog; persistState(r.state); renderTree(); renderTx(); }
  for (const x of lastRun.results) if (x.error && x.error.line) errLines.set(x.error.line, x.error.code + ': ' + x.error.message);
  paint();
  showOut('out');
  if (!r.aborted && !r.fatal) { if (!lastRun.results.some(x => x.error) && !RM && animMode !== 'aus') celebrate({ steps: 0 }); else renderSummary(); }
  if (selected && catalog) refreshSelected();
}
$('#stepBtn').onclick = (ev) => run(ev.shiftKey ? 'all' : 'stmt', true);
$('#runStmt').onclick = () => run('stmt');
$('#runAll').onclick = () => run('all');
$('#stopBtn').onclick = stopRun;
$('#txCommit').onclick = () => quickRun('COMMIT;');
$('#txRollback').onclick = () => quickRun('ROLLBACK;');
async function quickRun(sql) {
  if (running) return;
  if (isRemote()) return remoteQuick(sql);
  running = true; const r = await call({ cmd: 'run', sql }); running = false;
  if (r.results) { lastRun = r; catalog = r.catalog; persistState(r.state); renderTree(); renderTx(); showOut('out'); if (selected) refreshSelected(); }
}

// ---------- Ausgabe ----------
function gridHTML(g, opt) {
  if (!g) return '';
  const head = '<tr><th class="rn">#</th>' + g.cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
  const body = g.rows.map((r, i) => '<tr><td class="rn">' + (i + 1) + '</td>' + r.map((v, k) => v === null ? '<td class="nul">(null)</td>' : '<td' + (g.kinds[k] === 'num' ? ' class="num"' : '') + ' title="' + esc(v.length > 40 ? v : '') + '">' + esc(v) + '</td>').join('') + '</tr>').join('');
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  gridStore.set(id, g);
  return '<div class="gridwrap"><table class="grid">' + head + body + '</table></div>' +
    '<div class="gridfoot">' + (g.total > g.rows.length ? 'Angezeigt: ' + g.rows.length + ' von ' + g.total + ' Zeilen · ' : '') + (g.rows.length ? '<button class="mini" data-copy="' + id + '">Als Tabelle kopieren</button>' : '') + '</div>';
}
const gridStore = new Map();
function errHTML(e) {
  return '<div class="oerr"><div><span class="code">' + esc(e.code) + '</span> <span class="em">' + esc(e.message) + '</span></div>' +
    (e.stack && e.stack.length ? '<div class="stk">' + esc(e.stack.join('\n')) + '</div>' : '') +
    (e.hint ? '<div class="hint"><b>Tipp</b><span>' + esc(e.hint) + '</span></div>' : '') + '</div>';
}
function resHTML(r) {
  const first = (r.text || '').split('\n').find(l => l.trim()) || '';
  let h = '<article class="res' + (r.error ? ' bad' : '') + '"><header>' + (r.file ? '<span class="ln" style="text-decoration:none">' + esc(r.file) + ' · Z. ' + r.line + '</span>' : '<button class="ln" data-line="' + r.line + '">Z. ' + r.line + '</button>') + '<code>' + esc(first.trim().slice(0, 140)) + '</code></header><div class="rb">';
  if (r.output && r.output.length) h += '<div class="console">' + esc(r.output.join('\n')) + '</div>';
  if (r.caption) h += '<div class="msg">' + esc(r.caption) + '</div>';
  if (r.grid) h += gridHTML(r.grid);
  if (r.implicit) for (const g of r.implicit) h += gridHTML(g);
  if (r.msg) h += r.plain ? '<div class="prompt">' + esc(r.msg) + '</div>' : '<div class="msg">' + ICON.ok + esc(r.msg) + '</div>';
  if (r.error) h += errHTML(r.error);
  return h + '</div></article>';
}
function renderOut() {
  gridStore.clear();
  if (!lastRun) {
    outBody.innerHTML = '<div class="welcome"><h3>Bereit.</h3>Setze den Cursor in eine Anweisung und drücke <b>Strg+Enter</b> – oder führe mit <b>F5</b> das ganze Skript aus. Links im Objekt-Browser siehst du jede Tabelle, View, Prozedur und jeden Trigger; ein Klick zeigt Inhalt und Definition.' +
      '<div class="keys"><span>Strg+Enter</span><span>Anweisung unter dem Cursor bzw. Markierung</span><span>F5</span><span>ganzes Skript</span><span>/</span><span>eigene Zeile nach jedem PL/SQL-Block, jeder Prozedur, jedem Trigger</span><span>Strg+/</span><span>Zeilen aus- und einkommentieren</span><span>Strg+Shift+F</span><span>formatieren (Markierung oder ganzes Blatt)</span><span>Doppelklick</span><span>auf einen Blatt-Reiter benennt ihn um</span></div>' +
      (isRemote() ? 'Verbunden mit <b>' + esc(remoteCfg().label) + '</b> – Anweisungen laufen direkt auf dem Server.' : 'Das Beispielschema (STUDIENGANG, STUDIERENDE, zwei Views, Funktion, Prozedur, Trigger) ist schon geladen.') + ' Weitere Skripte findest du unter <b>Beispiele</b>, die Syntax im <b>Spickzettel</b>.</div>';
    $('#summary').textContent = '';
    return;
  }
  const res = lastRun.results.filter(r => !r.silent || r.error);
  renderSummary();
  let h = '';
  if (lastRun.files) h += '<div class="hidden-note">' + ICON.ok + '<span>Import: ' + lastRun.files.map(f => esc(f.name) + ' – ' + f.total.toLocaleString('de-DE') + ' Anweisungen' + (f.errors ? ', <b style="color:var(--err)">' + f.errors + ' Fehler</b>' : ', fehlerfrei')).join(' · ') + '</span></div>';
  if (lastRun.hidden) h += '<div class="hidden-note">' + ICON.ok + '<span>' + lastRun.hidden.toLocaleString('de-DE') + ' erfolgreiche Anweisungen ohne Ausgabe ausgeblendet' + (res.length ? ' – unten folgen nur Fehler, Ergebnisse und Ausgaben.' : '.') + '</span></div>';
  for (const r of res.slice(0, 400)) h += resHTML(r);
  outBody.innerHTML = h || '<div class="welcome">Keine Ausgabe.</div>';
  const firstErr = outBody.querySelector('.res.bad');
  if (firstErr && res.length > 1) firstErr.scrollIntoView({ block: 'nearest' }); else outBody.scrollTop = 0;
}
outBody.addEventListener('click', ev => {
  const ln = ev.target.closest('[data-line]'); if (ln) { gotoLine(+ln.dataset.line); return; }
  const cp = ev.target.closest('[data-copy]');
  if (cp) { const g = gridStore.get(cp.dataset.copy); if (g) copyText([g.cols.join('\t')].concat(g.rows.map(r => r.map(v => v === null ? '' : v).join('\t'))).join('\n'), 'Tabelle kopiert – lässt sich in Excel einfügen.'); return; }
  const act = ev.target.closest('[data-act]'); if (act) objAction(act.dataset.act);
});
function gotoLine(l, col) {
  const text = ta.value; let pos = 0; for (let i = 1; i < l; i++) { const k = text.indexOf('\n', pos); if (k < 0) break; pos = k + 1; }
  if (col) { const le = text.indexOf('\n', pos); pos = Math.min(pos + col - 1, le < 0 ? text.length : le); }
  ta.focus(); ta.setSelectionRange(pos, pos);
  const lh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 21;
  ta.scrollTop = Math.max(0, (l - 4) * lh); sync();
}
function showOut(which) {
  outTab = which;
  $('#tabOut').classList.toggle('act', which === 'out'); $('#tabObj').classList.toggle('act', which === 'obj');
  if (which === 'out') renderOut(); else renderDetail();
}
$('#tabOut').onclick = () => showOut('out');
$('#tabObj').onclick = () => showOut('obj');

// ---------- Objekt-Browser ----------
const GROUPS = [
  ['tables', 'Tabellen'], ['views', 'Views'], ['seqs', 'Sequenzen'], ['PROCEDURE', 'Prozeduren'], ['FUNCTION', 'Funktionen'],
  ['pkgs', 'Packages'], ['triggers', 'Trigger'], ['types', 'Typen'], ['indexes', 'Indizes'],
];
const openGroups = new Set(JSON.parse(LS.get('orasim.groups') || '["tables","views","PROCEDURE","FUNCTION","triggers","pkgs","seqs"]'));
function groupItems(key) {
  if (!catalog) return [];
  if (key === 'PROCEDURE' || key === 'FUNCTION') return catalog.procs.filter(p => p.kind === key).map(p => ({ kind: 'proc', name: p.name, meta: '' }));
  const map = { tables: x => { const c = treeCounts && treeCounts[x.name] !== undefined ? treeCounts[x.name] : x.count; return { kind: 'table', name: x.name, meta: c === null || c === undefined ? '' : c + (c === 1 ? ' Zeile' : ' Zeilen') }; }, views: x => ({ kind: 'view', name: x.name, meta: x.error ? '<span class="off">Fehler</span>' : x.count === null || x.count === undefined ? '' : x.count + ' Z.' }), seqs: x => ({ kind: 'seq', name: x.name, meta: 'nächster ' + x.next }), pkgs: x => ({ kind: 'pkg', name: x.name, meta: x.hasBody ? '' : 'ohne Body' }), triggers: x => ({ kind: 'trigger', name: x.name, meta: x.enabled ? x.table : '<span class="off">aus</span>' }), types: x => ({ kind: 'type', name: x.name, meta: '' }), indexes: x => ({ kind: 'index', name: x.name, meta: x.table }) };
  return catalog[key].map(map[key]);
}
function renderTree(countsOverride) {
  treeCounts = countsOverride || null;
  const q = $('#objSearch').value.trim().toUpperCase();
  let h = '';
  for (const [key, label] of GROUPS) {
    let items = groupItems(key);
    if (q) items = items.filter(i => i.name.includes(q));
    if (!items.length && (key === 'types' || key === 'indexes' || key === 'pkgs' || q)) continue;
    h += '<details class="grp" data-g="' + key + '"' + (openGroups.has(key) || q ? ' open' : '') + '><summary>' + ICON.chev + label + '<span class="n">' + items.length + '</span></summary>';
    h += items.length ? items.map(i => '<button class="obj' + (selected && selected.kind === i.kind && selected.name === i.name ? ' sel' : '') + '" data-kind="' + i.kind + '" data-name="' + esc(i.name) + '"><span class="nm">' + esc(i.name) + '</span><span class="meta">' + i.meta + '</span></button>').join('') : '<div class="empty">keine</div>';
    h += '</details>';
  }
  $('#objTree').innerHTML = h;
}
$('#objTree').addEventListener('toggle', ev => { const d = ev.target; if (!d.dataset || !d.dataset.g) return; if (d.open) openGroups.add(d.dataset.g); else openGroups.delete(d.dataset.g); LS.set('orasim.groups', JSON.stringify(Array.from(openGroups))); }, true);
$('#objTree').addEventListener('click', ev => {
  const b = ev.target.closest('.obj'); if (!b) return;
  selected = { kind: b.dataset.kind, name: b.dataset.name };
  $('#tabObj').hidden = false; $('#tabObj').textContent = b.dataset.name;
  renderTree(); showOut('obj');
  work.classList.remove('side-open');
  if (isRemote()) { const sel = selected; remoteLoadDetail(sel).then(() => { if (selected === sel && outTab === 'obj') renderDetail(); }); }
});
$('#objSearch').addEventListener('input', renderTree);
function findObj(sel) {
  if (!catalog || !sel) return null;
  const k = sel.kind;
  const list = k === 'table' ? catalog.tables : k === 'view' ? catalog.views : k === 'seq' ? catalog.seqs : k === 'proc' ? catalog.procs : k === 'pkg' ? catalog.pkgs : k === 'trigger' ? catalog.triggers : k === 'type' ? catalog.types : catalog.indexes;
  return list.find(x => x.name === sel.name) || null;
}
function refreshSelected() { if (!findObj(selected)) { selected = null; $('#tabObj').hidden = true; if (outTab === 'obj') showOut('out'); return; } if (outTab === 'obj') renderDetail(); }
function srcHTML(t) { return '<pre class="src">' + hlHTML(t || '') + '</pre>'; }
function renderDetail() {
  gridStore.clear();
  const o = findObj(selected);
  if (!o) { outBody.innerHTML = '<div class="welcome">Das Objekt existiert nicht mehr.</div>'; $('#summary').textContent = ''; return; }
  const k = selected.kind; let h = '<div class="det">';
  if (o.remote && !o.loaded) { outBody.innerHTML = o.loadError ? '<div class="oerr"><div>' + esc(o.loadError) + '</div></div>' : '<div class="welcome"><span class="running"><span class="spin"></span>Details werden vom Server geladen …</span></div>'; $('#summary').textContent = ''; return; }
  $('#summary').textContent = '';
  if (k === 'table') {
    h += '<h3>' + esc(o.name) + '</h3><div class="sub">Tabelle · ' + o.count + (o.count === 1 ? ' Zeile' : ' Zeilen') + ' · ' + o.cols.length + ' Spalten' + (o.triggers.length ? ' · Trigger: ' + esc(o.triggers.join(', ')) : '') + '</div>';
    h += '<div class="acts"><button class="mini" data-act="select">SELECT * einfügen</button><button class="mini" data-act="insert">INSERT-Vorlage einfügen</button><button class="mini" data-act="ddl">CREATE TABLE in neues Blatt</button></div>';
    h += '<h4>Daten</h4>' + (o.preview.rows.length ? gridHTML(o.preview) : '<div class="msg">Die Tabelle ist leer.</div>');
    h += '<h4>Spalten</h4><div class="gridwrap"><table class="grid"><tr><th>Spalte</th><th>Typ</th><th>Null?</th><th>Default</th><th>Schlüssel</th></tr>' +
      o.cols.map(c => '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.type) + '</td><td>' + (c.nn ? 'NOT NULL' : '') + '</td><td>' + esc(c.def || '') + '</td><td>' + (c.pk ? '<span class="badge pk">PK</span>' : '') + (c.fk ? '<span class="badge fk">FK → ' + esc(c.fk) + '</span>' : '') + '</td></tr>').join('') + '</table></div>';
    if (o.cons.length) h += '<h4>Constraints</h4><div class="gridwrap"><table class="grid"><tr><th>Name</th><th>Typ</th><th>Spalten</th><th>Details</th><th>Status</th></tr>' +
      o.cons.map(c => '<tr><td>' + esc(c.name) + '</td><td>' + ({ P: 'PRIMARY KEY', U: 'UNIQUE', R: 'FOREIGN KEY', C: 'CHECK' }[c.type]) + '</td><td>' + esc(c.cols.join(', ')) + '</td><td>' + esc(c.ref ? '→ ' + c.ref + (c.onDelete ? ' ON DELETE ' + c.onDelete : '') : (c.check || '')) + '</td><td>' + (c.enabled ? 'aktiv' : 'deaktiviert') + '</td></tr>').join('') + '</table></div>';
    h += '<h4>Definition</h4>' + srcHTML(o.ddl);
  } else if (k === 'view') {
    h += '<h3>' + esc(o.name) + '</h3><div class="sub">View' + (o.preview ? ' · ' + o.count + (o.count === 1 ? ' Zeile' : ' Zeilen') : '') + '</div>';
    h += '<div class="acts"><button class="mini" data-act="select">SELECT * einfügen</button><button class="mini" data-act="src">Definition in neues Blatt</button></div>';
    h += '<h4>Daten</h4>' + (o.error ? '<div class="errline">' + esc(o.error) + '</div>' : (o.preview.rows.length ? gridHTML(o.preview) : '<div class="msg">Die View liefert keine Zeilen.</div>'));
    h += '<h4>Definition</h4>' + srcHTML(o.text);
  } else if (k === 'seq') {
    h += '<h3>' + esc(o.name) + '</h3><div class="sub">Sequenz · nächster Wert ' + o.next + ' · Schrittweite ' + o.inc + (o.curr !== null ? ' · CURRVAL in dieser Session ' + o.curr : '') + '</div>';
    h += '<div class="acts"><button class="mini" data-act="nextval">NEXTVAL-Abfrage einfügen</button></div><h4>Definition</h4>' + srcHTML(o.text);
  } else if (k === 'index') {
    h += '<h3>' + esc(o.name) + '</h3><div class="sub">' + (o.unique ? 'Eindeutiger Index' : 'Index') + ' auf ' + esc(o.table) + ' (' + esc(o.cols.join(', ')) + ')</div>';
    h += srcHTML('CREATE ' + (o.unique ? 'UNIQUE ' : '') + 'INDEX ' + o.name.toLowerCase() + ' ON ' + o.table.toLowerCase() + ' (' + o.cols.join(', ').toLowerCase() + ');');
  } else {
    const label = { proc: o.kind === 'FUNCTION' ? 'Funktion' : 'Prozedur', pkg: 'Package', trigger: 'Trigger', type: 'Typ' }[k];
    const sub = k === 'proc' ? esc(o.sig) : k === 'trigger' ? esc(o.desc) + ' auf ' + esc(o.table) + (o.enabled ? '' : ' · deaktiviert') : k === 'pkg' ? (o.hasBody ? 'Spezifikation und Body' : 'nur Spezifikation') : '';
    h += '<h3>' + esc(o.name) + '</h3><div class="sub">' + label + (sub ? ' · ' + sub : '') + '</div>';
    h += '<div class="acts"><button class="mini" data-act="src">Quelltext in neues Blatt</button>' + (k === 'proc' ? '<button class="mini" data-act="call">Aufruf einfügen</button>' : '') + '</div>';
    if (k === 'pkg') h += '<h4>Inhalt der Spezifikation</h4><div class="msg" style="flex-wrap:wrap;gap:4px 12px;font-family:var(--mono);font-size:13px">' + o.members.map(esc).join('<br>') + '</div>';
    h += '<h4>Quelltext</h4>' + srcHTML(o.text);
  }
  outBody.innerHTML = h + '</div>';
  outBody.scrollTop = 0;
}
function objAction(a) {
  const o = findObj(selected); if (!o) return;
  const n = o.name.toLowerCase();
  if (a === 'select') { insertText('SELECT * FROM ' + n + ';\n'); }
  else if (a === 'insert') { insertText('INSERT INTO ' + n + ' (' + o.cols.map(c => c.name.toLowerCase()).join(', ') + ')\nVALUES (' + o.cols.map(() => 'NULL').join(', ') + ');\n'); }
  else if (a === 'ddl') addSheet(o.name, o.ddl + '\n');
  else if (a === 'src') { const t = o.text.trim(); addSheet(o.name, selected.kind === 'view' ? t.replace(/;?\s*$/, ';') + '\n' : t + '\n/\n'); }
  else if (a === 'nextval') insertText('SELECT ' + n + '.NEXTVAL FROM dual;\n');
  else if (a === 'call') {
    const args = (o.sig.match(/^\((.*)\)/) || ['', ''])[1];
    const names = args ? args.split(',').map(x => x.trim().split(' ')[0] + ' => ') : [];
    insertText(o.kind === 'FUNCTION' ? 'SELECT ' + n + '(' + names.map(x => x + 'NULL').join(', ') + ') FROM dual;\n' : 'EXEC ' + n + '(' + names.map(x => x + 'NULL').join(', ') + ');\n');
  }
}
function renderTx() {
  const tx = catalog && catalog.tx; const b = $('#txBadge');
  b.hidden = !(tx && tx.open);
  if (tx && tx.open) { const t = tx.tables.length ? 'Offen: ' + tx.tables.join(', ') : 'Offene Transaktion'; $('#txText').textContent = t; b.title = t + ' – noch nicht mit COMMIT bestätigt'; }
  fitBar();
}
// Kopfzeile verdichten statt umbrechen
function fitBar() {
  const bar = $('.bar'); if (!bar) return;
  bar.classList.remove('c1', 'c2', 'c3', 'c4');
  for (const c of ['c1', 'c2', 'c3', 'c4']) { if (bar.scrollWidth <= bar.clientWidth + 1) break; bar.classList.add(c); }
}
if (window.ResizeObserver) new ResizeObserver(() => fitBar()).observe(document.documentElement); else addEventListener('resize', fitBar);

// ---------- Spickzettel ----------
function renderCheat() {
  const q = $('#cheatSearch').value.trim().toLowerCase();
  let h = '';
  CHEAT.forEach(([sec, items], si) => {
    const hits = items.filter(([t, c, d]) => !q || (sec + ' ' + t + ' ' + c + ' ' + (d || '')).toLowerCase().includes(q));
    if (!hits.length) return;
    h += '<details class="cs"' + (q || si < 2 ? ' open' : '') + '><summary>' + ICON.chev + esc(sec) + '</summary>';
    for (const [t, c, d] of hits) {
      const id = items.indexOf(hits.find(x => x[0] === t));
      h += '<div class="ci"><div class="h"><span>' + esc(t) + '</span><button class="mini" data-ins="' + si + ':' + id + '">Einfügen</button><button class="mini" data-cp="' + si + ':' + id + '">Kopieren</button></div><pre>' + hlHTML(c) + '</pre>' + (d ? '<p>' + esc(d) + '</p>' : '') + '</div>';
    }
    h += '</details>';
  });
  $('#cheatBody').innerHTML = h || '<div class="empty" style="padding:12px 14px">Nichts gefunden.</div>';
}
$('#cheatBody').addEventListener('click', ev => {
  const b = ev.target.closest('[data-ins],[data-cp]'); if (!b) return;
  const [s, i] = (b.dataset.ins || b.dataset.cp).split(':').map(Number);
  const code = CHEAT[s][1][i][1];
  if (b.dataset.ins) { insertText(code + '\n'); if (innerWidth <= 1180) setCheat(false); toast('Eingefügt.'); }
  else copyText(code, 'Kopiert.');
});
$('#cheatSearch').addEventListener('input', renderCheat);
function setCheat(on) {
  work.classList.toggle('cheat-open', on); $('#cheatBtn').classList.toggle('on', on); $('#cheatBtn').setAttribute('aria-pressed', on);
  LS.set('orasim.cheat', on ? '1' : '0');
}
$('#cheatBtn').onclick = () => setCheat(!work.classList.contains('cheat-open'));
$('#cheatClose').onclick = () => setCheat(false);
$('#scrimC').onclick = () => setCheat(false);
$('#sideBtn').onclick = () => work.classList.add('side-open');
$('#sideClose').onclick = () => work.classList.remove('side-open');
$('#scrimS').onclick = () => work.classList.remove('side-open');

// ---------- Menüs, Dialoge ----------
const pop = $('#pop');
function openPop(anchor, html, onClick) {
  if (!pop.hidden && popAnchor === anchor) { closePop(); return; }
  popAnchor = anchor;
  pop.innerHTML = html; pop.hidden = false;
  const r = anchor.getBoundingClientRect(); const w = pop.offsetWidth;
  pop.style.top = (r.bottom + 6) + 'px'; pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.onclick = ev => { const b = ev.target.closest('button[data-v]'); if (!b) return; if (b.dataset.keep !== undefined) { onClick(b.dataset.v, b); return; } closePop(); onClick(b.dataset.v, b); };
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
}
let popAnchor = null;
function outside(ev) { if (pop.contains(ev.target) || (popAnchor && popAnchor.contains(ev.target))) return; closePop(); }
function closePop() { pop.hidden = true; popAnchor = null; document.removeEventListener('pointerdown', outside); }
$('#exBtn').onclick = (ev) => openPop(ev.currentTarget, EXAMPLES.map((e, i) => '<button data-v="' + i + '">' + esc(e.name) + '</button>').join('') + '', v => {
  addSheet(EXAMPLES[+v].name, EXAMPLES[+v].sql);
});
const seg = (key, cur, opts) => '<div class="seg">' + opts.map(([v, n]) => '<button data-keep data-v="' + key + ':' + v + '"' + (v === cur ? ' class="on"' : '') + '>' + n + '</button>').join('') + '</div>';
function menuHTML() {
  const fs = parseFloat(LS.get('orasim.fs') || '14');
  return '<button data-v="export">Als SQL exportieren<small>CREATE- und INSERT-Skript zum Sichern</small></button>' +
    '<button data-v="open">SQL-Datei öffnen<small>.sql-Datei in ein neues Blatt laden</small></button><hr>' +
  '<button data-v="import">Datenbank importieren<small>.sql-Dateien (Schema, Daten) direkt einspielen</small></button>' +
  '<button data-v="seed">Aktuelle Datenbank zurücksetzen<small>auf das Beispielschema STUDIENGANG/STUDIERENDE</small></button>' +
  '<button data-v="empty">Aktuelle Datenbank leeren<small>alle Objekte löschen</small></button>' +
  '<button data-v="factory">Alles zurücksetzen<small>alle Datenbanken, Blätter und Einstellungen – Auslieferungszustand</small></button><hr>' +
    '<div class="lab">Editor</div>' +
    '<button data-keep data-v="lint">Live-Syntaxprüfung<span class="tog' + (lintOn ? ' on' : '') + '"></span></button>' +
    '<div class="lab2">Schlüsselwörter beim Formatieren</div>' + seg('case', caseMode, [['upper', 'GROSS'], ['lower', 'klein'], ['keep', 'wie getippt']]) +
    '<div class="lab2">Schriftgröße</div><div class="seg"><button data-keep data-v="font-">A−</button><button class="val" data-keep data-v="font0">' + fs + ' px</button><button data-keep data-v="font+">A+</button></div>' +
    '<div class="lab">Animation</div>' +
    '<div class="lab2">Beim Ausführen (F5, Strg+Enter)</div>' + seg('anim', animMode, [['turbo', 'Turbo'], ['schnell', 'Schnell'], ['aus', 'Aus']]) +
    '<div class="lab2">Schrittmodus (F8)</div>' + seg('step', stepSpeed, SPEEDS.slice().reverse());
}
$('#menuBtn').onclick = (ev) => openPop(ev.currentTarget, menuHTML(), (v, btn) => {
  const keep = btn && btn.dataset.keep !== undefined;
  if (keep) {
    const [k, val] = v.split(':');
    if (k === 'lint') setLint(!lintOn);
    else if (k === 'case') { caseMode = val; LS.set('orasim.case', caseMode); }
    else if (k === 'anim') { animMode = val; LS.set('orasim.anim', animMode); }
    else if (k === 'step') { stepSpeed = val; LS.set('orasim.stepSpeed', stepSpeed); if (PL && PL.manual) setSpeed(val); }
    else if (k === 'font+' || k === 'font-' || k === 'font0') { const cur = parseFloat(LS.get('orasim.fs') || '14'); setFont(k === 'font0' ? 14 : Math.max(11, Math.min(22, cur + (k === 'font+' ? 1 : -1)))); }
    const st = pop.scrollTop; pop.innerHTML = menuHTML(); pop.scrollTop = st;
    return;
  }
  if (isRemote() && (v === 'export' || v === 'seed' || v === 'empty')) { toast('Das geht nur mit Datenbanken der Simulation – nicht auf dem externen Server.'); return; }
  if (v === 'export') doExport();
  else if (v === 'import') $('#importIn').click();
  else if (v === 'open') $('#fileIn').click();
  else if (v === 'seed') confirmBox('Beispielschema neu laden?', 'Alle Tabellen, Views, Prozeduren und Daten werden gelöscht und durch das Beispielschema ersetzt. Deine Arbeitsblätter bleiben erhalten.', 'Zurücksetzen', () => reset(true));
  else if (v === 'factory') confirmBox('Alles zurücksetzen?', 'Sämtliche Datenbanken, Arbeitsblätter und Einstellungen in diesem Browser werden gelöscht. Vorher am besten „Als SQL exportieren“.', 'Alles löschen', factoryReset);
  else if (v === 'empty') confirmBox('Datenbank leeren?', 'Alle Objekte und Daten werden gelöscht. Deine Arbeitsblätter bleiben erhalten.', 'Leeren', () => reset(false));
});
const SKINS = [['tiefsee', 'Tiefsee', '#0b1622', '#4fd6e8', '#f5cd8f'], ['pflaume', 'Pflaume', '#1a0f1f', '#ff8fa3', '#ffcaa6'], ['graphit', 'Graphit', '#16171a', '#ff9e45', '#9ccf8a'], ['mitternacht', 'Mitternacht', '#0d0b14', '#a78bfa', '#f0abfc'], ['papier', 'Papier – hell, gut für den Beamer', '#ffffff', '#0a66c2', '#a6410f'], ['sand', 'Sand – hell und warm', '#fbf7f0', '#b5541c', '#8a5a00'], ['kontrast', 'Hochkontrast', '#000000', '#ffe600', '#7cf5ff']];
function setSkin(k) { if (!SKINS.some(x => x[0] === k)) k = 'graphit'; document.documentElement.setAttribute('data-skin', k); LS.set('orasim.skin', k); }
$('#skinBtn').onclick = (ev) => { const curSkin = document.documentElement.getAttribute('data-skin'); openPop(ev.currentTarget, '<div class="lab">Farbschema</div>' + SKINS.map(([k, n, a, b, c]) => '<button data-v="' + k + '"' + (k === curSkin ? ' class="cur"' : '') + '><span class="sw"><i style="background:' + a + '"></i><i style="background:' + b + '"></i><i style="background:' + c + '"></i></span>' + esc(n) + (k === curSkin ? '<span class="chk">✓</span>' : '') + '</button>').join(''), v => setSkin(v)); };
function setFont(px) { document.documentElement.style.setProperty('--fs', px + 'px'); document.documentElement.style.setProperty('--lh', Math.round(px * 1.5) + 'px'); LS.set('orasim.fs', String(px)); schedulePaint(); }
async function reset(seed) {
  if (running) stopRun();
  const r = await call({ cmd: 'reset', seed: seed ? SEED_SQL : null });
  catalog = r.catalog; persistState(r.state); selected = null; $('#tabObj').hidden = true; lastRun = null;
  renderTree(); renderTx(); showOut('out'); toast(seed ? 'Beispielschema geladen.' : 'Datenbank geleert.');
}
async function doExport() {
  const r = await call({ cmd: 'export' });
  modal('<h3>Export als SQL</h3><p>Dieses Skript legt alle Objekte und Daten neu an. Kopiere es in eine .sql-Datei – über „SQL-Datei öffnen“ und F5 stellst du alles wieder her.</p><textarea readonly id="expTa" aria-label="Export">' + esc(r.sql || '') + '</textarea><div class="row"><button class="btn" data-m="close">Schließen</button><button class="btn primary" data-m="copy">Kopieren</button></div>', v => {
    if (v === 'copy') copyText($('#expTa').value, 'Export kopiert.'); else closeModal();
  });
}
$('#fileIn').addEventListener('change', ev => {
  const f = ev.target.files[0]; if (!f) return;
  if (f.size > 300000) { ev.target.value = ''; confirmBox('Große Datei (' + fmtSize(f.size) + ')', 'So große Skripte importierst du besser direkt als Datenbank, statt sie im Editor zu öffnen.', 'Importieren', () => importFiles([f])); return; }
  const rd = new FileReader(); rd.onload = () => { addSheet(f.name.replace(/\.[^.]+$/, ''), String(rd.result)); toast('Datei geladen – mit F5 ausführen.'); }; rd.readAsText(f);
  ev.target.value = '';
});
function modal(html, onClick) {
  const m = $('#modal'); $('#dlg').innerHTML = html; m.hidden = false;
  $('#dlg').onclick = ev => { const b = ev.target.closest('[data-m]'); if (b) onClick(b.dataset.m); };
  m.onclick = ev => { if (ev.target === m) closeModal(); };
  const f = $('#dlg').querySelector('.primary'); if (f) f.focus();
}
function closeModal() { $('#modal').hidden = true; ta.focus(); }
async function factoryReset() {
  LS.set = () => false; KV.set = async () => false;   // ausstehende Speicher-Timer dürfen nichts zurückschreiben
  try { clearTimeout(saveTimer); } catch (e) { }
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('orasim.')) localStorage.removeItem(k); } catch (e) { }
  try { const ids = (dbList || []).map(d => d.id); for (const id of ids) await KV.del('db:' + id); } catch (e) { }
  try { indexedDB.deleteDatabase('orasim'); } catch (e) { }
  location.reload();
}
function confirmBox(title, text, okLabel, fn) {
  modal('<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p><div class="row"><button class="btn" data-m="no">Abbrechen</button><button class="btn primary" data-m="ok">' + esc(okLabel) + '</button></div>', v => { closeModal(); if (v === 'ok') fn(); });
}
let toastT = null;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2600); }
function copyText(t, msg) {
  const ok = () => toast(msg || 'Kopiert.');
  try { navigator.clipboard.writeText(t).then(ok, () => fallbackCopy(t, ok)); } catch (e) { fallbackCopy(t, ok); }
}
function fallbackCopy(t, ok) { const x = document.createElement('textarea'); x.value = t; document.body.appendChild(x); x.select(); try { document.execCommand('copy'); ok(); } catch (e) { toast('Kopieren nicht möglich – bitte manuell markieren.'); } x.remove(); }

// ---------- Teiler ----------
(() => {
  const sp = $('#split'), center = $('.center');
  let drag = null;
  sp.addEventListener('pointerdown', ev => { drag = { y: ev.clientY, h: $('#ed').getBoundingClientRect().height }; sp.setPointerCapture(ev.pointerId); });
  sp.addEventListener('pointermove', ev => {
    if (!drag) return;
    const total = center.getBoundingClientRect().height - 46;
    const h = Math.max(120, Math.min(total - 120, drag.h + ev.clientY - drag.y));
    center.style.setProperty('--edH', h + 'px');
  });
  sp.addEventListener('pointerup', () => { if (drag) LS.set('orasim.edH', center.style.getPropertyValue('--edH')); drag = null; });
  const saved = LS.get('orasim.edH'); if (saved) center.style.setProperty('--edH', saved);
})();

/*PLAYER*/
/*DBMGR*/
/*REMOTE*/
// ---------- Start ----------
function start(data) {
  data = data || {};
  if (!LS.set('orasim.probe', '1')) $('#sideFoot').textContent = 'Dieser Browser erlaubt hier kein lokales Speichern – nach dem Neuladen ist alles weg. Sichere deine Arbeit über Menü → Als SQL exportieren.';
  let sh = data.sheets ? { sheets: data.sheets, activeId: data.activeId } : null;
  if (!sh) { try { sh = JSON.parse(LS.get('orasim.sheets') || 'null'); } catch (e) { sh = null; } }
  if (sh && sh.sheets && sh.sheets.length) { sheets = sh.sheets; activeId = sh.activeId && sheets.some(s => s.id === sh.activeId) ? sh.activeId : sheets[0].id; }
  else { sheets = [{ id: newId(), name: 'Blatt 1', text: START_SHEET }]; activeId = sheets[0].id; }
  const fs = LS.get('orasim.fs'); if (fs) setFont(+fs);
  setSkin(LS.get('orasim.skin') || 'graphit');
  setCheat(LS.get('orasim.cheat') === '1' && innerWidth > 1180);
  renderCheat();
  openSheet(activeId);
  showOut('out');
  worker = makeWorker();
  bootDbs();
  if (window.claude && window.claude.hot && window.claude.hot.snapshot) window.claude.hot.snapshot(() => ({ sheets, activeId }));
  ta.focus();
}
if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start); else start((window.claude && window.claude.hot && window.claude.hot.data) || {});
}
