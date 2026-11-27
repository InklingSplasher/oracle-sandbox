// ===== Zustand, Auswertung, Abfragen =====
const SCHEMA = 'STUDENT';
let DB = null;
const SESSION = {
  nls: { dateFmt: 'DD.MM.YYYY', tsFmt: 'DD.MM.YYYY HH24:MI:SS,FF6' },
  seqCurr: {}, pkgState: {}, out: [], lineBuf: '', outEnabled: true,
  sqlAttr: { found: null, rowcount: 0, isopen: false, notfound: null },
  steps: 0, depth: 0, ctx: 'sql', queryDepth: 0,
  undo: [], binds: [], trig: [], mutating: new Set(), implicitResults: [],
  lastErrors: [], stepLimit: 3000000, trace: null, traceMax: 6000, traceTrunc: false,
};
function tr(ev) {
  const T = SESSION.trace; if (!T) return;
  if (T.length >= SESSION.traceMax) { if (!SESSION.traceTrunc) { SESSION.traceTrunc = true; T.push({ t: 'trunc' }); } return; }
  T.push(ev);
}
function traceVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Rec) { const s = v.names.slice(0, 4).map(n => n.toLowerCase() + '=' + (v.get(n) === null ? 'NULL' : (v.get(n) instanceof Rec || v.get(n) instanceof Coll ? '…' : fmtCell(v.get(n))))).join(', '); return '{' + s + (v.names.length > 4 ? ', …' : '') + '}'; }
  if (v instanceof Coll) return v.isNull ? 'NULL' : '[' + v.map.size + ' Elemente]';
  if (v instanceof CursorState) return v.isOpen ? '(Cursor offen)' : '(Cursor)';
  if (isStr(v)) return "'" + (v.length > 40 ? v.slice(0, 40) + '…' : v) + "'";
  const s = fmtCell(v); return s.length > 40 ? s.slice(0, 40) + '…' : s;
}
function traceVars(f) {
  const out = []; const seen = new Set();
  for (let x = f; x && out.length < 14; x = x.parent) {
    for (const [n, v] of x.vars) { if (seen.has(n) || n[0] === ':') continue; seen.add(n); out.push([n.toLowerCase(), traceVal(v.value)]); if (out.length >= 14) break; }
    if (x.kind === 'proc') break;
  }
  return out.reverse();
}
function traceStep(line, f) { if (SESSION.trace && f.act.script) tr({ t: 'pl', line, vars: traceVars(f) }); }
function freshDB() {
  return { tables: {}, views: {}, seqs: {}, procs: {}, pkgs: {}, triggers: {}, indexes: {}, types: {}, synonyms: {}, comments: {}, conSeq: 8000, objSeq: 70000 };
}
class AbortError extends Error { }
class ExitSignal { constructor(label) { this.label = label; } }
class ContinueSignal { constructor(label) { this.label = label; } }
class ReturnSignal { constructor(value) { this.value = value; } }

function stepCheck() {
  if (++SESSION.steps > SESSION.stepLimit) throw new AbortError('Ausführung abgebrochen: mehr als ' + SESSION.stepLimit.toLocaleString('de-DE') + ' Schritte – vermutlich eine Endlosschleife (fehlt ein EXIT oder ein Inkrement?)');
}
function sub(env, patch) { const o = Object.assign({}, env); return Object.assign(o, patch); }
function jsonKey(e) { return JSON.stringify(e, (k, v) => (k === 'line' || k === 'col' || k === 'outer') ? undefined : v); }

// ---------- Fehler-Helfer ----------
function invalidIdent(node, inPl) {
  const parts = node.parts || [String(node)];
  const nm = parts.map(p => '"' + p + '"').join('.');
  let e;
  if (inPl) { e = plsErr('00201', 'Bezeichner \'' + parts.join('.') + '\' muss deklariert werden'); }
  else e = oraErr('00904', nm);
  if (node.quoted && /\s|[a-z]/.test(parts[parts.length - 1])) e.hint = 'Doppelte Anführungszeichen kennzeichnen in Oracle Bezeichner (Spalten-/Tabellennamen). Zeichenketten stehen in einfachen Anführungszeichen: \'' + parts[parts.length - 1] + '\'';
  if (node.line) { e.line = node.line; e.col = node.col; }
  return e;
}

// ---------- Ausdrucksauswertung ----------
function ev(e, env) {
  switch (e.k) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'null': return null;
    case 'bool': return e.v;
    case 'paren': return ev(e.e, env);
    case 'id': return evId(e, env);
    case 'bin': return evBin(e, env);
    case 'neg': { const v = ev(e.e, env); if (v === null) return null; if (v && v.interval) return negInterval(v); return -toNum(v); }
    case 'cmp': {
      const l = ev(e.l, env); const r = ev(e.r, env);
      if (Array.isArray(l) || Array.isArray(r)) return cmpTuple(e.op, l, r);
      return cmpOp(e.op, cmpVals(l, r));
    }
    case 'and': { const l = toBool(ev(e.l, env)); if (l === false) return false; const r = toBool(ev(e.r, env)); if (r === false) return false; if (l === null || r === null) return null; return true; }
    case 'or': { const l = toBool(ev(e.l, env)); if (l === true) return true; const r = toBool(ev(e.r, env)); if (r === true) return true; if (l === null || r === null) return null; return false; }
    case 'not': { const v = toBool(ev(e.e, env)); return v === null ? null : !v; }
    case 'isnull': { const v = ev(e.e, env); const n = v === null || v === undefined || ((v instanceof Coll) && v.isNull); return e.not ? !n : n; }
    case 'isempty': { const v = ev(e.e, env); const r = v instanceof Coll && v.map.size === 0; return e.not ? !r : r; }
    case 'istrue': { const v = toBool(ev(e.e, env)); const r = v === e.v; return e.not ? !r : r; }
    case 'like': {
      const v = ev(e.e, env), p = ev(e.pat, env); const esc = e.esc ? toStr(ev(e.esc, env)) : null;
      if (v === null || p === null) return null;
      const r = likeMatch(toStr(v), toStr(p), esc);
      return e.not ? !r : r;
    }
    case 'between': {
      const v = ev(e.e, env), lo = ev(e.lo, env), hi = ev(e.hi, env);
      const a = cmpVals(v, lo), b = cmpVals(v, hi);
      const x = a === null ? null : a >= 0, y = b === null ? null : b <= 0;
      let r; if (x === false || y === false) r = false; else if (x === null || y === null) r = null; else r = true;
      return e.not ? (r === null ? null : !r) : r;
    }
    case 'in': return evIn(e, env);
    case 'exists': { const res = runQuery(e.q, env, { limit: 1 }); return res.rows.length > 0; }
    case 'subq': {
      const res = runQuery(e.q, env, { limit: 2 });
      if (res.cols.length > 1) throw oraErr('00913');
      if (res.rows.length > 1) throw oraErr('01427');
      return res.rows.length ? res.rows[0][0] : null;
    }
    case 'case': {
      if (e.base) {
        const b = ev(e.base, env);
        for (const w of e.whens) if (cmpVals(b, ev(w.w, env)) === 0) return ev(w.t, env);
      } else {
        for (const w of e.whens) if (toBool(ev(w.w, env)) === true) return ev(w.t, env);
      }
      return e.else ? ev(e.else, env) : null;
    }
    case 'call': return evCall(e, env);
    case 'callx': { const o = ev(e.obj, env); if (o instanceof Coll) { if (e.args.length !== 1) throw plsErr('00306', 'Falsche Anzahl von Indizes'); return collGet(o, ev(e.args[0], env)); } throw plsErr('00225', 'Ungültige Referenz (kein Collection-Element)'); }
    case 'member': { const o = ev(e.obj, env); return recField(o, e.name); }
    case 'agg': return evAgg(e, env);
    case 'attr': return evAttr(e, env);
    case 'cast': return castVal(ev(e.e, env), e.type, env);
    case 'tuple': return e.items.map(x => ev(x, env));
    case 'dlit': return dateLiteral(e);
    case 'interval': return intervalLit(e);
    case 'prior': { const rs = env.rs; if (!rs || !rs.prior) return null; return ev(e.e, sub(env, { rs: rs.prior })); }
    case 'cbroot': { const rs = env.rs; if (!rs || !rs.root) return ev(e.e, env); return ev(e.e, sub(env, { rs: rs.root })); }
    case 'cmpq': {
      const l = ev(e.l, env);
      const vals = e.sub ? runQuery(e.sub, env).rows.map(r => r[0]) : e.list.map(x => ev(x, env));
      if (e.q === 'ANY') { let sawNull = false; for (const v of vals) { const c = cmpOp(e.op, cmpVals(l, v)); if (c === true) return true; if (c === null) sawNull = true; } return sawNull ? null : false; }
      let sawNull = false; for (const v of vals) { const c = cmpOp(e.op, cmpVals(l, v)); if (c === false) return false; if (c === null) sawNull = true; } return sawNull ? null : true;
    }
  }
  throw new OraError('ORA-00600', 'Interner Fehler: unbekannter Ausdruck ' + e.k);
}
function cmpOp(op, c) {
  if (c === null) return null;
  switch (op) { case '=': return c === 0; case '<>': return c !== 0; case '<': return c < 0; case '>': return c > 0; case '<=': return c <= 0; case '>=': return c >= 0; }
}
function cmpTuple(op, l, r) {
  if (!Array.isArray(l) || !Array.isArray(r) || l.length !== r.length) throw oraErr('00920');
  if (op !== '=' && op !== '<>') throw oraErr('00920');
  let sawNull = false;
  for (let i = 0; i < l.length; i++) { const c = cmpVals(l[i], r[i]); if (c === null) sawNull = true; else if (c !== 0) return op === '<>'; }
  if (sawNull) return null;
  return op === '=';
}
function evIn(e, env) {
  const v = ev(e.e, env);
  let list;
  if (e.q) { const res = runQuery(e.q, env); list = Array.isArray(v) ? res.rows : res.rows.map(r => { if (r.length > 1) throw oraErr('00913'); return r[0]; }); }
  else list = e.list.map(x => ev(x, env));
  let sawNull = false, found = false;
  for (const x of list) {
    const c = Array.isArray(v) ? cmpTuple('=', v, x) : (cmpVals(v, x) === null ? null : cmpVals(v, x) === 0);
    if (c === true) { found = true; break; }
    if (c === null) sawNull = true;
  }
  if (e.not) { if (found) return false; return sawNull ? null : true; }
  if (found) return true; return sawNull ? null : false;
}
function likeMatch(s, p, esc) {
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (esc && c === esc && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%') re += '[\\s\\S]*'; else if (c === '_') re += '[\\s\\S]'; else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$').test(s);
}
function evBin(e, env) {
  const l = ev(e.l, env), r = ev(e.r, env);
  if (e.op === '||') {
    const a = l === null ? '' : toStr(l), b = r === null ? '' : toStr(r);
    const s = a + b; return s === '' ? null : s;
  }
  if (l === null || r === null) return null;
  const hintPlus = (err) => { if (e.op === '+' && (isStr(l) || isStr(r)) && (err.code === 'ORA-01722' || err.code === 'ORA-06502')) err.hint = 'Zeichenketten werden in Oracle mit || verkettet, nicht mit +.'; return err; };
  try {
    switch (e.op) {
      case '+':
        if (isDate(l) && (isNum(r) || isStr(r))) return addDays(l, toNum(r));
        if (isDate(r) && isNum(l)) return addDays(r, l);
        if (l && l.interval) return isDate(r) ? addInterval(r, l) : addIntervals(l, r);
        if (r && r.interval) return isDate(l) ? addInterval(l, r) : addIntervals(l, r);
        if (isDate(l) && isDate(r)) throw oraErr('00975' in ORA_MSG ? '00975' : '00932', 'NUMBER', 'DATE');
        return toNum(l) + toNum(r);
      case '-':
        if (isDate(l) && isDate(r)) return (l.getTime() - r.getTime()) / 86400000;
        if (isDate(l) && (isNum(r) || isStr(r))) return addDays(l, -toNum(r));
        if (isDate(l) && r && r.interval) return addInterval(l, negInterval(r));
        if (isDate(r)) throw oraErr('00932', 'NUMBER', 'DATE');
        return toNum(l) - toNum(r);
      case '*': return toNum(l) * toNum(r);
      case '/': { const d = toNum(r); if (d === 0) throw oraErr('01476'); return toNum(l) / d; }
      case '**': return Math.pow(toNum(l), toNum(r));
      case 'MOD': { const a = toNum(l), b = toNum(r); if (b === 0) return a; return a - b * Math.trunc(a / b); }
    }
  } catch (err) { if (err instanceof OraError) throw hintPlus(err); throw err; }
}
function addDays(d, n) { const r = new Date(d.getTime() + Math.round(n * 86400000)); if (d.isTs) r.isTs = true; return r; }
function addInterval(d, iv) { if (iv.months !== undefined) return addMonths(d, iv.months); return addDays(d, iv.days); }
function addIntervals(a, b) { if (a.months !== undefined) return { interval: true, months: a.months + b.months }; return { interval: true, days: a.days + b.days }; }
function negInterval(v) { return v.months !== undefined ? { interval: true, months: -v.months } : { interval: true, days: -v.days }; }
function intervalLit(e) {
  const s = e.v.trim(); const u = e.unit;
  if (u === 'YEAR') { const m = s.match(/^([+-]?\d+)(?:-(\d+))?$/); if (!m) throw oraErr('01867' in ORA_MSG ? '01867' : '01861'); return { interval: true, months: parseInt(m[1], 10) * 12 + (m[2] ? parseInt(m[2], 10) * Math.sign(parseInt(m[1], 10) || 1) : 0) }; }
  if (u === 'MONTH') return { interval: true, months: parseInt(s, 10) };
  if (u === 'DAY') {
    const m = s.match(/^([+-]?\d+)(?:\s+(\d+)(?::(\d+)(?::(\d+(?:\.\d+)?))?)?)?$/);
    if (!m) throw oraErr('01861');
    const sign = s.startsWith('-') ? -1 : 1;
    return { interval: true, days: parseInt(m[1], 10) + sign * ((+(m[2] || 0)) / 24 + (+(m[3] || 0)) / 1440 + (+(m[4] || 0)) / 86400) };
  }
  if (u === 'HOUR') { const [h, mi] = s.split(':'); return { interval: true, days: (+h) / 24 + (+(mi || 0)) / 1440 }; }
  if (u === 'MINUTE') return { interval: true, days: (+s) / 1440 };
  if (u === 'SECOND') return { interval: true, days: (+s) / 86400 };
  throw oraErr('01861');
}
function dateLiteral(e) {
  const s = e.v.trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/);
  if (!m || (!e.ts && m[4])) { const err = oraErr('01861'); err.hint = 'Datumsliterale haben das Format DATE \'JJJJ-MM-TT\', z. B. DATE \'2026-11-26\'.'; throw err; }
  const d = safeMk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
  if (e.ts) d.isTs = true;
  return d;
}
function castVal(v, type, env) {
  if (v === null) return null;
  const t = type.b ? type : resolveType(type, env.f);
  if (t.b === 'VARCHAR2' || t.b === 'CHAR') {
    const s = toStr(v); if (t.len != null && s.length > t.len) { if (isNum(v)) throw oraErr('01438'); throw oraErr('25137' in ORA_MSG ? '25137' : '12899', 'CAST', s.length, t.len); }
    return t.b === 'CHAR' ? s.padEnd(t.len) : s;
  }
  return coerce(v, t, { kind: SESSION.ctx === 'plsql' ? 'var' : 'col', table: 'CAST', col: '' });
}

// ---------- Bezeichner ----------
function lookupSrcCol(srcs, parts, node) {
  // liefert {i, c} | {multi:[...]} | null
  if (parts.length === 1) {
    const n = parts[0]; let hit = null, multi = null;
    for (let i = 0; i < srcs.length; i++) {
      const c = srcs[i].idx.get(n);
      if (c !== undefined) { if (hit) { multi = multi || [hit]; multi.push({ i, c }); } else hit = { i, c }; }
    }
    if (multi) {
      if (multi.every(m => srcs[m.i].using && srcs[m.i].using.has(n))) return { multi };
      const e = oraErr('00918'); if (node && node.line) { e.line = node.line; e.col = node.col; }
      e.hint = 'Die Spalte ' + n + ' kommt in mehreren Tabellen vor – qualifiziere sie mit dem Alias, z. B. ' + (srcs[multi[0].i].alias || srcs[multi[0].i].name) + '.' + n;
      throw e;
    }
    return hit;
  }
  let p = parts;
  if (p.length === 3 && p[0] === SCHEMA) p = p.slice(1);
  if (p.length === 2 || p.length === 3) {
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i];
      if (s.alias === p[0] || (!s.aliased && s.name === p[0])) {
        const c = s.idx.get(p[1]);
        if (c === undefined) { const e = oraErr('00904', '"' + p[0] + '"."' + p[1] + '"'); if (node && node.line) { e.line = node.line; e.col = node.col; } throw e; }
        return p.length === 3 ? { i, c, path: [p[2]] } : { i, c };
      }
    }
    if (p.length === 2) {
      // Spalte vom Objekttyp: spalte.attribut
      const r = lookupSrcCol(srcs, [p[0]], node);
      if (r && !r.multi && srcs[r.i].types[r.c] && srcs[r.i].types[r.c].b === 'OBJ') return { i: r.i, c: r.c, path: [p[1]] };
    }
  }
  return null;
}
const PSEUDO_ROW = new Set(['ROWNUM', 'LEVEL', 'CONNECT_BY_ISLEAF', 'CONNECT_BY_ISCYCLE', 'ROWID', 'ORA_ROWSCN']);
function evId(e, env) {
  let rs = env.rs;
  if (rs) {
    const parts = e.parts;
    if (env.grpNull && parts.length <= 2 && env.grpNull.has(parts[parts.length - 1])) return null;
    while (rs) {
      const srcs = rs.srcs;
      let r = srcs.cache.get(e);
      if (r === undefined) { r = lookupSrcCol(srcs, parts, e) || false; srcs.cache.set(e, r); }
      if (r) {
        if (r.multi) { for (const m of r.multi) { const v = rs.vals[m.i][m.c]; if (v !== null && v !== undefined) return v; } return null; }
        const row = rs.vals[r.i];
        if (r.path) { let v = row[r.c]; for (const f of r.path) { if (v === null || v === undefined) return null; if (!(v instanceof Rec) || !v.has(f)) throw oraErr('00904', '"' + parts.join('"."') + '"'); v = v.get(f); } return v; }
        return row[r.c];
      }
      rs = rs.parent;
    }
    if (parts.length === 1 && PSEUDO_ROW.has(parts[0])) {
      const p = parts[0];
      for (let x = env.rs; x; x = x.parent) {
        if (p === 'ROWNUM' && x.rownum !== undefined) return x.rownum;
        if (p === 'LEVEL' && x.level !== undefined) return x.level;
        if (p === 'CONNECT_BY_ISLEAF' && x.level !== undefined) return x.isLeaf ? 1 : 0;
        if (p === 'CONNECT_BY_ISCYCLE' && x.level !== undefined) return 0;
        if (p === 'ROWID' || p === 'ORA_ROWSCN') { const v = x.vals[0]; return v && v.__rid ? v.__rid : 'AAAR' + (x.rownum || 0); }
      }
    }
  }
  return resolveName(e, env);
}

// ---------- Abfragen ----------
function runQuery(q, env, opts) {
  SESSION.queryDepth++;
  const prevCtx = SESSION.ctx; SESSION.ctx = 'sql';
  try {
    let qenv = env;
    if (q.with) {
      const map = {};
      for (const w of q.with) map[w.name] = { def: w, result: null, busy: false, env: null };
      qenv = sub(env, { ctes: { map, parent: env.ctes || null } });
      for (const w of q.with) map[w.name].env = qenv;
    }
    if (q.k === 'setop') return runSetop(q, qenv, opts || {});
    return runSelect(q, qenv, opts || {});
  } finally { SESSION.queryDepth--; SESSION.ctx = prevCtx; }
}
function exprName(item) {
  if (item.alias) return item.alias;
  if (item.e.k === 'id' && !item.e.parts[0].startsWith(':')) return item.e.parts[item.e.parts.length - 1];
  let out = '', q = false;
  for (const ch of item.txt) {
    if (ch === "'") { q = !q; out += ch; continue; }
    if (q) out += ch; else if (!/\s/.test(ch)) out += ch.toUpperCase();
  }
  return out.slice(0, 128);
}
function mkSrc(name, alias, cols, types, extra) {
  const idx = new Map(); cols.forEach((c, i) => { if (!idx.has(c)) idx.set(c, i); });
  return Object.assign({ name, alias: alias || name, aliased: !!alias, cols, types: types || [], idx }, extra || {});
}
function mkSrcs(arr) { arr.cache = new Map(); return arr; }

function getRelation(item, env) {
  // liefert {srcs:[...], rows:[ [r1, r2...] ]}
  if (item.k === 'tbl') {
    const d = tableData(item.name, env, item);
    const src = mkSrc(item.name, item.alias, d.cols, d.types, { tbl: d.tbl });
    return { srcs: [src], rows: d.rows.map(r => [r]) };
  }
  if (item.k === 'subq') {
    const res = runQuery(item.q, sub(env, { rs: env.rs }), {});
    const src = mkSrc(item.alias || '', item.alias, res.cols, res.types);
    if (!item.alias) src.alias = null;
    return { srcs: [src], rows: res.rows.map(r => [r]) };
  }
  if (item.k === 'tabfn') {
    const v = ev(item.e, env);
    if (!(v instanceof Coll)) throw oraErr('22905' in ORA_MSG ? '22905' : '00932', 'COLLECTION', typeName(v));
    v.checkInit();
    const keys = v.keys(); let cols, rows;
    const first = keys.length ? v.map.get(keys[0]) : null;
    if (first instanceof Rec) { cols = first.names.slice(); rows = keys.map(k => { const r = v.map.get(k); return [cols.map(c => r.get(c))]; }); }
    else { cols = ['COLUMN_VALUE']; rows = keys.map(k => [[v.map.get(k)]]); }
    return { srcs: [mkSrc(item.alias || 'TABLE', item.alias, cols)], rows };
  }
  if (item.k === 'join') return joinRel(item, env);
  throw new OraError('ORA-00600', 'Unbekannte FROM-Quelle');
}
function eqPairs(conds, Ls, Rs) {
  // liefert Extraktoren für Gleichheits-Bedingungen zwischen linker und rechter Seite
  const out = [];
  const res = (srcs, e) => { if (!e || e.k !== 'id' || e.parts[0][0] === ':') return null; try { const r = lookupSrcCol(srcs, e.parts); return r && !r.multi ? r : null; } catch (x) { return null; } };
  for (const c of conds) {
    if (!c || c.k !== 'cmp' || c.op !== '=') continue;
    let a = res(Ls, c.l), b = res(Rs, c.r);
    if (a && b && !res(Rs, c.l) && !res(Ls, c.r)) { out.push({ l: a, r: b }); continue; }
    a = res(Ls, c.r); b = res(Rs, c.l);
    if (a && b && !res(Rs, c.r) && !res(Ls, c.l)) out.push({ l: a, r: b });
  }
  return out;
}
function hashKey(vals) { for (const v of vals) if (v === null || v === undefined) return null; return keyOf(vals.map(v => isStr(v) && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : v)); }
function nullRow(src) { return new Array(src.cols.length).fill(null); }
function joinRel(j, env) {
  const L = getRelation(j.l, env), R = getRelation(j.r, env);
  const srcs = mkSrcs(L.srcs.concat(R.srcs));
  let on = j.on;
  let usingCols = j.using;
  if (j.natural) {
    const lc = new Set(); L.srcs.forEach(s => s.cols.forEach(c => lc.add(c)));
    usingCols = []; R.srcs.forEach(s => s.cols.forEach(c => { if (lc.has(c) && !usingCols.includes(c)) usingCols.push(c); }));
  }
  let pairs = null;
  if (usingCols) {
    pairs = usingCols.map(c => {
      const li = L.srcs.findIndex(s => s.idx.has(c)), ri = R.srcs.findIndex(s => s.idx.has(c));
      if (li < 0 || ri < 0) throw oraErr('00904', '"' + c + '"');
      return { li, lc: L.srcs[li].idx.get(c), ri, rc: R.srcs[ri].idx.get(c), c };
    });
    for (const p of pairs) {
      (L.srcs[p.li].using = L.srcs[p.li].using || new Set()).add(p.c);
      (R.srcs[p.ri].using = R.srcs[p.ri].using || new Set()).add(p.c);
      (R.srcs[p.ri].hidden = R.srcs[p.ri].hidden || new Set()).add(p.c);
    }
  }
  const match = (lv, rv) => {
    if (pairs) { for (const p of pairs) { if (cmpVals(lv[p.li][p.lc], rv[p.ri][p.rc]) !== 0) return false; } return true; }
    if (!on) return true;
    const rs = { srcs, vals: lv.concat(rv), parent: env.rs || null };
    return toBool(ev(on, sub(env, { rs }))) === true;
  };
  const out = [];
  const rNull = R.srcs.map(nullRow), lNull = L.srcs.map(nullRow);
  const type = j.type;
  const pairsH = !pairs && on && (type === 'INNER' || type === 'LEFT') ? eqPairs(splitAnd(on, []), L.srcs, R.srcs) : null;
  if (pairsH && pairsH.length) {
    const idx = new Map();
    for (const rv of R.rows) { const k = hashKey(pairsH.map(p => rv[p.r.i][p.r.c])); if (k === null) continue; let b = idx.get(k); if (!b) { b = []; idx.set(k, b); } b.push(rv); }
    for (const lv of L.rows) {
      stepCheck();
      const k = hashKey(pairsH.map(p => lv[p.l.i][p.l.c]));
      let any = false;
      if (k !== null) for (const rv of (idx.get(k) || [])) { stepCheck(); if (match(lv, rv)) { out.push(lv.concat(rv)); any = true; } }
      if (!any && type === 'LEFT') out.push(lv.concat(rNull));
    }
  } else if (type === 'INNER' || type === 'CROSS') {
    for (const lv of L.rows) for (const rv of R.rows) { stepCheck(); if (match(lv, rv)) out.push(lv.concat(rv)); }
  } else if (type === 'LEFT') {
    for (const lv of L.rows) { let any = false; for (const rv of R.rows) { stepCheck(); if (match(lv, rv)) { out.push(lv.concat(rv)); any = true; } } if (!any) out.push(lv.concat(rNull)); }
  } else if (type === 'RIGHT') {
    for (const rv of R.rows) { let any = false; for (const lv of L.rows) { stepCheck(); if (match(lv, rv)) { out.push(lv.concat(rv)); any = true; } } if (!any) out.push(lNull.concat(rv)); }
  } else if (type === 'FULL') {
    const used = new Set();
    for (const lv of L.rows) { let any = false; R.rows.forEach((rv, k) => { stepCheck(); if (match(lv, rv)) { out.push(lv.concat(rv)); any = true; used.add(k); } }); if (!any) out.push(lv.concat(rNull)); }
    R.rows.forEach((rv, k) => { if (!used.has(k)) out.push(lNull.concat(rv)); });
  }
  if (usingCols && (type === 'RIGHT' || type === 'FULL')) {
    // USING-Spalte bei RIGHT/FULL: Wert aus rechter Seite in die linke kopieren, wenn links NULL
    for (const row of out) for (const p of pairs) if (row[p.li][p.lc] === null && row[L.srcs.length + p.ri][p.rc] !== null) { row[p.li] = row[p.li].slice(); row[p.li][p.lc] = row[L.srcs.length + p.ri][p.rc]; }
  }
  return { srcs, rows: out };
}
function splitAnd(e, out) { if (!e) return out; if (e.k === 'and') { splitAnd(e.l, out); splitAnd(e.r, out); } else out.push(e); return out; }
function findOuterIds(e, acc) {
  if (!e || typeof e !== 'object') return acc;
  if (e.k === 'id' && e.outer) acc.push(e);
  if (e.k === 'subq' || e.k === 'exists') return acc;
  for (const k in e) { const v = e[k]; if (v && typeof v === 'object') { if (Array.isArray(v)) v.forEach(x => findOuterIds(x, acc)); else if (k !== 'q') findOuterIds(v, acc); } }
  return acc;
}
function buildFrom(q, env) {
  // liefert {srcs, rows, where}
  if (!q.from.length) return { srcs: mkSrcs([]), rows: [[]], where: q.where };
  let where = q.where;
  const rels = q.from.map(it => getRelation(it, env));
  let outerMap = null;
  if (where && findOuterIds(where, []).length) {
    const conj = splitAnd(where, []); const rest = []; outerMap = new Map();
    for (const c of conj) {
      const ids = findOuterIds(c, []);
      if (!ids.length) { rest.push(c); continue; }
      const id = ids[0];
      let ri = -1;
      for (let k = 0; k < rels.length; k++) {
        const s = rels[k].srcs;
        if (id.parts.length >= 2 ? s.some(x => x.alias === id.parts[id.parts.length - 2] || x.name === id.parts[id.parts.length - 2]) : s.some(x => x.idx.has(id.parts[0]))) { ri = k; break; }
      }
      if (ri < 0) throw oraErr('00904', '"' + id.parts.join('.') + '"');
      if (!outerMap.has(ri)) outerMap.set(ri, []);
      outerMap.get(ri).push(c);
    }
    where = rest.length ? rest.reduce((a, b) => ({ k: 'and', l: a, r: b })) : null;
  }
  let cur = null;
  const order = rels.map((r, i) => i).filter(i => !outerMap || !outerMap.has(i)).concat(outerMap ? Array.from(outerMap.keys()) : []);
  for (const i of order) {
    const R = rels[i];
    if (!cur) { cur = { srcs: R.srcs.slice(), rows: R.rows }; continue; }
    const srcs = mkSrcs(cur.srcs.concat(R.srcs));
    const out = [];
    if (outerMap && outerMap.has(i)) {
      const conds = outerMap.get(i); const rNull = R.srcs.map(nullRow);
      for (const lv of cur.rows) {
        let any = false;
        for (const rv of R.rows) {
          stepCheck();
          const rs = { srcs, vals: lv.concat(rv), parent: env.rs || null };
          if (conds.every(c => toBool(ev(c, sub(env, { rs }))) === true)) { out.push(lv.concat(rv)); any = true; }
        }
        if (!any) out.push(lv.concat(rNull));
      }
    } else {
      const ps = where ? eqPairs(splitAnd(where, []), cur.srcs, R.srcs) : [];
      if (ps.length) {
        const idx = new Map();
        for (const rv of R.rows) { const k = hashKey(ps.map(p => rv[p.r.i][p.r.c])); if (k === null) continue; let b = idx.get(k); if (!b) { b = []; idx.set(k, b); } b.push(rv); }
        for (const lv of cur.rows) { stepCheck(); const k = hashKey(ps.map(p => lv[p.l.i][p.l.c])); if (k === null) continue; for (const rv of (idx.get(k) || [])) out.push(lv.concat(rv)); }
      } else for (const lv of cur.rows) for (const rv of R.rows) { stepCheck(); out.push(lv.concat(rv)); }
    }
    cur = { srcs, rows: out };
  }
  return { srcs: mkSrcs(cur.srcs), rows: cur.rows, where };
}

function walkExpr(e, fn, intoSub) {
  if (!e || typeof e !== 'object') return;
  if (Array.isArray(e)) { e.forEach(x => walkExpr(x, fn, intoSub)); return; }
  if (e.k && fn(e) === false) return;
  for (const k in e) {
    if (k === 'q' || k === 'sub') { if (intoSub) walkExpr(e[k], fn, intoSub); continue; }
    const v = e[k];
    if (v && typeof v === 'object') walkExpr(v, fn, intoSub);
  }
}
function hasAggregate(nodes) {
  let found = false;
  for (const n of nodes) walkExpr(n, x => {
    if (found) return false;
    if (x.k === 'agg' && !x.over) { found = true; return false; }
    if (x.k === 'agg' && x.over) { walkExpr(x.args, y => { if (y.k === 'agg' && !y.over) found = true; }); return false; }
  });
  return found;
}
function collectWin(nodes) {
  const out = [];
  for (const n of nodes) walkExpr(n, x => { if (x.k === 'agg' && x.over) { out.push(x); return false; } });
  return out;
}
function validateGroup(q, srcs, selItems) {
  const keys = new Set(); const colKeys = new Set();
  const gb = q.groupBy || [];
  for (const g of gb) {
    keys.add(jsonKey(g));
    if (g.k === 'id') { try { const r = lookupSrcCol(srcs, g.parts); if (r && !r.multi) colKeys.add(r.i + ':' + r.c); else if (r && r.multi) colKeys.add('U:' + g.parts[g.parts.length - 1]); } catch (e) { } }
  }
  const errNum = gb.length ? '00979' : '00937';
  const check = (e) => {
    if (!e || typeof e !== 'object') return;
    if (keys.has(jsonKey(e))) return;
    if (e.k === 'agg' && !e.over) return;
    if (e.k === 'subq' || e.k === 'exists') return;
    if (e.k === 'id') {
      let r = null; try { r = lookupSrcCol(srcs, e.parts); } catch (x) { return; }
      if (r && !r.multi && !colKeys.has(r.i + ':' + r.c)) {
        const err = oraErr(errNum);
        err.hint = gb.length ? 'Jede Spalte im SELECT, die nicht in einer Aggregatfunktion steht, muss im GROUP BY stehen: ' + e.parts.join('.') : 'Mischung aus Aggregat (z. B. COUNT, SUM) und normaler Spalte ' + e.parts.join('.') + ' – dafür ist ein GROUP BY nötig.';
        if (e.line) { err.line = e.line; err.col = e.col; }
        throw err;
      }
      if (r && r.multi && !colKeys.has('U:' + e.parts[e.parts.length - 1])) throw oraErr(errNum);
      return;
    }
    for (const k in e) { if (k === 'q') continue; const v = e[k]; if (v && typeof v === 'object') { if (Array.isArray(v)) v.forEach(check); else check(v); } }
  };
  for (const it of selItems) { if (it.star) throw oraErr(errNum); check(it.e); }
  if (q.having) check(q.having);
}

const PSEUDO_OK = new Set(['ROWNUM', 'LEVEL', 'CONNECT_BY_ISLEAF', 'CONNECT_BY_ISCYCLE', 'ROWID', 'ORA_ROWSCN', 'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'USER', 'UID', 'SQLCODE', 'SQLERRM', 'INSERTING', 'UPDATING', 'DELETING', 'DBTIMEZONE', 'SESSIONTIMEZONE', 'NULL', 'DEFAULT']);
function staticCheck(exprs, srcs, env, aliases) {
  const chk = (x) => {
    if (x.k === 'id') {
      const parts = x.parts;
      if (parts[0][0] === ':') return;
      for (let rs = { srcs, parent: env.rs }; rs; rs = rs.parent) { if (lookupSrcCol(rs.srcs, parts, x)) return; }
      if (parts.length === 1 && (PSEUDO_OK.has(parts[0]) || (aliases && aliases.has(parts[0])))) return;
      if (env.f && findVarPath(parts, env.f)) return;
      if (parts.length >= 2 && (DB.pkgs[parts[0]] || DB.seqs[parts[0]] || (DB.synonyms[parts[0]]))) return;
      if (parts.length >= 2 && (parts[1] === 'NEXTVAL' || parts[1] === 'CURRVAL')) return;
      if (parts.length === 3 && parts[0] === SCHEMA) return;
      if (findCallable(parts, env.f)) return;
      if (env.f && parts.length >= 1 && findCursor(parts[0], env.f)) return;
      if (SESSION.trig.length && (parts[0] === 'NEW' || parts[0] === 'OLD')) return;
      throw invalidIdent(x, false);
    }
    if (x.k === 'call') {
      const parts = x.name;
      if (env.f && findVarPath(parts, env.f)) return;
      if (findCallable(parts, env.f)) return;
      if (parts.length === 1 && (DB.types[parts[0]] || (env.f && lookupType(parts[0], env.f)))) return;
      if (parts.length === 2 && DB.pkgs[parts[0]]) return;
      evCall(x, env);
    }
  };
  for (const e of exprs) if (e) walkExpr(e, x => { if (x.k === 'subq' || x.k === 'exists' || (x.k === 'in' && x.q)) { if (x.k === 'in') walkExpr(x.e, y => { chk(y); }); return false; } chk(x); });
}
function runSelect(q, env, opts) {
  const fr = buildFrom(q, env);
  const srcs = fr.srcs;
  {
    staticCheck(q.cols.filter(c => !c.star).map(c => c.e).concat([fr.where, q.having, q.startWith, q.connectBy]).concat(q.groupBy || []), srcs, env, null);
    if (q.orderBy) staticCheck(q.orderBy.map(o => o.e), srcs, env, new Set(q.cols.filter(c => !c.star).map(exprName)));
  }
  const parentRs = env.rs || null;
  let rsList;
  if (q.connectBy) rsList = hierarchy(q, srcs, fr.rows, env);
  else rsList = fr.rows.map(vals => ({ srcs, vals, parent: parentRs }));
  // WHERE + ROWNUM
  const where = fr.where;
  const filtered = []; let rn = 0;
  const noRownumLimit = !opts.limit;
  for (const rs of rsList) {
    stepCheck();
    rs.rownum = rn + 1;
    if (where) {
      const ok = toBool(ev(where, sub(env, { rs })));
      if (ok !== true) continue;
    }
    rn++; filtered.push(rs);
  }
  // Gruppierung
  const sel = q.cols;
  const aggregated = (q.groupBy && q.groupBy.length) || hasAggregate(sel.filter(c => !c.star).map(c => c.e).concat(q.having ? [q.having] : []).concat(q.orderBy ? q.orderBy.map(o => o.e) : []));
  let items;
  if (aggregated) {
    validateGroup(q, srcs, sel);
    const gb = q.groupBy || [];
    const sets = [];
    if (q.rollup === 'ROLLUP') for (let n = gb.length; n >= 0; n--) sets.push(gb.slice(0, n));
    else if (q.rollup === 'CUBE') { const n = gb.length; for (let m = (1 << n) - 1; m >= 0; m--) sets.push(gb.filter((_, i) => m & (1 << (n - 1 - i)))); }
    else sets.push(gb);
    items = [];
    for (const set of sets) {
      const groups = new Map();
      for (const rs of filtered) {
        const key = keyOf(set.map(g => ev(g, sub(env, { rs }))));
        let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(rs);
      }
      if (!gb.length && groups.size === 0) groups.set('', []);
      const nulled = gb.filter(g => !set.includes(g));
      const grpNull = nulled.length ? new Set(nulled.filter(g => g.k === 'id').map(g => g.parts[g.parts.length - 1])) : null;
      for (const g of groups.values()) {
        const rep = g[0] || { srcs, vals: srcs.map(nullRow), parent: parentRs, rownum: 0 };
        items.push({ rs: rep, grp: { rows: g, cache: new Map(), nulled: grpNull }, grpNull });
      }
    }
    if (q.having) items = items.filter(it => toBool(ev(q.having, envOf(env, it))) === true);
    let nested = false;
    for (const c of sel) if (!c.star) walkExpr(c.e, x => { if (x.k === 'agg' && !x.over) { walkExpr(x.args, y => { if (y.k === 'agg' && !y.over) nested = true; }); return false; } });
    if (nested) items = [{ rs: items.length ? items[0].rs : { srcs, vals: srcs.map(nullRow), parent: parentRs }, grp: { rows: items, cache: new Map(), nested: true } }];
  } else items = filtered.map(rs => ({ rs }));
  // Fensterfunktionen
  const winNodes = collectWin(sel.filter(c => !c.star).map(c => c.e).concat(q.orderBy ? q.orderBy.map(o => o.e) : []));
  if (winNodes.length) computeWindows(winNodes, items, env);
  // Projektion
  const cols = [], types = [], exprs = [];
  for (const it of sel) {
    if (it.star) {
      let found = false;
      srcs.forEach((s, si) => {
        if (it.table && !(s.alias === it.table || s.name === it.table)) return;
        found = true;
        s.cols.forEach((c, ci) => { if (!it.table && s.hidden && s.hidden.has(c)) return; cols.push(c); types.push(s.types[ci] || null); exprs.push({ si, ci, usingName: (!it.table && s.using && s.using.has(c)) ? c : null }); });
      });
      if (!found && it.table) throw oraErr('00904', '"' + it.table + '"');
      if (!found && !srcs.length) throw oraErr('00923');
      continue;
    }
    cols.push(exprName(it));
    let t = null;
    if (it.e.k === 'id') { try { const r = lookupSrcCol(srcs, it.e.parts); if (r && !r.multi) t = srcs[r.i].types[r.c] || null; } catch (e) { } }
    types.push(t); exprs.push(it.e);
  }
  for (const it of items) {
    stepCheck();
    const ienv = envOf(env, it);
    it.out = exprs.map(x => {
      if (x.si !== undefined) {
        if (x.usingName) { const v = it.rs.vals[x.si][x.ci]; if (v !== null) return v; const r = lookupSrcCol(srcs, [x.usingName]); if (r && r.multi) { for (const m of r.multi) { const w = it.rs.vals[m.i][m.c]; if (w !== null) return w; } } return v; }
        return it.rs.vals[x.si][x.ci];
      }
      const v = ev(x, ienv);
      if (v instanceof Rec || v instanceof Coll) return v;
      return v === undefined ? null : v;
    });
  }
  if (q.distinct) {
    const seen = new Set(); items = items.filter(it => { const k = keyOf(it.out); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (q.orderBy) sortItems(items, q.orderBy, cols, sel, env, !!q.distinct || aggregated);
  let rows = items;
  rows = applyFetch(q, rows, env);
  if (opts.limit && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
  const res = { cols, types, rows: rows.map(it => it.out) };
  if (opts.keepRs) res.rsList = rows.map(it => it.rs);
  return res;
}
function envOf(env, it) {
  const o = sub(env, { rs: it.rs });
  if (it.grp) o.grp = it.grp; else delete o.grp;
  if (it.grpNull) o.grpNull = it.grpNull; else delete o.grpNull;
  if (it.win) o.win = it.win;
  return o;
}
function sortItems(items, orderBy, cols, sel, env, restricted) {
  const extractors = orderBy.map(o => {
    const e = o.e;
    if (e.k === 'num') { const p = e.v; if (p < 1 || p > cols.length || !Number.isInteger(p)) throw oraErr('01785' in ORA_MSG ? '01785' : '00933'); return it => it.out[p - 1]; }
    if (e.k === 'id' && e.parts.length === 1) {
      const idxs = []; cols.forEach((c, i) => { if (c === e.parts[0]) idxs.push(i); });
      const aliasHit = sel.findIndex(s => !s.star && s.alias === e.parts[0]);
      if (aliasHit >= 0) { let pos = 0; for (let k = 0; k < aliasHit; k++) pos += 1; const ci = cols.indexOf(e.parts[0]); return it => it.out[ci]; }
      if (idxs.length === 1) return it => it.out[idxs[0]];
      if (idxs.length > 1) throw oraErr('00960' in ORA_MSG ? '00960' : '00918');
    }
    const k = jsonKey(e);
    let selIdx = -1, pos = 0;
    for (const s of sel) { if (s.star) { pos = -9999; continue; } if (jsonKey(s.e) === k && pos >= 0) { selIdx = pos; break; } pos++; }
    if (selIdx >= 0) return it => it.out[selIdx];
    if (restricted && sel.some(s => s.star) === false) { /* bei DISTINCT müsste der Ausdruck in der Liste stehen */ }
    return it => { if (!it._env) it._env = envOf(env, it); return ev(e, it._env); };
  });
  const keyed = items.map((it, i) => ({ it, i, keys: extractors.map(f => f(it)) }));
  keyed.sort((a, b) => {
    for (let k = 0; k < orderBy.length; k++) { const c = sortCmp(a.keys[k], b.keys[k], orderBy[k].desc, orderBy[k].nulls); if (c) return c; }
    return a.i - b.i;
  });
  items.length = 0; keyed.forEach(x => { x.it._keys = x.keys; items.push(x.it); });
}
function applyFetch(q, rows, env) {
  if (q.offset) { const o = Math.max(0, Math.floor(toNum(ev(q.offset, env)) || 0)); rows = rows.slice(o); }
  if (q.fetch) {
    let n = toNum(ev(q.fetch.n, env));
    if (q.fetch.pct) n = Math.ceil(rows.length * n / 100);
    n = Math.max(0, Math.floor(n));
    if (q.fetch.ties && rows.length > n && n > 0) {
      const last = rows[n - 1]._keys; let m = n;
      while (m < rows.length && last && rows[m]._keys && keyOf(rows[m]._keys) === keyOf(last)) m++;
      rows = rows.slice(0, m);
    } else rows = rows.slice(0, n);
  }
  return rows;
}
function hierarchy(q, srcs, rows, env) {
  const parent = env.rs || null;
  const all = rows.map(vals => ({ srcs, vals, parent }));
  const roots = q.startWith ? all.filter(rs => toBool(ev(q.startWith, sub(env, { rs }))) === true) : all;
  const out = [];
  const visit = (rs, level, prior, root, path) => {
    stepCheck();
    const node = { srcs, vals: rs.vals, parent, level, prior, root: root || null };
    node.root = root || node;
    out.push(node);
    const kids = [];
    for (const c of all) {
      const cand = { srcs, vals: c.vals, parent, prior: node, level: level + 1 };
      if (toBool(ev(q.connectBy, sub(env, { rs: cand }))) === true) {
        if (path.includes(c.vals)) { if (q.nocycle) continue; throw new OraError('ORA-01436', 'CONNECT BY-Schleife in Benutzerdaten'); }
        kids.push(c);
      }
    }
    node.isLeaf = kids.length === 0;
    if (q.siblings) {
      const ks = kids.map(c => ({ c, keys: q.siblings.map(o => ev(o.e, sub(env, { rs: { srcs, vals: c.vals, parent, prior: node, level: level + 1 } }))) }));
      ks.sort((a, b) => { for (let k = 0; k < q.siblings.length; k++) { const r = sortCmp(a.keys[k], b.keys[k], q.siblings[k].desc, q.siblings[k].nulls); if (r) return r; } return 0; });
      kids.length = 0; ks.forEach(x => kids.push(x.c));
    }
    for (const c of kids) visit(c, level + 1, node, node.root, path.concat([c.vals]));
  };
  for (const r of roots) visit(r, 1, null, null, [r.vals]);
  return out;
}
function runSetop(q, env, opts) {
  const L = runQuery(q.l, env, {}), R = runQuery(q.r, env, {});
  if (L.cols.length !== R.cols.length) throw oraErr('01789');
  for (let c = 0; c < L.cols.length; c++) {
    const lk = L.rows.map(r => valueKind(r[c])).find(x => x), rk = R.rows.map(r => valueKind(r[c])).find(x => x);
    if (lk && rk && lk !== rk) throw oraErr('01790');
  }
  let rows;
  const distinct = arr => { const s = new Set(); return arr.filter(r => { const k = keyOf(r); if (s.has(k)) return false; s.add(k); return true; }); };
  if (q.op === 'UNION ALL') rows = L.rows.concat(R.rows);
  else if (q.op === 'UNION') rows = distinct(L.rows.concat(R.rows));
  else if (q.op === 'INTERSECT') { const rk = new Set(R.rows.map(keyOf)); rows = distinct(L.rows).filter(r => rk.has(keyOf(r))); }
  else { const rk = new Set(R.rows.map(keyOf)); rows = distinct(L.rows).filter(r => !rk.has(keyOf(r))); }
  let items = rows.map(r => ({ out: r }));
  if (q.orderBy) {
    const ext = q.orderBy.map(o => {
      if (o.e.k === 'num') { const p = o.e.v; if (p < 1 || p > L.cols.length) throw oraErr('01785' in ORA_MSG ? '01785' : '00933'); return it => it.out[p - 1]; }
      if (o.e.k === 'id') { const n = o.e.parts[o.e.parts.length - 1]; const i = L.cols.indexOf(n); if (i >= 0) return it => it.out[i]; }
      const e = new OraError('ORA-01785', 'ORDER BY-Element muss die Nummer eines SELECT-Listenausdrucks sein'); e.hint = 'Bei UNION/MINUS/INTERSECT nach Spaltennamen der ersten Abfrage oder nach Position (ORDER BY 1) sortieren.'; throw e;
    });
    const keyed = items.map((it, i) => ({ it, i, keys: ext.map(f => f(it)) }));
    keyed.sort((a, b) => { for (let k = 0; k < ext.length; k++) { const c = sortCmp(a.keys[k], b.keys[k], q.orderBy[k].desc, q.orderBy[k].nulls); if (c) return c; } return a.i - b.i; });
    items = keyed.map(x => { x.it._keys = x.keys; return x.it; });
  }
  items = applyFetch(q, items, env);
  if (opts.limit) items = items.slice(0, opts.limit);
  return { cols: L.cols, types: L.types, rows: items.map(i => i.out) };
}

// ---------- Aggregate & Fenster ----------
function aggregate(fn, vals, node, env, rowsForWithin) {
  let v = vals;
  if (fn === 'COUNT') return v.length;
  if (node.distinct) { const s = new Set(); v = v.filter(x => { const k = keyOf([x]); if (s.has(k)) return false; s.add(k); return true; }); }
  if (!v.length) return null;
  switch (fn) {
    case 'SUM': return v.reduce((a, b) => a + toNum(b), 0);
    case 'AVG': return v.reduce((a, b) => a + toNum(b), 0) / v.length;
    case 'MIN': return v.reduce((a, b) => cmpVals(b, a) < 0 ? b : a);
    case 'MAX': return v.reduce((a, b) => cmpVals(b, a) > 0 ? b : a);
    case 'MEDIAN': { const s = v.map(toNum).sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    case 'VARIANCE': case 'VAR_SAMP': case 'STDDEV': case 'STDDEV_SAMP': case 'VAR_POP': case 'STDDEV_POP': {
      const n = v.map(toNum); const mean = n.reduce((a, b) => a + b, 0) / n.length;
      const ss = n.reduce((a, b) => a + (b - mean) ** 2, 0);
      const pop = fn.endsWith('_POP');
      if (!pop && n.length === 1) return fn.startsWith('VAR_SAMP') || fn === 'STDDEV_SAMP' ? null : 0;
      const varr = ss / (pop ? n.length : n.length - 1);
      return fn.startsWith('STD') ? Math.sqrt(varr) : varr;
    }
  }
  throw new OraError('ORA-00904', fn + ': ungültige Aggregatfunktion');
}
function evAgg(e, env) {
  if (e.over) {
    if (env.win && env.win.has(e)) return env.win.get(e);
    throw new OraError('ORA-30483', 'Fensterfunktionen sind hier nicht zulässig');
  }
  const g = env.grp;
  if (!g) { const err = new OraError('ORA-00934', 'Gruppenfunktion ist hier nicht zulässig'); err.hint = 'Aggregatfunktionen (COUNT, SUM, ...) gehören nicht ins WHERE – dafür gibt es HAVING.'; throw err; }
  if (g.cache.has(e)) return g.cache.get(e);
  const inner = sub(env, { grp: null }); delete inner.grp; delete inner.grpNull;
  let result;
  if (g.nested && !(e.fn === 'COUNT' && e.star)) {
    const vals = [];
    for (const it of g.rows) { const v = ev(e.args[0], envOf(inner, it)); if (v !== null && v !== undefined) vals.push(v); }
    result = aggregate(e.fn, vals, e, env);
    g.cache.set(e, result); return result;
  }
  if (e.fn === 'COUNT' && e.star) result = g.rows.length;
  else if (e.fn === 'LISTAGG') {
    let rows = g.rows.slice();
    if (e.within) {
      const keyed = rows.map((rs, i) => ({ rs, i, keys: e.within.map(o => ev(o.e, sub(inner, { rs }))) }));
      keyed.sort((a, b) => { for (let k = 0; k < e.within.length; k++) { const c = sortCmp(a.keys[k], b.keys[k], e.within[k].desc, e.within[k].nulls); if (c) return c; } return a.i - b.i; });
      rows = keyed.map(x => x.rs);
    }
    const sep = e.args[1] ? (toStr(ev(e.args[1], inner)) || '') : '';
    let vals = rows.map(rs => ev(e.args[0], sub(inner, { rs }))).filter(v => v !== null).map(toStr);
    if (e.distinct) vals = Array.from(new Set(vals));
    result = vals.length ? vals.join(sep) : null;
  } else {
    if (!e.args.length) throw oraErr('00909');
    const vals = [];
    for (const rs of g.rows) { const v = ev(e.args[0], sub(inner, { rs })); if (v !== null && v !== undefined) vals.push(v); }
    result = aggregate(e.fn, vals, e, env);
  }
  g.cache.set(e, result);
  return result;
}
function computeWindows(nodes, items, env) {
  for (const it of items) if (!it.win) it.win = new Map();
  for (const w of nodes) {
    const parts = new Map();
    for (const it of items) {
      const ienv = envOf(env, it);
      const k = keyOf(w.over.partition.map(p => ev(p, ienv)));
      let arr = parts.get(k); if (!arr) { arr = []; parts.set(k, arr); } arr.push(it);
    }
    for (let arr of parts.values()) {
      let keys = null;
      if (w.over.order) {
        const keyed = arr.map((it, i) => ({ it, i, keys: w.over.order.map(o => ev(o.e, envOf(env, it))) }));
        keyed.sort((a, b) => { for (let k = 0; k < w.over.order.length; k++) { const c = sortCmp(a.keys[k], b.keys[k], w.over.order[k].desc, w.over.order[k].nulls); if (c) return c; } return a.i - b.i; });
        arr = keyed.map(x => x.it); keys = keyed.map(x => keyOf(x.keys));
      }
      const n = arr.length;
      const argVal = (it, i = 0) => w.args[i] ? ev(w.args[i], envOf(env, it)) : null;
      const set = (it, v) => it.win.set(w, v);
      switch (w.fn) {
        case 'ROW_NUMBER': arr.forEach((it, i) => set(it, i + 1)); break;
        case 'RANK': { let r = 1; arr.forEach((it, i) => { if (i > 0 && keys[i] !== keys[i - 1]) r = i + 1; set(it, r); }); break; }
        case 'DENSE_RANK': { let r = 1; arr.forEach((it, i) => { if (i > 0 && keys[i] !== keys[i - 1]) r++; set(it, r); }); break; }
        case 'PERCENT_RANK': { let r = 1; arr.forEach((it, i) => { if (i > 0 && keys[i] !== keys[i - 1]) r = i + 1; set(it, n > 1 ? (r - 1) / (n - 1) : 0); }); break; }
        case 'CUME_DIST': { arr.forEach((it, i) => { let j = i; while (j + 1 < n && keys[j + 1] === keys[i]) j++; set(it, (j + 1) / n); }); break; }
        case 'NTILE': { const b = Math.max(1, toNum(argVal(arr[0])) | 0); const base = Math.floor(n / b), extra = n % b; let i = 0; for (let g = 1; g <= b; g++) { const sz = base + (g <= extra ? 1 : 0); for (let k = 0; k < sz; k++) set(arr[i++], g); } break; }
        case 'LAG': case 'LEAD': {
          arr.forEach((it, i) => {
            const off = w.args[1] ? toNum(argVal(it, 1)) : 1; const j = w.fn === 'LAG' ? i - off : i + off;
            set(it, j >= 0 && j < n ? argVal(arr[j]) : (w.args[2] ? argVal(it, 2) : null));
          }); break;
        }
        default: {
          // Aggregat / FIRST_VALUE / LAST_VALUE / NTH_VALUE über Fensterrahmen
          const vals = arr.map(it => w.star ? 1 : argVal(it));
          const fr = w.over.frame;
          arr.forEach((it, i) => {
            let s = 0, e = n - 1;
            if (fr) {
              const bound = (b, isStart) => { if (b.u) return b.d === 'PRECEDING' ? 0 : n - 1; if (b.cur) { if (fr.unit === 'RANGE' && keys) { let j = i; if (isStart) { while (j > 0 && keys[j - 1] === keys[i]) j--; } else { while (j + 1 < n && keys[j + 1] === keys[i]) j++; } return j; } return i; } const off = toNum(ev(b.n, env)); return b.d === 'PRECEDING' ? i - off : i + off; };
              s = Math.max(0, bound(fr.s, true)); e = Math.min(n - 1, bound(fr.e, false));
            } else if (w.over.order) { e = i; while (e + 1 < n && keys[e + 1] === keys[i]) e++; }
            const win = []; for (let k = s; k <= e; k++) win.push(vals[k]);
            if (w.fn === 'FIRST_VALUE') { set(it, s <= e ? (w.ignoreNulls ? win.find(x => x !== null) ?? null : win[0]) : null); return; }
            if (w.fn === 'LAST_VALUE') { set(it, s <= e ? (w.ignoreNulls ? [...win].reverse().find(x => x !== null) ?? null : win[win.length - 1]) : null); return; }
            if (w.fn === 'NTH_VALUE') { const k = toNum(argVal(it, 1)); set(it, win[k - 1] ?? null); return; }
            if (w.fn === 'RATIO_TO_REPORT') { const tot = vals.filter(x => x !== null).reduce((a, b) => a + toNum(b), 0); set(it, vals[i] === null || tot === 0 ? null : toNum(vals[i]) / tot); return; }
            if (w.fn === 'COUNT') { set(it, w.star ? win.length : win.filter(x => x !== null).length); return; }
            if (w.fn === 'LISTAGG') { const sep = w.args[1] ? toStr(argVal(it, 1)) : ''; const v = win.filter(x => x !== null).map(toStr); set(it, v.length ? v.join(sep || '') : null); return; }
            set(it, aggregate(w.fn, win.filter(x => x !== null), w, env));
          });
        }
      }
    }
  }
}

// ---------- Tabellen-Daten ----------
function findCte(env, name) { for (let c = env.ctes; c; c = c.parent) if (c.map[name]) return c.map[name]; return null; }
function tableData(name, env, item) {
  const cte = findCte(env, name);
  if (cte) {
    if (cte.busy) throw new OraError('ORA-32039', 'Rekursive WITH-Klausel muss eine Spaltenaliasliste haben (rekursive CTEs werden nicht unterstützt)');
    if (!cte.result) { cte.busy = true; try { const r = runQuery(cte.def.q, sub(cte.env, { rs: null }), {}); if (cte.def.cols) { if (cte.def.cols.length !== r.cols.length) throw oraErr('32038' in ORA_MSG ? '32038' : '01789'); r.cols = cte.def.cols.slice(); } cte.result = r; } finally { cte.busy = false; } }
    return { cols: cte.result.cols, types: cte.result.types, rows: cte.result.rows };
  }
  if (name === 'DUAL') return { cols: ['DUMMY'], types: [{ b: 'VARCHAR2', len: 1 }], rows: [['X']] };
  if (DB.synonyms[name]) return tableData(DB.synonyms[name].target, env, item);
  const t = DB.tables[name];
  if (t) {
    if (SESSION.mutating.has(name)) { const e = oraErr('04091', SCHEMA + '.' + name); e.hint = 'Ein FOR EACH ROW-Trigger darf die Tabelle, auf der er feuert, nicht abfragen (mutating table). Nutze :NEW/:OLD oder einen Statement-Trigger.'; throw e; }
    return { cols: t.cols.map(c => c.name), types: t.cols.map(c => c.type), rows: t.rows, tbl: t };
  }
  const v = DB.views[name];
  if (v) {
    if (v._busy) throw new OraError('ORA-01731', 'Zirkuläre View-Definition gefunden');
    v._busy = true;
    try {
      const r = runQuery(v.q, { f: null, rs: null }, {});
      const cols = v.cols || r.cols;
      if (cols.length !== r.cols.length) throw new OraError('ORA-04063', 'View "' + SCHEMA + '"."' + name + '" enthält Fehler');
      return { cols, types: r.types, rows: r.rows };
    } catch (e) {
      if (e instanceof OraError && e.code !== 'ORA-04063' && e.code !== 'ORA-04091') { const x = new OraError('ORA-04063', 'View "' + SCHEMA + '"."' + name + '" enthält Fehler'); x.oraStack = [e.code + ': ' + e.message]; throw x; }
      throw e;
    } finally { v._busy = false; }
  }
  const dict = dictView(name);
  if (dict) return dict;
  const e = oraErr('00942');
  if (item && item.line) { e.line = item.line; e.col = item.col; }
  e.objName = name;
  throw e;
}
