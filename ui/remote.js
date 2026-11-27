// ---------- Externer Oracle-Server (Brücke: Oracle Net/ODBC, oder ORDS REST) ----------
const RX = { busy: false, ctrl: null, txTables: new Set(), lastStatus: null };
function remoteCfg() { const m = dbList.find(d => d.id === activeDb); return m && m.remote ? m.remote : null; }
function isRemote() { return !!remoteCfg(); }
const sqlLit = s => "'" + String(s).replace(/'/g, "''") + "'";
const qid = s => '"' + String(s).replace(/"/g, '""') + '"';

// Skript in Anweisungen zerlegen – tolerant, ohne den Simulations-Parser (der kennt nicht jede Oracle-Syntax)
function splitScript(src) {
  const out = []; const n = src.length; let i = 0;
  const lineAt = (() => { const nl = []; for (let k = 0; k < n; k++) if (src.charCodeAt(k) === 10) nl.push(k); return p => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < p) lo = m + 1; else hi = m; } return lo + 1; }; })();
  const slashLine = p => { // steht an p (Zeilenanfang) eine Zeile nur mit "/"?
    let k = p; while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    if (src[k] !== '/') return -1; k++;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) k++;
    return (k >= n || src[k] === '\n') ? k : -1;
  };
  const skipQuoted = (k) => { // k zeigt auf ' bzw. q' bzw. "
    if ((src[k] === 'q' || src[k] === 'Q') && src[k + 1] === "'") {
      const open = src[k + 2]; const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] || open;
      const e = src.indexOf(close + "'", k + 3); return e < 0 ? n : e + 2;
    }
    const qch = src[k]; k++;
    while (k < n) { if (src[k] === qch) { if (src[k + 1] === qch) { k += 2; continue; } return k + 1; } k++; }
    return n;
  };
  while (i < n) {
    // Leerraum, Kommentare und einzelne "/"-Zeilen zwischen Anweisungen überspringen
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { const e = src.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    const ls = src.lastIndexOf('\n', i - 1) + 1;
    if (c === '/' && /^\s*$/.test(src.slice(ls, i))) { const e = slashLine(ls); if (e >= 0) { i = e + 1; continue; } }
    const start = i; const head = src.slice(i, i + 160).replace(/\s+/g, ' ').toUpperCase();
    let kind = 'sql';
    if (/^(DECLARE|BEGIN)\b/.test(head) || /^CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY|JAVA)\b/.test(head)) kind = 'plsql';
    else if (/^(DESC|DESCRIBE|EXEC|EXECUTE|PROMPT|SHOW|SHO|SPOOL|CONN|CONNECT|DEFINE|UNDEFINE|COLUMN|COL|TTITLE|BTITLE|BREAK|CLEAR|WHENEVER|PAUSE|ACCEPT|HOST|REM|REMARK)\b|^@/.test(head) || (/^SET\s/.test(head) && !/^SET\s+(TRANSACTION|ROLE|CONSTRAINTS?)\b/.test(head))) kind = 'cmd';
    let end = n, next = n;
    if (kind === 'cmd') { const e = src.indexOf('\n', i); end = e < 0 ? n : e; next = end; }
    else {
      let k = i; let atLineStart = false;
      while (k < n) {
        const ch = src[k];
        if (atLineStart) { const e = slashLine(k); if (e >= 0) { end = k; next = e; break; } atLineStart = false; }
        if (ch === '\n') { atLineStart = true; k++; continue; }
        if (ch === "'" || ch === '"' || ((ch === 'q' || ch === 'Q') && src[k + 1] === "'" && !/[\w$#]/.test(src[k - 1] || ''))) { k = skipQuoted(k); continue; }
        if (ch === '-' && src[k + 1] === '-') { const e = src.indexOf('\n', k); k = e < 0 ? n : e; continue; }
        if (ch === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k + 2); k = e < 0 ? n : e + 2; continue; }
        if (ch === ';' && kind === 'sql') { end = k; next = k + 1; break; }
        k++;
      }
      if (k >= n) { end = n; next = n; }
    }
    let text = src.slice(start, end).replace(/\s+$/, '');
    if (kind === 'cmd') text = text.replace(/;\s*$/, '');
    if (text) out.push({ text, kind, line: lineAt(start), start, end });
    i = Math.max(next, start + 1);
  }
  return out;
}

const PLOBJ = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PACKAGE\s+BODY|TYPE\s+BODY|PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\s+(?:"?[\w$#]+"?\s*\.\s*)?"?([A-Za-z][\w$#]*)"?/i;
// SQL*Plus-Befehle in echte Anweisungen übersetzen – oder lokal beantworten
function prepStatements(items) {
  return items.map(it => {
    const s = { text: it.text, kind: it.kind, line: it.line };
    if (it.kind === 'plsql') { const m = it.text.match(PLOBJ); if (m) s.obj = { type: m[1].toUpperCase().replace(/\s+/g, ' '), name: m[2].toUpperCase() }; }
    if (it.kind === 'cmd') {
      const t = it.text.trim(); let m;
      if ((m = t.match(/^EXEC(?:UTE)?\s+([\s\S]+)$/i))) return { text: 'BEGIN\n  ' + m[1].replace(/;\s*$/, '') + ';\nEND;', kind: 'plsql', line: it.line, label: t };
      if ((m = t.match(/^DESC(?:RIBE)?\s+(?:"?(\w+)"?\.)?"?([\w$#]+)"?\s*$/i))) return { text: 'SELECT column_name AS "Name", CASE nullable WHEN \'N\' THEN \'NOT NULL\' END AS "Null?", data_type || CASE WHEN data_type IN (\'VARCHAR2\',\'NVARCHAR2\',\'CHAR\',\'NCHAR\',\'RAW\') THEN \'(\' || data_length || \')\' WHEN data_type = \'NUMBER\' AND data_precision IS NOT NULL THEN \'(\' || data_precision || CASE WHEN data_scale > 0 THEN \',\' || data_scale END || \')\' END AS "Typ" FROM user_tab_columns WHERE table_name = ' + sqlLit(m[2].toUpperCase()) + ' ORDER BY column_id', kind: 'sql', line: it.line, label: t, desc: m[2].toUpperCase() };
      if ((m = t.match(/^PROMPT\s?([\s\S]*)$/i))) return { local: true, line: it.line, label: t, plain: m[1] };
      if (/^SET\s+SERVEROUT(PUT)?\s/i.test(t)) return { local: true, line: it.line, label: t, note: 'DBMS_OUTPUT wird immer angezeigt.' };
      return { local: true, line: it.line, label: t, note: 'SQL*Plus-Befehl – hier ohne Wirkung.' };
    }
    return s;
  });
}

// ---------- Transport ----------
async function bridgeFetch(cfg, path, body, signal) {
  let res;
  try {
    res = await fetch(cfg.url.replace(/\/+$/, '') + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'X-Token': cfg.token || '' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Keine Verbindung zur Brücke unter ' + cfg.url + '. Läuft „oracle_bruecke.py“?');
  }
  let j = null; try { j = await res.json(); } catch (e) { }
  if (res.status === 401) throw new Error((j && j.error) || 'Falscher Schlüssel.');
  if (res.status === 409) { const err = new Error((j && j.error) || 'Nicht verbunden.'); err.notConnected = true; throw err; }
  if (!j) throw new Error('Unerwartete Antwort der Brücke (HTTP ' + res.status + ').');
  return j;
}
async function ordsFetch(cfg, script, signal) {
  let res;
  const url = cfg.url.replace(/\/+$/, '').replace(/\/_\/sql$/, '') + '/_/sql';
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + btoa(unescape(encodeURIComponent(cfg.user + ':' + (cfg.pw || RX.pw || '')))) }, body: JSON.stringify({ statementText: script, limit: 500 }), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('ORDS unter ' + url + ' nicht erreichbar – Adresse und CORS-Freigabe (Allowed Origins) prüfen.');
  }
  if (res.status === 401) throw new Error('ORDS: Anmeldung abgelehnt (Benutzer/Passwort, oder Schema nicht REST-aktiviert).');
  let j = null; try { j = await res.json(); } catch (e) { }
  if (!res.ok || !j) throw new Error('ORDS antwortet mit HTTP ' + res.status + (j && j.message ? ': ' + j.message : '') + '.');
  return j;
}
function ordsScript(stmts) { // Anweisungsliste → SQL*Plus-Skript für ORDS
  return stmts.map(s => s.kind === 'plsql' ? s.text + '\n/' : s.text + ';').join('\n');
}
function ordsValue(v, type) {
  if (v === null || v === undefined) return [null, 'str'];
  if (typeof v === 'number') return [String(v), 'num'];
  if (typeof v === 'boolean') return [v ? '1' : '0', 'num'];
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v) && /DATE|TIMESTAMP/i.test(type || '')) {
    const d = v.slice(8, 10) + '.' + v.slice(5, 7) + '.' + v.slice(0, 4), t = v.slice(11, 19);
    return [t === '00:00:00' ? d : d + ' ' + t, 'str'];
  }
  if (typeof v === 'object') return [JSON.stringify(v), 'str'];
  return [String(v), /NUMBER|FLOAT|INTEGER|BINARY/i.test(type || '') ? 'num' : 'str'];
}
function fromOrds(j, lineShift) { // ORDS-Antwort → Brücken-Format
  return (j.items || []).map(it => {
    const r = { line: Math.max(1, ((it.statementPos && it.statementPos.startLine) || 1) - lineShift), ords: it };
    if (it.errorCode) {
      const code = 'ORA-' + String(it.errorCode).padStart(5, '0');
      r.error = { code, message: String(it.errorMessage || '').split(/\n\s*\n/)[0].replace(/^\s*ORA-\d+:\s*/, '').trim(), lineOffset: null };
      if (it.errorDetails) r.error.details = String(it.errorDetails);
    } else if (it.resultSet) {
      const md = it.resultSet.metadata || [];
      const kinds = md.map(() => 'str');
      const rows = (it.resultSet.items || []).map(row => md.map((m, k) => { const [s, kd] = ordsValue(row[m.jsonColumnName], m.columnTypeName); if (s !== null && kd === 'num') kinds[k] = 'num'; return s; }));
      r.grid = { cols: md.map(m => m.columnName), rows, kinds, more: !!it.resultSet.hasMore };
    } else {
      r.rowcount = typeof it.result === 'number' ? it.result : -1;
      const out = (it.response || []).join('').split('\n').map(l => l.replace(/\r$/, ''));
      if (it.statementType === 'plsql') { const o = out.filter(l => l.trim() && !/PL\/SQL procedure successfully completed|Procedure .* compiled|Function .* compiled|Package .* compiled|Trigger .* compiled/i.test(l)); if (o.length) r.output = o; }
      if (/compiled\s*$/im.test(out.join('\n')) && /Errors?:|LINE\/COL/i.test(out.join('\n'))) r.compileText = out.filter(l => l.trim()).join('\n');
    }
    return r;
  });
}
// Liste vorbereiteter Anweisungen ausführen → Brücken-Format (items, tx)
async function remoteExec(stmts, opts) {
  const cfg = remoteCfg(); if (!cfg) throw new Error('Keine externe Verbindung aktiv.');
  opts = opts || {};
  const send = stmts.filter(s => !s.local);
  let items = [], tx = null;
  if (send.length) {
    if (cfg.type === 'ords') {
      const raw = opts.rawScript !== undefined;
      const j = await ordsFetch(cfg, 'SET SERVEROUTPUT ON\n' + (raw ? opts.rawScript : ordsScript(send)), opts.signal);
      items = fromOrds(j, 1).filter(r => !(r.ords && r.ords.statementType === 'sqlplus' && /^\s*SET\s+SERVEROUT/i.test(r.ords.statementText || '') && ((r.ords.statementPos || {}).startLine || 1) === 1));
      if (raw) return { items: items.map(r => Object.assign(r, { stmt: { text: (r.ords.statementText || '').trim(), kind: r.ords.statementType === 'plsql' ? 'plsql' : 'sql', ords: true } })), tx: null };
      items = items.map((r, k) => Object.assign(r, { line: send[k] ? send[k].line : r.line }));
    } else {
      let j;
      try { j = await bridgeFetch(cfg, '/sql', { statements: send.map(s => ({ text: s.text, kind: s.kind, line: s.line, obj: s.obj })), limit: opts.limit || 500, tx: true }, opts.signal); }
      catch (e) { if (e.notConnected && await ensureBridgeSession(cfg, true)) j = await bridgeFetch(cfg, '/sql', { statements: send.map(s => ({ text: s.text, kind: s.kind, line: s.line, obj: s.obj })), limit: opts.limit || 500, tx: true }, opts.signal); else throw e; }
      items = j.items || []; tx = j.tx;
    }
  }
  // lokale Einträge (PROMPT, SET …) wieder einsortieren
  const all = []; let k = 0;
  for (const s of stmts) { if (s.local) all.push({ line: s.line, local: s }); else if (k < items.length) all.push(Object.assign(items[k++], { stmt: send[k - 1] })); }
  while (k < items.length) all.push(items[k++]);
  return { items: all, tx };
}
async function ensureBridgeSession(cfg, silent) {
  const st = await bridgeFetch(cfg, '/status');
  if (st.connected) return true;
  const pw = cfg.pw || RX.pw;
  if (pw === undefined || pw === null) { if (!silent) toast('Bitte erneut anmelden.'); openConnect(cfg); return false; }
  const r = await bridgeFetch(cfg, '/connect', Object.assign({}, cfg, { password: pw }));
  if (!r.ok) throw new Error(r.error || 'Anmeldung fehlgeschlagen.');
  return true;
}

// ---------- Ergebnisse in das Ausgabeformat der Sandbox übersetzen ----------
const kindWord = { 'PACKAGE BODY': 'Package Body', 'TYPE BODY': 'Typ-Body', PROCEDURE: 'Prozedur', FUNCTION: 'Funktion', PACKAGE: 'Package', TRIGGER: 'Trigger', TYPE: 'Typ' };
function okMessage(text, rc) {
  const t = text.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g, '').trim(); const u = t.toUpperCase().replace(/\s+/g, ' ');
  const n = rc >= 0 ? rc : 0, z = n === 1 ? ' Zeile ' : ' Zeilen ';
  const name = (re) => { const m = t.match(re); return m ? m[m.length - 1].replace(/"/g, '').toUpperCase() : ''; };
  if (/^INSERT\b/.test(u)) return n + z + 'eingefügt.';
  if (/^UPDATE\b/.test(u)) return n + z + 'aktualisiert.';
  if (/^DELETE\b/.test(u)) return n + z + 'gelöscht.';
  if (/^MERGE\b/.test(u)) return n + z + 'zusammengeführt.';
  if (/^COMMIT\b/.test(u)) return 'Commit abgeschlossen.';
  if (/^ROLLBACK\b/.test(u)) return 'Rollback abgeschlossen.';
  if (/^SAVEPOINT\b/.test(u)) return 'Savepoint erstellt.';
  if (/^TRUNCATE\b/.test(u)) return 'Tabelle ' + name(/TABLE\s+("?[\w$#.]+"?)/i) + ' wurde geleert.';
  let m;
  if ((m = u.match(/^CREATE (?:OR REPLACE )?(?:(?:GLOBAL )?TEMPORARY |UNIQUE |BITMAP |FORCE |NOFORCE |(?:NON)?EDITIONABLE )*(TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|PUBLIC SYNONYM|MATERIALIZED VIEW|USER|ROLE)\b/))) return ({ TABLE: 'Tabelle', VIEW: 'View', INDEX: 'Index', SEQUENCE: 'Sequenz', SYNONYM: 'Synonym', 'PUBLIC SYNONYM': 'Synonym', 'MATERIALIZED VIEW': 'Materialized View', USER: 'Benutzer', ROLE: 'Rolle' }[m[1]]) + ' ' + name(new RegExp(m[1].replace(' ', '\\s+') + '\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?("?[\\w$#]+"?\\.)?("?[\\w$#]+"?)', 'i')) + ' wurde erstellt.';
  if ((m = u.match(/^DROP (TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|PROCEDURE|FUNCTION|PACKAGE BODY|PACKAGE|TRIGGER|TYPE BODY|TYPE|MATERIALIZED VIEW|USER|ROLE)\b/))) return (kindWord[m[1]] || { TABLE: 'Tabelle', VIEW: 'View', INDEX: 'Index', SEQUENCE: 'Sequenz', SYNONYM: 'Synonym' }[m[1]] || m[1]) + ' ' + name(new RegExp(m[1].replace(' ', '\\s+') + '\\s+(?:IF\\s+EXISTS\\s+)?("?[\\w$#]+"?\\.)?("?[\\w$#]+"?)', 'i')) + ' wurde gelöscht.';
  if ((m = u.match(/^ALTER (TABLE|VIEW|INDEX|SEQUENCE|TRIGGER|PROCEDURE|FUNCTION|PACKAGE|SESSION|USER)\b/))) return m[1] === 'SESSION' ? 'Sitzung geändert.' : ({ TABLE: 'Tabelle', VIEW: 'View', INDEX: 'Index', SEQUENCE: 'Sequenz' }[m[1]] || kindWord[m[1]] || m[1]) + ' ' + name(new RegExp(m[1] + '\\s+("?[\\w$#]+"?\\.)?("?[\\w$#]+"?)', 'i')) + ' wurde geändert.';
  if (/^(GRANT|REVOKE)\b/.test(u)) return 'Berechtigung ' + (u[0] === 'G' ? 'erteilt.' : 'entzogen.');
  if (/^COMMENT\b/.test(u)) return 'Kommentar gespeichert.';
  if (/^(SET TRANSACTION|LOCK)\b/.test(u)) return 'Erledigt.';
  return rc >= 0 && /^(SELECT|WITH)\b/.test(u) ? '' : 'Anweisung ausgeführt.';
}
function toResult(it) {
  const st = it.stmt || {}; const text = (st.label || st.text || '').trim();
  const r = { line: it.line || st.line || 1, text: text || ((it.ords && it.ords.statementText) || '') };
  if (it.local) { const l = it.local; r.text = l.label; if (l.plain !== undefined) { r.msg = l.plain; r.plain = true; } else { r.msg = l.note; r.plain = true; } return r; }
  if (it.output && it.output.length) r.output = it.output;
  if (it.error) {
    r.error = { code: it.error.code, message: it.error.message, stack: it.error.details ? [it.error.details] : [], line: r.line + (it.error.lineOffset || 0) };
    return r;
  }
  if (it.compile && it.compile.length) {
    const o = st.obj || {}; const first = it.compile[0];
    r.error = { code: (first.text.match(/^(PLS|ORA)-\d+/) || ['PLS-00000'])[0], message: (kindWord[o.type] || 'Objekt') + ' ' + (o.name || '') + ' wurde mit Kompilierungsfehlern erstellt.', stack: it.compile.map(e => 'Zeile ' + e.line + ', Spalte ' + e.pos + ': ' + e.text), line: r.line + first.line - 1 };
    return r;
  }
  if (it.compileText) { r.error = { code: 'PLS', message: 'Kompilierungsfehler', stack: [it.compileText], line: r.line }; return r; }
  if (it.grid) {
    const g = it.grid; r.grid = { cols: g.cols, rows: g.rows, kinds: g.kinds || g.cols.map(() => 'str'), total: g.rows.length };
    r.msg = g.more ? 'Mehr als ' + g.rows.length + ' Zeilen – angezeigt werden die ersten ' + g.rows.length + '.' : g.rows.length + (g.rows.length === 1 ? ' Zeile ausgewählt.' : ' Zeilen ausgewählt.');
    if (st.desc) r.msg = 'Spalten von ' + st.desc;
    return r;
  }
  if (st.kind === 'plsql') {
    const m = !st.obj && (st.text || '').match(PLOBJ);
    const o = st.obj || (m ? { type: m[1].toUpperCase().replace(/\s+/g, ' '), name: m[2].toUpperCase() } : null);
    r.msg = o && o.name ? (kindWord[o.type] || 'Objekt') + ' ' + o.name + ' wurde erstellt.' : 'PL/SQL-Prozedur erfolgreich abgeschlossen.';
    return r;
  }
  r.msg = okMessage(r.text, it.rowcount);
  if (!r.msg) r.silent = true;
  return r;
}

// ---------- Katalog ----------
const CAT_STMTS = [
  'SELECT table_name FROM user_tables ORDER BY table_name',
  'SELECT view_name FROM user_views ORDER BY view_name',
  'SELECT sequence_name, last_number, increment_by FROM user_sequences ORDER BY sequence_name',
  "SELECT object_name, object_type, status FROM user_objects WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TYPE') ORDER BY object_name",
  'SELECT trigger_name, table_name, trigger_type, triggering_event, status FROM user_triggers ORDER BY trigger_name',
  "SELECT index_name, table_name, uniqueness FROM user_indexes WHERE generated = 'N' ORDER BY index_name",
].map(t => ({ text: t, kind: 'sql', line: 1 }));
const rowsOf = it => it && it.grid ? it.grid.rows : [];
async function remoteCatalog() {
  const { items, tx } = await remoteExec(CAT_STMTS, { limit: 5000 });
  const bad = items.find(i => i.error); if (bad && items.indexOf(bad) === 0) throw new Error(bad.error.code + ': ' + bad.error.message);
  const tnames = rowsOf(items[0]).map(r => r[0]).filter(t => t && !/^BIN\$/.test(t));
  const objs = rowsOf(items[3]);
  const bodies = new Set(objs.filter(r => r[1] === 'PACKAGE BODY').map(r => r[0]));
  const invalid = new Set(objs.filter(r => r[2] === 'INVALID').map(r => r[0] + '|' + r[1]));
  const cat = {
    remote: true,
    tables: tnames.map(name => ({ name, count: null, remote: true })),
    views: rowsOf(items[1]).map(r => ({ name: r[0], count: null, remote: true })),
    seqs: rowsOf(items[2]).map(r => ({ name: r[0], next: r[1], inc: r[2], curr: null, remote: true })),
    procs: objs.filter(r => r[1] === 'PROCEDURE' || r[1] === 'FUNCTION').map(r => ({ name: r[0], kind: r[1], sig: '', invalid: r[2] === 'INVALID', remote: true })),
    pkgs: objs.filter(r => r[1] === 'PACKAGE').map(r => ({ name: r[0], hasBody: bodies.has(r[0]), members: [], invalid: invalid.has(r[0] + '|PACKAGE') || invalid.has(r[0] + '|PACKAGE BODY'), remote: true })),
    types: objs.filter(r => r[1] === 'TYPE').map(r => ({ name: r[0], remote: true })),
    triggers: rowsOf(items[4]).map(r => ({ name: r[0], table: r[1], desc: (r[2] || '') + ' ' + (r[3] || ''), enabled: r[4] === 'ENABLED', remote: true })),
    indexes: rowsOf(items[5]).map(r => ({ name: r[0], table: r[1], unique: r[2] === 'UNIQUE', cols: [], remote: true })),
    tx: { open: false, tables: [] },
  };
  // Zeilenzahlen (bis 80 Tabellen in einer Abfrage)
  if (cat.tables.length && cat.tables.length <= 80) {
    const q = cat.tables.map(t => 'SELECT ' + sqlLit(t.name) + ' AS t, COUNT(*) AS n FROM ' + qid(t.name)).join(' UNION ALL ');
    try { const r = await remoteExec([{ text: q, kind: 'sql', line: 1 }], { limit: 100 }); const m = new Map(rowsOf(r.items[0]).map(x => [x[0], +x[1]])); cat.tables.forEach(t => { if (m.has(t.name)) t.count = m.get(t.name); }); } catch (e) { }
  }
  setRemoteTx(cat, tx);
  return cat;
}
function setRemoteTx(cat, tx) {
  if (tx === false) RX.txTables.clear();
  cat.tx = { open: !!tx, tables: Array.from(RX.txTables), remote: true };
}
async function remoteLoadDetail(sel) {
  const o = findObj(sel); if (!o || o.loaded || o.loading) return;
  o.loading = true;
  const N = sqlLit(o.name);
  const ddlPrep = { kind: 'plsql', line: 1, text: "BEGIN\n  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);\n  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);\n  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);\nEND;" };
  const S = t => ({ text: t, kind: 'sql', line: 1 });
  const grid = it => it && it.grid ? { cols: it.grid.cols, rows: it.grid.rows, kinds: it.grid.kinds, total: it.grid.rows.length } : { cols: [], rows: [], kinds: [], total: 0 };
  try {
    const k = sel.kind;
    if (k === 'table' || k === 'view') {
      const st = [S('SELECT * FROM ' + qid(o.name) + ' WHERE ROWNUM <= 200'), S('SELECT COUNT(*) FROM ' + qid(o.name)), ddlPrep, S("SELECT DBMS_METADATA.GET_DDL('" + (k === 'table' ? 'TABLE' : 'VIEW') + "', " + N + ') FROM dual')];
      if (k === 'table') st.push(S('SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, data_default FROM user_tab_columns WHERE table_name = ' + N + ' ORDER BY column_id'),
        S("SELECT c.constraint_name, c.constraint_type, (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM user_cons_columns cc WHERE cc.constraint_name = c.constraint_name) AS cols, (SELECT r.table_name FROM user_constraints r WHERE r.constraint_name = c.r_constraint_name) AS rtab, c.delete_rule, c.status, c.generated, c.search_condition FROM user_constraints c WHERE c.table_name = " + N + " ORDER BY c.constraint_type, c.constraint_name"));
      const { items } = await remoteExec(st, { limit: 200 });
      const pv = items[0]; o.preview = grid(pv); o.error = pv && pv.error ? pv.error.code + ': ' + pv.error.message : null;
      o.count = items[1] && items[1].grid ? +items[1].grid.rows[0][0] : o.preview.total;
      const ddl = items[3] && items[3].grid ? items[3].grid.rows[0][0] : null;
      if (k === 'view') o.text = ddl || '';
      if (k === 'table') {
        const cons = rowsOf(items[5]).filter(r => !(r[1] === 'C' && r[6] === 'GENERATED NAME' && /IS NOT NULL$/i.test(r[7] || '')));
        const pkCols = new Set(), fkOf = {};
        cons.forEach(r => { const cols = (r[2] || '').split(', '); if (r[1] === 'P') cols.forEach(c => pkCols.add(c)); if (r[1] === 'R') cols.forEach(c => fkOf[c] = r[3]); });
        o.cols = rowsOf(items[4]).map(r => ({ name: r[0], type: r[1] + (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(r[1]) ? '(' + r[2] + ')' : r[1] === 'NUMBER' && r[3] ? '(' + r[3] + (+r[4] > 0 ? ',' + r[4] : '') + ')' : ''), nn: r[5] === 'N', def: r[6] ? String(r[6]).trim() : '', pk: pkCols.has(r[0]), fk: fkOf[r[0]] || null }));
        o.cons = cons.map(r => ({ name: r[0], type: r[1], cols: (r[2] || '').split(', ').filter(Boolean), ref: r[3] || null, check: r[1] === 'C' ? r[7] : null, onDelete: r[4] && r[4] !== 'NO ACTION' ? r[4] : null, enabled: r[5] === 'ENABLED' }));
        o.triggers = catalog.triggers.filter(t => t.table === o.name).map(t => t.name);
        o.ddl = ddl || ('CREATE TABLE ' + o.name.toLowerCase() + ' (\n' + o.cols.map(c => '  ' + c.name.toLowerCase() + ' ' + c.type + (c.nn ? ' NOT NULL' : '')).join(',\n') + '\n);');
      }
    } else if (k === 'seq') {
      const { items } = await remoteExec([ddlPrep, S("SELECT DBMS_METADATA.GET_DDL('SEQUENCE', " + N + ') FROM dual')]);
      o.text = items[1] && items[1].grid ? items[1].grid.rows[0][0] : 'CREATE SEQUENCE ' + o.name.toLowerCase() + ' START WITH ' + o.next + ' INCREMENT BY ' + o.inc + ';';
    } else if (k === 'index') {
      const { items } = await remoteExec([S('SELECT column_name FROM user_ind_columns WHERE index_name = ' + N + ' ORDER BY column_position')]);
      o.cols = rowsOf(items[0]).map(r => r[0]);
    } else {
      const { items } = await remoteExec([S('SELECT type, line, text FROM user_source WHERE name = ' + N + " ORDER BY CASE WHEN type LIKE '% BODY' THEN 2 ELSE 1 END, line")], { limit: 50000 });
      const parts = {}; for (const r of rowsOf(items[0])) (parts[r[0]] = parts[r[0]] || []).push(r[2] === null ? '' : String(r[2]));
      const join = ls => { const t = ls.every(l => /\n$/.test(l)) ? ls.join('') : ls.join('\n'); return t.replace(/\s+$/, ''); };
      const src = Object.keys(parts).map(t => 'CREATE OR REPLACE ' + join(parts[t]).replace(/^\s+/, ''));
      o.text = src.join('\n/\n\n') || '-- Kein Quelltext gefunden (fremdes oder verschlüsseltes Objekt?)';
      if (k === 'proc') {
        const body = src[0] || ''; const m = body.match(/(?:PROCEDURE|FUNCTION)\s+"?[\w$#.]+"?\s*(\(([^()]|\([^()]*\))*\))?/i);
        const ret = o.kind === 'FUNCTION' ? (body.match(/\bRETURN\s+([\w.%]+)/i) || ['', '?'])[1] : '';
        o.sig = (m && m[1] ? m[1].replace(/\s+/g, ' ') : '()') + (ret ? ' RETURN ' + ret : '');
      }
      if (k === 'pkg') o.members = ((parts.PACKAGE && join(parts.PACKAGE)) || '').split('\n').map(l => l.match(/^\s*(PROCEDURE|FUNCTION)\s+(\w+)/i)).filter(Boolean).map(m => (m[1].toUpperCase() === 'FUNCTION' ? 'ƒ ' : 'ᴘ ') + m[2].toUpperCase());
    }
    o.loaded = true;
  } catch (e) {
    o.loadError = e.message;
  } finally { o.loading = false; }
}

// ---------- Ausführen ----------
async function remoteRun(mode) {
  if (running) return;
  const cfg = remoteCfg();
  hideHud();
  const text = ta.value; let sql, range;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s !== e) { const l0 = lineOf(text, s); sql = '\n'.repeat(l0 - 1) + text.slice(s, e); range = [l0, lineOf(text, e)]; }
  else if (mode === 'stmt') {
    const items = splitScript(text); if (!items.length) { toast('Keine Anweisung gefunden.'); return; }
    let it = items.find(x => s >= x.start && s <= x.end + 2) || null;
    if (!it) { const before = items.filter(x => x.start <= s); it = before.length ? before[before.length - 1] : items[0]; const nx = items[items.indexOf(it) + 1]; if (nx && /\n\s*\n/.test(text.slice(it.end, s))) it = nx; }
    sql = '\n'.repeat(it.line - 1) + it.text + (it.kind === 'plsql' ? '\n/' : it.kind === 'sql' ? ';' : ''); range = [it.line, it.line + it.text.split('\n').length - 1];
  } else { sql = text; range = null; }
  if (!sql.trim()) { toast('Der Editor ist leer.'); return; }
  running = true; RX.busy = true; errLines = new Map(); ranRange = range; paint();
  $('#summary').innerHTML = '<span class="running"><span class="spin"></span>läuft auf ' + esc(cfg.label || 'dem Server') + ' …</span>';
  clearTimeout(stopTimer); stopTimer = setTimeout(() => { if (running) $('#stopBtn').hidden = false; }, 350);
  RX.ctrl = new AbortController(); const t0 = performance.now();
  const stmts = prepStatements(splitScript(sql));
  let res = null, fail = null;
  try { res = await remoteExec(stmts, { signal: RX.ctrl.signal, rawScript: cfg.type === 'ords' ? sql : undefined }); }
  catch (e) { fail = e; }
  running = false; RX.busy = false; clearTimeout(stopTimer); $('#stopBtn').hidden = true;
  if (fail) {
    lastRun = { results: [{ line: range ? range[0] : 1, text: '', error: { code: fail.name === 'AbortError' ? 'ABBRUCH' : 'VERBINDUNG', message: fail.name === 'AbortError' ? 'Die Ausführung wurde abgebrochen.' : fail.message, stack: [], line: null } }], ms: 0 };
    showOut('out'); paint(); return;
  }
  const results = res.items.map(toResult);
  // offene Transaktion: DML-Ziele merken
  results.forEach((r, k) => { const st = res.items[k].stmt; if (!r.error && st && st.kind === 'sql') { const m = st.text.match(/^\s*(?:INSERT\s+(?:ALL\s+)?INTO|UPDATE|DELETE\s+(?:FROM\s+)?|MERGE\s+INTO)\s+(?:"?\w+"?\.)?"?([\w$#]+)"?/i); if (m) RX.txTables.add(m[1].toUpperCase()); if (/^\s*(COMMIT|ROLLBACK)\b(?!\s+TO)/i.test(st.text)) RX.txTables.clear(); } });
  lastRun = { results, ms: Math.round(performance.now() - t0), total: results.length };
  for (const x of results) if (x.error && x.error.line) errLines.set(x.error.line, x.error.code + ': ' + x.error.message);
  paint(); showOut('out');
  if (!results.some(x => x.error) && !RM && animMode !== 'aus') celebrate({ steps: 0 }); else renderSummary();
  await refreshRemote(res.tx);
}
async function refreshRemote(tx) {
  try { const keepSel = selected; catalog = await remoteCatalog(); if (tx !== undefined && tx !== null) setRemoteTx(catalog, tx); renderTree(); renderTx(); if (keepSel && findObj(keepSel)) { if (outTab === 'obj') { await remoteLoadDetail(keepSel); renderDetail(); } } else if (keepSel) refreshSelected(); }
  catch (e) { toast('Objektliste konnte nicht geladen werden: ' + e.message); }
}
async function remoteQuick(sql) {
  if (running) return;
  running = true;
  try { const res = await remoteExec(prepStatements(splitScript(sql))); const results = res.items.map(toResult); lastRun = { results, ms: 0, total: results.length }; if (!results.some(r => r.error)) RX.txTables.clear(); showOut('out'); await refreshRemote(res.tx); }
  catch (e) { toast(e.message); }
  finally { running = false; }
}
function remoteStop() { if (RX.ctrl) RX.ctrl.abort(); const cfg = remoteCfg(); if (cfg && cfg.type === 'bridge') bridgeFetch(cfg, '/cancel', {}).catch(() => { }); }

// ---------- Verbinden ----------
function cfgLabel(c) { return c.type === 'ords' ? (c.user || '').toUpperCase() + ' @ ' + c.url.replace(/^https?:\/\//, '').replace(/\/+$/, '') : (c.user ? c.user.toUpperCase() + ' @ ' : '') + (c.driver === 'odbc' ? 'ODBC ' + (c.odbc || '').replace(/PWD=[^;]*/i, '') : (c.host || 'localhost') + ':' + (c.port || 1521) + '/' + (c.service || '')); }
function openConnect(pre, editId) {
  const p = Object.assign({ type: 'bridge', url: 'http://127.0.0.1:8765', token: '', driver: 'oracledb', host: 'localhost', port: '1521', service: 'FREEPDB1', odbc: '', user: '', ordsUrl: 'https://server:8443/ords/schema', remember: false }, pre || {});
  if (p.type === 'ords') p.ordsUrl = p.url;
  const f = (id, label, val, attrs) => '<label class="fld' + (attrs && attrs.wide ? ' wide' : '') + '"><span>' + label + '</span><input id="' + id + '" value="' + esc(val == null ? '' : val) + '"' + (attrs && attrs.type ? ' type="' + attrs.type + '"' : ' type="text"') + (attrs && attrs.ph ? ' placeholder="' + esc(attrs.ph) + '"' : '') + ' autocomplete="off" spellcheck="false"></label>';
  modal('<h3>Mit Oracle-Server verbinden</h3>' +
    '<div class="seg big" id="cxType"><button data-t="bridge"' + (p.type === 'bridge' ? ' class="on"' : '') + '>Brücke · Oracle Net / ODBC</button><button data-t="ords"' + (p.type === 'ords' ? ' class="on"' : '') + '>ORDS · REST</button></div>' +
    '<div class="cx" data-for="bridge">' +
    '<p class="cxhint">Startet auf deinem Rechner die mitgelieferte <b>oracle_bruecke.py</b> (Ordner „bruecke“): <code>py -m pip install oracledb pyodbc; py oracle_bruecke.py</code> – sie zeigt Adresse und Schlüssel an.</p>' +
    f('cxUrl', 'Adresse der Brücke', p.url) + f('cxToken', 'Schlüssel', p.token, { ph: 'z. B. 3F9A1C0B' }) +
    '<div class="fld wide"><span>Treiber</span><div class="seg" id="cxDrv"><button data-d="oracledb"' + (p.driver !== 'odbc' ? ' class="on"' : '') + '>Oracle Net (Host, Port, Service)</button><button data-d="odbc"' + (p.driver === 'odbc' ? ' class="on"' : '') + '>ODBC (DSN)</button></div></div>' +
    '<div class="cx2" data-drv="oracledb">' + f('cxHost', 'Host', p.host) + f('cxPort', 'Port', p.port) + f('cxSvc', 'Service-Name', p.service, { ph: 'FREEPDB1, XEPDB1, ORCL …' }) + '</div>' +
    '<div class="cx2" data-drv="odbc">' + f('cxOdbc', 'DSN oder ODBC-Verbindungszeichenfolge', p.odbc, { wide: true, ph: 'OracleDSN  –  oder  Driver={Oracle in OraClient19Home1};DBQ=host:1521/ORCL' }) + '</div>' +
    '</div>' +
    '<div class="cx" data-for="ords"><p class="cxhint">Oracle REST Data Services mit REST-aktiviertem Schema (<code>ORDS.ENABLE_SCHEMA</code>) und freigegebenem Ursprung (CORS). Jede Ausführung läuft dort in einer eigenen Sitzung und wird am Ende bestätigt.</p>' +
    f('cxOrds', 'Basis-URL des Schemas', p.ordsUrl, { wide: true, ph: 'https://server:8443/ords/hr' }) + '</div>' +
    '<div class="cx2 on">' + f('cxUser', 'Benutzer', p.user) + f('cxPw', 'Passwort', p.pw || '', { type: 'password' }) + f('cxName', 'Name in der Liste', p.name || '', { ph: 'wird sonst erzeugt' }) + '</div>' +
    '<label class="chkline"><input type="checkbox" id="cxRem"' + (p.remember || p.pw ? ' checked' : '') + '> Passwort in diesem Browser speichern <small>(unverschlüsselt – nur auf dem eigenen Rechner)</small></label>' +
    '<div class="cxmsg" id="cxMsg" role="status"></div>' +
    '<div class="row"><button class="btn" data-m="no">Abbrechen</button><button class="btn" data-m="test">Verbindung testen</button><button class="btn primary" data-m="ok">Verbinden</button></div>', async v => {
      if (v === 'no') { closeModal(); return; }
      const c = readCx();
      const msg = $('#cxMsg'); msg.className = 'cxmsg busy'; msg.textContent = 'Verbinde …';
      try {
        const info = await testConnect(c);
        msg.className = 'cxmsg ok'; msg.textContent = 'Verbunden als ' + info.user + (info.server ? ' · Oracle ' + info.server : '') + '.';
        if (v === 'ok') { closeModal(); await activateRemote(c, editId); }
      } catch (e) { msg.className = 'cxmsg bad'; msg.textContent = e.message; }
    });
  const dlg = $('#dlg');
  const sync = () => {
    const t = dlg.querySelector('#cxType .on').dataset.t, d = dlg.querySelector('#cxDrv .on').dataset.d;
    dlg.querySelectorAll('.cx').forEach(x => x.hidden = x.dataset.for !== t);
    dlg.querySelectorAll('[data-drv]').forEach(x => x.hidden = x.dataset.drv !== d);
  };
  dlg.querySelectorAll('#cxType button, #cxDrv button').forEach(b => b.addEventListener('click', () => { b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); sync(); }));
  dlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') dlg.querySelector('.primary').click(); });
  sync();
  const first = p.type === 'bridge' && !p.token ? '#cxToken' : (p.user ? '#cxPw' : '#cxUser'); setTimeout(() => { const el = dlg.querySelector(first); if (el) el.focus(); }, 30);
}
function readCx() {
  const d = $('#dlg'); const val = id => (d.querySelector(id).value || '').trim();
  const type = d.querySelector('#cxType .on').dataset.t;
  const c = { type, user: val('#cxUser'), remember: d.querySelector('#cxRem').checked, name: val('#cxName') };
  const pw = d.querySelector('#cxPw').value;
  if (type === 'ords') c.url = val('#cxOrds');
  else Object.assign(c, { url: val('#cxUrl') || 'http://127.0.0.1:8765', token: val('#cxToken').toUpperCase(), driver: d.querySelector('#cxDrv .on').dataset.d, host: val('#cxHost'), port: val('#cxPort'), service: val('#cxSvc'), odbc: val('#cxOdbc') });
  c._pw = pw;
  return c;
}
async function testConnect(c) {
  if (c.type === 'ords') {
    if (!/^https?:\/\//i.test(c.url)) throw new Error('Bitte die ORDS-Adresse mit http:// oder https:// angeben.');
    const j = await ordsFetch(Object.assign({}, c, { pw: c._pw }), 'SELECT USER AS u FROM dual');
    const it = (j.items || [])[0] || {};
    if (it.errorCode) throw new Error('ORA-' + String(it.errorCode).padStart(5, '0') + ': ' + (it.errorMessage || '').replace(/^ORA-\d+:\s*/, ''));
    const row = (it.resultSet && it.resultSet.items && it.resultSet.items[0]) || {};
    return { user: row.u || c.user.toUpperCase(), server: row.v || '' };
  }
  const st = await bridgeFetch(c, '/status');
  if (c.driver === 'oracledb' && st.drivers && !st.drivers.includes('oracledb')) throw new Error('Der Brücke fehlt python-oracledb:  py -m pip install oracledb');
  if (c.driver === 'odbc' && st.drivers && !st.drivers.includes('odbc')) throw new Error('Der Brücke fehlt pyodbc:  py -m pip install pyodbc');
  const r = await bridgeFetch(c, '/connect', { driver: c.driver, host: c.host, port: c.port, service: c.service, odbc: c.odbc, user: c.user, password: c._pw });
  if (!r.ok) throw new Error(r.error || 'Anmeldung fehlgeschlagen.');
  return { user: r.user, server: r.server };
}
async function activateRemote(c, editId) {
  if (PL) finishPlay(true);
  if (running) stopRun();
  const remote = { type: c.type, url: c.url, user: c.user };
  if (c.type === 'bridge') Object.assign(remote, { token: c.token, driver: c.driver, host: c.host, port: c.port, service: c.service, odbc: c.odbc });
  if (c.remember) remote.pw = c._pw; RX.pw = c._pw;
  remote.label = cfgLabel(remote);
  let meta = editId ? dbList.find(d => d.id === editId) : dbList.find(d => d.remote && cfgLabel(d.remote) === remote.label && d.remote.type === remote.type);
  if (!meta) { meta = { id: newId(), name: c.name || uniqueDbName(c.type === 'ords' ? 'ORDS ' + (c.user || '').toUpperCase() : (c.user || 'Oracle').toUpperCase() + ' (extern)'), created: Date.now() }; dbList.push(meta); }
  else if (c.name) meta.name = c.name;
  meta.remote = remote; activeDb = meta.id; saveDbMeta();
  await loadRemote();
}
async function loadRemote() {
  hideHud(); RX.txTables.clear();
  selected = null; $('#tabObj').hidden = true; lastRun = null; errLines = new Map(); clearHeat();
  renderDbBtn(); applyRemoteUi();
  $('#summary').innerHTML = '<span class="running"><span class="spin"></span>Objektliste wird geladen …</span>';
  try { catalog = await remoteCatalog(); }
  catch (e) { catalog = { tables: [], views: [], seqs: [], procs: [], pkgs: [], triggers: [], types: [], indexes: [], tx: { open: false, tables: [] }, remote: true }; toast(e.message); }
  renderTree(); renderTx(); showOut('out'); paint();
}
async function switchToRemote(meta) {
  const cfg = meta.remote; RX.pw = cfg.pw;
  if (cfg.type === 'ords') {
    if (!cfg.pw) { openConnect(Object.assign({}, cfg, { name: meta.name }), meta.id); return; }
    activeDb = meta.id; saveDbMeta(); await loadRemote(); return;
  }
  try {
    const st = await bridgeFetch(cfg, '/status');
    const sameUser = st.connected && (st.user || '').toUpperCase() === (cfg.user || '').toUpperCase();
    if (!sameUser) {
      if (!cfg.pw) { openConnect(Object.assign({}, cfg, { name: meta.name }), meta.id); return; }
      const r = await bridgeFetch(cfg, '/connect', Object.assign({}, cfg, { password: cfg.pw }));
      if (!r.ok) throw new Error(r.error);
    }
    activeDb = meta.id; saveDbMeta(); await loadRemote();
  } catch (e) { toast(e.message); openConnect(Object.assign({}, cfg, { name: meta.name }), meta.id); }
}
function applyRemoteUi() {
  const cfg = remoteCfg();
  document.body.classList.toggle('remote', !!cfg);
  const sub = $('#dbBtn small'); if (sub) sub.textContent = cfg ? 'extern · ' + cfg.label : 'Schema STUDENT';
  $('#sideFoot').innerHTML = cfg ? '<b>Externer Server.</b> Anweisungen laufen direkt auf ' + esc(cfg.label) + (cfg.type === 'ords' ? ' – ORDS bestätigt jede Ausführung automatisch.' : ' – Änderungen erst mit COMMIT dauerhaft.') : 'Alles wird lokal in deinem Browser gespeichert. Für eine Sicherung: Menü → Als SQL exportieren.';
}
