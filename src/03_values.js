// ===== Werte, Konvertierung, Formatierung =====
class Rec {
  constructor(fields) { // fields: [{name,type}]
    this.names = fields.map(f => f.name);
    this.types = {}; this.vals = {};
    for (const f of fields) { this.types[f.name] = f.type || null; this.vals[f.name] = initValue(f.type); }
  }
  has(n) { return Object.prototype.hasOwnProperty.call(this.vals, n); }
  get(n) { return this.vals[n]; }
  set(n, v) { this.vals[n] = v; }
  clone() { const r = Object.create(Rec.prototype); r.names = this.names.slice(); r.types = Object.assign({}, this.types); r.vals = {}; for (const n of this.names) r.vals[n] = cloneVal(this.vals[n]); r.isNull = this.isNull; if (this.objType) r.objType = this.objType; return r; }
}
class Coll {
  constructor(type) { // type: {b:'COLL', kind, of, indexBy, size}
    this.type = type; this.kind = type.kind; this.map = new Map(); this.isNull = type.kind !== 'table' || type.indexBy ? false : true;
    if (type.kind === 'varray') this.isNull = true;
    if (type.kind === 'table' && type.indexBy) this.isNull = false;
    this.strKeys = !!(type.indexBy && type.indexBy.b === 'VARCHAR2');
    this.maxKey = 0;
  }
  keys() {
    const ks = Array.from(this.map.keys());
    if (this.strKeys) ks.sort((a, b) => a < b ? -1 : a > b ? 1 : 0); else ks.sort((a, b) => a - b);
    return ks;
  }
  clone() { const c = Object.create(Coll.prototype); Object.assign(c, this); c.map = new Map(); for (const [k, v] of this.map) c.map.set(k, cloneVal(v)); return c; }
  checkInit() { if (this.isNull) throw oraErr('06531'); }
}
class CursorState {
  constructor(name) { this.name = name; this.isOpen = false; this.rows = null; this.pos = 0; this.found = null; this.rowcount = 0; this.cols = null; }
}
function cloneVal(v) { return (v instanceof Rec || v instanceof Coll) ? v.clone() : (v instanceof Date ? new Date(v.getTime()) : v); }

function initValue(type) {
  if (!type) return null;
  if (type.b === 'REC') { const r = new Rec(type.fields); return r; }
  if (type.b === 'COLL') return new Coll(type);
  return null;
}

// ---------- Typprüfung ----------
const isNum = v => typeof v === 'number';
const isStr = v => typeof v === 'string';
const isDate = v => v instanceof Date;
const isBool = v => typeof v === 'boolean';

function numToStr(v) {
  if (!isFinite(v)) return v > 0 ? '~' : '-~';
  if (Object.is(v, -0)) v = 0;
  let s;
  const r = Number(v.toPrecision(15));
  if (Number.isInteger(r) && Math.abs(r) < 1e21) s = BigInt(Math.round(r)).toString();
  else {
    s = String(r);
    if (s.includes('e')) {
      const [m, e] = s.split('e'); const ex = parseInt(e, 10);
      if (ex < 0 && ex > -40) s = r.toFixed(Math.min(100, -ex + (m.split('.')[1] || '').length)).replace(/0+$/, '');
      else s = m.replace('.', ',').replace(',', '.') + 'E' + (ex > 0 ? '+' : '') + ex;
    }
  }
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s;
}
function numDisplay(v) { // für das Ergebnisgitter: mit führender 0
  let s = numToStr(v);
  if (s.startsWith('.')) s = '0' + s; else if (s.startsWith('-.')) s = '-0' + s.slice(1);
  return s;
}

function toNum(v, ctx) {
  if (v === null || v === undefined) return null;
  if (isNum(v)) return v;
  if (isStr(v)) {
    const s = v.trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
    const e = SESSION.inPlsqlProc && !SESSION.inSql ? oraErr('06502', ': Fehler beim Konvertieren von Zeichen in Zahl') : oraErr('01722');
    e.badValue = v;
    throw e;
  }
  if (isBool(v)) throw plsErr('00382', 'Ausdruck hat falschen Typ (BOOLEAN statt NUMBER)');
  if (isDate(v)) throw oraErr('00932', 'NUMBER', 'DATE');
  throw oraErr('00932', 'NUMBER', typeName(v));
}
function typeName(v) { if (v instanceof Rec) return 'RECORD'; if (v instanceof Coll) return 'COLLECTION'; if (v instanceof CursorState) return 'CURSOR'; return typeof v; }

function toStr(v) {
  if (v === null || v === undefined) return null;
  if (isStr(v)) return v;
  if (isNum(v)) return numToStr(v);
  if (isDate(v)) return v.isTs ? fmtDate(v, SESSION.nls.tsFmt) : fmtDate(v, SESSION.nls.dateFmt);
  if (isBool(v)) return v ? 'TRUE' : 'FALSE';
  if (v instanceof Rec) throw plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten (RECORD statt Zeichenfolge)');
  if (v && v.interval) return intervalToStr(v);
  throw oraErr('00932', 'CHAR', typeName(v));
}
function intervalToStr(v) {
  if (v.months !== undefined) { const y = Math.trunc(v.months / 12), m = Math.abs(v.months % 12); return (v.months < 0 ? '-' : '+') + String(Math.abs(y)).padStart(2, '0') + '-' + String(m).padStart(2, '0'); }
  const d = v.days; const sign = d < 0 ? '-' : '+'; let a = Math.abs(d); const dd = Math.floor(a); let rest = (a - dd) * 86400; const hh = Math.floor(rest / 3600); rest -= hh * 3600; const mi = Math.floor(rest / 60); const ss = rest - mi * 60;
  return sign + String(dd).padStart(2, '0') + ' ' + String(hh).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + ss.toFixed(0).padStart(2, '0');
}

function toDate(v) {
  if (v === null || v === undefined) return null;
  if (isDate(v)) return v;
  if (isStr(v)) {
    const d = parseDateLenient(v);
    if (d) return d;
    throw oraErr('01861');
  }
  if (isNum(v)) throw oraErr('00932', 'DATE', 'NUMBER');
  throw oraErr('00932', 'DATE', typeName(v));
}
function toBool(v) {
  if (v === null || v === undefined) return null;
  if (isBool(v)) return v;
  if (isNum(v)) return v !== 0;
  if (isStr(v)) { const u = v.trim().toUpperCase(); if (['TRUE', 'YES', 'ON', '1', 'T', 'Y'].includes(u)) return true; if (['FALSE', 'NO', 'OFF', '0', 'F', 'N'].includes(u)) return false; }
  throw plsErr('00382', 'Ausdruck hat falschen Typ (BOOLEAN erwartet)');
}

// ---------- Datum ----------
const MON_DE = ['JAN', 'FEB', 'MRZ', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];
const MON_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_DE = ['JANUAR', 'FEBRUAR', 'MÄRZ', 'APRIL', 'MAI', 'JUNI', 'JULI', 'AUGUST', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DEZEMBER'];
const MONTH_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const DY_DE = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
const DAY_DE = ['SONNTAG', 'MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG'];
const DY_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function mkDate(y, m, d, hh = 0, mi = 0, ss = 0, ms = 0) {
  const dt = new Date(Date.UTC(2000, 0, 1, hh, mi, ss, ms));
  dt.setUTCFullYear(y, m - 1, d);
  return dt;
}
function nowDate() { const n = new Date(); return mkDate(n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds()); }
function dParts(d) { return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), dow: d.getUTCDay() }; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

const DFMT_TOKENS = ['SYYYY', 'YYYY', 'IYYY', 'RRRR', 'Y,YYY', 'YEAR', 'YYY', 'YY', 'RR', 'Y', 'MONTH', 'MON', 'MM', 'DDD', 'DD', 'DAY', 'DY', 'D', 'HH24', 'HH12', 'HH', 'MI', 'SSSSS', 'SS', 'FF9', 'FF6', 'FF3', 'FF', 'AM', 'PM', 'A.M.', 'P.M.', 'Q', 'WW', 'IW', 'W', 'J', 'FM', 'TH', 'CC', 'TZH', 'TZM', 'TZR'];
function tokenizeDateFmt(fmt) {
  const out = []; let i = 0; const U = fmt.toUpperCase();
  while (i < fmt.length) {
    if (fmt[i] === '"') { const e = fmt.indexOf('"', i + 1); out.push({ lit: fmt.slice(i + 1, e < 0 ? fmt.length : e) }); i = e < 0 ? fmt.length : e + 1; continue; }
    let tk = null;
    for (const t of DFMT_TOKENS) if (U.startsWith(t, i)) { tk = t; break; }
    if (tk) { out.push({ t: tk, raw: fmt.substr(i, tk.length) }); i += tk.length; continue; }
    if (/[-\/,.;: \t]/.test(fmt[i])) { out.push({ lit: fmt[i] }); i++; continue; }
    throw oraErr('01821' in ORA_MSG ? '01821' : '01861');
  }
  return out;
}
function caseLike(raw, word) {
  if (raw === raw.toUpperCase()) return word.toUpperCase();
  if (raw[0] === raw[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1).toLowerCase();
  return word.toLowerCase();
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { w: Math.ceil(((t - y0) / 86400000 + 1) / 7), y: t.getUTCFullYear() };
}
function fmtDate(d, fmt) {
  if (d === null) return null;
  const p = dParts(d); let fm = false; let out = '';
  const pad = (n, w) => fm ? String(n) : String(n).padStart(w, '0');
  for (const tk of tokenizeDateFmt(fmt)) {
    if (tk.lit !== undefined) { out += tk.lit; continue; }
    const t = tk.t;
    switch (t) {
      case 'FM': fm = !fm; break;
      case 'SYYYY': case 'YYYY': case 'RRRR': case 'IYYY': out += pad(t === 'IYYY' ? isoWeek(d).y : p.y, 4); break;
      case 'Y,YYY': out += String(p.y).replace(/(\d)(\d{3})$/, '$1,$2'); break;
      case 'YYY': out += pad(p.y % 1000, 3); break;
      case 'YY': case 'RR': out += pad(p.y % 100, 2); break;
      case 'Y': out += String(p.y % 10); break;
      case 'YEAR': out += caseLike(tk.raw, String(p.y)); break;
      case 'CC': out += pad(Math.floor((p.y - 1) / 100) + 1, 2); break;
      case 'MM': out += pad(p.m, 2); break;
      case 'MON': out += caseLike(tk.raw, MON_DE[p.m - 1]); break;
      case 'MONTH': { let w = MONTH_DE[p.m - 1]; if (!fm) w = w.padEnd(9); out += caseLike(tk.raw, w); break; }
      case 'DD': out += pad(p.d, 2); break;
      case 'DDD': { const st = Date.UTC(p.y, 0, 1); out += pad(Math.floor((Date.UTC(p.y, p.m - 1, p.d) - st) / 86400000) + 1, 3); break; }
      case 'D': out += String(p.dow === 0 ? 7 : p.dow); break;
      case 'DY': out += caseLike(tk.raw, DY_DE[p.dow]); break;
      case 'DAY': { let w = DAY_DE[p.dow]; if (!fm) w = w.padEnd(10); out += caseLike(tk.raw, w); break; }
      case 'HH24': out += pad(p.hh, 2); break;
      case 'HH': case 'HH12': out += pad(p.hh % 12 === 0 ? 12 : p.hh % 12, 2); break;
      case 'MI': out += pad(p.mi, 2); break;
      case 'SS': out += pad(p.ss, 2); break;
      case 'SSSSS': out += pad(p.hh * 3600 + p.mi * 60 + p.ss, 5); break;
      case 'FF': case 'FF9': out += String(p.ms).padStart(3, '0') + '000000'; break;
      case 'FF6': out += String(p.ms).padStart(3, '0') + '000'; break;
      case 'FF3': out += String(p.ms).padStart(3, '0'); break;
      case 'AM': case 'PM': out += caseLike(tk.raw, p.hh < 12 ? 'AM' : 'PM'); break;
      case 'A.M.': case 'P.M.': out += caseLike(tk.raw, p.hh < 12 ? 'A.M.' : 'P.M.'); break;
      case 'Q': out += String(Math.floor((p.m - 1) / 3) + 1); break;
      case 'WW': out += pad(Math.floor((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86400000 / 7) + 1, 2); break;
      case 'IW': out += pad(isoWeek(d).w, 2); break;
      case 'W': out += String(Math.floor((p.d - 1) / 7) + 1); break;
      case 'J': out += String(Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86400000) + 2440588); break;
      case 'TH': { const n = parseInt(out.match(/(\d+)$/)?.[1] || '0', 10); const s = (n % 100 >= 11 && n % 100 <= 13) ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH'); out += caseLike(tk.raw, s); break; }
      case 'TZH': out += '+00'; break; case 'TZM': out += '00'; break; case 'TZR': out += 'UTC'; break;
    }
  }
  return out;
}
function parseDateFmt(s, fmt, strict) {
  const toks = tokenizeDateFmt(fmt);
  const now = nowDate(); const np = dParts(now);
  let y = np.y, m = np.m, d = 1, hh = 0, mi = 0, ss = 0, ms = 0, pm = null, hh12 = false;
  let i = 0;
  const skipSep = () => { while (i < s.length && /[-\/,.;: \t]/.test(s[i])) i++; };
  const readNum = (max) => {
    skipSep();
    let j = i; if (s[j] === '-' || s[j] === '+') j++;
    while (j < s.length && j - i < max && /[0-9]/.test(s[j])) j++;
    if (j === i) throw oraErr('01858');
    const v = parseInt(s.slice(i, j), 10); const len = j - i; i = j; return { v, len };
  };
  const readWord = () => { skipSep(); let j = i; while (j < s.length && /[A-Za-zÄÖÜäöü.]/.test(s[j])) j++; const w = s.slice(i, j).toUpperCase(); i = j; return w; };
  for (const tk of toks) {
    if (tk.lit !== undefined) { if (s.substr(i, tk.lit.length) === tk.lit) i += tk.lit.length; continue; }
    switch (tk.t) {
      case 'FM': case 'TH': break;
      case 'SYYYY': case 'YYYY': case 'IYYY': case 'Y,YYY': y = readNum(4).v; break;
      case 'RRRR': { const r = readNum(4); y = r.len <= 2 ? rr(r.v) : r.v; break; }
      case 'YYY': y = Math.floor(np.y / 1000) * 1000 + readNum(3).v; break;
      case 'YY': y = Math.floor(np.y / 100) * 100 + readNum(2).v; break;
      case 'RR': { const r = readNum(4); y = r.len <= 2 ? rr(r.v) : r.v; break; }
      case 'Y': y = Math.floor(np.y / 10) * 10 + readNum(1).v; break;
      case 'MM': m = readNum(2).v; break;
      case 'MON': case 'MONTH': {
        const w = readWord(); let idx = -1;
        for (const arr of [MON_DE, MON_EN, MONTH_DE, MONTH_EN]) { const k = arr.findIndex(x => x === w || (w.length >= 3 && x.startsWith(w) && arr.length === 12 && (arr === MONTH_DE || arr === MONTH_EN))); if (k >= 0) { idx = k; break; } }
        if (w === 'MAER' || w === 'MAERZ' || w === 'MÄR') idx = 2;
        if (idx < 0) throw oraErr('01843');
        m = idx + 1; break;
      }
      case 'DD': d = readNum(2).v; break;
      case 'DDD': { const v = readNum(3).v; const dt = mkDate(y, 1, 1); dt.setUTCDate(v); m = dt.getUTCMonth() + 1; d = dt.getUTCDate(); break; }
      case 'D': readNum(1); break;
      case 'DY': case 'DAY': readWord(); break;
      case 'HH24': hh = readNum(2).v; if (hh > 23) throw new OraError('ORA-01850', 'Stunde muss zwischen 0 und 23 liegen'); break;
      case 'HH': case 'HH12': hh = readNum(2).v; hh12 = true; if (hh < 1 || hh > 12) throw new OraError('ORA-01849', 'Stunde muss zwischen 1 und 12 liegen'); break;
      case 'MI': mi = readNum(2).v; if (mi > 59) throw new OraError('ORA-01851', 'Minuten müssen zwischen 0 und 59 liegen'); break;
      case 'SS': ss = readNum(2).v; if (ss > 59) throw new OraError('ORA-01852', 'Sekunden müssen zwischen 0 und 59 liegen'); break;
      case 'SSSSS': { const v = readNum(5).v; hh = Math.floor(v / 3600); mi = Math.floor(v % 3600 / 60); ss = v % 60; break; }
      case 'FF': case 'FF3': case 'FF6': case 'FF9': { const r = readNum(9); ms = Math.round(r.v / Math.pow(10, r.len - 3)); break; }
      case 'AM': case 'PM': case 'A.M.': case 'P.M.': { const w = readWord(); pm = w.startsWith('P'); break; }
      case 'J': { const v = readNum(7).v; const dt = new Date((v - 2440588) * 86400000); y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate(); break; }
      default: readNum(4);
    }
  }
  skipSep();
  if (i < s.length) throw oraErr('01830');
  if (pm !== null && hh12) { if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  if (m < 1 || m > 12) throw oraErr('01843');
  if (d < 1 || d > daysInMonth(y, m)) throw oraErr('01847');
  return mkDate(y, m, d, hh, mi, ss, ms);
}
function rr(v) { const cy = new Date().getFullYear(); const c = Math.floor(cy / 100) * 100; const ly = cy % 100; if (v < 50) return ly < 50 ? c + v : c + 100 + v; return ly < 50 ? c - 100 + v : c + v; }
function parseDateLenient(s) {
  s = s.trim();
  try { return parseDateFmt(s, SESSION.nls.dateFmt); } catch (e) { }
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/))) return safeMk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) return safeMk(m[3].length === 2 ? rr(+m[3]) : +m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if ((m = s.match(/^(\d{1,2})-([A-Za-zÄä]{3,9})-(\d{2}|\d{4})$/))) {
    const w = m[2].toUpperCase(); let idx = MON_EN.indexOf(w.slice(0, 3)); if (idx < 0) idx = MON_DE.indexOf(w.slice(0, 3)); if (w.startsWith('MÄR')) idx = 2;
    if (idx >= 0) return safeMk(m[3].length === 2 ? rr(+m[3]) : +m[3], idx + 1, +m[1]);
  }
  return null;
}
function safeMk(y, mo, d, hh = 0, mi = 0, ss = 0, ms = 0) {
  if (mo < 1 || mo > 12) throw oraErr('01843');
  if (d < 1 || d > daysInMonth(y, mo)) throw oraErr('01847');
  return mkDate(y, mo, d, hh, mi, ss, ms);
}
function addMonths(d, n) {
  const p = dParts(d); let m = p.m - 1 + Math.trunc(n); let y = p.y + Math.floor(m / 12); m = ((m % 12) + 12) % 12 + 1;
  const last = daysInMonth(p.y, p.m) === p.d; const dim = daysInMonth(y, m);
  return mkDate(y, m, last ? dim : Math.min(p.d, dim), p.hh, p.mi, p.ss);
}

// ---------- Zahlenformat ----------
function fmtNumber(n, fmt) {
  if (n === null) return null;
  let f = fmt.toUpperCase(); let fm = false;
  if (f.startsWith('FM')) { fm = true; f = f.slice(2); }
  let lead = '', trailMinus = false, leadS = false, trailS = false, curr = '';
  if (f.endsWith('MI')) { trailMinus = true; f = f.slice(0, -2); }
  if (f.startsWith('S')) { leadS = true; f = f.slice(1); } else if (f.endsWith('S')) { trailS = true; f = f.slice(0, -1); }
  if (f.includes('EEEE')) { const r = n.toExponential(Math.max(0, (f.split(/[.D]/)[1] || '').replace('EEEE', '').length)).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2'); return (fm ? '' : ' ') + r; }
  f = f.replace(/\$/g, () => { curr = '$'; return ''; }).replace(/L/g, () => { curr = '€'; return ''; }).replace(/C/g, () => { curr = 'EUR'; return ''; }).replace(/U/g, () => { curr = '€'; return ''; });
  const xMatch = f.match(/^X+$/);
  if (xMatch || /^0*X+$/.test(f)) { let h = Math.round(n).toString(16).toUpperCase(); if (fmt.includes('x')) h = h.toLowerCase(); return (fm ? '' : ' ') + h.padStart(f.replace(/X/g, '').length ? f.length : (fm ? 0 : f.length), f.startsWith('0') ? '0' : ' '); }
  let dpos = f.search(/[.D]/);
  const intF = dpos >= 0 ? f.slice(0, dpos) : f;
  const decF = dpos >= 0 ? f.slice(dpos + 1) : '';
  const decChar = dpos >= 0 ? (f[dpos] === 'D' ? ',' : '.') : '';
  const decDigits = decF.replace(/[^90]/g, '').length;
  const neg = n < 0; const a = Math.abs(n);
  const fixed = a.toFixed(decDigits);
  let [ip, dp] = fixed.split('.');
  const intSlots = intF.replace(/[^90]/g, '').length;
  if (ip === '0' && intSlots > 0 && !intF.includes('0')) ip = (decDigits ? '' : '0');
  if (ip.length > intSlots) return '#'.repeat(fmt.length + 1);
  // Ganzzahlteil auffüllen
  let res = ''; let di = ip.length - 1; let started = false;
  const firstZero = intF.indexOf('0');
  for (let k = intF.length - 1; k >= 0; k--) {
    const c = intF[k];
    if (c === '9' || c === '0') {
      if (di >= 0) { res = ip[di--] + res; }
      else if (c === '0' || (firstZero >= 0 && k >= firstZero)) res = '0' + res;
      else res = (fm ? '' : ' ') + res;
    } else if (c === ',' || c === 'G') {
      const hasLeft = di >= 0 || (firstZero >= 0 && k > firstZero);
      if (hasLeft) res = (c === 'G' ? '.' : ',') + res; else res = (fm ? '' : ' ') + res;
    } else if (c === 'B') { } else res = c + res;
  }
  let out = res;
  if (decChar) {
    let d = (dp || '');
    if (fm) d = d.replace(/0+$/, (z) => { const minZ = decF.lastIndexOf('0') + 1; return z.slice(0, Math.max(0, minZ - (d.length - z.length))); });
    out += decChar + d;
  }
  if (fm) out = out.trimStart();
  out = curr + out;
  if (leadS) out = (neg ? '-' : '+') + out;
  else if (trailS) out = out + (neg ? '-' : '+');
  else if (trailMinus) out = out + (neg ? '-' : (fm ? '' : ' '));
  else if (!fm) out = (neg ? '-' : ' ') + out;
  else if (neg) out = '-' + out;
  if (!fm && neg && !leadS && !trailS && !trailMinus) { out = out.replace(/^-(\s+)/, '$1-'); }
  return out;
}
function parseNumberFmt(s, fmt) {
  if (s === null) return null;
  let t = String(s).trim().replace(/[€$]/g, '').replace(/EUR/i, '');
  const f = (fmt || '').toUpperCase();
  if (f.includes('D') || f.includes('G')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  if (/MI$/.test(f) && t.endsWith('-')) t = '-' + t.slice(0, -1);
  if (/^X+$/.test(f)) return parseInt(t, 16);
  t = t.replace(/\s/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) throw oraErr('01722');
  return parseFloat(t);
}

// ---------- Vergleich ----------
function cmpVals(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
  if (isStr(a) && isStr(b)) { if (a === b) return 0; let x = a, y = b; if (x.endsWith(' ') || y.endsWith(' ')) { x = x.replace(/ +$/, ''); y = y.replace(/ +$/, ''); } return x < y ? -1 : x > y ? 1 : 0; }
  if (isDate(a) || isDate(b)) { const x = toDate(a).getTime(), y = toDate(b).getTime(); return x < y ? -1 : x > y ? 1 : 0; }
  if (isNum(a) || isNum(b)) { const x = toNum(a), y = toNum(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (isBool(a) && isBool(b)) return a === b ? 0 : (a ? 1 : -1);
  if (isBool(a) || isBool(b)) throw plsErr('00306', 'Falsche Typen beim Vergleich mit BOOLEAN');
  throw oraErr('00932', typeName(a), typeName(b));
}
function keyOf(vals) {
  let s = '';
  for (const v of vals) {
    if (v === null || v === undefined) s += '\u0000N';
    else if (isNum(v)) s += 'n' + (Object.is(v, -0) ? 0 : v);
    else if (isDate(v)) s += 'd' + v.getTime();
    else if (isBool(v)) s += 'b' + v;
    else s += 's' + String(v).replace(/ +$/, '');
    s += '\u0001';
  }
  return s;
}
function sortCmp(a, b, desc, nulls) {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an || bn) {
    if (an && bn) return 0;
    const nullsFirst = nulls ? nulls === 'FIRST' : desc;
    return an ? (nullsFirst ? -1 : 1) : (nullsFirst ? 1 : -1);
  }
  const c = cmpVals(a, b);
  return desc ? -c : c;
}

// ---------- Typ-Anpassung ----------
function typeText(t) {
  if (!t) return '';
  if (t.b === 'NUMBER') { if (t.int) return 'NUMBER(38)'; if (t.fl) return t.fl === 'FLOAT' ? 'FLOAT' : t.fl; if (t.p == null) return 'NUMBER'; return t.s ? 'NUMBER(' + t.p + ',' + t.s + ')' : 'NUMBER(' + t.p + ')'; }
  if (t.b === 'VARCHAR2') return (t.orig || 'VARCHAR2') + (t.len != null ? '(' + t.len + (t.orig === 'RAW' ? '' : ' BYTE') + ')' : '');
  if (t.b === 'CHAR') return 'CHAR(' + t.len + ' BYTE)';
  if (t.b === 'CLOB') return t.orig || 'CLOB';
  if (t.b === 'TIMESTAMP') return 'TIMESTAMP(6)';
  if (t.b === 'PLS_INTEGER') return t.sub || 'PLS_INTEGER';
  if (t.b === 'REC') return t.name || 'RECORD';
  if (t.b === 'OBJ') return t.name;
  if (t.b === 'COLL') return t.name || 'COLLECTION';
  return t.b;
}
function coerce(v, t, where) {
  // where: {kind:'col', table, col} | {kind:'var', name}
  if (v === undefined) v = null;
  if (!t) return v;
  if (v === null) return null;
  const isCol = where && where.kind === 'col';
  const valErr = (detail) => isCol ? oraErr('01722') : oraErr('06502', detail ? ': ' + detail : '');
  switch (t.b) {
    case 'NUMBER': {
      let n;
      try { n = toNum(v); } catch (e) { if (e.code === 'ORA-01722' || e.code === 'ORA-06502') { if (isCol) throw oraErr('01722'); throw oraErr('06502', ': Fehler beim Konvertieren von Zeichen in Zahl'); } throw e; }
      if (t.s != null && !t.fl) {
        const f = Math.pow(10, t.s);
        n = Math.round(n * f + (n >= 0 ? 1e-9 : -1e-9)) / f;
        if (t.s < 0) n = Math.round(n / Math.pow(10, -t.s)) * Math.pow(10, -t.s);
      }
      if (t.p != null && !t.int && !t.fl) {
        const intDigits = Math.abs(n) < 1 ? 0 : Math.floor(Math.log10(Math.abs(n))) + 1;
        if (intDigits > t.p - (t.s || 0)) { if (isCol) throw oraErr('01438'); throw oraErr('06502', ': Genauigkeit der Zahl zu hoch'); }
      }
      if (t.int) n = Math.round(n);
      return n;
    }
    case 'PLS_INTEGER': {
      let n; try { n = toNum(v); } catch (e) { throw valErr('Fehler beim Konvertieren von Zeichen in Zahl'); }
      n = Math.round(n);
      if ((t.sub === 'NATURAL' || t.sub === 'NATURALN') && n < 0) throw valErr();
      if ((t.sub === 'POSITIVE' || t.sub === 'POSITIVEN') && n < 1) throw valErr();
      if (Math.abs(n) > 2147483647) throw oraErr('01426' in ORA_MSG ? '01426' : '06502', '');
      return n;
    }
    case 'VARCHAR2': case 'CLOB': {
      if (v instanceof Rec || v instanceof Coll) throw plsErr('00382', 'Ausdruck hat falschen Typ');
      let s = toStr(v);
      if (s === '') return null;
      if (t.b === 'VARCHAR2' && t.len != null && s.length > t.len) {
        if (isCol) throw oraErr('12899', '"' + SCHEMA + '"."' + where.table + '"."' + where.col + '"', s.length, t.len);
        throw oraErr('06502', ': Zeichenfolgenpuffer zu klein');
      }
      return s;
    }
    case 'CHAR': {
      let s = toStr(v);
      if (s === '') return null;
      if (s.length > t.len) {
        if (/ +$/.test(s) && s.replace(/ +$/, '').length <= t.len) s = s.slice(0, t.len);
        else { if (isCol) throw oraErr('12899', '"' + SCHEMA + '"."' + where.table + '"."' + where.col + '"', s.length, t.len); throw oraErr('06502', ': Zeichenfolgenpuffer zu klein'); }
      }
      return s.padEnd(t.len, ' ');
    }
    case 'DATE': case 'TIMESTAMP': {
      if (isNum(v)) throw oraErr('00932', 'DATE', 'NUMBER');
      const d = toDate(v);
      const r = new Date(d.getTime());
      if (t.b === 'DATE') r.setUTCMilliseconds(0); else r.isTs = true;
      return r;
    }
    case 'BOOLEAN': return toBool(v);
    case 'INTERVAL': return v;
    case 'OBJ': {
      if (!(v instanceof Rec)) throw oraErr('00932', t.name, typeName(v));
      if (v.objType && v.objType !== t.name) throw oraErr('00932', t.name, v.objType);
      const r = v.clone(); r.objType = t.name; return r;
    }
    case 'REFCURSOR': if (!(v instanceof CursorState)) throw plsErr('00382', 'Ausdruck hat falschen Typ'); return v;
    case 'REC': {
      if (!(v instanceof Rec)) throw plsErr('00382', 'Ausdruck hat falschen Typ (RECORD erwartet)');
      const r = new Rec(t.fields);
      const byName = t.fields.every(f => v.has(f.name));
      t.fields.forEach((f, i) => {
        const src = byName ? v.get(f.name) : v.get(v.names[i]);
        if (!byName && i >= v.names.length) throw plsErr('00382', 'Ausdruck hat falschen Typ (Record-Struktur passt nicht)');
        r.set(f.name, coerce(cloneVal(src), f.type, { kind: 'var', name: f.name }));
      });
      return r;
    }
    case 'COLL': {
      if (!(v instanceof Coll)) throw plsErr('00382', 'Ausdruck hat falschen Typ (Collection erwartet)');
      const c = v.clone(); c.type = t; return c;
    }
  }
  return v;
}
function valueKind(v) {
  if (v === null || v === undefined) return null;
  if (isNum(v)) return 'num'; if (isDate(v)) return 'date'; if (isBool(v)) return 'bool'; return 'str';
}
