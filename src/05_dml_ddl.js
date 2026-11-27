// ===== Transaktionen, DML, DDL =====
function hasTx() { return SESSION.undo.some(m => m.kind === 'tx'); }
function ensureTx() { if (!hasTx()) SESSION.undo.unshift({ kind: 'tx', map: new Map() }); }
function touch(tbl) {
  ensureTx(); tbl._uk = null;
  for (const m of SESSION.undo) { const v = m.map.get(tbl); if (!v) m.map.set(tbl, tbl.rows.slice()); else if (v.app !== undefined) m.map.set(tbl, tbl.rows.slice(0, v.app)); }
}
function touchAppend(tbl) { ensureTx(); for (const m of SESSION.undo) if (!m.map.has(tbl)) m.map.set(tbl, m.kind === 'stmt' ? { app: tbl.rows.length } : tbl.rows.slice()); }
function restoreMap(map) {
  for (const [tbl, rows] of map) {
    if (DB.tables[tbl.name] !== tbl) continue;
    tbl._uk = null;
    if (rows.app !== undefined) { tbl.rows = tbl.rows.slice(0, rows.app); continue; }
    if (!rows.length || rows[0].length === tbl.cols.length) tbl.rows = rows.slice();
  }
}
function beginStmt() { const m = { kind: 'stmt', map: new Map() }; SESSION.undo.push(m); return m; }
function endStmt(m, ok) { if (!ok) restoreMap(m.map); const i = SESSION.undo.indexOf(m); if (i >= 0) SESSION.undo.splice(i, 1); }
function doCommit() { SESSION.undo = SESSION.undo.filter(m => m.kind === 'stmt'); }
function doRollback(to) {
  if (to) {
    const i = SESSION.undo.findIndex(m => m.kind === 'sp' && m.name === to);
    if (i < 0) throw new OraError('ORA-01086', 'Savepoint \'' + to + '\' wurde in dieser Session nie eingerichtet oder ist ungültig');
    const sp = SESSION.undo[i];
    restoreMap(sp.map);
    SESSION.undo = SESSION.undo.filter((m, k) => !(m.kind === 'sp' && k > i));
    sp.map = new Map();
    return;
  }
  const tx = SESSION.undo.find(m => m.kind === 'tx');
  if (tx) restoreMap(tx.map);
  SESSION.undo = SESSION.undo.filter(m => m.kind === 'stmt');
}
function doSavepoint(name) {
  ensureTx();
  SESSION.undo = SESSION.undo.filter(m => !(m.kind === 'sp' && m.name === name));
  SESSION.undo.push({ kind: 'sp', name, map: new Map() });
}
function dirtyTables() { const tx = SESSION.undo.find(m => m.kind === 'tx'); return tx ? Array.from(tx.map.keys()).filter(t => DB.tables[t.name] === t).map(t => t.name) : []; }

function newConName() { DB.conSeq++; return 'SYS_C00' + DB.conSeq; }
function objExists(name) { return !!(DB.tables[name] || DB.views[name] || DB.seqs[name] || DB.procs[name] || DB.pkgs[name] || DB.types[name] || DB.synonyms[name]); }
function objType(name) { return DB.tables[name] ? 'TABLE' : DB.views[name] ? 'VIEW' : DB.seqs[name] ? 'SEQUENCE' : DB.procs[name] ? DB.procs[name].kind : DB.pkgs[name] ? 'PACKAGE' : DB.types[name] ? 'TYPE' : DB.synonyms[name] ? 'SYNONYM' : null; }
function stamp() { return new Date().toISOString(); }

// ---------- Constraints ----------
function colIdx(tbl, name, node) {
  const i = tbl.cols.findIndex(c => c.name === name);
  if (i < 0) { const e = oraErr('00904', '"' + name + '"'); if (node) { e.line = node.line; e.col = node.col; } throw e; }
  return i;
}
function tblSrcs(tbl, alias) { return mkSrcs([mkSrc(tbl.name, alias, tbl.cols.map(c => c.name), tbl.cols.map(c => c.type), { tbl })]); }
function checkRow(tbl, row, op, env) {
  tbl.cols.forEach((c, i) => {
    if (row[i] === null && (c.notNull || tbl.cons.some(k => k.type === 'P' && k.enabled !== false && k.cols.includes(c.name)))) {
      throw oraErr(op === 'UPDATE' ? '01407' : '01400', '"' + SCHEMA + '"."' + tbl.name + '"."' + c.name + '"');
    }
  });
  const checks = tbl.cons.filter(k => k.type === 'C' && k.enabled !== false);
  if (checks.length) {
    const srcs = tbl._srcs || (tbl._srcs = tblSrcs(tbl));
    if (srcs[0].cols.length !== tbl.cols.length) tbl._srcs = null;
    const s2 = tbl._srcs || (tbl._srcs = tblSrcs(tbl));
    for (const k of checks) {
      const v = toBool(ev(k.check, { f: null, rs: { srcs: s2, vals: [row], parent: null } }));
      if (v === false) throw oraErr('02290', SCHEMA + '.' + k.name);
    }
  }
}
function uniqueSets(tbl) {
  const out = tbl.cons.filter(k => (k.type === 'P' || k.type === 'U') && k.enabled !== false).map(k => ({ name: k.name, cols: k.cols }));
  for (const ix of Object.values(DB.indexes)) if (ix.table === tbl.name && ix.unique && !ix.auto) {
    if (ix.cols.every(c => tbl.cols.some(x => x.name === c))) out.push({ name: ix.name, cols: ix.cols });
  }
  return out;
}
function validateTables(modified, op, changed) {
  for (const tbl of modified) {
    const us = uniqueSets(tbl);
    const sig = us.map(u => u.name + ':' + u.cols.join(',')).join('|');
    if (op === 'INSERT' && changed && changed.length && tbl._uk && tbl._ukSig === sig && tbl._ukLen === tbl.rows.length - changed.length) {
      for (const u of us) {
        const idx = u.cols.map(c => tbl.cols.findIndex(x => x.name === c)); const set = tbl._uk[u.name];
        for (const r of changed) {
          const vals = idx.map(i => r[i]); if (vals.every(v => v === null)) continue;
          const k = keyOf(vals);
          if (set.has(k)) { tbl._uk = null; const e = oraErr('00001', SCHEMA + '.' + u.name); e.hint = 'Der Wert (' + vals.map(v => v === null ? 'NULL' : toStr(v)).join(', ') + ') existiert bereits in ' + tbl.name + '(' + u.cols.join(', ') + ').'; throw e; }
          set.add(k);
        }
      }
      tbl._ukLen = tbl.rows.length;
      continue;
    }
    const cache = {};
    for (const u of us) {
      const seenSet = cache[u.name] = new Set();
      const idx = u.cols.map(c => tbl.cols.findIndex(x => x.name === c));
      const seen = seenSet;
      for (const r of tbl.rows) {
        const vals = idx.map(i => r[i]);
        if (vals.every(v => v === null)) continue;
        const k = keyOf(vals);
        if (seen.has(k)) { tbl._uk = null; const e = oraErr('00001', SCHEMA + '.' + u.name); e.hint = 'Der Wert (' + vals.map(v => v === null ? 'NULL' : toStr(v)).join(', ') + ') existiert bereits in ' + tbl.name + '(' + u.cols.join(', ') + ').'; throw e; }
        seen.add(k);
      }
    }
    tbl._uk = cache; tbl._ukSig = sig; tbl._ukLen = tbl.rows.length;
  }
  const modNames = new Set(modified.map(t => t.name));
  for (const child of Object.values(DB.tables)) {
    for (const k of child.cons) {
      if (k.type !== 'R' || k.enabled === false) continue;
      const childMod = modNames.has(child.name), parentMod = modNames.has(k.refTable);
      if (!childMod && !parentMod) continue;
      const parent = DB.tables[k.refTable]; if (!parent) continue;
      const pIdx = k.refCols.map(c => parent.cols.findIndex(x => x.name === c));
      const cIdx = k.cols.map(c => child.cols.findIndex(x => x.name === c));
      const keys = new Set(parent.rows.map(r => keyOf(pIdx.map(i => r[i]))));
      for (const r of child.rows) {
        const vals = cIdx.map(i => r[i]);
        if (vals.some(v => v === null)) continue;
        if (!keys.has(keyOf(vals))) {
          const asChild = childMod && !(op === 'DELETE') && (!changed || op !== 'UPDATE' || changed.has(r) || child.name !== k.refTable);
          if (asChild) { const e = oraErr('02291', SCHEMA + '.' + k.name); e.hint = 'In ' + k.refTable + '(' + k.refCols.join(', ') + ') gibt es keinen Datensatz mit (' + vals.map(toStr).join(', ') + ').'; throw e; }
          const e = oraErr('02292', SCHEMA + '.' + k.name); e.hint = 'Es gibt noch Datensätze in ' + child.name + ', die darauf verweisen. Erst diese löschen – oder den Fremdschlüssel mit ON DELETE CASCADE anlegen.'; throw e;
        }
      }
    }
  }
}

// ---------- Trigger ----------
function triggersFor(tbl, timing, event, row, setCols) {
  return Object.values(DB.triggers).filter(t => t.table === tbl.name && t.enabled && t.timing === timing && t.events.includes(event) && t.row === row &&
    (event !== 'UPDATE' || !t.ofCols || !setCols || t.ofCols.some(c => setCols.includes(c))));
}
function rowRec(tbl, row) {
  const r = new Rec(tbl.cols.map(c => ({ name: c.name, type: c.type })));
  if (row) tbl.cols.forEach((c, i) => r.set(c.name, row[i]));
  return r;
}
function fireTriggers(trs, tbl, event, oldRow, newRow, setCols, mutating) {
  if (!trs.length) return newRow;
  let newRec = newRow ? rowRec(tbl, newRow) : rowRec(tbl, null);
  const oldRec = oldRow ? rowRec(tbl, oldRow) : rowRec(tbl, null);
  for (const t of trs) {
    const ctx = { trigger: t, event, setCols, newRec, oldRec };
    if (t.when) {
      const f = new Frame(null, 'block');
      f.vars.set(t.refNew || 'NEW', { name: 'NEW', value: newRec, type: null });
      f.vars.set(t.refOld || 'OLD', { name: 'OLD', value: oldRec, type: null });
      SESSION.trig.push(ctx);
      try { if (toBool(ev(t.when, { f })) !== true) continue; } finally { SESSION.trig.pop(); }
    }
    const f = new Frame(null, 'block');
    f.act = { line: 0, base: t.lineBase, obj: t.name, trig: true };
    f.vars.set(':' + (t.refNew || 'NEW'), { name: ':NEW', value: newRec, type: null, trigNew: t.timing !== 'BEFORE' ? 'ro' : 'rw' });
    f.vars.set(':' + (t.refOld || 'OLD'), { name: ':OLD', value: oldRec, type: null, ro: true });
    if (t.refNew !== 'NEW') f.vars.set(':NEW', f.vars.get(':' + t.refNew));
    if (t.refOld !== 'OLD') f.vars.set(':OLD', f.vars.get(':' + t.refOld));
    SESSION.trig.push(ctx);
    const added = mutating && t.row && !SESSION.mutating.has(tbl.name);
    if (added) SESSION.mutating.add(tbl.name);
    const prevCtx = SESSION.ctx; SESSION.ctx = 'plsql';
    try { execBlockIn(t.block, f, true); }
    catch (e) {
      if (e instanceof OraError) {
        e.oraStack.push('ORA-06512: in "' + SCHEMA + '.' + t.name + '", Zeile ' + Math.max(1, f.act.line - t.lineBase + 1));
        e.oraStack.push('ORA-04088: Fehler bei der Ausführung von Trigger \'' + SCHEMA + '.' + t.name + '\'');
      }
      throw e;
    } finally { SESSION.ctx = prevCtx; SESSION.trig.pop(); if (added) SESSION.mutating.delete(tbl.name); }
    newRec = ctx.newRec;
  }
  if (newRow) return tbl.cols.map((c, i) => coerce(newRec.get(c.name), c.type, { kind: 'col', table: tbl.name, col: c.name }));
  return newRow;
}
function fireStmtTriggers(tbl, timing, event, setCols) {
  const trs = triggersFor(tbl, timing, event, false, setCols);
  if (trs.length) fireTriggers(trs, tbl, event, null, null, setCols, false);
}

// ---------- DML ----------
function dmlTable(name, node) {
  if (SESSION.queryDepth > 0) throw new OraError('ORA-14551', 'DML-Vorgang innerhalb einer Abfrage kann nicht ausgeführt werden');
  if (DB.synonyms[name]) name = DB.synonyms[name].target;
  if (SESSION.mutating.has(name)) { const e = oraErr('04091', SCHEMA + '.' + name); e.hint = 'Ein FOR EACH ROW-Trigger darf seine eigene Tabelle weder lesen noch ändern (mutating table).'; throw e; }
  const t = DB.tables[name];
  if (t) return t;
  if (DB.views[name]) return { view: DB.views[name] };
  const e = oraErr('00942'); if (node && node.tline) { e.line = node.tline; e.col = node.tcol; } throw e;
}
function viewTarget(v) {
  // einfache, aktualisierbare View: eine Tabelle, nur Spaltenreferenzen
  const q = v.q;
  if (v.readOnly) throw new OraError('ORA-42399', 'DML-Vorgang auf schreibgeschützter View nicht möglich');
  if (q.k !== 'select' || q.from.length !== 1 || q.from[0].k !== 'tbl' || q.distinct || q.groupBy || hasAggregate(q.cols.filter(c => !c.star).map(c => c.e)) || q.connectBy) throw oraErr('01732');
  const tbl = DB.tables[q.from[0].name]; if (!tbl) throw oraErr('01732');
  const map = {};
  let i = 0;
  for (const it of q.cols) {
    if (it.star) { tbl.cols.forEach(c => { map[(v.cols && v.cols[i]) || c.name] = c.name; i++; }); continue; }
    const name = (v.cols && v.cols[i]) || exprName(it);
    if (it.e.k === 'id') map[name] = it.e.parts[it.e.parts.length - 1];
    i++;
  }
  return { tbl, map, where: q.where, alias: q.from[0].alias };
}
function nextIdentity(tbl, col) {
  tbl.ident = tbl.ident || {};
  const id = col.identity;
  if (tbl.ident[col.name] === undefined) tbl.ident[col.name] = id.start;
  const v = tbl.ident[col.name]; tbl.ident[col.name] = v + id.inc; return v;
}
function computeVirtual(tbl, row) {
  if (!tbl.cols.some(c => c.virtual)) return row;
  const srcs = tblSrcs(tbl);
  tbl.cols.forEach((c, i) => { if (c.virtual) row[i] = coerce(ev(c.virtual, { f: null, rs: { srcs, vals: [row], parent: null } }), c.type, { kind: 'col', table: tbl.name, col: c.name }); });
  return row;
}
const DEFAULT_MARK = { k: 'default' };
function buildInsertRow(tbl, colIdxs, vals, env) {
  const row = new Array(tbl.cols.length).fill(undefined);
  colIdxs.forEach((ci, k) => { row[ci] = vals[k]; });
  tbl.cols.forEach((c, i) => {
    if (c.virtual) { if (row[i] !== undefined) throw new OraError('ORA-54013', 'INSERT-Vorgang für virtuelle Spalten nicht zulässig'); row[i] = null; return; }
    if (c.identity) {
      if (row[i] !== undefined && row[i] !== DEFAULT_MARK) {
        if (c.identity.always) throw new OraError('ORA-32795', 'Einfügen in eine Identitätsspalte vom Typ GENERATED ALWAYS nicht möglich');
        if (row[i] === null && c.identity.onNull) row[i] = undefined;
      }
      if (row[i] === undefined || row[i] === DEFAULT_MARK) { row[i] = nextIdentity(tbl, c); return; }
    }
    if (row[i] === undefined || row[i] === DEFAULT_MARK) row[i] = c.default ? ev(c.default, { f: env.f }) : null;
    row[i] = coerce(row[i], c.type, { kind: 'col', table: tbl.name, col: c.name });
  });
  return computeVirtual(tbl, row);
}
function execInsert(s, env) {
  let tbl = dmlTable(s.table, s), viewMap = null;
  if (tbl.view) { const vt = viewTarget(tbl.view); tbl = vt.tbl; viewMap = vt.map; }
  let colIdxs;
  if (s.cols) {
    const seen = new Set();
    colIdxs = s.cols.map(c => { const real = viewMap ? viewMap[c] : c; if (viewMap && !real) throw new OraError('ORA-01733', 'Virtuelle Spalte hier nicht zulässig'); if (seen.has(real)) throw oraErr('00957'); seen.add(real); return colIdx(tbl, real); });
  } else if (viewMap) colIdxs = Object.values(viewMap).map(c => colIdx(tbl, c));
  else colIdxs = tbl.cols.map((c, i) => c.virtual ? -1 : i).filter(i => i >= 0);
  let valueRows;
  if (s.values || s.multi) {
    const lists = s.multi || [s.values];
    valueRows = lists.map(list => {
      if (list.length < colIdxs.length) throw oraErr('00947');
      if (list.length > colIdxs.length) throw oraErr('00913');
      return list.map(e => (e.k === 'id' && e.parts.length === 1 && e.parts[0] === 'DEFAULT') ? DEFAULT_MARK : ev(e, env));
    });
  } else if (s.valuesRec) {
    const r = ev(s.valuesRec, env);
    if (!(r instanceof Rec)) throw plsErr('00382', 'Ausdruck hat falschen Typ (Record erwartet)');
    if (r.names.length !== colIdxs.length) throw oraErr(r.names.length < colIdxs.length ? '00947' : '00913');
    valueRows = [r.names.map(n => r.get(n))];
  } else {
    const res = runQuery(s.query, env, {});
    if (res.cols.length < colIdxs.length) throw oraErr('00947');
    if (res.cols.length > colIdxs.length) throw oraErr('00913');
    valueRows = res.rows;
  }
  const single = !!s.values && !s.multi;
  const st = beginStmt(); let n = 0; const inserted = [];
  const prevCtx = SESSION.ctx; SESSION.ctx = 'sql';
  try {
    fireStmtTriggers(tbl, 'BEFORE', 'INSERT');
    const bTrs = triggersFor(tbl, 'BEFORE', 'INSERT', true), aTrs = triggersFor(tbl, 'AFTER', 'INSERT', true);
    for (const vals of valueRows) {
      stepCheck();
      let row = buildInsertRow(tbl, colIdxs, vals, env);
      if (bTrs.length) row = computeVirtual(tbl, fireTriggers(bTrs, tbl, 'INSERT', null, row, null, !single));
      checkRow(tbl, row, 'INSERT', env);
      touchAppend(tbl); tbl.rows.push(row); n++; inserted.push(row);
      if (aTrs.length) fireTriggers(aTrs, tbl, 'INSERT', null, row, null, !single);
    }
    validateTables([tbl], 'INSERT', inserted);
    fireStmtTriggers(tbl, 'AFTER', 'INSERT');
    if (s.returning) doReturning(s, tbl, inserted, env);
    endStmt(st, true);
  } catch (e) { endStmt(st, false); throw e; } finally { SESSION.ctx = prevCtx; }
  SESSION.sqlAttr = { found: n > 0, notfound: n === 0, rowcount: n, isopen: false };
  if (n) tr({ t: 'dml', table: tbl.name, op: 'INSERT', n });
  return n;
}
function doReturning(s, tbl, rows, env) {
  const srcs = tblSrcs(tbl, s.alias);
  const vals = rows.map(r => s.returning.map(e => ev(e, sub(env, { rs: { srcs, vals: [r], parent: null } }))));
  if (s.retBulk) {
    s.retInto.forEach((t, k) => { const ref = lref(t, env); const c = ref.get(); if (!(c instanceof Coll)) throw plsErr('00497', 'BULK COLLECT erwartet eine Collection'); const nc = new Coll(c.type); nc.isNull = false; vals.forEach((v, i) => nc.map.set(i + 1, v[k])); nc.size = vals.length; ref.set(nc); });
    return;
  }
  if (rows.length > 1) throw oraErr('01422');
  if (!rows.length) return;
  assignTargets(s.retInto, vals[0], env);
}
function cursorCurrentRow(name, env) {
  const c = findCursor(name, env.f);
  if (!c || !c.state.isOpen || !c.state.current) throw oraErr('01002');
  return c.state.current;
}
function execUpdate(s, env) {
  let tbl = dmlTable(s.table, s), viewMap = null, viewWhere = null, alias = s.alias;
  if (tbl.view) { const vt = viewTarget(tbl.view); tbl = vt.tbl; viewMap = vt.map; viewWhere = vt.where; }
  const srcs = tblSrcs(tbl, alias || (viewMap ? null : null));
  if (alias) { srcs[0].alias = alias; srcs[0].aliased = true; }
  const setCols = [];
  const plan = s.sets.map(st => {
    if (st.row) return { row: true, e: st.e };
    const idxs = st.cols.map(c => { const real = viewMap ? viewMap[c] : c; if (!real) throw new OraError('ORA-01733', 'Virtuelle Spalte hier nicht zulässig'); const i = colIdx(tbl, real); if (tbl.cols[i].virtual) throw new OraError('ORA-54017', 'UPDATE-Vorgang für virtuelle Spalten nicht zulässig'); if (tbl.cols[i].identity && tbl.cols[i].identity.always) throw new OraError('ORA-32796', 'Identitätsspalte vom Typ GENERATED ALWAYS kann nicht aktualisiert werden'); setCols.push(real); return i; });
    return { idxs, e: st.e, q: st.q };
  });
  const cur = s.currentOf ? cursorCurrentRow(s.currentOf, env) : null;
  staticCheck([s.where].concat(s.sets.map(x => x.e)), srcs, env, null);
  const targets = [];
  tbl.rows.forEach((r, i) => {
    stepCheck();
    if (cur) { if (r === cur) targets.push(i); return; }
    const rs = { srcs, vals: [r], parent: env.rs || null };
    const e2 = sub(env, { rs });
    if (viewWhere && toBool(ev(viewWhere, e2)) !== true) return;
    if (s.where && toBool(ev(s.where, e2)) !== true) return;
    targets.push(i);
  });
  const st = beginStmt(); const updated = [];
  const prevCtx = SESSION.ctx; SESSION.ctx = 'sql';
  try {
    fireStmtTriggers(tbl, 'BEFORE', 'UPDATE', setCols);
    const bTrs = triggersFor(tbl, 'BEFORE', 'UPDATE', true, setCols), aTrs = triggersFor(tbl, 'AFTER', 'UPDATE', true, setCols);
    const snapshot = tbl.rows;
    const newRows = [];
    for (const i of targets) {
      const old = snapshot[i];
      let row = old.slice();
      const rs = { srcs, vals: [old], parent: env.rs || null };
      const e2 = sub(env, { rs });
      for (const p of plan) {
        if (p.row) { const r = ev(p.e, e2); if (!(r instanceof Rec)) throw plsErr('00382', 'Record erwartet'); tbl.cols.forEach((c, k) => { row[k] = r.get(r.names[k]); setCols.push(c.name); }); continue; }
        let vals;
        if (p.q) { const res = runQuery(p.q, e2, { limit: 2 }); if (res.rows.length > 1) throw oraErr('01427'); if (res.cols.length !== p.idxs.length) throw oraErr(res.cols.length < p.idxs.length ? '00947' : '00913'); vals = res.rows.length ? res.rows[0] : p.idxs.map(() => null); }
        else { const v = (p.e.k === 'id' && p.e.parts.length === 1 && p.e.parts[0] === 'DEFAULT') ? (tbl.cols[p.idxs[0]].default ? ev(tbl.cols[p.idxs[0]].default, { f: env.f }) : null) : ev(p.e, e2); vals = [v]; }
        p.idxs.forEach((ci, k) => { row[ci] = coerce(vals[k], tbl.cols[ci].type, { kind: 'col', table: tbl.name, col: tbl.cols[ci].name }); });
      }
      row = computeVirtual(tbl, row);
      newRows.push([i, old, row]);
    }
    if (!touchDone(tbl)) touch(tbl);
    tbl.rows = tbl.rows.slice();
    for (const [i, old, row0] of newRows) {
      stepCheck();
      let row = row0;
      if (bTrs.length) row = computeVirtual(tbl, fireTriggers(bTrs, tbl, 'UPDATE', old, row, setCols, true));
      checkRow(tbl, row, 'UPDATE', env);
      tbl.rows[i] = row; updated.push(row);
      if (aTrs.length) fireTriggers(aTrs, tbl, 'UPDATE', old, row, setCols, true);
    }
    validateTables([tbl], 'UPDATE', new Set(updated));
    fireStmtTriggers(tbl, 'AFTER', 'UPDATE', setCols);
    if (s.returning) doReturning(s, tbl, updated, env);
    endStmt(st, true);
  } catch (e) { endStmt(st, false); throw e; } finally { SESSION.ctx = prevCtx; }
  const n = targets.length;
  SESSION.sqlAttr = { found: n > 0, notfound: n === 0, rowcount: n, isopen: false };
  if (n) tr({ t: 'dml', table: tbl.name, op: 'UPDATE', n });
  return n;
}
function touchDone(tbl) { return false; }
function deleteRows(tbl, del, depth) {
  if (!del.size) return 0;
  if (depth > 30) throw new OraError('ORA-00036', 'Maximale Anzahl rekursiver SQL-Ebenen überschritten');
  const bTrs = triggersFor(tbl, 'BEFORE', 'DELETE', true), aTrs = triggersFor(tbl, 'AFTER', 'DELETE', true);
  for (const r of del) if (bTrs.length) fireTriggers(bTrs, tbl, 'DELETE', r, null, null, true);
  touch(tbl);
  tbl.rows = tbl.rows.filter(r => !del.has(r));
  for (const r of del) if (aTrs.length) fireTriggers(aTrs, tbl, 'DELETE', r, null, null, true);
  // ON DELETE CASCADE / SET NULL
  for (const child of Object.values(DB.tables)) {
    for (const k of child.cons) {
      if (k.type !== 'R' || k.refTable !== tbl.name || !k.onDelete || k.enabled === false) continue;
      const pIdx = k.refCols.map(c => tbl.cols.findIndex(x => x.name === c));
      const keys = new Set(Array.from(del).map(r => keyOf(pIdx.map(i => r[i]))));
      const cIdx = k.cols.map(c => child.cols.findIndex(x => x.name === c));
      const hits = child.rows.filter(r => keys.has(keyOf(cIdx.map(i => r[i]))));
      if (!hits.length) continue;
      if (k.onDelete === 'CASCADE') deleteRows(child, new Set(hits), depth + 1);
      else {
        touch(child); const hs = new Set(hits);
        child.rows = child.rows.map(r => { if (!hs.has(r)) return r; const n = r.slice(); cIdx.forEach(i => n[i] = null); checkRow(child, n, 'UPDATE', {}); return n; });
      }
    }
  }
  return del.size;
}
function execDelete(s, env) {
  let tbl = dmlTable(s.table, s), viewWhere = null;
  if (tbl.view) { const vt = viewTarget(tbl.view); tbl = vt.tbl; viewWhere = vt.where; }
  const srcs = tblSrcs(tbl, s.alias);
  const cur = s.currentOf ? cursorCurrentRow(s.currentOf, env) : null;
  staticCheck([s.where], srcs, env, null);
  const del = new Set();
  for (const r of tbl.rows) {
    stepCheck();
    if (cur) { if (r === cur) del.add(r); continue; }
    const e2 = sub(env, { rs: { srcs, vals: [r], parent: env.rs || null } });
    if (viewWhere && toBool(ev(viewWhere, e2)) !== true) continue;
    if (!s.where || toBool(ev(s.where, e2)) === true) del.add(r);
  }
  const st = beginStmt();
  const prevCtx = SESSION.ctx; SESSION.ctx = 'sql';
  try {
    fireStmtTriggers(tbl, 'BEFORE', 'DELETE');
    if (s.returning) doReturning(s, tbl, Array.from(del), env);
    deleteRows(tbl, del, 0);
    validateTables([tbl], 'DELETE');
    fireStmtTriggers(tbl, 'AFTER', 'DELETE');
    endStmt(st, true);
  } catch (e) { endStmt(st, false); throw e; } finally { SESSION.ctx = prevCtx; }
  const n = del.size;
  SESSION.sqlAttr = { found: n > 0, notfound: n === 0, rowcount: n, isopen: false };
  if (n) tr({ t: 'dml', table: tbl.name, op: 'DELETE', n });
  return n;
}
function execMerge(s, env) {
  const tbl = dmlTable(s.table, s); if (tbl.view) throw oraErr('01732');
  const tSrc = tblSrcs(tbl, s.alias)[0];
  const srcRel = getRelation(s.src, env);
  const srcs = mkSrcs([tSrc].concat(srcRel.srcs));
  const st = beginStmt(); let n = 0;
  const prevCtx = SESSION.ctx; SESSION.ctx = 'sql';
  try {
    touch(tbl);
    tbl.rows = tbl.rows.slice();
    const matchedRows = new Set();
    const toInsert = [];
    for (const sv of srcRel.rows) {
      stepCheck();
      let matched = false;
      for (let i = 0; i < tbl.rows.length; i++) {
        const r = tbl.rows[i];
        const e2 = sub(env, { rs: { srcs, vals: [r].concat(sv), parent: null } });
        if (toBool(ev(s.on, e2)) !== true) continue;
        matched = true;
        if (!s.upd) continue;
        if (matchedRows.has(r)) throw oraErr('30926');
        if (s.upd.where && toBool(ev(s.upd.where, e2)) !== true) continue;
        const row = r.slice();
        for (const p of s.upd.sets) { const ci = colIdx(tbl, p.cols[0]); if (s.on && JSON.stringify(s.on).includes('"' + p.cols[0] + '"')) { const err = new OraError('ORA-38104', 'In der ON-Klausel referenzierte Spalten können nicht aktualisiert werden: ' + p.cols[0]); throw err; } row[ci] = coerce(ev(p.e, e2), tbl.cols[ci].type, { kind: 'col', table: tbl.name, col: tbl.cols[ci].name }); }
        const trs = triggersFor(tbl, 'BEFORE', 'UPDATE', true);
        let nr = trs.length ? fireTriggers(trs, tbl, 'UPDATE', r, row, null, true) : row;
        checkRow(tbl, nr, 'UPDATE', env);
        tbl.rows[i] = nr; matchedRows.add(nr); n++;
        if (s.upd.delWhere) { const e3 = sub(env, { rs: { srcs, vals: [nr].concat(sv), parent: null } }); if (toBool(ev(s.upd.delWhere, e3)) === true) { tbl.rows.splice(i, 1); i--; } }
        const at = triggersFor(tbl, 'AFTER', 'UPDATE', true); if (at.length) fireTriggers(at, tbl, 'UPDATE', r, nr, null, true);
      }
      if (!matched && s.ins) {
        const e2 = sub(env, { rs: { srcs, vals: [nullRow(tSrc)].concat(sv), parent: null } });
        if (s.ins.where && toBool(ev(s.ins.where, e2)) !== true) continue;
        const cols = s.ins.cols || tbl.cols.map(c => c.name);
        if (cols.length !== s.ins.values.length) throw oraErr(cols.length > s.ins.values.length ? '00947' : '00913');
        toInsert.push({ idxs: cols.map(c => colIdx(tbl, c)), vals: s.ins.values.map(v => ev(v, e2)) });
      }
    }
    for (const ti of toInsert) {
      let row = buildInsertRow(tbl, ti.idxs, ti.vals, env);
      const trs = triggersFor(tbl, 'BEFORE', 'INSERT', true);
      if (trs.length) row = fireTriggers(trs, tbl, 'INSERT', null, row, null, true);
      checkRow(tbl, row, 'INSERT', env); tbl.rows.push(row); n++;
      const at = triggersFor(tbl, 'AFTER', 'INSERT', true); if (at.length) fireTriggers(at, tbl, 'INSERT', null, row, null, true);
    }
    validateTables([tbl]);
    endStmt(st, true);
  } catch (e) { endStmt(st, false); throw e; } finally { SESSION.ctx = prevCtx; }
  SESSION.sqlAttr = { found: n > 0, notfound: n === 0, rowcount: n, isopen: false };
  return n;
}
function execInsertAll(s, env) {
  const res = runQuery(s.query, env, {});
  const srcs = mkSrcs([mkSrc('Q', null, res.cols, res.types)]);
  const st = beginStmt(); let n = 0; const mod = new Set();
  try {
    for (const r of res.rows) {
      const e2 = sub(env, { rs: { srcs, vals: [r], parent: null } });
      let anyMatched = false;
      for (const into of s.intos) {
        if (into.cond && into.cond.k === 'else') { if (anyMatched) continue; }
        else if (into.cond) { if (toBool(ev(into.cond, e2)) !== true) continue; }
        anyMatched = true;
        const tbl = dmlTable(into.table); if (tbl.view) throw oraErr('01732');
        const cols = into.cols ? into.cols.map(c => colIdx(tbl, c)) : tbl.cols.map((c, i) => i);
        const vals = into.values ? into.values.map(v => ev(v, e2)) : r;
        if (vals.length !== cols.length) throw oraErr(vals.length < cols.length ? '00947' : '00913');
        let row = buildInsertRow(tbl, cols, vals, env);
        const trs = triggersFor(tbl, 'BEFORE', 'INSERT', true); if (trs.length) row = fireTriggers(trs, tbl, 'INSERT', null, row, null, true);
        checkRow(tbl, row, 'INSERT', env); touch(tbl); tbl.rows.push(row); n++; mod.add(tbl);
        if (s.mode === 'FIRST') break;
      }
    }
    validateTables(Array.from(mod));
    endStmt(st, true);
  } catch (e) { endStmt(st, false); throw e; }
  SESSION.sqlAttr = { found: n > 0, notfound: n === 0, rowcount: n, isopen: false };
  return n;
}

// ---------- DDL ----------
function ddlCommit() { doCommit(); }
function requireFree(name) { if (objExists(name)) throw oraErr('00955'); }
function checkExprCols(e, tbl) {
  walkExpr(e, x => { if (x.k === 'id' && x.parts.length === 1 && !['SYSDATE', 'USER', 'NULL', 'TRUE', 'FALSE'].includes(x.parts[0]) && !tbl.cols.some(c => c.name === x.parts[0])) { throw oraErr('00904', '"' + x.parts[0] + '"'); } if (x.k === 'subq' || x.k === 'exists') throw new OraError('ORA-02251', 'Unterabfrage hier nicht zulässig'); });
}
function addConstraint(tbl, c, validate) {
  tbl._uk = null;
  const k = Object.assign({}, c);
  if (!k.name) k.name = newConName(); else if (Object.values(DB.tables).some(t => t.cons.some(x => x.name === k.name))) throw new OraError('ORA-02264', 'Name wird bereits von einem vorhandenen Constraint verwendet');
  k.cols = (k.cols || []).slice();
  for (const cn of k.cols) colIdx(tbl, cn);
  k.enabled = true;
  if (k.type === 'P' && tbl.cons.some(x => x.type === 'P')) throw oraErr('02260');
  if ((k.type === 'P' || k.type === 'U') && tbl.cons.some(x => (x.type === 'P' || x.type === 'U') && x.cols.join() === k.cols.join())) throw new OraError('ORA-02261', 'Ein solcher eindeutiger oder Primärschlüssel ist in der Tabelle bereits vorhanden');
  if (k.type === 'C') checkExprCols(k.check, tbl);
  if (k.type === 'R') {
    const parent = k.refTable === tbl.name ? tbl : DB.tables[k.refTable];
    if (!parent) throw oraErr('00942');
    if (!k.refCols) { const pk = parent.cons.find(x => x.type === 'P'); if (!pk) throw new OraError('ORA-02268', 'Referenzierte Tabelle hat keinen Primärschlüssel'); k.refCols = pk.cols.slice(); }
    if (k.refCols.length !== k.cols.length) throw new OraError('ORA-02256', 'Anzahl der referenzierenden Spalten muss mit referenzierten Spalten übereinstimmen');
    const pc = parent === tbl && !parent.cons.length ? null : parent.cons.find(x => (x.type === 'P' || x.type === 'U') && x.cols.join() === k.refCols.join());
    if (!pc && !(parent === tbl && (tbl._pendingCons || []).some(x => (x.type === 'P' || x.type === 'U') && x.cols.join() === k.refCols.join()))) { const e = oraErr('02270'); e.hint = 'Ein Fremdschlüssel muss auf den Primärschlüssel (oder einen UNIQUE-Constraint) der Elterntabelle zeigen.'; throw e; }
    k.refCons = pc ? pc.name : null;
  }
  if (validate && tbl.rows.length) {
    const tmp = { name: tbl.name, cols: tbl.cols, rows: tbl.rows, cons: [k] };
    try {
      if (k.type === 'C') { for (const r of tbl.rows) { const v = toBool(ev(k.check, { f: null, rs: { srcs: tblSrcs(tbl), vals: [r], parent: null } })); if (v === false) throw 0; } }
      if (k.type === 'P') { for (const r of tbl.rows) for (const cn of k.cols) if (r[colIdx(tbl, cn)] === null) throw 1; }
      if (k.type === 'P' || k.type === 'U') { const s = new Set(); const ix = k.cols.map(c => colIdx(tbl, c)); for (const r of tbl.rows) { const v = ix.map(i => r[i]); if (v.every(x => x === null)) continue; const kk = keyOf(v); if (s.has(kk)) throw 2; s.add(kk); } }
      if (k.type === 'R') { const parent = DB.tables[k.refTable] || tbl; const pi = k.refCols.map(c => colIdx(parent, c)); const keys = new Set(parent.rows.map(r => keyOf(pi.map(i => r[i])))); const ci = k.cols.map(c => colIdx(tbl, c)); for (const r of tbl.rows) { const v = ci.map(i => r[i]); if (v.some(x => x === null)) continue; if (!keys.has(keyOf(v))) throw 3; } }
    } catch (x) {
      if (x instanceof OraError) throw x;
      if (x === 0) throw oraErr('02293', SCHEMA + '.' + k.name);
      if (x === 1) throw oraErr('02296', SCHEMA + '.' + k.name);
      if (x === 2) throw oraErr(k.type === 'P' ? '02437' : '02299', SCHEMA + '.' + k.name);
      if (x === 3) throw oraErr('02298', SCHEMA + '.' + k.name);
    }
  }
  tbl.cons.push(k);
  if (k.type === 'P' || k.type === 'U') DB.indexes[k.name] = { name: k.name, table: tbl.name, cols: k.cols.slice(), unique: true, auto: true };
  if (k.type === 'P') k.cols.forEach(cn => { tbl.cols[colIdx(tbl, cn)].pkNotNull = true; });
  return k;
}
function execCreateTable(s, env) {
  if (objExists(s.name)) { if (s.ifNotExists) return 'Tabelle ' + s.name + ' existiert bereits (übersprungen).'; throw oraErr('00955'); }
  const tbl = { name: s.name, cols: [], rows: [], cons: [], created: stamp(), temp: !!s.temp };
  let qres = null;
  if (s.asQuery) {
    qres = runQuery(s.asQuery, { f: null, rs: null }, {});
    const names = s.cols.length ? s.cols.map(c => c.name) : qres.cols;
    if (names.length !== qres.cols.length) throw oraErr('01730' in ORA_MSG ? '01730' : '00913');
    names.forEach((n, i) => {
      if (!/^[A-Z][A-Z0-9_$#]*$/.test(n) && !s.cols.length) { const e = new OraError('ORA-00998', 'Dieser Ausdruck muss mit einem Spaltenalias benannt werden'); e.hint = 'Gib berechneten Spalten im SELECT einen Alias, z. B. SUM(betrag) AS summe.'; throw e; }
      let type = qres.types[i];
      if (!type) {
        const vals = qres.rows.map(r => r[i]).filter(v => v !== null);
        if (vals.length && vals.every(isNum)) type = { b: 'NUMBER', p: null, s: null };
        else if (vals.length && vals.every(isDate)) type = { b: 'DATE' };
        else if (vals.length && vals.every(isBool)) type = { b: 'BOOLEAN' };
        else type = { b: 'VARCHAR2', len: Math.max(1, ...vals.map(v => toStr(v).length), 1) };
      }
      tbl.cols.push({ name: n, type: Object.assign({}, type) });
    });
  } else {
    const seen = new Set();
    for (const c of s.cols) {
      if (seen.has(c.name)) throw oraErr('00957'); seen.add(c.name);
      if (!c.type) throw oraErr('00902');
      if (c.type.named) {
        const tn = c.type.named.join('.'); const td = DB.types[c.type.named[c.type.named.length - 1]];
        if (!td || td.def.k !== 'record') { const e = oraErr('00902'); e.message += ' (' + tn + ')'; e.hint = td ? 'Nur Objekttypen (CREATE TYPE ... AS OBJECT) können als Spaltentyp dienen.' : 'Typ ' + tn + ' existiert nicht. Lege ihn vorher mit CREATE TYPE ' + tn + ' AS OBJECT (...) an.'; throw e; }
        c.type = { b: 'OBJ', name: td.name, txt: td.name };
      }
      tbl.cols.push({ name: c.name, type: c.type, notNull: !!c.notNull, default: c.default || null, defaultText: c.defaultText || null, identity: c.identity || null, virtual: c.virtual || null, nnName: c.nnName || null });
    }
    if (tbl.cols.length > 1000) throw new OraError('ORA-01792', 'Maximale Anzahl Spalten in Tabelle oder View ist 1000');
  }
  tbl._pendingCons = s.cons;
  const sorted = s.cons.filter(c => c.type !== 'R').concat(s.cons.filter(c => c.type === 'R'));
  for (const c of sorted) addConstraint(tbl, c, false);
  delete tbl._pendingCons;
  if (qres) tbl.rows = qres.rows.map(r => r.map((v, i) => coerce(v, tbl.cols[i].type, { kind: 'col', table: tbl.name, col: tbl.cols[i].name })));
  ddlCommit();
  DB.tables[s.name] = tbl;
  return 'Tabelle ' + s.name + ' wurde erstellt.' + (qres ? ' (' + tbl.rows.length + ' Zeilen übernommen)' : '');
}
function referencingFks(tblName) {
  const out = [];
  for (const t of Object.values(DB.tables)) for (const k of t.cons) if (k.type === 'R' && k.refTable === tblName && t.name !== tblName) out.push({ t, k });
  return out;
}
function execDrop(s) {
  const n = s.name; const w = s.what;
  const missing = (num, ...a) => { if (s.ifExists) return null; throw oraErr(num, ...a); };
  switch (w) {
    case 'TABLE': {
      const t = DB.tables[n]; if (!t) { if (missing('00942') === null) return 'Tabelle ' + n + ' existiert nicht (übersprungen).'; }
      const refs = referencingFks(n);
      if (refs.length && !s.cascade) { const e = oraErr('02449'); e.hint = 'Tabelle ' + refs[0].t.name + ' verweist per Fremdschlüssel hierauf. Erst die Kind-Tabelle löschen oder DROP TABLE ' + n + ' CASCADE CONSTRAINTS.'; throw e; }
      for (const r of refs) r.t.cons = r.t.cons.filter(k => k !== r.k);
      ddlCommit();
      delete DB.tables[n];
      for (const [k, ix] of Object.entries(DB.indexes)) if (ix.table === n) delete DB.indexes[k];
      for (const [k, tr] of Object.entries(DB.triggers)) if (tr.table === n) delete DB.triggers[k];
      return 'Tabelle ' + n + ' wurde gelöscht.';
    }
    case 'VIEW': if (!DB.views[n]) { if (missing('00942') === null) return 'View ' + n + ' existiert nicht (übersprungen).'; } delete DB.views[n]; ddlCommit(); return 'View ' + n + ' wurde gelöscht.';
    case 'SEQUENCE': if (!DB.seqs[n]) { if (missing('02289') === null) return 'Sequence existiert nicht (übersprungen).'; } delete DB.seqs[n]; delete SESSION.seqCurr[n]; ddlCommit(); return 'Sequence ' + n + ' wurde gelöscht.';
    case 'INDEX': if (!DB.indexes[n] || DB.indexes[n].auto) { if (DB.indexes[n] && DB.indexes[n].auto) throw new OraError('ORA-02429', 'Index zur Durchsetzung von eindeutigem/Primärschlüssel kann nicht gelöscht werden'); if (missing('01418') === null) return 'Index existiert nicht (übersprungen).'; } delete DB.indexes[n]; ddlCommit(); return 'Index ' + n + ' wurde gelöscht.';
    case 'PROCEDURE': case 'FUNCTION': if (!DB.procs[n] || DB.procs[n].kind !== w) { if (missing('04043', n) === null) return w + ' existiert nicht (übersprungen).'; } delete DB.procs[n]; ddlCommit(); return (w === 'PROCEDURE' ? 'Prozedur ' : 'Funktion ') + n + ' wurde gelöscht.';
    case 'TRIGGER': if (!DB.triggers[n]) { if (missing('04080', '\'' + n + '\'') === null) return 'Trigger existiert nicht (übersprungen).'; } delete DB.triggers[n]; ddlCommit(); return 'Trigger ' + n + ' wurde gelöscht.';
    case 'PACKAGE': if (!DB.pkgs[n]) { if (missing('04043', n) === null) return 'Package existiert nicht (übersprungen).'; } delete DB.pkgs[n]; delete SESSION.pkgState[n]; ddlCommit(); return 'Package ' + n + ' wurde gelöscht.';
    case 'PACKAGE BODY': if (!DB.pkgs[n] || !DB.pkgs[n].body) { if (missing('04043', n) === null) return 'Package Body existiert nicht (übersprungen).'; } DB.pkgs[n].body = null; delete SESSION.pkgState[n]; ddlCommit(); return 'Package Body ' + n + ' wurde gelöscht.';
    case 'TYPE': if (!DB.types[n]) { if (missing('04043', n) === null) return 'Typ existiert nicht (übersprungen).'; } delete DB.types[n]; ddlCommit(); return 'Typ ' + n + ' wurde gelöscht.';
    case 'SYNONYM': if (!DB.synonyms[n]) { if (missing('01434' in ORA_MSG ? '01434' : '04043', n) === null) return 'Synonym existiert nicht (übersprungen).'; } delete DB.synonyms[n]; return 'Synonym ' + n + ' wurde gelöscht.';
    case 'USER': case 'ROLE': return 'DROP ' + w + ' wird in der Sandbox ignoriert.';
  }
  throw oraErr('00950' in ORA_MSG ? '00950' : '00900');
}
function renameInExpr(e, from, to) { walkExpr(e, x => { if (x.k === 'id' && x.parts[x.parts.length - 1] === from) x.parts[x.parts.length - 1] = to; }); }
function execAlterTable(s, env) {
  const tbl = DB.tables[s.name]; if (!tbl) throw oraErr('00942');
  tbl._uk = null;
  ddlCommit();
  const msgs = [];
  for (const a of s.acts) {
    switch (a.a) {
      case 'addCol': {
        const c = a.col;
        if (tbl.cols.some(x => x.name === c.name)) throw new OraError('ORA-01430', 'Hinzuzufügende Spalte ist in Tabelle bereits vorhanden');
        if (c.notNull && !c.default && !c.identity && tbl.rows.length) { const e = new OraError('ORA-01758', 'Tabelle muss leer sein, um eine obligatorische (NOT NULL) Spalte hinzuzufügen'); e.hint = 'Gib einen DEFAULT-Wert an oder füge die Spalte erst ohne NOT NULL hinzu.'; throw e; }
        const col = { name: c.name, type: c.type, notNull: !!c.notNull, default: c.default || null, defaultText: c.defaultText || null, identity: c.identity || null, virtual: c.virtual || null };
        tbl.cols.push(col);
        tbl.rows = tbl.rows.map(r => { const n = r.concat([null]); const i = n.length - 1; if (col.identity) n[i] = nextIdentity(tbl, col); else if (col.default) n[i] = coerce(ev(col.default, { f: null }), col.type, { kind: 'col', table: tbl.name, col: col.name }); return n; });
        if (col.virtual) tbl.rows = tbl.rows.map(r => computeVirtual(tbl, r));
        tbl._srcs = null;
        for (const k of a.cons) addConstraint(tbl, k, true);
        msgs.push('Spalte ' + c.name + ' hinzugefügt');
        break;
      }
      case 'addCons': addConstraint(tbl, a.c, true); msgs.push('Constraint hinzugefügt'); break;
      case 'modCol': {
        const i = colIdx(tbl, a.name); const col = tbl.cols[i];
        if (a.type) {
          const vals = tbl.rows.map(r => r[i]);
          if (vals.some(v => v !== null) && a.type.b !== col.type.b && !((a.type.b === 'VARCHAR2' || a.type.b === 'CHAR') && (col.type.b === 'VARCHAR2' || col.type.b === 'CHAR'))) throw new OraError('ORA-01439', 'Zu ändernde Spalte muss leer sein, um den Datentyp zu ändern');
          const nv = vals.map(v => { try { return coerce(v, a.type, { kind: 'col', table: tbl.name, col: col.name }); } catch (e) { if (e.code === 'ORA-12899') throw new OraError('ORA-01441', 'Spaltenlänge kann nicht verringert werden, da einige Werte zu groß sind'); if (e.code === 'ORA-01438') throw new OraError('ORA-01440', 'Zu ändernde Spalte muss leer sein, um die Genauigkeit oder Skala zu verringern'); throw e; } });
          col.type = a.type; tbl.rows = tbl.rows.map((r, k) => { const n = r.slice(); n[i] = nv[k]; return n; });
        }
        if (a.default !== undefined) { col.default = a.default; col.defaultText = a.defaultText; }
        if (a.notNull === true) { if (col.notNull) throw oraErr('01442'); if (tbl.rows.some(r => r[i] === null)) throw oraErr('02296', SCHEMA + '.' + newConName()); col.notNull = true; }
        if (a.notNull === false) { if (!col.notNull) throw oraErr('01451'); col.notNull = false; }
        tbl._srcs = null;
        msgs.push('Spalte ' + a.name + ' geändert');
        break;
      }
      case 'dropCol': {
        for (const nm of a.names) {
          const i = colIdx(tbl, nm);
          if (tbl.cols.length === 1) throw new OraError('ORA-12983', 'Alle Spalten einer Tabelle können nicht gelöscht werden');
          const refd = referencingFks(tbl.name).filter(r => r.k.refCols.includes(nm));
          if (refd.length) throw new OraError('ORA-12992', 'Übergeordnete Schlüsselspalte kann nicht gelöscht werden');
          tbl.cols.splice(i, 1);
          tbl.rows = tbl.rows.map(r => { const n = r.slice(); n.splice(i, 1); return n; });
          tbl.cons = tbl.cons.filter(k => { const hit = k.cols.includes(nm) || (k.type === 'C' && JSON.stringify(k.check).includes('"' + nm + '"')); if (hit) delete DB.indexes[k.name]; return !hit; });
        }
        tbl._srcs = null;
        msgs.push('Spalte(n) gelöscht');
        break;
      }
      case 'dropCons': case 'dropPk': case 'dropUnique': {
        let k;
        if (a.a === 'dropCons') k = tbl.cons.find(x => x.name === a.name);
        else if (a.a === 'dropPk') k = tbl.cons.find(x => x.type === 'P');
        else k = tbl.cons.find(x => x.type === 'U' && x.cols.join() === a.cols.join());
        if (!k) throw oraErr('02443');
        if (k.type === 'P' || k.type === 'U') {
          const refs = referencingFks(tbl.name).filter(r => r.k.refCols.join() === k.cols.join());
          if (refs.length && !a.cascade) throw new OraError('ORA-02273', 'Dieser eindeutige/primäre Schlüssel wird von einigen Fremdschlüsseln referenziert');
          for (const r of refs) r.t.cons = r.t.cons.filter(x => x !== r.k);
          delete DB.indexes[k.name];
          if (k.type === 'P') k.cols.forEach(cn => { const c = tbl.cols.find(x => x.name === cn); if (c) c.pkNotNull = false; });
        }
        tbl.cons = tbl.cons.filter(x => x !== k);
        msgs.push('Constraint ' + k.name + ' gelöscht');
        break;
      }
      case 'renCol': {
        const i = colIdx(tbl, a.from);
        if (tbl.cols.some(c => c.name === a.to)) throw oraErr('00957');
        tbl.cols[i].name = a.to;
        for (const k of tbl.cons) { k.cols = k.cols.map(c => c === a.from ? a.to : c); if (k.check) renameInExpr(k.check, a.from, a.to); }
        for (const t of Object.values(DB.tables)) for (const k of t.cons) if (k.type === 'R' && k.refTable === tbl.name) k.refCols = k.refCols.map(c => c === a.from ? a.to : c);
        for (const ix of Object.values(DB.indexes)) if (ix.table === tbl.name) ix.cols = ix.cols.map(c => c === a.from ? a.to : c);
        tbl._srcs = null;
        msgs.push('Spalte umbenannt');
        break;
      }
      case 'renCons': { const k = tbl.cons.find(x => x.name === a.from); if (!k) throw oraErr('02443'); if (DB.indexes[k.name]) { DB.indexes[a.to] = Object.assign(DB.indexes[k.name], { name: a.to }); delete DB.indexes[k.name]; } k.name = a.to; msgs.push('Constraint umbenannt'); break; }
      case 'renTable': renameObject(tbl.name, a.to); msgs.push('Tabelle umbenannt in ' + a.to); break;
      case 'consState': {
        const k = a.pk ? tbl.cons.find(x => x.type === 'P') : tbl.cons.find(x => x.name === a.name);
        if (!k) throw oraErr('02443');
        if (a.state === 'ENABLE' && k.enabled === false) { tbl.cons = tbl.cons.filter(x => x !== k); try { addConstraint(tbl, Object.assign({}, k, { enabled: true }), true); } catch (e) { tbl.cons.push(k); throw e; } }
        else if (a.state === 'DISABLE') k.enabled = false;
        msgs.push('Constraint ' + k.name + (a.state === 'ENABLE' ? ' aktiviert' : ' deaktiviert'));
        break;
      }
      case 'trigState': for (const t of Object.values(DB.triggers)) if (t.table === tbl.name) t.enabled = a.state === 'ENABLE'; msgs.push('Trigger ' + (a.state === 'ENABLE' ? 'aktiviert' : 'deaktiviert')); break;
    }
  }
  return 'Tabelle ' + s.name + ' wurde geändert.';
}
function renameObject(from, to) {
  if (objExists(to)) throw oraErr('00955');
  if (DB.tables[from]) {
    const t = DB.tables[from]; delete DB.tables[from]; t.name = to; DB.tables[to] = t; t._srcs = null;
    for (const x of Object.values(DB.tables)) for (const k of x.cons) if (k.type === 'R' && k.refTable === from) k.refTable = to;
    for (const tr of Object.values(DB.triggers)) if (tr.table === from) tr.table = to;
    for (const ix of Object.values(DB.indexes)) if (ix.table === from) ix.table = to;
  } else if (DB.views[from]) { DB.views[to] = DB.views[from]; DB.views[to].name = to; delete DB.views[from]; }
  else if (DB.seqs[from]) { DB.seqs[to] = DB.seqs[from]; DB.seqs[to].name = to; delete DB.seqs[from]; }
  else throw oraErr('04043', from);
}
function execCreateView(s) {
  const n = s.name;
  if (DB.views[n] && !s.orReplace) throw oraErr('00955');
  if (!DB.views[n] && objExists(n)) throw oraErr('00955');
  let cols = s.cols;
  if (!s.force) {
    const r = runQuery(s.q, { f: null, rs: null }, { limit: 0 });
    if (cols && cols.length !== r.cols.length) throw new OraError('ORA-01730', 'Ungültige Anzahl der angegebenen Spaltennamen');
    const names = cols || r.cols;
    const seen = new Set();
    for (const c of names) { if (seen.has(c)) { const e = oraErr('00957'); e.hint = 'Zwei Spalten der View heißen ' + c + ' – vergib Aliase.'; throw e; } seen.add(c); if (!cols && !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(c)) { const e = new OraError('ORA-00998', 'Dieser Ausdruck muss mit einem Spaltenalias benannt werden'); e.hint = 'Berechnete Spalten in einer View brauchen einen Alias, z. B. COUNT(*) AS anzahl.'; throw e; } }
  }
  ddlCommit();
  DB.views[n] = { name: n, cols: cols || null, q: s.q, qText: s.qText, text: s.srcText, created: DB.views[n] ? DB.views[n].created : stamp(), withCheck: s.withCheck, readOnly: s.readOnly, mat: s.mat };
  return (s.mat ? 'Materialized View ' : 'View ') + n + ' wurde erstellt.';
}
function seqNext(name) {
  const s = DB.seqs[name];
  let v = s.next;
  const max = s.max != null ? s.max : (s.inc > 0 ? 1e28 : -1);
  const min = s.min != null ? s.min : (s.inc > 0 ? 1 : -1e27);
  if ((s.inc > 0 && v > max) || (s.inc < 0 && v < min)) {
    if (!s.cycle) throw oraErr('08004', name, s.inc > 0 ? 'überschreitet' : 'unterschreitet');
    v = s.inc > 0 ? min : max;
  }
  s.next = v + s.inc; s.used = true;
  SESSION.seqCurr[name] = v;
  return v;
}
function execCreateSeq(s) {
  requireFree(s.name);
  const o = s.o;
  const start = o.start != null ? o.start : (o.inc > 0 ? (o.min != null ? o.min : 1) : (o.max != null ? o.max : -1));
  if (o.min != null && start < o.min) throw new OraError('ORA-04006', 'START WITH darf nicht kleiner als MINVALUE sein');
  if (o.max != null && start > o.max) throw new OraError('ORA-04008', 'START WITH darf nicht größer als MAXVALUE sein');
  if (o.inc === 0) throw new OraError('ORA-04002', 'INCREMENT darf nicht null sein');
  ddlCommit();
  DB.seqs[s.name] = { name: s.name, start, next: start, inc: o.inc, min: o.min, max: o.max, cycle: o.cycle, cache: o.cache, created: stamp() };
  return 'Sequence ' + s.name + ' wurde erstellt.';
}
function execCreateIndex(s) {
  const t = DB.tables[s.table]; if (!t) throw oraErr('00942');
  if (DB.indexes[s.name] || objExists(s.name)) throw oraErr('00955');
  for (const c of s.cols) if (/^[A-Z_][A-Z0-9_$#]*$/.test(c)) colIdx(t, c);
  if (Object.values(DB.indexes).some(ix => ix.table === s.table && ix.cols.join() === s.cols.join())) throw oraErr('01408');
  if (s.unique) {
    const ix = s.cols.map(c => colIdx(t, c)); const seen = new Set();
    for (const r of t.rows) { const v = ix.map(i => r[i]); if (v.every(x => x === null)) continue; const k = keyOf(v); if (seen.has(k)) throw new OraError('ORA-01452', 'CREATE UNIQUE INDEX nicht möglich; doppelte Schlüssel gefunden'); seen.add(k); }
  }
  ddlCommit();
  DB.indexes[s.name] = { name: s.name, table: s.table, cols: s.cols, unique: s.unique, auto: false, created: stamp() };
  return 'Index ' + s.name + ' wurde erstellt.';
}
function execTruncate(s) {
  const t = DB.tables[s.name]; if (!t) throw oraErr('00942');
  const refs = referencingFks(s.name).filter(r => r.k.enabled !== false);
  if (refs.length) throw new OraError('ORA-02266', 'Eindeutige/primäre Schlüssel in Tabelle von aktivierten Fremdschlüsseln referenziert');
  ddlCommit();
  t.rows = [];
  return 'Tabelle ' + s.name + ' wurde mit TRUNCATE geleert.';
}
