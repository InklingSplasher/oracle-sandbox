// ===== Ausführung auf oberster Ebene, Katalog, Persistenz =====
const rowsMsg = (n, verb) => n + (n === 1 ? ' Zeile ' : ' Zeilen ') + verb + '.';

function execTopBlock(st) {
  const f = new Frame(null, 'block', st.label);
  f.act = { line: st.ln, base: 1, script: true };
  const m = beginStmt();
  try {
    execBlockIn(st, f);
    endStmt(m, true);
  } catch (e) {
    endStmt(m, false);
    if (e instanceof ExitSignal || e instanceof ContinueSignal) { const x = plsErr('00376', 'Ungültige EXIT/CONTINUE-Anweisung außerhalb einer Schleife'); x.scriptLine = f.act.line; throw x; }
    if (e instanceof ReturnSignal) return { msg: 'PL/SQL-Prozedur erfolgreich abgeschlossen.' };
    if (e instanceof OraError) { e.oraStack.push('ORA-06512: in Zeile ' + f.act.line); if (!e.scriptLine) e.scriptLine = f.act.line; }
    throw e;
  }
  return { msg: 'PL/SQL-Prozedur erfolgreich abgeschlossen.' };
}
function insteadOf(view, event) { return Object.values(DB.triggers).filter(t => t.table === view && t.timing === 'INSTEAD OF' && t.enabled && t.events.includes(event)); }
function execInsteadOf(st, env, event) {
  const v = DB.views[st.table]; const trs = insteadOf(st.table, event);
  const d = tableData(st.table, env);
  const fake = { name: st.table, cols: d.cols.map((c, i) => ({ name: c, type: d.types[i] || null })) };
  let n = 0;
  if (event === 'INSERT') {
    const cols = st.cols || d.cols;
    const lists = st.query ? runQuery(st.query, env, {}).rows : (st.multi || [st.values]).map(l => l.map(e => ev(e, env)));
    for (const vals of lists) { const row = fake.cols.map(c => { const i = cols.indexOf(c.name); return i >= 0 ? vals[i] : null; }); fireTriggers(trs, fake, 'INSERT', null, row, null, false); n++; }
  } else {
    const srcs = mkSrcs([mkSrc(st.table, st.alias, d.cols, d.types)]);
    for (const r of d.rows) {
      const e2 = sub(env, { rs: { srcs, vals: [r], parent: null } });
      if (st.where && toBool(ev(st.where, e2)) !== true) continue;
      let nr = null;
      if (event === 'UPDATE') { nr = r.slice(); for (const s of st.sets) s.cols.forEach(c => { const i = d.cols.indexOf(c); if (i < 0) throw oraErr('00904', '"' + c + '"'); nr[i] = ev(s.e, e2); }); }
      fireTriggers(trs, fake, event, r, nr, null, false); n++;
    }
  }
  SESSION.sqlAttr = { found: n > 0, rowcount: n };
  return n;
}
function execStatement(st, env, dynamic) {
  env = env || { f: null };
  switch (st.k) {
    case 'query': {
      if (st.q.into) { const e = oraErr('00905'); e.hint = 'SELECT ... INTO funktioniert nur in PL/SQL, z. B. in einem BEGIN ... END;-Block.'; throw e; }
      const r = runQuery(st.q, env, {});
      return { grid: r, msg: r.rows.length ? rowsMsg(r.rows.length, 'ausgewählt') : 'Keine Zeilen ausgewählt.' };
    }
    case 'insert': if (DB.views[st.table] && insteadOf(st.table, 'INSERT').length) return { msg: rowsMsg(execInsteadOf(st, env, 'INSERT'), 'eingefügt') }; return { msg: rowsMsg(execInsert(st, env), 'eingefügt') };
    case 'insertAll': return { msg: rowsMsg(execInsertAll(st, env), 'eingefügt') };
    case 'update': if (DB.views[st.table] && insteadOf(st.table, 'UPDATE').length) return { msg: rowsMsg(execInsteadOf(st, env, 'UPDATE'), 'aktualisiert') }; return { msg: rowsMsg(execUpdate(st, env), 'aktualisiert') };
    case 'delete': if (DB.views[st.table] && insteadOf(st.table, 'DELETE').length) return { msg: rowsMsg(execInsteadOf(st, env, 'DELETE'), 'gelöscht') }; return { msg: rowsMsg(execDelete(st, env), 'gelöscht') };
    case 'merge': return { msg: rowsMsg(execMerge(st, env), 'zusammengeführt') };
    case 'block': return execTopBlock(st);
    case 'commit': doCommit(); tr({ t: 'tx', op: 'commit' }); return { msg: 'Commit abgeschlossen.' };
    case 'rollback': doRollback(st.to); tr({ t: 'tx', op: 'rollback', to: st.to || null }); return { msg: 'Rollback abgeschlossen.' };
    case 'savepoint': doSavepoint(st.name); return { msg: 'Savepoint ' + st.name + ' wurde erstellt.' };
    case 'createTable': return { msg: execCreateTable(st, env) };
    case 'createView': return { msg: execCreateView(st) };
    case 'createSeq': return { msg: execCreateSeq(st) };
    case 'createIndex': return { msg: execCreateIndex(st) };
    case 'createProc': {
      const ex = DB.procs[st.name];
      if (ex && !st.orReplace) throw oraErr('00955');
      if (ex && ex.kind !== st.kind) throw oraErr('00955');
      if (!ex && objExists(st.name)) throw oraErr('00955');
      ddlCommit();
      DB.procs[st.name] = { kind: st.kind, name: st.name, params: st.params, ret: st.ret, block: st.block, text: st.srcText, lineBase: st.srcLine, line: st.line, created: ex ? ex.created : stamp(), ddl: stamp() };
      SESSION.lastErrors = [];
      return { msg: (st.kind === 'PROCEDURE' ? 'Prozedur ' : 'Funktion ') + st.name + ' wurde erstellt.' };
    }
    case 'createTrigger': {
      const isView = !!DB.views[st.table];
      if (!DB.tables[st.table] && !isView) throw oraErr('00942');
      if (st.timing === 'INSTEAD OF' && !isView) throw new OraError('ORA-25002', 'INSTEAD OF-Trigger können nicht für Tabellen erstellt werden');
      if (st.timing !== 'INSTEAD OF' && isView) throw new OraError('ORA-25001', 'Dieser Trigger-Typ kann nicht für Views erstellt werden (nur INSTEAD OF)');
      if (DB.triggers[st.name] && !st.orReplace) throw oraErr('04081', st.name);
      if (!st.row && st.timing !== 'INSTEAD OF' && /:\s*(NEW|OLD)\b/i.test(st.srcText)) { const e = new OraError('ORA-04082', 'NEW- oder OLD-Referenzen in Triggern auf Tabellenebene nicht zulässig'); e.hint = ':NEW und :OLD gibt es nur in Zeilen-Triggern – ergänze FOR EACH ROW.'; throw e; }
      if (st.when && !st.row) throw new OraError('ORA-04077', 'WHEN-Klausel kann nicht mit Triggern auf Tabellenebene verwendet werden');
      if (st.ofCols) for (const c of st.ofCols) if (DB.tables[st.table] && !DB.tables[st.table].cols.some(x => x.name === c)) throw oraErr('00904', '"' + c + '"');
      ddlCommit();
      DB.triggers[st.name] = { name: st.name, table: st.table, timing: st.timing, events: st.events, ofCols: st.ofCols, row: st.row || st.timing === 'INSTEAD OF', when: st.when, block: st.block, enabled: st.enabled, refNew: st.refNew, refOld: st.refOld, text: st.srcText, lineBase: st.block.ln || st.srcLine, created: stamp() };
      return { msg: 'Trigger ' + st.name + ' wurde erstellt.' };
    }
    case 'createPkg': {
      const ex = DB.pkgs[st.name];
      if (ex && !st.orReplace) throw oraErr('00955');
      if (!ex && objExists(st.name)) throw oraErr('00955');
      ddlCommit();
      DB.pkgs[st.name] = { name: st.name, spec: { decls: st.decls, text: st.srcText, srcLine: st.srcLine }, body: ex ? ex.body : null, created: ex ? ex.created : stamp() };
      delete SESSION.pkgState[st.name];
      return { msg: 'Package ' + st.name + ' wurde erstellt.' };
    }
    case 'createPkgBody': {
      const ex = DB.pkgs[st.name];
      if (!ex) { const e = plsErr('00304', 'Body von \'' + st.name + '\' kann nicht ohne Spezifikation kompiliert werden'); e.hint = 'Zuerst CREATE PACKAGE ' + st.name + ' (Spezifikation) anlegen, dann den PACKAGE BODY.'; throw e; }
      if (ex.body && !st.orReplace) throw oraErr('00955');
      for (const d of ex.spec.decls) if (d.k === 'subprog') {
        if (!st.decls.some(b => b.k === 'subprog' && b.def.name === d.def.name && b.def.params.length === d.def.params.length && b.def.block)) throw plsErr('00323', 'Unterprogramm oder Cursor \'' + d.def.name + '\' ist in einer Package-Spezifikation deklariert und muss im Package Body definiert werden');
      }
      ddlCommit();
      ex.body = { decls: st.decls, init: st.init, text: st.srcText, srcLine: st.srcLine };
      delete SESSION.pkgState[st.name];
      return { msg: 'Package Body ' + st.name + ' wurde erstellt.' };
    }
    case 'createType': {
      if (DB.types[st.name] && !st.orReplace) throw oraErr('00955');
      if (!DB.types[st.name] && objExists(st.name)) throw oraErr('00955');
      ddlCommit();
      DB.types[st.name] = { name: st.name, def: st.def, text: st.srcText, created: stamp() };
      return { msg: 'Typ ' + st.name + ' wurde erstellt.' };
    }
    case 'createSynonym': {
      if (DB.synonyms[st.name] && !st.orReplace) throw oraErr('00955');
      if (!DB.synonyms[st.name] && objExists(st.name)) throw oraErr('00955');
      DB.synonyms[st.name] = { name: st.name, target: st.target };
      return { msg: 'Synonym ' + st.name + ' wurde erstellt.' };
    }
    case 'drop': return { msg: execDrop(st) };
    case 'alterTable': return { msg: execAlterTable(st, env) };
    case 'truncate': return { msg: execTruncate(st) };
    case 'rename': ddlCommit(); renameObject(st.from, st.to); return { msg: 'Tabelle wurde umbenannt.' };
    case 'comment': {
      const key = st.col ? st.table + '.' + st.col : st.table;
      if (!DB.tables[st.table] && !DB.views[st.table]) throw oraErr('00942');
      DB.comments[key] = st.text; return { msg: 'Kommentar wurde erstellt.' };
    }
    case 'alterSession': {
      for (const p of st.params) {
        if (p.p === 'NLS_DATE_FORMAT') { tokenizeDateFmt(String(p.v)); SESSION.nls.dateFmt = String(p.v); }
        else if (p.p === 'NLS_TIMESTAMP_FORMAT') SESSION.nls.tsFmt = String(p.v);
      }
      return { msg: 'Session wurde geändert.' };
    }
    case 'alterTrigger': {
      const t = DB.triggers[st.name]; if (!t) throw oraErr('04080', '\'' + st.name + '\'');
      if (st.act === 'ENABLE') t.enabled = true; else if (st.act === 'DISABLE') t.enabled = false;
      return { msg: 'Trigger ' + st.name + ' wurde geändert.' };
    }
    case 'alterSeq': {
      const s = DB.seqs[st.name]; if (!s) throw oraErr('02289');
      const o = st.o;
      if (o.inc !== undefined) { s.next = s.next - s.inc + o.inc; s.inc = o.inc; }
      if (o.max !== undefined) s.max = o.max; if (o.min !== undefined) s.min = o.min; if (o.cycle !== undefined) s.cycle = o.cycle;
      if (o.restart !== undefined) s.next = o.restart === true ? s.start : o.restart;
      return { msg: 'Sequence ' + st.name + ' wurde geändert.' };
    }
    case 'noop': return { msg: (st.what || 'Anweisung') + ' – in der Sandbox ohne Wirkung.' };
    case 'desc': return describe(st.name);
    case 'prompt': return { msg: st.text, plain: true };
    case 'sqlplus': {
      const w = st.words;
      if (st.kind === 'set') {
        if (w[1] === 'SERVEROUTPUT') SESSION.outEnabled = w[2] !== 'OFF';
        return { silent: true };
      }
      if (st.kind === 'show') {
        if (w[1] === 'ERRORS' || w[1] === 'ERR') {
          if (!SESSION.lastErrors.length) return { msg: 'Keine Fehler.' };
          return { grid: { cols: ['LINE/COL', 'ERROR'], types: [], rows: SESSION.lastErrors.map(e => [e.line + '/' + e.col, e.text]) } };
        }
        if (w[1] === 'USER') return { msg: 'USER ist "' + SCHEMA + '"' };
        if (w[1] === 'TABLES') return { msg: 'SHOW TABLES gibt es in Oracle nicht – nutze SELECT table_name FROM user_tables; oder den Objekt-Browser links.' };
        return { msg: 'SHOW ' + w.slice(1).join(' ') + ' – in der Sandbox nicht verfügbar.' };
      }
      return { silent: true };
    }
  }
  throw oraErr('00900');
}
function describe(name) {
  if (DB.synonyms[name]) name = DB.synonyms[name].target;
  if (DB.tables[name]) {
    const t = DB.tables[name];
    return { grid: { cols: ['Name', 'Null?', 'Typ'], types: [], rows: t.cols.map(c => [c.name, (c.notNull || c.pkNotNull) ? 'NOT NULL' : null, typeText(c.type)]) }, caption: 'Tabelle ' + name };
  }
  if (DB.views[name]) {
    const d = tableData(name, { f: null });
    return { grid: { cols: ['Name', 'Null?', 'Typ'], types: [], rows: d.cols.map((c, i) => [c, null, typeText(d.types[i]) || 'VARCHAR2']) }, caption: 'View ' + name };
  }
  if (DB.procs[name]) {
    const p = DB.procs[name];
    const rows = p.params.map(x => [x.name, x.type.txt || typeText(x.type), x.mode, x.def ? 'ja' : null]);
    if (p.kind === 'FUNCTION') rows.unshift(['<return value>', p.ret.txt || typeText(p.ret), 'OUT', null]);
    return { grid: { cols: ['Argumentname', 'Typ', 'In/Out', 'Default?'], types: [], rows }, caption: p.kind + ' ' + name };
  }
  if (DB.pkgs[name]) {
    const rows = DB.pkgs[name].spec.decls.map(d => d.k === 'subprog' ? [d.def.kind, d.def.name, d.def.params.map(p => p.name + ' ' + p.mode + ' ' + (p.type.txt || '')).join(', ') + (d.def.ret ? ' RETURN ' + d.def.ret.txt : '')] : [d.k.toUpperCase(), d.name, d.type ? d.type.txt : '']);
    return { grid: { cols: ['Art', 'Name', 'Signatur'], types: [], rows }, caption: 'PACKAGE ' + name };
  }
  const e = oraErr('04043', name); throw e;
}

// ---------- Anzeige ----------
function fmtCell(v) {
  if (v === null || v === undefined) return null;
  if (isNum(v)) return numDisplay(v);
  if (isDate(v)) return v.isTs ? fmtDate(v, SESSION.nls.tsFmt) : fmtDate(v, SESSION.nls.dateFmt);
  if (isBool(v)) return v ? 'TRUE' : 'FALSE';
  if (v instanceof Rec) return v.objType ? v.objType + '(' + v.names.map(n => fmtCell(v.get(n)) ?? 'NULL').join(', ') + ')' : '(' + v.names.map(n => n + '=' + (fmtCell(v.get(n)) ?? 'NULL')).join(', ') + ')';
  if (v instanceof Coll) return (v.type.name || 'COLLECTION') + '(' + v.keys().map(k => fmtCell(v.map.get(k)) ?? 'NULL').join(', ') + ')';
  if (v instanceof CursorState) return '(CURSOR)';
  if (v && v.interval) return intervalToStr(v);
  return String(v);
}
function gridOut(r, max) {
  max = max || 1000;
  const kinds = r.cols.map((c, i) => { for (const row of r.rows) { const k = valueKind(row[i]); if (k) return k; } const t = r.types && r.types[i]; return t && (t.b === 'NUMBER' || t.b === 'PLS_INTEGER') ? 'num' : 'str'; });
  return { cols: r.cols, kinds, rows: r.rows.slice(0, max).map(row => row.map(fmtCell)), total: r.rows.length };
}
function errOut(e, item) {
  if (e instanceof AbortError) return { code: 'ABBRUCH', message: e.message, stack: [], hint: null, line: SESSION.lastLine || item.line };
  if (!(e instanceof OraError)) return { code: 'ORA-00600', message: 'Interner Fehler der Sandbox: ' + (e && e.message), stack: [], hint: 'Das ist ein Fehler im Simulator, nicht in deinem SQL. Bitte die Anweisung vereinfachen.', line: item.line, internal: String(e && e.stack || e) };
  const end = item.line + (item.text.match(/\n/g) || []).length;
  let line = e.scriptLine || null;
  if (!line && e.line && (e.parse || (e.line >= item.line && e.line <= end))) line = e.line;
  return { code: e.code, message: e.userExc ? ORA_MSG['06510'] : e.message, stack: e.oraStack || [], hint: e.hint || null, line: line || item.line, col: e.col || null };
}
function runScript(text, opts) {
  opts = opts || {};
  SESSION.trace = opts.trace ? [] : null; SESSION.traceTrunc = false;
  let hidden = 0;
  let items;
  try { items = parseScript(text); }
  catch (e) { return { results: [{ line: 1, text: text.split('\n')[0], error: errOut(e, { line: 1, text }) }] }; }
  const results = [];
  const compact = items.length > (opts.compactOver !== undefined ? opts.compactOver : 400);
  if (compact) SESSION.trace = null;
  let done = 0;
  for (const item of items) {
    done++; if (opts.progress && done % 250 === 0) opts.progress(done, items.length);
    const r = { line: item.line, text: item.text, endLine: item.line + (item.text.match(/\n/g) || []).length };
    if (SESSION.trace) { if (SESSION.trace.length < SESSION.traceMax) SESSION.trace.push({ t: 'stmt', i: results.length, line: item.line, end: r.endLine }); else if (!SESSION.traceTrunc) { SESSION.traceTrunc = true; SESSION.trace.push({ t: 'trunc' }); } }
    SESSION.steps = 0; SESSION.out = []; SESSION.lineBuf = ''; SESSION.implicitResults = []; SESSION.depth = 0; SESSION.queryDepth = 0; SESSION.ctx = 'sql'; SESSION.trig = []; SESSION.mutating = new Set();
    SESSION.undo = SESSION.undo.filter(m => m.kind !== 'stmt');
    if (item.error) {
      r.error = errOut(item.error, item);
      if (item.pl) { const m = item.text.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\s+(?:"?\w+"?\.)?"?([\w$#]+)/i); SESSION.lastErrors = [{ name: m ? m[2].toUpperCase() : null, type: m ? m[1].toUpperCase().replace(/\s+/, ' ') : 'ANONYMOUS BLOCK', line: item.error.line || item.line, col: item.error.col || 0, text: item.error.message.replace(/^Zeile \d+, Spalte \d+:\n/, '') }]; }
    } else {
      try {
        const res = execStatement(item.stmt, { f: null });
        if (res.grid) r.grid = gridOut(res.grid);
        if (res.msg) r.msg = res.msg;
        if (res.plain) r.plain = true;
        if (res.caption) r.caption = res.caption;
        if (res.silent) r.silent = true;
      } catch (e) {
        r.error = errOut(e, item);
      }
    }
    if (SESSION.lineBuf) { SESSION.out.push(SESSION.lineBuf); SESSION.lineBuf = ''; }
    if (SESSION.out.length && SESSION.outEnabled) r.output = SESSION.out.slice();
    if (SESSION.implicitResults.length) r.implicit = SESSION.implicitResults.map(x => gridOut(x));
    if (SESSION.trace) { if (r.error) SESSION.trace.push({ t: 'err', i: results.length, line: r.error.line, code: r.error.code }); SESSION.trace.push({ t: 'done', i: results.length }); }
    if (compact && !r.error && !r.grid && !r.output && !r.implicit && done < items.length - 3) { hidden++; continue; }
    results.push(r);
  }
  const trace = SESSION.trace; SESSION.trace = null;
  return { results, trace, hidden, total: items.length };
}
function splitStatements(text) {
  try { return parseScript(text).map(i => ({ start: i.start, end: i.end, line: i.line })); } catch (e) { return []; }
}

// ---------- Data Dictionary ----------
function dictRows(name) {
  const base = name.replace(/^(ALL|DBA)_/, 'USER_');
  const T = Object.values(DB.tables), V = Object.values(DB.views);
  const typeParts = (t) => ({ dt: t ? (t.b === 'OBJ' ? t.name : t.b === 'VARCHAR2' ? (t.orig || 'VARCHAR2') : t.b === 'PLS_INTEGER' ? 'NUMBER' : t.b === 'TIMESTAMP' ? 'TIMESTAMP(6)' : t.b) : 'VARCHAR2', len: t ? (t.b === 'VARCHAR2' || t.b === 'CHAR' ? t.len : t.b === 'DATE' ? 7 : t.b === 'NUMBER' ? 22 : t.b === 'TIMESTAMP' ? 11 : 4000) : 4000, p: t && t.b === 'NUMBER' && !t.int ? t.p : null, s: t && t.b === 'NUMBER' ? (t.int ? 0 : t.s) : null });
  switch (base) {
    case 'USER_TABLES': return { cols: ['TABLE_NAME', 'TABLESPACE_NAME', 'NUM_ROWS', 'TEMPORARY'], rows: T.map(t => [t.name, 'USERS', t.rows.length, t.temp ? 'Y' : 'N']) };
    case 'USER_TAB_COLUMNS': case 'USER_TAB_COLS': {
      const rows = [];
      for (const t of T) t.cols.forEach((c, i) => { const p = typeParts(c.type); rows.push([t.name, c.name, p.dt, p.len, p.p, p.s, (c.notNull || c.pkNotNull) ? 'N' : 'Y', i + 1, c.defaultText || null]); });
      for (const v of V) { let d; try { d = tableData(v.name, { f: null }); } catch (e) { continue; } d.cols.forEach((c, i) => { const p = typeParts(d.types[i]); rows.push([v.name, c, p.dt, p.len, p.p, p.s, 'Y', i + 1, null]); }); }
      return { cols: ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'DATA_LENGTH', 'DATA_PRECISION', 'DATA_SCALE', 'NULLABLE', 'COLUMN_ID', 'DATA_DEFAULT'], rows };
    }
    case 'USER_VIEWS': return { cols: ['VIEW_NAME', 'TEXT_LENGTH', 'TEXT'], rows: V.map(v => [v.name, (v.qText || '').length, v.qText]) };
    case 'USER_OBJECTS': {
      const rows = [];
      const add = (n, t, c, st) => rows.push([n, t, st || 'VALID', c ? new Date(c) : nowDate(), c ? new Date(c) : nowDate(), ++DB.objSeq]);
      T.forEach(t => add(t.name, 'TABLE', t.created)); V.forEach(v => add(v.name, 'VIEW', v.created));
      Object.values(DB.seqs).forEach(s => add(s.name, 'SEQUENCE', s.created));
      Object.values(DB.procs).forEach(p => add(p.name, p.kind, p.created));
      Object.values(DB.pkgs).forEach(p => { add(p.name, 'PACKAGE', p.created); if (p.body) add(p.name, 'PACKAGE BODY', p.created); });
      Object.values(DB.triggers).forEach(t => add(t.name, 'TRIGGER', t.created));
      Object.values(DB.indexes).forEach(i => add(i.name, 'INDEX', i.created));
      Object.values(DB.types).forEach(t => add(t.name, 'TYPE', t.created));
      Object.values(DB.synonyms).forEach(t => add(t.name, 'SYNONYM'));
      return { cols: ['OBJECT_NAME', 'OBJECT_TYPE', 'STATUS', 'CREATED', 'LAST_DDL_TIME', 'OBJECT_ID'], rows };
    }
    case 'USER_CONSTRAINTS': {
      const rows = [];
      for (const t of T) {
        t.cols.forEach(c => { if (c.notNull) rows.push([c.nnName || ('SYS_NN_' + t.name + '_' + c.name).slice(0, 30), 'C', t.name, '"' + c.name + '" IS NOT NULL', null, null, 'ENABLED', c.nnName ? 'USER NAME' : 'GENERATED NAME']); });
        for (const k of t.cons) rows.push([k.name, k.type, t.name, k.type === 'C' ? k.checkText : null, k.type === 'R' ? k.refCons : null, k.type === 'R' ? (k.onDelete || 'NO ACTION') : null, k.enabled === false ? 'DISABLED' : 'ENABLED', /^SYS_/.test(k.name) ? 'GENERATED NAME' : 'USER NAME']);
      }
      return { cols: ['CONSTRAINT_NAME', 'CONSTRAINT_TYPE', 'TABLE_NAME', 'SEARCH_CONDITION', 'R_CONSTRAINT_NAME', 'DELETE_RULE', 'STATUS', 'GENERATED'], rows };
    }
    case 'USER_CONS_COLUMNS': { const rows = []; for (const t of T) for (const k of t.cons) k.cols.forEach((c, i) => rows.push([k.name, t.name, c, i + 1])); return { cols: ['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'POSITION'], rows }; }
    case 'USER_SEQUENCES': return { cols: ['SEQUENCE_NAME', 'MIN_VALUE', 'MAX_VALUE', 'INCREMENT_BY', 'CYCLE_FLAG', 'CACHE_SIZE', 'LAST_NUMBER'], rows: Object.values(DB.seqs).map(s => [s.name, s.min != null ? s.min : 1, s.max != null ? s.max : 9.999999999999999e27, s.inc, s.cycle ? 'Y' : 'N', s.cache || 0, s.next]) };
    case 'USER_TRIGGERS': return { cols: ['TRIGGER_NAME', 'TRIGGER_TYPE', 'TRIGGERING_EVENT', 'TABLE_NAME', 'STATUS', 'TRIGGER_BODY'], rows: Object.values(DB.triggers).map(t => [t.name, t.timing + (t.row ? ' EACH ROW' : ' STATEMENT'), t.events.join(' OR '), t.table, t.enabled ? 'ENABLED' : 'DISABLED', t.text]) };
    case 'USER_SOURCE': {
      const rows = [];
      const add = (n, t, txt) => (txt || '').split('\n').forEach((l, i) => rows.push([n, t, i + 1, l]));
      Object.values(DB.procs).forEach(p => add(p.name, p.kind, p.text));
      Object.values(DB.pkgs).forEach(p => { add(p.name, 'PACKAGE', p.spec.text); if (p.body) add(p.name, 'PACKAGE BODY', p.body.text); });
      Object.values(DB.triggers).forEach(t => add(t.name, 'TRIGGER', t.text));
      Object.values(DB.types).forEach(t => add(t.name, 'TYPE', t.text));
      return { cols: ['NAME', 'TYPE', 'LINE', 'TEXT'], rows };
    }
    case 'USER_PROCEDURES': { const rows = []; Object.values(DB.procs).forEach(p => rows.push([p.name, null, p.kind])); Object.values(DB.pkgs).forEach(p => p.spec.decls.filter(d => d.k === 'subprog').forEach(d => rows.push([p.name, d.def.name, 'PACKAGE']))); return { cols: ['OBJECT_NAME', 'PROCEDURE_NAME', 'OBJECT_TYPE'], rows }; }
    case 'USER_ARGUMENTS': { const rows = []; Object.values(DB.procs).forEach(p => { if (p.ret) rows.push([p.name, null, 0, p.ret.txt, 'OUT']); p.params.forEach((a, i) => rows.push([p.name, a.name, i + 1, a.type.txt, a.mode])); }); return { cols: ['OBJECT_NAME', 'ARGUMENT_NAME', 'POSITION', 'DATA_TYPE', 'IN_OUT'], rows }; }
    case 'USER_INDEXES': return { cols: ['INDEX_NAME', 'TABLE_NAME', 'UNIQUENESS', 'INDEX_TYPE', 'GENERATED'], rows: Object.values(DB.indexes).map(i => [i.name, i.table, i.unique ? 'UNIQUE' : 'NONUNIQUE', 'NORMAL', i.auto ? 'Y' : 'N']) };
    case 'USER_IND_COLUMNS': { const rows = []; Object.values(DB.indexes).forEach(i => i.cols.forEach((c, k) => rows.push([i.name, i.table, c, k + 1]))); return { cols: ['INDEX_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'COLUMN_POSITION'], rows }; }
    case 'USER_TAB_COMMENTS': return { cols: ['TABLE_NAME', 'TABLE_TYPE', 'COMMENTS'], rows: T.map(t => [t.name, 'TABLE', DB.comments[t.name] || null]).concat(V.map(v => [v.name, 'VIEW', DB.comments[v.name] || null])) };
    case 'USER_COL_COMMENTS': { const rows = []; for (const t of T) t.cols.forEach(c => rows.push([t.name, c.name, DB.comments[t.name + '.' + c.name] || null])); return { cols: ['TABLE_NAME', 'COLUMN_NAME', 'COMMENTS'], rows }; }
    case 'USER_ERRORS': return { cols: ['NAME', 'TYPE', 'LINE', 'POSITION', 'TEXT'], rows: SESSION.lastErrors.map(e => [e.name || null, e.type || null, e.line, e.col, e.text]) };
    case 'USER_TYPES': return { cols: ['TYPE_NAME', 'TYPECODE'], rows: Object.values(DB.types).map(t => [t.name, t.def.k === 'record' ? 'OBJECT' : 'COLLECTION']) };
    case 'USER_SYNONYMS': return { cols: ['SYNONYM_NAME', 'TABLE_OWNER', 'TABLE_NAME'], rows: Object.values(DB.synonyms).map(s => [s.name, SCHEMA, s.target]) };
    case 'USER_USERS': return { cols: ['USERNAME', 'USER_ID', 'DEFAULT_TABLESPACE', 'CREATED'], rows: [[SCHEMA, 101, 'USERS', nowDate()]] };
  }
  switch (name) {
    case 'TAB': return { cols: ['TNAME', 'TABTYPE', 'CLUSTERID'], rows: T.map(t => [t.name, 'TABLE', null]).concat(V.map(v => [v.name, 'VIEW', null])) };
    case 'CAT': return { cols: ['TABLE_NAME', 'TABLE_TYPE'], rows: T.map(t => [t.name, 'TABLE']).concat(V.map(v => [v.name, 'VIEW'])).concat(Object.values(DB.seqs).map(s => [s.name, 'SEQUENCE'])) };
    case 'DICTIONARY': case 'DICT': return { cols: ['TABLE_NAME', 'COMMENTS'], rows: DICT_VIEWS.map(d => [d[0], d[1]]) };
    case 'V$VERSION': return { cols: ['BANNER'], rows: [['Oracle-Sandbox (Simulation im Browser) – Syntax angelehnt an Oracle Database 19c/23ai']] };
    case 'NLS_SESSION_PARAMETERS': return { cols: ['PARAMETER', 'VALUE'], rows: [['NLS_LANGUAGE', 'GERMAN'], ['NLS_TERRITORY', 'GERMANY'], ['NLS_DATE_FORMAT', SESSION.nls.dateFmt], ['NLS_TIMESTAMP_FORMAT', SESSION.nls.tsFmt], ['NLS_NUMERIC_CHARACTERS', '.,']] };
  }
  return null;
}
const DICT_VIEWS = [['USER_TABLES', 'Eigene Tabellen'], ['USER_TAB_COLUMNS', 'Spalten eigener Tabellen und Views'], ['USER_VIEWS', 'Eigene Views mit Definition'], ['USER_OBJECTS', 'Alle eigenen Objekte'], ['USER_CONSTRAINTS', 'Constraints'], ['USER_CONS_COLUMNS', 'Spalten der Constraints'], ['USER_SEQUENCES', 'Sequenzen'], ['USER_TRIGGERS', 'Trigger'], ['USER_SOURCE', 'Quelltext von Prozeduren, Funktionen, Packages, Triggern'], ['USER_PROCEDURES', 'Prozeduren und Funktionen'], ['USER_ARGUMENTS', 'Parameter von Prozeduren/Funktionen'], ['USER_INDEXES', 'Indizes'], ['USER_IND_COLUMNS', 'Index-Spalten'], ['USER_TAB_COMMENTS', 'Tabellenkommentare'], ['USER_COL_COMMENTS', 'Spaltenkommentare'], ['USER_ERRORS', 'Letzte Kompilierfehler'], ['USER_TYPES', 'Eigene Typen'], ['USER_SYNONYMS', 'Synonyme'], ['TAB', 'Tabellen und Views (Kurzform)'], ['CAT', 'Katalog (Kurzform)'], ['NLS_SESSION_PARAMETERS', 'NLS-Einstellungen'], ['V$VERSION', 'Versionsinfo']];
function dictView(name) {
  const r = dictRows(name);
  if (!r) return null;
  let cols = r.cols, rows = r.rows;
  if (/^(ALL|DBA)_/.test(name) && dictRows(name.replace(/^(ALL|DBA)_/, 'USER_'))) { cols = ['OWNER'].concat(cols); rows = rows.map(x => [SCHEMA].concat(x)); }
  return { cols, types: [], rows };
}

// ---------- Katalog für die UI ----------
function catalog() {
  SESSION.steps = 0; SESSION.queryDepth = 0; SESSION.ctx = 'sql';
  const prev = (cols, rows, types) => gridOut({ cols, rows, types }, 200);
  const tables = Object.values(DB.tables).sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
    name: t.name, count: t.rows.length,
    cols: t.cols.map(c => ({ name: c.name, type: typeText(c.type), nn: !!(c.notNull || c.pkNotNull), pk: t.cons.some(k => k.type === 'P' && k.cols.includes(c.name)), fk: (t.cons.find(k => k.type === 'R' && k.cols.includes(c.name)) || {}).refTable || null, def: c.identity ? 'IDENTITY' : (c.defaultText || null) })),
    cons: t.cons.map(k => ({ name: k.name, type: k.type, cols: k.cols, ref: k.refTable ? k.refTable + '(' + k.refCols.join(', ') + ')' : null, check: k.checkText || null, onDelete: k.onDelete || null, enabled: k.enabled !== false })),
    triggers: Object.values(DB.triggers).filter(x => x.table === t.name).map(x => x.name),
    preview: prev(t.cols.map(c => c.name), t.rows, t.cols.map(c => c.type)),
    ddl: tableDDL(t),
  }));
  const views = Object.values(DB.views).sort((a, b) => a.name.localeCompare(b.name)).map(v => {
    let preview = null, error = null;
    try { const d = tableData(v.name, { f: null }); preview = prev(d.cols, d.rows, d.types); } catch (e) { error = e.code ? e.code + ': ' + e.message : String(e); }
    return { name: v.name, text: v.text || ('CREATE OR REPLACE VIEW ' + v.name + ' AS\n' + v.qText), preview, error, count: preview ? preview.total : null };
  });
  const seqs = Object.values(DB.seqs).map(s => ({ name: s.name, next: s.next, inc: s.inc, curr: SESSION.seqCurr[s.name] !== undefined ? SESSION.seqCurr[s.name] : null, text: 'CREATE SEQUENCE ' + s.name + ' START WITH ' + s.start + ' INCREMENT BY ' + s.inc + (s.max != null ? ' MAXVALUE ' + s.max : '') + (s.cycle ? ' CYCLE' : '') + ';' }));
  const procs = Object.values(DB.procs).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ name: p.name, kind: p.kind, sig: '(' + p.params.map(x => x.name.toLowerCase() + (x.mode !== 'IN' ? ' ' + x.mode : '') + ' ' + (x.type.txt || '').toLowerCase()).join(', ') + ')' + (p.ret ? ' → ' + (p.ret.txt || '').toLowerCase() : ''), text: p.text }));
  const pkgs = Object.values(DB.pkgs).map(p => ({ name: p.name, hasBody: !!p.body, members: p.spec.decls.map(d => d.k === 'subprog' ? (d.def.kind === 'FUNCTION' ? 'ƒ ' : 'ᴘ ') + d.def.name : (d.k === 'var' ? '· ' + d.name : d.k + ' ' + d.name)), text: p.spec.text + (p.body ? '\n\n' + p.body.text : '') }));
  const triggers = Object.values(DB.triggers).map(t => ({ name: t.name, table: t.table, desc: t.timing + ' ' + t.events.join(' OR ') + (t.row ? ', FOR EACH ROW' : ', Statement'), enabled: t.enabled, text: t.text }));
  const types = Object.values(DB.types).map(t => ({ name: t.name, text: t.text }));
  const indexes = Object.values(DB.indexes).filter(i => !i.auto).map(i => ({ name: i.name, table: i.table, cols: i.cols, unique: i.unique }));
  return { tables, views, seqs, procs, pkgs, triggers, types, indexes, tx: { open: hasTx() && dirtyTables().length > 0, tables: dirtyTables() }, nls: SESSION.nls };
}

// ---------- DDL-Export ----------
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (isNum(v)) return numDisplay(v);
  if (isBool(v)) return v ? 'TRUE' : 'FALSE';
  if (v instanceof Rec) return v.objType ? v.objType + '(' + v.names.map(n => sqlLit(v.get(n))).join(', ') + ')' : 'NULL';
  if (isDate(v)) return v.isTs ? "TO_TIMESTAMP('" + fmtDate(v, 'YYYY-MM-DD HH24:MI:SS.FF3') + "', 'YYYY-MM-DD HH24:MI:SS.FF3')" : (dParts(v).hh || dParts(v).mi || dParts(v).ss ? "TO_DATE('" + fmtDate(v, 'YYYY-MM-DD HH24:MI:SS') + "', 'YYYY-MM-DD HH24:MI:SS')" : "DATE '" + fmtDate(v, 'YYYY-MM-DD') + "'");
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function consDDL(k) {
  const nm = /^SYS_C/.test(k.name) ? '' : 'CONSTRAINT ' + k.name.toLowerCase() + ' ';
  if (k.type === 'P') return nm + 'PRIMARY KEY (' + k.cols.join(', ').toLowerCase() + ')';
  if (k.type === 'U') return nm + 'UNIQUE (' + k.cols.join(', ').toLowerCase() + ')';
  if (k.type === 'C') return nm + 'CHECK (' + k.checkText + ')';
  if (k.type === 'R') return nm + 'FOREIGN KEY (' + k.cols.join(', ').toLowerCase() + ') REFERENCES ' + k.refTable.toLowerCase() + ' (' + k.refCols.join(', ').toLowerCase() + ')' + (k.onDelete ? ' ON DELETE ' + k.onDelete : '');
}
function tableDDL(t, noFk, forExport) {
  const w = Math.max(...t.cols.map(c => c.name.length));
  const lines = t.cols.map(c => '  ' + c.name.toLowerCase().padEnd(w + 1) + typeText(c.type).replace(' BYTE', '') + (c.identity ? (forExport ? ' GENERATED BY DEFAULT AS IDENTITY (START WITH ' + ((t.ident && t.ident[c.name]) || c.identity.start) + ' INCREMENT BY ' + c.identity.inc + ')' : ' GENERATED ' + (c.identity.always ? 'ALWAYS' : 'BY DEFAULT') + ' AS IDENTITY') : '') + (c.virtual ? '' : (c.defaultText ? ' DEFAULT ' + c.defaultText : '')) + (c.notNull && !c.identity ? ' NOT NULL' : ''));
  for (const k of t.cons) if (!(noFk && k.type === 'R')) lines.push('  ' + consDDL(k));
  return 'CREATE TABLE ' + t.name.toLowerCase() + ' (\n' + lines.join(',\n') + '\n);';
}
function exportSQL() {
  const out = ['-- Export der Oracle-Sandbox, ' + fmtDate(nowDate(), 'DD.MM.YYYY HH24:MI'), ''];
  const T = Object.values(DB.tables);
  for (const t of T) out.push(tableDDL(t, true, true), '');
  for (const t of T) for (const k of t.cons) if (k.type === 'R') out.push('ALTER TABLE ' + t.name.toLowerCase() + ' ADD ' + consDDL(k) + ';');
  out.push('');
  for (const ix of Object.values(DB.indexes)) if (!ix.auto) out.push('CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + ix.name.toLowerCase() + ' ON ' + ix.table.toLowerCase() + ' (' + ix.cols.join(', ').toLowerCase() + ');');
  for (const s of Object.values(DB.seqs)) out.push('CREATE SEQUENCE ' + s.name.toLowerCase() + ' START WITH ' + s.next + ' INCREMENT BY ' + s.inc + (s.max != null ? ' MAXVALUE ' + s.max : '') + (s.min != null ? ' MINVALUE ' + s.min : '') + (s.cycle ? ' CYCLE' : '') + ';');
  out.push('');
  for (const t of T) if (t.rows.length) {
    const cols = t.cols.filter(c => !c.virtual);
    const idx = cols.map(c => t.cols.indexOf(c));
    for (const r of t.rows) out.push('INSERT INTO ' + t.name.toLowerCase() + ' (' + cols.map(c => c.name.toLowerCase()).join(', ') + ') VALUES (' + idx.map(i => sqlLit(r[i])).join(', ') + ');');
    out.push('');
  }
  out.push('COMMIT;', '');
  for (const ty of Object.values(DB.types)) out.push(ty.text.trim().replace(/;?\s*$/, ';'), '/', '');
  for (const v of Object.values(DB.views)) out.push((v.text || 'CREATE OR REPLACE VIEW ' + v.name + ' AS ' + v.qText).trim().replace(/;?\s*$/, ';'), '');
  for (const p of Object.values(DB.pkgs)) { out.push(p.spec.text.trim(), '/', ''); if (p.body) out.push(p.body.text.trim(), '/', ''); }
  for (const p of Object.values(DB.procs)) out.push(p.text.trim(), '/', '');
  for (const t of Object.values(DB.triggers)) out.push(t.text.trim(), '/', '');
  return out.join('\n');
}

// ---------- Persistenz ----------
function saveState() {
  return JSON.stringify({ v: 1, db: DB, nls: SESSION.nls }, function (k, v) {
    const o = this[k];
    if (o instanceof Date) return { $d: o.getTime(), ts: !!o.isTs };
    if (o instanceof Rec) return { $rec: o.objType || '', n: o.names, v: o.names.map(x => o.vals[x]) };
    if (k === '_srcs' || k === '_busy' || k === 'rowType' || k === '_uk' || k === '_ukSig' || k === '_ukLen') return undefined;
    return v;
  });
}
function loadState(str) {
  const o = JSON.parse(str, (k, v) => {
    if (v && typeof v === 'object' && v.$d !== undefined && Object.keys(v).length <= 2) { const d = new Date(v.$d); if (v.ts) d.isTs = true; return d; }
    if (v && typeof v === 'object' && v.$rec !== undefined && Array.isArray(v.n)) { const r = Object.create(Rec.prototype); r.names = v.n; r.vals = {}; r.types = {}; v.n.forEach((x, i) => { r.vals[x] = v.v[i]; r.types[x] = null; }); if (v.$rec) r.objType = v.$rec; return r; }
    return v;
  });
  DB = Object.assign(freshDB(), o.db);
  if (o.nls) SESSION.nls = Object.assign(SESSION.nls, o.nls);
  resetSession();
}
function resetSession() { SESSION.seqCurr = {}; SESSION.pkgState = {}; SESSION.undo = []; SESSION.out = []; SESSION.lastErrors = []; SESSION.binds = []; SESSION.trig = []; SESSION.mutating = new Set(); SESSION.outEnabled = true; }
function resetDB() { DB = freshDB(); resetSession(); SESSION.nls = { dateFmt: 'DD.MM.YYYY', tsFmt: 'DD.MM.YYYY HH24:MI:SS,FF6' }; }
DB = freshDB();
