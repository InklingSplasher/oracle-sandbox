// ===== PL/SQL-Laufzeit =====
class Frame {
  constructor(parent, kind, label) {
    this.parent = parent; this.kind = kind; this.label = label || null;
    this.vars = new Map(); this.types = new Map(); this.cursors = new Map(); this.excs = new Map(); this.subs = new Map();
    this.curErr = null;
    this.act = parent ? parent.act : { line: 0, base: 1 };
  }
}
const PREDEF_EXC = {
  NO_DATA_FOUND: 'ORA-01403', TOO_MANY_ROWS: 'ORA-01422', ZERO_DIVIDE: 'ORA-01476', VALUE_ERROR: 'ORA-06502', INVALID_NUMBER: 'ORA-01722',
  DUP_VAL_ON_INDEX: 'ORA-00001', CURSOR_ALREADY_OPEN: 'ORA-06511', INVALID_CURSOR: 'ORA-01001', CASE_NOT_FOUND: 'ORA-06592',
  COLLECTION_IS_NULL: 'ORA-06531', SUBSCRIPT_BEYOND_COUNT: 'ORA-06533', SUBSCRIPT_OUTSIDE_LIMIT: 'ORA-06532', ROWTYPE_MISMATCH: 'ORA-06504',
  PROGRAM_ERROR: 'ORA-06501', STORAGE_ERROR: 'ORA-06500', ACCESS_INTO_NULL: 'ORA-06530', LOGIN_DENIED: 'ORA-01017', NOT_LOGGED_ON: 'ORA-01012',
  TIMEOUT_ON_RESOURCE: 'ORA-00051', SYS_INVALID_ROWID: 'ORA-01410', SELF_IS_NULL: 'ORA-30625',
};
const COLL_METHODS = new Set(['COUNT', 'FIRST', 'LAST', 'LIMIT', 'EXISTS', 'NEXT', 'PRIOR', 'EXTEND', 'DELETE', 'TRIM']);

function lookupVar(name, f) { for (let x = f; x; x = x.parent) { const v = x.vars.get(name); if (v) return v; } return null; }
function lookupType(name, f) { for (let x = f; x; x = x.parent) { const t = x.types.get(name); if (t) return t; } return null; }
function findCursor(name, f) {
  for (let x = f; x; x = x.parent) { const c = x.cursors.get(name); if (c) return c; }
  if (name.includes('.')) { const [pk, cn] = name.split('.'); if (DB.pkgs[pk]) { const pf = pkgMember(pk, cn, f); const c = pf.cursors.get(cn); if (c) return c; } }
  const v = f ? lookupVar(name, f) : null;
  if (v && (v.value instanceof CursorState || (v.type && v.type.b === 'REFCURSOR'))) return { ref: true, v, get state() { return v.value || (v.value = new CursorState(name)); } };
  return null;
}
function lookupExc(name, f) { for (let x = f; x; x = x.parent) { const e = x.excs.get(name); if (e) return e; } return null; }
function lookupSubs(name, f) { for (let x = f; x; x = x.parent) { const s = x.subs.get(name); if (s) return s; } return null; }
function inPackage(f, pf) { for (let x = f; x; x = x.parent) if (x === pf) return true; return false; }

// ---------- Typen ----------
function resolveType(spec, f) {
  if (!spec) return null;
  if (spec.b) return spec;
  if (spec.ref === 'TYPE') {
    const p = spec.parts;
    if (p.length === 1) { const v = f && lookupVar(p[0], f); if (v) return v.type; throw plsErr('00201', 'Bezeichner \'' + p[0] + '\' muss deklariert werden'); }
    let pp = p; if (pp.length === 3 && pp[0] === SCHEMA) pp = pp.slice(1);
    const t = DB.tables[pp[0]];
    if (t && pp.length === 2) { const c = t.cols.find(c => c.name === pp[1]); if (!c) throw plsErr('00302', 'Komponente \'' + pp[1] + '\' muss deklariert werden'); return Object.assign({}, c.type); }
    if (DB.views[pp[0]] && pp.length === 2) { const d = tableData(pp[0], { f: null }); const i = d.cols.indexOf(pp[1]); if (i < 0) throw plsErr('00302', 'Komponente \'' + pp[1] + '\' muss deklariert werden'); return d.types[i] || { b: 'VARCHAR2', len: 4000 }; }
    const v = f && lookupVar(pp[0], f);
    if (v && v.type && v.type.b === 'REC') { const fl = v.type.fields.find(x => x.name === pp[1]); if (fl) return fl.type; }
    if (DB.pkgs[pp[0]]) { const pf = getPkgFrame(pp[0]); const pv = pf.vars.get(pp[1]); if (pv) return pv.type; }
    throw plsErr('00201', 'Bezeichner \'' + p.join('.') + '\' muss deklariert werden');
  }
  if (spec.ref === 'ROWTYPE') {
    const p = spec.parts; const nm = p[p.length - 1];
    const c = p.length === 1 && f ? (function () { for (let x = f; x; x = x.parent) { const c = x.cursors.get(nm); if (c) return c; } return null; })() : null;
    if (c) return cursorRowType(c);
    const t = DB.tables[nm];
    if (t) return { b: 'REC', name: nm + '%ROWTYPE', fields: t.cols.map(c => ({ name: c.name, type: c.type })) };
    if (DB.views[nm]) { const d = tableData(nm, { f: null }); return { b: 'REC', name: nm + '%ROWTYPE', fields: d.cols.map((c, i) => ({ name: c, type: d.types[i] || null })) }; }
    throw plsErr('00201', 'Bezeichner \'' + p.join('.') + '\' muss deklariert werden');
  }
  if (spec.named) {
    const p = spec.parts || spec.named;
    if (p.length === 1) {
      const t = f && lookupType(p[0], f); if (t) return t;
      if (DB.types[p[0]]) return schemaType(p[0]);
    } else if (p.length === 2 && DB.pkgs[p[0]]) {
      const pf = getPkgFrame(p[0]); const t = pf.types.get(p[1]); if (t) return t;
    }
    throw plsErr('00201', 'Bezeichner \'' + p.join('.') + '\' muss deklariert werden');
  }
  return spec;
}
function schemaType(name) {
  const d = DB.types[name];
  return typeFromDef(name, d.def, null);
}
function typeFromDef(name, def, f) {
  if (def.k === 'record') return { b: 'REC', name, fields: def.fields.map(x => ({ name: x.name, type: resolveType(x.type, f), init: x.init })), object: !!def.object };
  if (def.k === 'table') return { b: 'COLL', name, kind: 'table', of: resolveType(def.of, f), indexBy: def.indexBy ? resolveType(def.indexBy, f) : null };
  if (def.k === 'varray') return { b: 'COLL', name, kind: 'varray', size: def.size, of: resolveType(def.of, f) };
  if (def.k === 'refcursor') return { b: 'REFCURSOR', name };
  if (def.k === 'subtype') return resolveType(def.type, f);
}
function cursorRowType(c) {
  if (c.rowType) return c.rowType;
  const d = c.decl;
  const pf = new Frame(c.frame, 'block');
  for (const p of d.params || []) pf.vars.set(p.name, { name: p.name, type: resolveType(p.type, c.frame), value: null });
  const r = runQuery(d.q, { f: pf }, { limit: 0 });
  c.rowType = { b: 'REC', name: d.name + '%ROWTYPE', fields: r.cols.map((n, i) => ({ name: n, type: r.types[i] || null })) };
  return c.rowType;
}

// ---------- Deklarationen ----------
function declare(decls, f) {
  for (const d of decls) {
    f.act.line = d.ln || f.act.line;
    switch (d.k) {
      case 'var': {
        if (f.vars.has(d.name) && f.kind !== 'pkg') throw plsErr('00371', 'Höchstens eine Deklaration für \'' + d.name + '\' zulässig');
        const type = resolveType(d.type, f);
        let value;
        if (d.init) value = coerce(cloneVal(ev(d.init, { f })), type, { kind: 'var', name: d.name });
        else { if (d.notNull) throw plsErr('00218', 'Eine als NOT NULL deklarierte Variable muss eine Initialisierungszuweisung haben'); value = initValue(type); }
        if (type && type.b === 'REC' && !d.init) recInit(value, type, f);
        f.vars.set(d.name, { name: d.name, type, value, constant: d.constant, notNull: d.notNull });
        break;
      }
      case 'type': f.types.set(d.name, typeFromDef(d.name, d.def, f)); break;
      case 'cursor': f.cursors.set(d.name, { decl: d, frame: f, state: new CursorState(d.name) }); break;
      case 'exc': f.excs.set(d.name, { name: d.name, code: null, id: Symbol(d.name) }); break;
      case 'pragma': { const e = lookupExc(d.name, f); if (!e) throw plsErr('00109', 'Unbekannter Exception-Name \'' + d.name + '\' in PRAGMA EXCEPTION_INIT'); e.code = Math.abs(d.code); break; }
      case 'subprog': {
        const def = d.def;
        const list = f.subs.get(def.name) || [];
        const idx = list.findIndex(x => x.def.params.length === def.params.length && x.def.kind === def.kind);
        const entry = { def, scope: f, lineBase: f.lineBase || f.act.base, objName: f.objName || null };
        if (idx >= 0) { if (!list[idx].def.block || def.block) list[idx] = entry; } else list.push(entry);
        f.subs.set(def.name, list);
        break;
      }
    }
  }
}
function recInit(rec, type, f) {
  if (!(rec instanceof Rec) || !type.fields) return;
  for (const fl of type.fields) if (fl.init) rec.set(fl.name, coerce(ev(fl.init, { f }), fl.type, { kind: 'var', name: fl.name }));
}

// ---------- Paket ----------
function getPkgFrame(name) {
  if (SESSION.pkgState[name]) return SESSION.pkgState[name];
  const pkg = DB.pkgs[name];
  if (!pkg || !pkg.spec) throw oraErr('04043', name);
  const pf = new Frame(null, 'pkg');
  pf.pkgName = name; pf.objName = name; pf.act = { line: 0, base: pkg.spec.srcLine || 1 }; pf.lineBase = pkg.spec.srcLine || 1;
  SESSION.pkgState[name] = pf;
  const prevCtx = SESSION.ctx; SESSION.ctx = 'plsql';
  try {
    declare(pkg.spec.decls, pf);
    pf.specNames = new Set();
    for (const d of pkg.spec.decls) pf.specNames.add(d.k === 'subprog' ? d.def.name : d.name);
    if (pkg.body) {
      pf.lineBase = pkg.body.srcLine || 1; pf.act = { line: 0, base: pf.lineBase };
      declare(pkg.body.decls, pf);
      if (pkg.body.init) execBlockIn(pkg.body.init, pf, true);
    }
  } catch (e) { delete SESSION.pkgState[name]; throw e; }
  finally { SESSION.ctx = prevCtx; }
  return pf;
}
function pkgMember(pkgName, member, f) {
  const pf = getPkgFrame(pkgName);
  if (!inPackage(f, pf) && !pf.specNames.has(member)) throw plsErr('00302', 'Komponente \'' + member + '\' muss deklariert werden (nicht in der Package-Spezifikation von ' + pkgName + ')');
  return pf;
}

// ---------- Namensauflösung ----------
function trigCtx() { return SESSION.trig.length ? SESSION.trig[SESSION.trig.length - 1] : null; }
function walkValue(val, parts, start, node) {
  let v = val;
  for (let i = start; i < parts.length; i++) {
    const p = parts[i];
    if (v instanceof Rec) { if (!v.has(p)) throw plsErr('00302', 'Komponente \'' + p + '\' muss deklariert werden'); v = v.get(p); continue; }
    if (v instanceof Coll) { v = collMethod(v, p, []); continue; }
    if (v === null && i < parts.length) { throw oraErr('06530'); }
    throw plsErr('00487', 'Ungültige Referenz auf Variable \'' + parts.slice(0, i).join('.') + '\'');
  }
  return v;
}
function findVarPath(parts, f) {
  // -> {v, used} | null
  if (!f) return null;
  if (parts.length >= 2) {
    for (let x = f; x; x = x.parent) {
      if ((x.label === parts[0] || x.procName === parts[0]) && x.vars.has(parts[1])) return { v: x.vars.get(parts[1]), used: 2 };
    }
  }
  const v = lookupVar(parts[0], f);
  if (v) return { v, used: 1 };
  return null;
}
function resolveName(e, env) {
  const parts = e.parts; const f = env.f;
  const p0 = parts[0];
  if (p0[0] === ':') {
    const tc = trigCtx();
    if (p0 === ':NEW' || p0 === ':OLD' || (f && lookupVar(p0, f))) {
      const v = f && lookupVar(p0, f);
      if (!v) throw plsErr('00049', 'Ungültige Bind-Variable \'' + p0.slice(1) + '\'');
      if (parts.length === 1) return v.value;
      return walkValue(v.value, parts, 1, e);
    }
    const b = SESSION.binds[SESSION.binds.length - 1];
    if (b) { const i = b.names.indexOf(p0); if (i >= 0 && i < b.vals.length) { const bv = b.vals[i]; return bv.ref ? bv.ref.get() : bv.v; } }
    throw oraErr('01008');
  }
  const fp = findVarPath(parts, f);
  if (fp) return walkValue(fp.v.value, parts, fp.used, e);
  if (parts.length >= 2 && DB.pkgs[p0]) {
    const pf = pkgMember(p0, parts[1], f);
    const v = pf.vars.get(parts[1]);
    if (v) return walkValue(v.value, parts, 2, e);
    const subs = pf.subs.get(parts[1]);
    if (subs) return callSub(pickOverload(subs, 0, parts.join('.')), [], env, true, parts.join('.'));
    throw plsErr('00302', 'Komponente \'' + parts[1] + '\' muss deklariert werden');
  }
  if (parts.length === 2 && (parts[1] === 'NEXTVAL' || parts[1] === 'CURRVAL')) {
    const sn = DB.synonyms[p0] ? DB.synonyms[p0].target : p0;
    if (DB.seqs[sn]) {
      if (parts[1] === 'NEXTVAL') return seqNext(sn);
      if (SESSION.seqCurr[sn] === undefined) throw oraErr('08002', sn);
      return SESSION.seqCurr[sn];
    }
    const err = oraErr('02289'); err.hint = 'Sequence ' + p0 + ' existiert nicht.'; throw err;
  }
  if (parts.length === 3 && parts[0] === SCHEMA) return resolveName({ k: 'id', parts: parts.slice(1), line: e.line, col: e.col }, env);
  if (parts.length === 1) {
    switch (p0) {
      case 'SYSDATE': case 'CURRENT_DATE': return nowDate();
      case 'SYSTIMESTAMP': case 'CURRENT_TIMESTAMP': case 'LOCALTIMESTAMP': { const n = new Date(); const d = mkDate(n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()); d.isTs = true; return d; }
      case 'USER': return SCHEMA;
      case 'UID': return 101;
      case 'SQLCODE': { const err = curErr(f); return err ? err.sqlcode : 0; }
      case 'SQLERRM': { const err = curErr(f); return err ? err.sqlerrm : 'ORA-0000: normal, successful completion'; }
      case 'INSERTING': case 'UPDATING': case 'DELETING': { const tc = trigCtx(); if (!tc) break; return p0 === 'INSERTING' ? tc.event === 'INSERT' : p0 === 'UPDATING' ? tc.event === 'UPDATE' : tc.event === 'DELETE'; }
      case 'ROWNUM': case 'LEVEL': if (!env.rs) { if (p0 === 'ROWNUM') return null; } break;
      case 'DBTIMEZONE': case 'SESSIONTIMEZONE': return '+01:00';
      case 'NULL': return null;
    }
  }
  // parameterlose Funktion
  const target = findCallable(parts, f);
  if (target) {
    if (target.sub) return callSub(pickOverload(target.sub, 0, parts.join('.')), [], env, true, parts.join('.'));
    if (target.builtin) return target.builtin([], env, { k: 'call', name: parts, args: [] });
  }
  throw invalidIdent(e, SESSION.ctx === 'plsql' && !env.rs);
}
function curErr(f) { for (let x = f; x; x = x.parent) if (x.curErr) return x.curErr; return null; }
function findCallable(parts, f) {
  if (parts.length === 1) {
    const s = lookupSubs(parts[0], f); if (s) return { sub: s };
    const p = DB.procs[parts[0]]; if (p) return { sub: [{ def: p, scope: null, lineBase: p.lineBase, objName: p.name }] };
    if (DB.synonyms[parts[0]] && DB.procs[DB.synonyms[parts[0]].target]) { const q = DB.procs[DB.synonyms[parts[0]].target]; return { sub: [{ def: q, scope: null, lineBase: q.lineBase, objName: q.name }] }; }
    if (BUILTIN[parts[0]]) return { builtin: BUILTIN[parts[0]] };
    return null;
  }
  if (parts.length === 2) {
    if (parts[0] === SCHEMA) return findCallable([parts[1]], f);
    if (DB.pkgs[parts[0]]) { const pf = pkgMember(parts[0], parts[1], f); const s = pf.subs.get(parts[1]); if (s) return { sub: s }; return null; }
    const b = BUILTIN[parts[0] + '.' + parts[1]]; if (b) return { builtin: b };
  }
  if (parts.length === 3 && parts[0] === SCHEMA) return findCallable(parts.slice(1), f);
  return null;
}
function pickOverload(list, nargs, name, named) {
  const ok = list.filter(x => { const ps = x.def.params; const req = ps.filter(p => !p.def).length; return nargs <= ps.length && nargs >= (named ? 0 : req); });
  if (!ok.length) { const e = plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + name + '\''); throw e; }
  return ok[0];
}

// ---------- Aufrufe ----------
function evCall(e, env) {
  const parts = e.name; const f = env.f;
  // Collection-Element oder Methode
  const fp = findVarPath(parts, f);
  if (fp) {
    if (fp.used === parts.length) {
      const v = fp.v.value;
      if (v instanceof Coll) { if (e.args.length !== 1) throw plsErr('00306', 'Falsche Anzahl von Indizes'); return collGet(v, ev(e.args[0], env)); }
      throw plsErr('00222', 'Keine Funktion mit Namen \'' + parts.join('.') + '\' in diesem Geltungsbereich vorhanden');
    }
    const holder = walkValue(fp.v.value, parts.slice(0, -1), fp.used, e);
    const last = parts[parts.length - 1];
    if (holder instanceof Coll && COLL_METHODS.has(last)) return collMethod(holder, last, e.args.map(a => ev(a, env)));
    const v = walkValue(holder, [last], 0, e);
    if (v instanceof Coll) return collGet(v, ev(e.args[0], env));
    throw plsErr('00222', 'Keine Funktion mit Namen \'' + parts.join('.') + '\'');
  }
  // Typkonstruktor
  if (parts.length === 1 || (parts.length === 2 && DB.pkgs[parts[0]])) {
    let t = null;
    if (parts.length === 1) { t = f && lookupType(parts[0], f); if (!t && DB.types[parts[0]] && !DB.procs[parts[0]]) t = schemaType(parts[0]); }
    else { const pf = getPkgFrame(parts[0]); t = pf.types.get(parts[1]) || null; }
    if (t && (t.b === 'COLL' || t.b === 'REC')) return construct(t, e.args.map(a => ev(a.named ? a.e : a, env)));
  }
  const target = findCallable(parts, f);
  if (target && target.sub) { const named = e.args.some(a => a.named); return callSub(pickOverload(target.sub, e.args.length, parts.join('.'), named), e.args, env, true, parts.join('.')); }
  if (target && target.builtin) return target.builtin(e.args, env, e);
  if (AGG_FUNCS.has(parts[0])) throw oraErr('00934' in ORA_MSG ? '00934' : '00904', parts[0]);
  const err = SESSION.ctx === 'plsql' && !env.rs ? plsErr('00201', 'Bezeichner \'' + parts.join('.') + '\' muss deklariert werden') : oraErr('00904', '"' + parts.join('"."') + '"');
  if (e.line) { err.line = e.line; }
  if (parts.length === 1 && ['LEFT', 'RIGHT', 'ISNULL', 'IFNULL', 'LEN', 'GETDATE', 'NOW', 'DATEDIFF', 'DATEADD', 'CHARINDEX', 'SUBSTRING', 'CURDATE', 'DATE_FORMAT', 'STR_TO_DATE', 'GROUP_CONCAT'].includes(parts[0])) {
    const map = { LEFT: 'SUBSTR(s, 1, n)', RIGHT: 'SUBSTR(s, -n)', ISNULL: 'NVL(a, b)', IFNULL: 'NVL(a, b)', LEN: 'LENGTH(s)', GETDATE: 'SYSDATE', NOW: 'SYSDATE', DATEDIFF: 'datum1 - datum2 (Tage) oder MONTHS_BETWEEN', DATEADD: 'datum + n bzw. ADD_MONTHS', CHARINDEX: 'INSTR(s, such)', SUBSTRING: 'SUBSTR(s, pos, len)', CURDATE: 'TRUNC(SYSDATE)', DATE_FORMAT: 'TO_CHAR(datum, \'DD.MM.YYYY\')', STR_TO_DATE: 'TO_DATE(s, \'DD.MM.YYYY\')', GROUP_CONCAT: 'LISTAGG(x, \', \') WITHIN GROUP (ORDER BY x)' };
    err.hint = parts[0] + ' gibt es in Oracle nicht. Oracle-Variante: ' + map[parts[0]];
  }
  throw err;
}
function construct(t, args) {
  if (t.b === 'REC') {
    const r = new Rec(t.fields);
    if (args.length !== t.fields.length) throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + t.name + '\'');
    t.fields.forEach((fl, i) => r.set(fl.name, coerce(cloneVal(args[i]), fl.type, { kind: 'var', name: fl.name })));
    if (t.object) r.objType = t.name;
    return r;
  }
  if (t.indexBy) throw plsErr('00222', 'Assoziative Arrays haben keinen Konstruktor');
  const c = new Coll(t); c.isNull = false;
  if (t.kind === 'varray' && args.length > t.size) throw oraErr('06532');
  args.forEach((a, i) => c.map.set(i + 1, coerce(cloneVal(a), t.of, { kind: 'var', name: t.name })));
  c.size = args.length;
  return c;
}
function recField(o, name) {
  if (o instanceof Rec) { if (!o.has(name)) throw plsErr('00302', 'Komponente \'' + name + '\' muss deklariert werden'); return o.get(name); }
  if (o instanceof Coll) return collMethod(o, name, []);
  if (o === null) throw oraErr('06530');
  throw plsErr('00487', 'Ungültige Referenz auf Feld ' + name);
}
function collKey(c, k) {
  if (k === null) { const e = oraErr('06502', ': NULL-Indexschlüsselwert'); throw e; }
  if (c.strKeys) return toStr(k);
  const n = toNum(k); return Math.round(n);
}
function collGet(c, k) {
  c.checkInit();
  const key = collKey(c, k);
  if (!c.map.has(key)) {
    if (c.type.indexBy) throw oraErr('01403');
    if (key < 1 || key > (c.size || 0)) throw oraErr(c.kind === 'varray' && key > c.type.size ? '06532' : '06533');
    throw oraErr('01403');
  }
  return c.map.get(key);
}
function collSetRef(c, k) {
  c.checkInit();
  const key = collKey(c, k);
  if (!c.type.indexBy) { if (key < 1 || key > (c.size || 0)) throw oraErr(c.kind === 'varray' && key > c.type.size ? '06532' : '06533'); }
  return key;
}
function collMethod(c, m, args) {
  const nullOk = m === 'EXISTS' || m === 'COUNT' && false;
  if (c.isNull && !nullOk) { if (m === 'EXISTS') return false; throw oraErr('06531'); }
  const ks = () => c.keys();
  switch (m) {
    case 'COUNT': return c.map.size;
    case 'FIRST': { const k = ks(); return k.length ? k[0] : null; }
    case 'LAST': { const k = ks(); return k.length ? k[k.length - 1] : null; }
    case 'LIMIT': return c.kind === 'varray' ? c.type.size : null;
    case 'EXISTS': { if (args[0] === null) return false; return c.map.has(collKey(c, args[0])); }
    case 'NEXT': case 'PRIOR': {
      const k = ks(); const x = c.strKeys ? toStr(args[0]) : toNum(args[0]); if (x === null) return null;
      if (m === 'NEXT') { for (const y of k) if (y > x) return y; return null; }
      for (let i = k.length - 1; i >= 0; i--) if (k[i] < x) return k[i]; return null;
    }
    case 'EXTEND': {
      if (c.type.indexBy) throw plsErr('00306', 'EXTEND ist für assoziative Arrays nicht erlaubt');
      const n = args.length ? toNum(args[0]) : 1; const src = args.length > 1 ? collGet(c, args[1]) : undefined;
      if (c.kind === 'varray' && (c.size || 0) + n > c.type.size) throw oraErr('06532');
      for (let i = 0; i < n; i++) { c.size = (c.size || 0) + 1; c.map.set(c.size, src !== undefined ? cloneVal(src) : initValue(c.type.of)); }
      return null;
    }
    case 'DELETE': {
      if (!args.length) { c.map.clear(); if (!c.type.indexBy) c.size = 0; return null; }
      if (c.kind === 'varray') throw plsErr('00306', 'DELETE(n) ist für VARRAYs nicht erlaubt');
      const a = collKey(c, args[0]), b = args.length > 1 ? collKey(c, args[1]) : a;
      for (const k of ks()) if (k >= a && k <= b) c.map.delete(k);
      return null;
    }
    case 'TRIM': {
      if (c.type.indexBy) throw plsErr('00306', 'TRIM ist für assoziative Arrays nicht erlaubt');
      const n = args.length ? toNum(args[0]) : 1; if (n > (c.size || 0)) throw oraErr('06533');
      for (let i = 0; i < n; i++) { c.map.delete(c.size); c.size--; }
      return null;
    }
  }
  throw plsErr('00302', 'Komponente \'' + m + '\' muss deklariert werden');
}
function evAttr(e, env) {
  if (e.of.k === 'id' && e.of.parts.length === 1 && e.of.parts[0] === 'SQL') {
    const a = SESSION.sqlAttr;
    switch (e.attr) { case 'FOUND': return a.found; case 'NOTFOUND': return a.found === null ? null : !a.found; case 'ROWCOUNT': return a.rowcount; case 'ISOPEN': return false; case 'BULK_ROWCOUNT': return a.rowcount; }
  }
  const name = e.of.k === 'id' ? e.of.parts.join('.') : null;
  const c = name && findCursor(name, env.f);
  if (!c) throw plsErr('00201', 'Bezeichner \'' + name + '\' muss deklariert werden');
  const s = c.state;
  if (e.attr === 'ISOPEN') return s.isOpen;
  if (!s.isOpen) throw oraErr('01001');
  switch (e.attr) { case 'FOUND': return s.found; case 'NOTFOUND': return s.found === null ? null : !s.found; case 'ROWCOUNT': return s.rowcount; }
}

// ---------- Zuweisungsziele ----------
function lref(node, env) {
  const f = env.f;
  if (node.k === 'id') {
    const parts = node.parts;
    if (parts[0][0] === ':') {
      const v = f && lookupVar(parts[0], f);
      if (!v) { const b = SESSION.binds[SESSION.binds.length - 1]; if (b) { const i = b.names.indexOf(parts[0]); if (i >= 0 && b.vals[i] && b.vals[i].ref) return b.vals[i].ref; } throw plsErr('00049', 'Ungültige Bind-Variable \'' + parts[0] + '\''); }
      if (parts.length === 1) throw plsErr('00049', 'Ungültige Bind-Variable');
      if (v.ro || v.trigNew === 'ro') { if (parts[0] === ':OLD' || v.ro) throw new OraError('ORA-04085', 'Wert der OLD-Referenzvariablen kann nicht geändert werden'); throw new OraError('ORA-04084', 'NEW-Werte können für diesen Trigger-Typ nicht geändert werden'); }
      return fieldRef(v.value, parts.slice(1), node);
    }
    const fp = findVarPath(parts, f);
    let v = fp ? fp.v : null, used = fp ? fp.used : 0;
    if (!v && parts.length >= 2 && DB.pkgs[parts[0]]) { const pf = pkgMember(parts[0], parts[1], f); v = pf.vars.get(parts[1]); used = 2; }
    if (!v) throw plsErr('00201', 'Bezeichner \'' + parts.join('.') + '\' muss deklariert werden');
    if (used === parts.length) {
      return {
        get: () => v.value,
        set: (x) => {
          if (v.constant) throw plsErr('00363', 'Ausdruck \'' + v.name + '\' kann nicht als Zuweisungsziel verwendet werden');
          const nv = coerce(cloneVal(x), v.type, { kind: 'var', name: v.name });
          if (v.notNull && nv === null) throw oraErr('06502', '');
          v.value = nv;
        }, type: v.type, isVar: true, v,
      };
    }
    if (v.constant) throw plsErr('00363', 'Ausdruck \'' + v.name + '\' kann nicht als Zuweisungsziel verwendet werden');
    return fieldRef(v.value, parts.slice(used), node);
  }
  if (node.k === 'call') {
    const base = lref({ k: 'id', parts: node.name }, env);
    const c = base.get();
    if (!(c instanceof Coll)) throw plsErr('00308', 'Diese Konstruktion ist als Zuweisungsziel nicht zulässig');
    if (node.args.length !== 1) throw plsErr('00306', 'Falsche Anzahl von Indizes');
    return elemRef(c, ev(node.args[0], env));
  }
  if (node.k === 'member') { const base = lref(node.obj, env); return fieldRef(base.get(), [node.name], node, base); }
  if (node.k === 'callx') { const base = lref(node.obj, env); const c = base.get(); if (!(c instanceof Coll)) throw plsErr('00308', 'Ungültiges Zuweisungsziel'); return elemRef(c, ev(node.args[0], env)); }
  throw plsErr('00308', 'Diese Konstruktion ist als Zuweisungsziel nicht zulässig');
}
function elemRef(c, k) {
  return {
    get: () => {
      c.checkInit(); const key = collKey(c, k);
      if (!c.map.has(key)) { if (c.type.indexBy) { const v = initValue(c.type.of); if (v instanceof Rec) { c.map.set(key, v); return v; } } return collGet(c, k); }
      return c.map.get(key);
    },
    set: (x) => { const key = collSetRef(c, k); c.map.set(key, coerce(cloneVal(x), c.type.of, { kind: 'var', name: 'element' })); },
    type: c.type.of,
  };
}
function fieldRef(holder, path, node) {
  let h = holder;
  for (let i = 0; i < path.length - 1; i++) {
    if (!(h instanceof Rec)) throw plsErr('00487', 'Ungültige Referenz');
    if (!h.has(path[i])) throw plsErr('00302', 'Komponente \'' + path[i] + '\' muss deklariert werden');
    h = h.get(path[i]);
  }
  const last = path[path.length - 1];
  if (!(h instanceof Rec)) { if (h === null) throw oraErr('06530'); throw plsErr('00487', 'Ungültige Referenz auf \'' + last + '\''); }
  if (!h.has(last)) throw plsErr('00302', 'Komponente \'' + last + '\' muss deklariert werden');
  return { get: () => h.get(last), set: (x) => h.set(last, coerce(cloneVal(x), h.types[last], { kind: 'var', name: last })), type: h.types[last] };
}
function assignTargets(targets, vals, env, cols) {
  if (targets.length === 1) {
    const ref = lref(targets[0], env);
    const cur = ref.get();
    if (cur instanceof Rec || (ref.type && ref.type.b === 'REC')) {
      const t = ref.type || { b: 'REC', fields: cur.names.map(n => ({ name: n, type: cur.types[n] })) };
      if (vals.length !== t.fields.length) throw oraErr(vals.length < t.fields.length ? '00947' : '00913');
      const r = new Rec(t.fields);
      t.fields.forEach((fl, i) => r.set(fl.name, coerce(vals[i], fl.type, { kind: 'var', name: fl.name })));
      ref.set(r); return;
    }
    if (vals.length > 1) throw oraErr('00913');
    ref.set(vals[0]); return;
  }
  if (targets.length > vals.length) throw oraErr('00947');
  if (targets.length < vals.length) throw oraErr('00913');
  targets.forEach((t, i) => lref(t, env).set(vals[i]));
}
function bulkInto(targets, rows, cols, env) {
  if (targets.length === 1) {
    const ref = lref(targets[0], env); const c = ref.get();
    if (!(c instanceof Coll)) throw plsErr('00497', 'BULK COLLECT INTO braucht eine Collection-Variable');
    const nc = new Coll(c.type); nc.isNull = false;
    const of = c.type.of;
    rows.forEach((r, i) => {
      let v;
      if (of && of.b === 'REC') { if (r.length !== of.fields.length) throw oraErr(r.length < of.fields.length ? '00947' : '00913'); v = new Rec(of.fields); of.fields.forEach((fl, k) => v.set(fl.name, coerce(r[k], fl.type, { kind: 'var', name: fl.name }))); }
      else { if (r.length > 1) throw oraErr('00913'); v = coerce(r[0], of, { kind: 'var', name: 'element' }); }
      nc.map.set(i + 1, v);
    });
    nc.size = rows.length;
    ref.set(nc);
    return;
  }
  if (targets.length !== (cols ? cols.length : (rows[0] || []).length) && rows.length) throw oraErr(targets.length > rows[0].length ? '00947' : '00913');
  targets.forEach((t, k) => {
    const ref = lref(t, env); const c = ref.get();
    if (!(c instanceof Coll)) throw plsErr('00497', 'BULK COLLECT INTO braucht Collection-Variablen');
    const nc = new Coll(c.type); nc.isNull = false;
    rows.forEach((r, i) => nc.map.set(i + 1, coerce(r[k], c.type.of, { kind: 'var', name: 'element' })));
    nc.size = rows.length; ref.set(nc);
  });
}

// ---------- Ausführung ----------
function execBlockIn(block, f, sameFrame) {
  const prevCtx = SESSION.ctx; SESSION.ctx = 'plsql';
  try {
    declare(block.decls || [], f);
    try { execStmts(block.body, f); }
    catch (e) {
      if (!(e instanceof OraError) || !block.handlers || !block.handlers.length) throw e;
      const h = findHandler(block.handlers, e, f);
      if (!h) throw e;
      const prev = f.curErr; f.curErr = e;
      try { execStmts(h.body, f); } finally { f.curErr = prev; }
    }
  } finally { SESSION.ctx = prevCtx; }
}
function findHandler(handlers, e, f) {
  for (const h of handlers) {
    for (const n of h.names) {
      if (n === 'OTHERS') return h;
      if (PREDEF_EXC[n] && PREDEF_EXC[n] === e.code && !e.userExc) return h;
      const ex = lookupExc(n, f) || (n.includes('.') ? null : null);
      if (ex) {
        if (e.excId === ex.id) return h;
        if (ex.code && parseInt(e.code.replace(/\D/g, ''), 10) === ex.code) return h;
      }
      if (!PREDEF_EXC[n] && !ex) { const pk = Object.keys(DB.pkgs).find(p => { try { const pf = SESSION.pkgState[p]; return pf && pf.excs.has(n); } catch (x) { return false; } }); if (pk) { const pe = SESSION.pkgState[pk].excs.get(n); if (e.excId === pe.id || (pe.code && parseInt(e.code.replace(/\D/g, ''), 10) === pe.code)) return h; } }
    }
  }
  return null;
}
function execStmts(list, f) { for (const s of list) execStmt(s, f); }
function loopRun(s, body, f, iter) {
  try { execStmts(body, f); }
  catch (sig) {
    if (sig instanceof ExitSignal && (!sig.label || sig.label === s.label)) return 'exit';
    if (sig instanceof ContinueSignal && (!sig.label || sig.label === s.label)) return 'cont';
    throw sig;
  }
  return 'cont';
}
function execStmt(s, f) {
  stepCheck();
  if (s.ln) { f.act.line = s.ln; if (f.act.script) SESSION.lastLine = s.ln; }
  if (SESSION.trace && f.act.script && s.k !== 'block') traceStep(s.ln, f);
  const env = { f };
  switch (s.k) {
    case 'null_s': return;
    case 'assign': { const ref = lref(s.target, env); ref.set(ev(s.e, env)); return; }
    case 'callp': return callProcStmt(s.e, env);
    case 'if': {
      for (const c of s.conds) if (toBool(ev(c.c, env)) === true) { execStmts(c.body, f); return; }
      if (s.else) execStmts(s.else, f);
      return;
    }
    case 'case_s': {
      const b = s.base ? ev(s.base, env) : undefined;
      for (const w of s.whens) {
        const hit = s.base ? cmpVals(b, ev(w.w, env)) === 0 : toBool(ev(w.w, env)) === true;
        if (hit) { execStmts(w.body, f); return; }
      }
      if (s.else) { execStmts(s.else, f); return; }
      throw oraErr('06592');
    }
    case 'loop': { let first = true; while (true) { stepCheck(); if (!first) traceStep(s.ln, f); first = false; if (loopRun(s, s.body, f) === 'exit') break; } return; }
    case 'while': { let first = true; while (true) { if (!first) traceStep(s.ln, f); first = false; if (toBool(ev(s.c, env)) !== true) break; stepCheck(); if (loopRun(s, s.body, f) === 'exit') break; } return; }
    case 'fori': {
      const lo = toNum(ev(s.lo, env)), hi = toNum(ev(s.hi, env));
      if (lo === null || hi === null) throw oraErr('06502', ': NULL in FOR-Schleifengrenze');
      const a = Math.round(lo), b = Math.round(hi);
      const lf = new Frame(f, 'block'); lf.label = s.label;
      const v = { name: s.v, type: { b: 'PLS_INTEGER' }, value: null, constant: true };
      lf.vars.set(s.v, v);
      if (!s.reverse) { for (let i = a; i <= b; i++) { stepCheck(); v.value = i; if (i !== a) traceStep(s.ln, lf); if (loopRun(s, s.body, lf) === 'exit') break; } }
      else { for (let i = b; i >= a; i--) { stepCheck(); v.value = i; if (i !== b) traceStep(s.ln, lf); if (loopRun(s, s.body, lf) === 'exit') break; } }
      return;
    }
    case 'forc': {
      let rows, cols, types, rsList;
      if (s.q) { const r = runQuery(s.q, env, { keepRs: true }); rows = r.rows; cols = r.cols; types = r.types; rsList = r.rsList; }
      else {
        const c = findCursor(s.cursor, f);
        if (!c || c.ref) throw plsErr('00201', 'Bezeichner \'' + s.cursor + '\' muss deklariert werden');
        if (c.state.isOpen) throw oraErr('06511');
        const r = openCursorQuery(c, s.args, env); rows = r.rows; cols = r.cols; types = r.types; rsList = r.rsList;
        c.state.isOpen = true; c.state.rowcount = 0; c.state.found = null;
        var cur = c;
      }
      const lf = new Frame(f, 'block'); lf.label = s.label;
      const fields = cols.map((n, i) => ({ name: n, type: types[i] || null }));
      const rv = { name: s.v, type: { b: 'REC', fields, name: 'RECORD' }, value: null };
      lf.vars.set(s.v, rv);
      try {
        for (let i = 0; i < rows.length; i++) {
          stepCheck();
          const r = new Rec(fields); cols.forEach((n, k) => r.set(n, rows[i][k])); rv.value = r;
          if (cur) { cur.state.rowcount++; cur.state.found = true; cur.state.current = rsList && rsList[i] ? rsList[i].vals[0] : null; }
          if (i > 0) traceStep(s.ln, lf);
          if (loopRun(s, s.body, lf) === 'exit') break;
        }
      } finally { if (cur) { cur.state.isOpen = false; cur.state.current = null; } }
      return;
    }
    case 'exit': if (!s.when || toBool(ev(s.when, env)) === true) throw new ExitSignal(s.label); return;
    case 'continue': if (!s.when || toBool(ev(s.when, env)) === true) throw new ContinueSignal(s.label); return;
    case 'return': throw new ReturnSignal(s.e ? ev(s.e, env) : undefined);
    case 'raise': {
      if (!s.name) { const e = curErr(f); if (!e) throw plsErr('00367', 'Eine RAISE-Anweisung ohne Namen ist nur in einem Exception-Handler zulässig'); throw e; }
      if (PREDEF_EXC[s.name]) { const num = PREDEF_EXC[s.name].slice(4); throw oraErr(num, ''); }
      let ex = lookupExc(s.name, f);
      if (!ex) { for (const p of Object.keys(SESSION.pkgState)) { const pf = SESSION.pkgState[p]; if (pf.excs.has(s.name)) { ex = pf.excs.get(s.name); break; } } }
      if (!ex) throw plsErr('00201', 'Bezeichner \'' + s.name + '\' muss deklariert werden');
      let e;
      if (ex.code) { const num = String(ex.code).padStart(5, '0'); e = ORA_MSG[num] ? oraErr(num) : new OraError('ORA-' + num, ''); }
      else { e = oraErr('06510'); e.userExc = true; e.excName = s.name; }
      e.excId = ex.id;
      throw e;
    }
    case 'block': {
      const bf = new Frame(f, 'block', s.label);
      execBlockIn(s, bf);
      return;
    }
    case 'sql': return execSqlInPlsql(s.stmt, env);
    case 'open': {
      const c = findCursor(s.name, f);
      if (!c) throw plsErr('00201', 'Bezeichner \'' + s.name + '\' muss deklariert werden');
      if (c.ref) throw plsErr('00382', 'Cursor-Variable mit OPEN ... FOR öffnen');
      if (c.state.isOpen) throw oraErr('06511');
      const r = openCursorQuery(c, s.args, env);
      Object.assign(c.state, { isOpen: true, rows: r.rows, cols: r.cols, types: r.types, rsList: r.rsList, pos: 0, rowcount: 0, found: null, current: null });
      return;
    }
    case 'openfor': {
      const ref = lref({ k: 'id', parts: [s.name] }, env);
      let r;
      if (s.q) r = runQuery(s.q, env, { keepRs: true });
      else {
        const sql = toStr(ev(s.dyn, env));
        const vals = (s.using || []).map(u => ({ v: ev(u, env) }));
        r = runDynamicQuery(sql, vals);
      }
      const st = new CursorState(s.name);
      Object.assign(st, { isOpen: true, rows: r.rows, cols: r.cols, types: r.types, pos: 0, rowcount: 0, found: null });
      const v = lookupVar(s.name, f); v.value = st;
      return;
    }
    case 'fetch': {
      const c = findCursor(s.name, f);
      if (!c) throw plsErr('00201', 'Bezeichner \'' + s.name + '\' muss deklariert werden');
      const st = c.state;
      if (!st.isOpen) throw oraErr('01001');
      if (s.bulk) {
        const lim = s.limit ? Math.max(0, toNum(ev(s.limit, env))) : Infinity;
        const chunk = st.rows.slice(st.pos, st.pos + lim);
        st.pos += chunk.length; st.rowcount += chunk.length; st.found = chunk.length > 0;
        bulkInto(s.into, chunk, st.cols, env);
        return;
      }
      if (st.pos < st.rows.length) {
        const row = st.rows[st.pos];
        st.current = st.rsList && st.rsList[st.pos] ? st.rsList[st.pos].vals[0] : null;
        st.pos++; st.rowcount++; st.found = true;
        assignTargets(s.into, row, env, st.cols);
      } else st.found = false;
      return;
    }
    case 'close': {
      const c = findCursor(s.name, f);
      if (!c) throw plsErr('00201', 'Bezeichner \'' + s.name + '\' muss deklariert werden');
      if (!c.state.isOpen) throw oraErr('01001');
      c.state.isOpen = false; c.state.current = null;
      return;
    }
    case 'execimm': return execImmediate(s, env);
    case 'forall': {
      let idx;
      if (s.indicesOf) { const c = ev(s.indicesOf, env); idx = c.keys(); }
      else { const a = Math.round(toNum(ev(s.lo, env))), b = Math.round(toNum(ev(s.hi, env))); idx = []; for (let i = a; i <= b; i++) idx.push(i); }
      const lf = new Frame(f, 'block');
      const v = { name: s.v, type: { b: 'PLS_INTEGER' }, value: null, constant: true }; lf.vars.set(s.v, v);
      let total = 0;
      for (const i of idx) { v.value = i; execStmt(s.stmt, lf); total += SESSION.sqlAttr.rowcount; }
      SESSION.sqlAttr = { found: total > 0, rowcount: total, isopen: false };
      return;
    }
  }
  throw new OraError('ORA-00600', 'Interner Fehler: Anweisung ' + s.k);
}
function openCursorQuery(c, args, env) {
  const d = c.decl;
  const pf = new Frame(c.frame, 'block');
  const ps = d.params || [];
  if ((args || []).length > ps.length) throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + d.name + '\'');
  ps.forEach((p, i) => {
    const a = args && args[i];
    let v = a ? ev(a.named ? a.e : a, env) : (p.def ? ev(p.def, { f: c.frame }) : undefined);
    if (v === undefined) throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + d.name + '\'');
    pf.vars.set(p.name, { name: p.name, type: resolveType(p.type, c.frame), value: v, constant: true });
  });
  return runQuery(d.q, { f: pf }, { keepRs: true });
}
function callProcStmt(e, env) {
  let parts, args;
  if (e.k === 'id') { parts = e.parts; args = []; }
  else if (e.k === 'call') { parts = e.name; args = e.args; }
  else throw plsErr('00221', 'Ausdruck ist keine Prozedur oder nicht definiert');
  const f = env.f;
  // Collection-Methoden als Anweisung
  const fp = findVarPath(parts, f);
  if (fp && fp.used < parts.length) {
    const holder = walkValue(fp.v.value, parts.slice(0, -1), fp.used, e);
    const m = parts[parts.length - 1];
    if (holder instanceof Coll && ['EXTEND', 'DELETE', 'TRIM'].includes(m)) { collMethod(holder, m, args.map(a => ev(a, env))); return; }
  }
  if (fp && fp.used === parts.length) throw plsErr('00221', '\'' + parts.join('.') + '\' ist keine Prozedur oder nicht definiert');
  const key = parts.join('.');
  if (BUILTIN_PROC[key]) { BUILTIN_PROC[key](args, env, e); return; }
  if (parts.length === 2 && parts[0] === SCHEMA && BUILTIN_PROC[parts[1]]) { BUILTIN_PROC[parts[1]](args, env, e); return; }
  const target = findCallable(parts, f);
  if (target && target.sub) { const named = args.some(a => a.named); callSub(pickOverload(target.sub, args.length, key, named), args, env, false, key); return; }
  if (target && target.builtin) throw plsErr('00221', '\'' + key + '\' ist keine Prozedur oder nicht definiert (es ist eine Funktion – Rückgabewert zuweisen: x := ' + key + '(...);)');
  const err = plsErr('00201', 'Bezeichner \'' + key + '\' muss deklariert werden');
  if (e.line) err.line = e.line;
  if (parts[0] === 'PRINT' || parts[0] === 'PRINTLN' || parts[0] === 'ECHO') err.hint = 'Ausgabe in PL/SQL: DBMS_OUTPUT.PUT_LINE(...)';
  throw err;
}
function callSub(entry, argNodes, env, wantFunc, callName) {
  const def = entry.def;
  if (!def.block) {
    if (def.spec) throw new OraError('ORA-04067', 'Nicht ausgeführt, Package Body "' + SCHEMA + '.' + (entry.scope && entry.scope.pkgName || '') + '" ist nicht vorhanden oder ' + def.name + ' fehlt darin');
  }
  if (wantFunc && def.kind !== 'FUNCTION') throw plsErr('00222', 'Keine Funktion mit Namen \'' + callName + '\' in diesem Geltungsbereich vorhanden (' + callName + ' ist eine Prozedur)');
  if (!wantFunc && def.kind === 'FUNCTION') { const e = plsErr('00221', '\'' + callName + '\' ist keine Prozedur oder nicht definiert'); e.hint = callName + ' ist eine Funktion – nutze den Rückgabewert, z. B. v := ' + callName + '(...); oder SELECT ' + callName + '(...) FROM dual;'; throw e; }
  if (++SESSION.depth > 250) { SESSION.depth--; throw new OraError('ORA-00036', 'Maximale Anzahl rekursiver SQL-Ebenen (250) überschritten'); }
  const traceCall = SESSION.trace && env.f && env.f.act && env.f.act.script;
  if (traceCall) tr({ t: 'call', name: callName.toUpperCase(), kind: def.kind });
  const f = new Frame(entry.scope, 'proc');
  f.procName = def.name; f.def = def;
  f.act = { line: def.line || 0, base: entry.lineBase || 1, obj: entry.objName || def.name };
  f.objName = entry.objName; f.lineBase = entry.lineBase;
  const prevCtx = SESSION.ctx;
  // Argumente binden
  const byParam = new Map(); let pos = 0;
  for (const a of argNodes) {
    if (a.named) { const p = def.params.find(x => x.name === a.named); if (!p) { SESSION.depth--; throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + callName + '\' (unbekannter Parameter ' + a.named + ')'); } byParam.set(p.name, a.e); }
    else { if (pos >= def.params.length) { SESSION.depth--; throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + callName + '\''); } byParam.set(def.params[pos++].name, a); }
  }
  const outs = [];
  let result;
  try {
    for (const p of def.params) {
      const type = resolveType(p.type, entry.scope || f);
      const an = byParam.get(p.name);
      let value;
      if (!an) {
        if (p.def) value = ev(p.def, { f });
        else if (p.mode === 'OUT') value = initValue(type);
        else throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + callName + '\' (Parameter ' + p.name + ' fehlt)');
      } else if (p.mode === 'IN') value = ev(an, env);
      else {
        let ref;
        try { ref = lref(an, env); } catch (x) { throw plsErr('00363', 'Ausdruck kann nicht als Zuweisungsziel für OUT-Parameter ' + p.name + ' verwendet werden'); }
        value = p.mode === 'OUT' ? initValue(type) : cloneVal(ref.get());
        outs.push([p, ref]);
      }
      const t2 = type && (type.b === 'VARCHAR2' || type.b === 'CHAR') ? Object.assign({}, type, { len: null }) : (type && type.b === 'NUMBER' ? Object.assign({}, type, { p: null, s: null }) : type);
      f.vars.set(p.name, { name: p.name, type: t2, value: value === null ? null : coerce(cloneVal(value), t2, { kind: 'var', name: p.name }), constant: p.mode === 'IN' });
    }
    SESSION.ctx = 'plsql';
    const prevQ = SESSION.queryDepth;
    try {
      execBlockIn(def.block, f, true);
      if (def.kind === 'FUNCTION') throw oraErr('06503');
    } catch (e) {
      if (e instanceof ReturnSignal) {
        if (def.kind === 'FUNCTION') {
          if (e.value === undefined) throw plsErr('00503', 'RETURN-Anweisung in einer Funktion braucht einen Rückgabewert');
          result = coerce(cloneVal(e.value), resolveType(def.ret, entry.scope || f), { kind: 'var', name: 'RETURN' });
        }
      } else throw e;
    }
    for (const [p, ref] of outs) ref.set(f.vars.get(p.name).value);
    if (traceCall) tr({ t: 'ret', name: callName.toUpperCase(), value: def.kind === 'FUNCTION' ? traceVal(result) : null });
  } catch (e) {
    if (e instanceof OraError && !e._stamped?.has(f)) {
      const rel = Math.max(1, (f.act.line || 1) - (f.act.base || 1) + 1);
      const objPath = entry.objName && entry.objName !== def.name ? entry.objName : def.name;
      e.oraStack.push('ORA-06512: in "' + SCHEMA + '.' + objPath + '", Zeile ' + rel);
      (e._stamped = e._stamped || new Set()).add(f);
    }
    throw e;
  } finally { SESSION.ctx = prevCtx; SESSION.depth--; }
  return result;
}
function execSqlInPlsql(st, env) {
  switch (st.k) {
    case 'query': {
      const q = st.q;
      if (!q.into) { const e = plsErr('00428', 'In dieser SELECT-Anweisung wird eine INTO-Klausel erwartet'); e.hint = 'In PL/SQL braucht ein SELECT ein INTO (SELECT spalte INTO variable FROM ...) – oder eine Cursor-FOR-Schleife.'; throw e; }
      const r = runQuery(q, env, q.bulk ? {} : { limit: 2 });
      if (q.bulk) { bulkInto(q.into, r.rows, r.cols, env); SESSION.sqlAttr = { found: r.rows.length > 0, rowcount: r.rows.length }; return; }
      if (!r.rows.length) { SESSION.sqlAttr = { found: false, rowcount: 0 }; throw oraErr('01403'); }
      if (r.rows.length > 1) { SESSION.sqlAttr = { found: true, rowcount: 2 }; throw oraErr('01422'); }
      assignTargets(q.into, r.rows[0], env, r.cols);
      SESSION.sqlAttr = { found: true, rowcount: 1 };
      return;
    }
    case 'insert': return void execInsert(st, env);
    case 'insertAll': return void execInsertAll(st, env);
    case 'update': return void execUpdate(st, env);
    case 'delete': return void execDelete(st, env);
    case 'merge': return void execMerge(st, env);
    case 'commit': doCommit(); tr({ t: 'tx', op: 'commit' }); return;
    case 'rollback': doRollback(st.to); tr({ t: 'tx', op: 'rollback', to: st.to || null }); return;
    case 'savepoint': doSavepoint(st.name); return;
    case 'noop': return;
  }
  throw plsErr('00103', 'Anweisung in PL/SQL nicht zulässig');
}
function bindNames(sql) {
  const names = [];
  try { for (const t of lex(sql)) if (t.t === T_BIND && t.v !== ':NEW' && t.v !== ':OLD' && !names.includes(t.v)) names.push(t.v); } catch (e) { }
  return names;
}
function runDynamicQuery(sql, vals) {
  const items = parseScript(sql.replace(/;\s*$/, ''));
  if (items.length !== 1) throw oraErr('00933');
  if (items[0].error) throw items[0].error;
  const st = items[0].stmt;
  if (st.k !== 'query') throw oraErr('00928');
  SESSION.binds.push({ names: bindNames(sql), vals });
  try { return runQuery(st.q, { f: null }, { keepRs: true }); } finally { SESSION.binds.pop(); }
}
function execImmediate(s, env) {
  const sql = toStr(ev(s.e, env));
  if (sql === null) throw new OraError('ORA-06535', 'Anweisungszeichenfolge in EXECUTE IMMEDIATE ist NULL oder hat Länge 0');
  const trimmed = sql.trim();
  const isBlock = /^(DECLARE|BEGIN)\b/i.test(trimmed) || /^CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE)\b/i.test(trimmed);
  if (!isBlock && /;\s*$/.test(trimmed)) { const e = oraErr('00911'); e.hint = 'Bei EXECUTE IMMEDIATE ohne Semikolon am Ende: EXECUTE IMMEDIATE \'DROP TABLE t\';'; throw e; }
  const items = parseScript(sql);
  if (items.length !== 1) { if (!items.length) throw oraErr('00900'); throw oraErr('00933'); }
  if (items[0].error) throw items[0].error;
  const st = items[0].stmt;
  const vals = (s.using || []).map(u => u.mode === 'IN' ? { v: ev(u.e, env) } : { ref: lref(u.e, env) });
  SESSION.binds.push({ names: bindNames(sql), vals });
  try {
    if (st.k === 'query') {
      const r = runQuery(st.q, { f: null }, s.bulk ? {} : { limit: 2 });
      if (!s.into) return;
      if (s.bulk) { bulkInto(s.into, r.rows, r.cols, env); return; }
      if (!r.rows.length) throw oraErr('01403');
      if (r.rows.length > 1) throw oraErr('01422');
      assignTargets(s.into, r.rows[0], env, r.cols);
      return;
    }
    const res = execStatement(st, { f: null }, true);
    if (s.retInto && st.returning) { }
    return res;
  } finally { SESSION.binds.pop(); }
}
