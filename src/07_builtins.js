// ===== Eingebaute Funktionen & Prozeduren =====
const BUILTIN = {};
const BUILTIN_PROC = {};
function argc(node, name, min, max, n) {
  if (n < min || n > max) { const e = SESSION.ctx === 'plsql' ? plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'' + name + '\'') : oraErr('00909'); if (node && node.line) e.line = node.line; throw e; }
}
function def(name, min, max, fn, opts) {
  BUILTIN[name] = (args, env, node) => {
    argc(node, name, min, max, args.length);
    const vals = args.map(a => ev(a.named ? a.e : a, env));
    if (!(opts && opts.nulls) && vals.some(v => v === null)) return null;
    return fn(vals, env, node, args);
  };
}
function lazy(name, min, max, fn) { BUILTIN[name] = (args, env, node) => { argc(node, name, min, max, args.length); return fn(args, env, node); }; }
const S = toStr, N = toNum;
const rnd = (x, d = 0) => { d = Math.trunc(d); const s = x < 0 ? -1 : 1; const a = Math.abs(x); const r = Number(Math.round(Number(a + 'e' + d)) + 'e' + (-d)); return s * (isFinite(r) ? r : Math.round(a * Math.pow(10, d)) / Math.pow(10, d)); };
const trc = (x, d = 0) => { d = Math.trunc(d); const f = Math.pow(10, d); const r = Math.trunc(Number((x * f).toPrecision(15))) / f; return r; };

// Zeichenketten
def('UPPER', 1, 1, v => S(v[0]).toUpperCase());
def('LOWER', 1, 1, v => S(v[0]).toLowerCase());
def('INITCAP', 1, 1, v => S(v[0]).toLowerCase().replace(/(^|[^A-Za-z0-9ÄÖÜäöüß])([a-zäöüß])/g, (m, a, b) => a + b.toUpperCase()));
def('LENGTH', 1, 1, v => S(v[0]).length); BUILTIN.LENGTHB = BUILTIN.LENGTH; BUILTIN.LENGTHC = BUILTIN.LENGTH;
def('SUBSTR', 2, 3, v => {
  const s = S(v[0]); let p = Math.trunc(N(v[1])); const len = v.length > 2 ? Math.trunc(N(v[2])) : undefined;
  if (len !== undefined && len < 1) return null;
  if (p === 0) p = 1;
  let start = p > 0 ? p - 1 : s.length + p;
  if (start < 0) return null;
  const r = len === undefined ? s.slice(start) : s.slice(start, start + len);
  return r === '' ? null : r;
});
BUILTIN.SUBSTRB = BUILTIN.SUBSTR;
def('INSTR', 2, 4, v => {
  const s = S(v[0]), sub = S(v[1]); const pos = v.length > 2 ? Math.trunc(N(v[2])) : 1; const occ = v.length > 3 ? Math.trunc(N(v[3])) : 1;
  if (pos === 0) return 0; if (occ < 1) throw oraErr('01428', occ);
  let count = 0;
  if (pos > 0) { let i = pos - 1; while (true) { const k = s.indexOf(sub, i); if (k < 0) return 0; if (++count === occ) return k + 1; i = k + 1; } }
  let i = s.length + pos; while (i >= 0) { const k = s.lastIndexOf(sub, i); if (k < 0) return 0; if (++count === occ) return k + 1; i = k - 1; }
  return 0;
});
def('CONCAT', 2, 2, v => { const r = (v[0] === null ? '' : S(v[0])) + (v[1] === null ? '' : S(v[1])); return r === '' ? null : r; }, { nulls: true });
const pad = (left) => (v) => { const s = S(v[0]); const n = Math.trunc(N(v[1])); const p = v.length > 2 ? S(v[2]) : ' '; if (n <= 0 || p === null) return null; if (s.length >= n) return s.slice(0, n); let fill = ''; while (fill.length < n - s.length) fill += p; fill = fill.slice(0, n - s.length); return left ? fill + s : s + fill; };
def('LPAD', 2, 3, pad(true)); def('RPAD', 2, 3, pad(false));
BUILTIN.TRIM = (args, env, node) => {
  const s = ev(args[0], env); if (s === null) return null;
  const chN = args[1] && args[1].k !== 'null' ? ev(args[1], env) : ' ';
  if (chN === null) return null;
  const ch = S(chN); if (ch.length !== 1) throw new OraError('ORA-30001', 'Trim-Set darf nur aus einem Zeichen bestehen');
  const mode = args[2] ? args[2].v : 'BOTH'; let r = S(s);
  if (mode !== 'TRAILING') while (r.startsWith(ch)) r = r.slice(1);
  if (mode !== 'LEADING') while (r.endsWith(ch)) r = r.slice(0, -1);
  return r === '' ? null : r;
};
def('LTRIM', 1, 2, v => { const set = v.length > 1 ? S(v[1]) : ' '; let s = S(v[0]); let i = 0; while (i < s.length && set.includes(s[i])) i++; s = s.slice(i); return s === '' ? null : s; });
def('RTRIM', 1, 2, v => { const set = v.length > 1 ? S(v[1]) : ' '; let s = S(v[0]); let i = s.length; while (i > 0 && set.includes(s[i - 1])) i--; s = s.slice(0, i); return s === '' ? null : s; });
def('REPLACE', 2, 3, v => { if (v[0] === null) return null; const s = S(v[0]); if (v[1] === null) return s; const r = s.split(S(v[1])).join(v.length > 2 && v[2] !== null ? S(v[2]) : ''); return r === '' ? null : r; }, { nulls: true });
def('TRANSLATE', 3, 3, v => { const s = S(v[0]), a = S(v[1]), b = S(v[2]); let r = ''; for (const c of s) { const i = a.indexOf(c); if (i < 0) r += c; else if (i < b.length) r += b[i]; } return r === '' ? null : r; });
def('REVERSE', 1, 1, v => S(v[0]).split('').reverse().join(''));
def('ASCII', 1, 1, v => { const s = S(v[0]); return s.length ? s.codePointAt(0) : null; });
def('CHR', 1, 1, v => String.fromCharCode(N(v[0])));
def('SOUNDEX', 1, 1, v => { const s = S(v[0]).toUpperCase().replace(/[^A-Z]/g, ''); if (!s) return null; const m = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 }; let r = s[0], last = m[s[0]]; for (const c of s.slice(1)) { const d = m[c]; if (d && d !== last) r += d; if (c !== 'H' && c !== 'W') last = d; } return (r + '000').slice(0, 4); });
function oraRegex(p, flags, global) {
  let src = S(p).replace(/\[:alpha:\]/g, 'A-Za-zÄÖÜäöüß').replace(/\[:digit:\]/g, '0-9').replace(/\[:alnum:\]/g, 'A-Za-z0-9ÄÖÜäöüß').replace(/\[:space:\]/g, '\\s').replace(/\[:upper:\]/g, 'A-ZÄÖÜ').replace(/\[:lower:\]/g, 'a-zäöüß').replace(/\[:punct:\]/g, '!-\\/:-@\\[-`{-~').replace(/\[:xdigit:\]/g, '0-9A-Fa-f').replace(/\[:blank:\]/g, ' \\t');
  let f = global ? 'g' : '';
  const fl = flags ? S(flags) : '';
  if (fl.includes('i')) f += 'i';
  if (fl.includes('n')) f += 's';
  if (fl.includes('m')) f += 'm';
  if (fl.includes('x')) src = src.replace(/\s+/g, '');
  try { return new RegExp(src, f); } catch (e) { throw new OraError('ORA-12725', 'Klammern im regulären Ausdruck stimmen nicht überein bzw. ungültiger Ausdruck'); }
}
def('REGEXP_LIKE', 2, 3, v => oraRegex(v[1], v[2]).test(S(v[0])));
def('REGEXP_REPLACE', 2, 6, v => {
  if (v[0] === null) return null; const s = S(v[0]); if (v[1] === null) return s;
  const rep = v.length > 2 && v[2] !== null ? S(v[2]).replace(/\\(\d)/g, '$$$1') : '';
  const pos = v.length > 3 ? N(v[3]) : 1; const occ = v.length > 4 ? N(v[4]) : 0;
  const head = s.slice(0, pos - 1), tail = s.slice(pos - 1);
  let r;
  if (!occ) r = tail.replace(oraRegex(v[1], v[5], true), rep);
  else { let i = 0; r = tail.replace(oraRegex(v[1], v[5], true), (...m) => { i++; if (i !== occ) return m[0]; return m[0].replace(oraRegex(v[1], v[5]), rep); }); }
  r = head + r; return r === '' ? null : r;
}, { nulls: true });
def('REGEXP_SUBSTR', 2, 6, v => {
  const s = S(v[0]); const pos = v.length > 2 ? N(v[2]) : 1; const occ = v.length > 3 ? N(v[3]) : 1; const grp = v.length > 5 ? N(v[5]) : 0;
  const re = oraRegex(v[1], v[4], true); const tail = s.slice(pos - 1); let i = 0, m;
  while ((m = re.exec(tail))) { if (++i === occ) { const r = m[grp]; return r === undefined || r === '' ? null : r; } if (m[0] === '') re.lastIndex++; }
  return null;
});
def('REGEXP_INSTR', 2, 7, v => {
  const s = S(v[0]); const pos = v.length > 2 ? N(v[2]) : 1; const occ = v.length > 3 ? N(v[3]) : 1; const ret = v.length > 4 ? N(v[4]) : 0;
  const re = oraRegex(v[1], v[5], true); const tail = s.slice(pos - 1); let i = 0, m;
  while ((m = re.exec(tail))) { if (++i === occ) return pos + m.index + (ret ? m[0].length : 0); if (m[0] === '') re.lastIndex++; }
  return 0;
});
def('REGEXP_COUNT', 2, 4, v => { const s = S(v[0]); const pos = v.length > 2 ? N(v[2]) : 1; const m = s.slice(pos - 1).match(oraRegex(v[1], v[3], true)); return m ? m.length : 0; });

// Zahlen
def('ABS', 1, 1, v => Math.abs(N(v[0])));
def('CEIL', 1, 1, v => Math.ceil(N(v[0])));
def('FLOOR', 1, 1, v => Math.floor(N(v[0])));
def('SIGN', 1, 1, v => Math.sign(N(v[0])));
def('MOD', 2, 2, v => { const a = N(v[0]), b = N(v[1]); if (b === 0) return a; return Number((a - b * Math.trunc(a / b)).toPrecision(15)); });
def('REMAINDER', 2, 2, v => { const a = N(v[0]), b = N(v[1]); if (b === 0) throw oraErr('01476'); return a - b * Math.round(a / b); });
def('POWER', 2, 2, v => Math.pow(N(v[0]), N(v[1])));
def('SQRT', 1, 1, v => { const x = N(v[0]); if (x < 0) throw oraErr('01428', x); return Math.sqrt(x); });
def('EXP', 1, 1, v => Math.exp(N(v[0])));
def('LN', 1, 1, v => { const x = N(v[0]); if (x <= 0) throw oraErr('01428', x); return Math.log(x); });
def('LOG', 2, 2, v => Math.log(N(v[1])) / Math.log(N(v[0])));
for (const fn of ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SINH', 'COSH', 'TANH']) def(fn, 1, 1, v => Math[fn.toLowerCase()](N(v[0])));
def('ATAN2', 2, 2, v => Math.atan2(N(v[0]), N(v[1])));
def('BITAND', 2, 2, v => Number(BigInt(Math.trunc(N(v[0]))) & BigInt(Math.trunc(N(v[1])))));
def('WIDTH_BUCKET', 4, 4, v => { const x = N(v[0]), lo = N(v[1]), hi = N(v[2]), n = N(v[3]); if (x < lo) return 0; if (x >= hi) return n + 1; return Math.floor((x - lo) / (hi - lo) * n) + 1; });
def('ROUND', 1, 2, v => {
  if (isDate(v[0])) return truncDate(v[0], v.length > 1 ? S(v[1]) : 'DD', true);
  return rnd(N(v[0]), v.length > 1 ? N(v[1]) : 0);
});
def('TRUNC', 1, 2, v => {
  if (isDate(v[0])) return truncDate(v[0], v.length > 1 ? S(v[1]) : 'DD', false);
  return trc(N(v[0]), v.length > 1 ? N(v[1]) : 0);
});
const cmpGL = (sign) => (v) => {
  let best = v[0]; const first = v[0];
  for (const x of v.slice(1)) {
    const y = isStr(first) ? S(x) : (isNum(first) ? N(x) : x);
    if (cmpVals(y, best) * sign > 0) best = y;
  }
  return best;
};
def('GREATEST', 1, 99, cmpGL(1)); def('LEAST', 1, 99, cmpGL(-1));

// NULL-Behandlung
def('NVL', 2, 2, v => v[0] !== null ? v[0] : v[1], { nulls: true });
def('NVL2', 3, 3, v => v[0] !== null ? v[1] : v[2], { nulls: true });
lazy('COALESCE', 1, 99, (args, env) => { for (const a of args) { const v = ev(a, env); if (v !== null) return v; } return null; });
def('NULLIF', 2, 2, v => cmpVals(v[0], v[1]) === 0 ? null : v[0], { nulls: true });
lazy('DECODE', 3, 255, (args, env) => {
  const x = ev(args[0], env);
  let i = 1;
  for (; i + 1 < args.length; i += 2) { const s = ev(args[i], env); if ((x === null && s === null) || cmpVals(x, s) === 0) return ev(args[i + 1], env); }
  return i < args.length ? ev(args[i], env) : null;
});
lazy('LNNVL', 1, 1, (args, env) => toBool(ev(args[0], env)) !== true);

// Konvertierung
def('TO_CHAR', 1, 3, v => {
  const x = v[0];
  if (v.length < 2 || v[1] === null) { if (isDate(x)) return toStr(x); return toStr(x); }
  const fmt = S(v[1]);
  if (isDate(x)) return fmtDate(x, fmt);
  if (isNum(x) || (isStr(x) && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(x.trim()))) return fmtNumber(N(x), fmt);
  if (x && x.interval) return intervalToStr(x);
  throw oraErr('01722');
}, { nulls: true });
BUILTIN.TO_NCHAR = BUILTIN.TO_CHAR; BUILTIN.TO_CLOB = (a, e, n) => { argc(n, 'TO_CLOB', 1, 1, a.length); return toStr(ev(a[0], e)); };
def('TO_NUMBER', 1, 3, v => { if (v.length > 1 && v[1] !== null) return parseNumberFmt(S(v[0]), S(v[1])); if (isNum(v[0])) return v[0]; return N(S(v[0]).trim()); });
def('TO_DATE', 1, 3, v => { if (isDate(v[0])) return v[0]; if (v.length > 1 && v[1] !== null) { const d = parseDateFmt(S(v[0]).trim(), S(v[1])); return d; } return toDate(S(v[0])); });
def('TO_TIMESTAMP', 1, 3, v => { const d = v.length > 1 ? parseDateFmt(S(v[0]).trim(), S(v[1])) : toDate(S(v[0])); const r = new Date(d.getTime()); r.isTs = true; return r; });
def('NUMTODSINTERVAL', 2, 2, v => { const n = N(v[0]); const u = S(v[1]).toUpperCase(); const f = { DAY: 1, HOUR: 1 / 24, MINUTE: 1 / 1440, SECOND: 1 / 86400 }[u]; return { interval: true, days: n * f }; });
def('NUMTOYMINTERVAL', 2, 2, v => { const n = N(v[0]); const u = S(v[1]).toUpperCase(); return { interval: true, months: u === 'YEAR' ? n * 12 : n }; });
def('TO_BINARY_DOUBLE', 1, 1, v => N(v[0])); def('TO_BINARY_FLOAT', 1, 1, v => N(v[0]));
def('ASCIISTR', 1, 1, v => S(v[0]).replace(/[^\x00-\x7f]/g, c => '\\' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')));

// Datum
def('ADD_MONTHS', 2, 2, v => addMonths(toDate(v[0]), N(v[1])));
def('MONTHS_BETWEEN', 2, 2, v => {
  const a = dParts(toDate(v[0])), b = dParts(toDate(v[1]));
  const lastA = a.d === daysInMonth(a.y, a.m), lastB = b.d === daysInMonth(b.y, b.m);
  const months = (a.y - b.y) * 12 + (a.m - b.m);
  if (a.d === b.d || (lastA && lastB)) return months;
  const secA = a.hh * 3600 + a.mi * 60 + a.ss, secB = b.hh * 3600 + b.mi * 60 + b.ss;
  return Number((months + (a.d - b.d) / 31 + (secA - secB) / 86400 / 31).toPrecision(15));
});
def('LAST_DAY', 1, 1, v => { const p = dParts(toDate(v[0])); return mkDate(p.y, p.m, daysInMonth(p.y, p.m), p.hh, p.mi, p.ss); });
def('NEXT_DAY', 2, 2, v => {
  const d = toDate(v[0]); const w = S(v[1]).toUpperCase();
  let idx = DAY_DE.findIndex(x => x.startsWith(w.slice(0, 2))); if (idx < 0) idx = DAY_EN.findIndex(x => x.startsWith(w.slice(0, 3))); if (idx < 0) idx = DY_DE.indexOf(w.slice(0, 2));
  if (idx < 0) throw new OraError('ORA-01846', 'Kein gültiger Wochentag');
  let r = addDays(d, 1); while (r.getUTCDay() !== idx) r = addDays(r, 1); return r;
});
function truncDate(d, fmt, round) {
  const p = dParts(d); const f = fmt.toUpperCase();
  let r;
  if (['DD', 'DDD', 'J'].includes(f)) { r = mkDate(p.y, p.m, p.d); if (round && p.hh >= 12) r = addDays(r, 1); }
  else if (['MM', 'MON', 'MONTH', 'RM'].includes(f)) { r = mkDate(p.y, p.m, 1); if (round && p.d >= 16) r = addMonths(r, 1); }
  else if (['YYYY', 'YEAR', 'YY', 'Y', 'SYYYY', 'YYY', 'RR', 'RRRR', 'IYYY'].includes(f)) { r = mkDate(p.y, 1, 1); if (round && p.m >= 7) r = mkDate(p.y + 1, 1, 1); }
  else if (f === 'Q') { r = mkDate(p.y, Math.floor((p.m - 1) / 3) * 3 + 1, 1); if (round && ((p.m - 1) % 3 > 1 || ((p.m - 1) % 3 === 1 && p.d >= 16))) r = addMonths(r, 3); }
  else if (['IW', 'D', 'DY', 'DAY', 'W', 'WW'].includes(f)) { const dow = (p.dow + 6) % 7; r = addDays(mkDate(p.y, p.m, p.d), -dow); if (round && dow >= 4) r = addDays(r, 7); }
  else if (['HH', 'HH12', 'HH24'].includes(f)) { r = mkDate(p.y, p.m, p.d, p.hh); if (round && p.mi >= 30) r = addDays(r, 1 / 24); }
  else if (f === 'MI') { r = mkDate(p.y, p.m, p.d, p.hh, p.mi); if (round && p.ss >= 30) r = addDays(r, 1 / 1440); }
  else throw new OraError('ORA-01898', 'Zu viele Genauigkeitsangaben / ungültiges Format für TRUNC/ROUND');
  return r;
}
def('EXTRACT', 2, 2, v => {
  const u = v[0];
  if (v[1] && v[1].interval) { const iv = v[1]; if (iv.months !== undefined) return u === 'YEAR' ? Math.trunc(iv.months / 12) : iv.months % 12; const d = iv.days; if (u === 'DAY') return Math.trunc(d); const rest = (d - Math.trunc(d)) * 86400; if (u === 'HOUR') return Math.floor(rest / 3600); if (u === 'MINUTE') return Math.floor(rest % 3600 / 60); return rest % 60; }
  const p = dParts(toDate(v[1]));
  switch (u) { case 'YEAR': return p.y; case 'MONTH': return p.m; case 'DAY': return p.d; case 'HOUR': return p.hh; case 'MINUTE': return p.mi; case 'SECOND': return p.ss + p.ms / 1000; }
  throw new OraError('ORA-30076', 'Ungültiges Extraktionsfeld für Extraktionsquelle');
});
def('SYSDATE', 0, 0, () => nowDate());
def('SYSTIMESTAMP', 0, 0, () => { const n = new Date(); const d = mkDate(n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()); d.isTs = true; return d; });

// Sonstiges
def('SYS_GUID', 0, 0, () => Array.from({ length: 32 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join(''));
def('USERENV', 1, 1, v => { const p = S(v[0]).toUpperCase(); return { SESSIONID: 4711, LANGUAGE: 'GERMAN_GERMANY.AL32UTF8', LANG: 'D', TERMINAL: 'SANDBOX', ISDBA: 'FALSE' }[p] || null; });
def('SYS_CONTEXT', 2, 3, v => { const p = S(v[1]).toUpperCase(); return { SESSION_USER: SCHEMA, CURRENT_USER: SCHEMA, CURRENT_SCHEMA: SCHEMA, DB_NAME: 'SANDBOX', INSTANCE_NAME: 'sandbox', HOST: 'browser', OS_USER: 'student', LANGUAGE: 'GERMAN_GERMANY.AL32UTF8', NLS_DATE_FORMAT: SESSION.nls.dateFmt, SERVER_HOST: 'browser', IP_ADDRESS: '127.0.0.1', SESSIONID: '4711', MODULE: 'Oracle-Sandbox' }[p] || null; });
def('VSIZE', 1, 1, v => toStr(v[0]).length);
def('DUMP', 1, 2, v => { const x = v[0]; const s = toStr(x); const typ = isNum(x) ? 2 : isDate(x) ? 12 : 1; return 'Typ=' + typ + ' Len=' + s.length + ': ' + Array.from(s).map(c => c.charCodeAt(0)).join(','); });
def('ORA_HASH', 1, 3, v => { const s = keyOf([v[0]]); let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; const max = v.length > 1 ? N(v[1]) : 4294967295; return h % (max + 1); });
def('EMPTY_CLOB', 0, 0, () => null, { nulls: true }); def('EMPTY_BLOB', 0, 0, () => null, { nulls: true });
def('CARDINALITY', 1, 1, v => { if (!(v[0] instanceof Coll)) throw oraErr('00932', 'COLLECTION', typeName(v[0])); return v[0].isNull ? null : v[0].map.size; });
lazy('GROUPING', 1, 1, (args, env) => { const a = args[0]; if (a.k === 'id' && env.grpNull && env.grpNull.has(a.parts[a.parts.length - 1])) return 1; return 0; });
lazy('SYS_CONNECT_BY_PATH', 2, 2, (args, env) => {
  const sep = toStr(ev(args[1], env)) || ''; const parts = [];
  for (let rs = env.rs; rs; rs = rs.prior) { parts.unshift(toStr(ev(args[0], sub(env, { rs }))) ?? ''); if (!rs.prior) break; }
  if (!env.rs || env.rs.level === undefined) throw new OraError('ORA-30002', 'SYS_CONNECT_BY_PATH-Funktion ist hier nicht zulässig');
  return sep + parts.join(sep);
});
lazy('UPDATING', 0, 1, (args, env) => { const tc = trigCtx(); if (!tc) throw plsErr('00201', 'Bezeichner \'UPDATING\' muss deklariert werden'); if (tc.event !== 'UPDATE') return false; if (!args.length) return true; const c = S(ev(args[0], env)).toUpperCase(); return !tc.setCols || tc.setCols.includes(c); });
lazy('INSERTING', 0, 0, () => { const tc = trigCtx(); return !!tc && tc.event === 'INSERT'; });
lazy('DELETING', 0, 0, () => { const tc = trigCtx(); return !!tc && tc.event === 'DELETE'; });
lazy('SQLERRM', 0, 1, (args, env) => {
  if (!args.length) { const e = curErr(env.f); return e ? e.sqlerrm : 'ORA-0000: normal, successful completion'; }
  const c = toNum(ev(args[0], env)); if (c === 0) return 'ORA-0000: normal, successful completion'; if (c === 100) return 'ORA-01403: ' + ORA_MSG['01403'];
  if (c > 0) return '-' + c + ': non-ORACLE exception';
  const num = String(-c).padStart(5, '0'); return 'ORA-' + num + ': ' + (ORA_MSG[num] || 'Meldung ' + num + ' nicht gefunden').replace(/\{\d\}/g, '');
});
lazy('SQLCODE', 0, 0, (args, env) => { const e = curErr(env.f); return e ? e.sqlcode : 0; });

// Pakete
let RAND_SEED = null;
function rand() { if (RAND_SEED === null) return Math.random(); RAND_SEED = (RAND_SEED * 16807) % 2147483647; return (RAND_SEED - 1) / 2147483646; }
def('DBMS_RANDOM.VALUE', 0, 2, v => { const r = rand(); if (v.length === 2) return N(v[0]) + r * (N(v[1]) - N(v[0])); return r; });
def('DBMS_RANDOM.RANDOM', 0, 0, () => Math.floor(rand() * 4294967296) - 2147483648);
def('DBMS_RANDOM.NORMAL', 0, 0, () => { const u = rand() || 1e-9, w = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); });
def('DBMS_RANDOM.STRING', 2, 2, v => {
  const o = S(v[0]).toUpperCase(); const n = N(v[1]);
  const sets = { U: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', L: 'abcdefghijklmnopqrstuvwxyz', A: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', X: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', P: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' };
  const set = sets[o] || sets.U; let r = ''; for (let i = 0; i < n; i++) r += set[Math.floor(rand() * set.length)]; return r || null;
});
def('DBMS_UTILITY.GET_TIME', 0, 0, () => Math.floor(Date.now() / 10) % 2147483647);
lazy('DBMS_UTILITY.FORMAT_ERROR_STACK', 0, 0, (a, env) => { const e = curErr(env.f); return e ? e.sqlerrm + '\n' : null; });
lazy('DBMS_UTILITY.FORMAT_ERROR_BACKTRACE', 0, 0, (a, env) => { const e = curErr(env.f); return e && e.oraStack.length ? e.oraStack.join('\n') + '\n' : 'ORA-06512: in Zeile ' + Math.max(1, (env.f && env.f.act.line || 1) - (env.f && env.f.act.base || 1) + 1) + '\n'; });
lazy('DBMS_UTILITY.FORMAT_CALL_STACK', 0, 0, () => '----- PL/SQL Call Stack -----\n(in der Sandbox nicht verfügbar)\n');
def('DBMS_ASSERT.ENQUOTE_LITERAL', 1, 1, v => "'" + S(v[0]).replace(/'/g, "''") + "'");
def('DBMS_ASSERT.SIMPLE_SQL_NAME', 1, 1, v => { if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(S(v[0]))) throw new OraError('ORA-44003', 'Ungültiger SQL-Name'); return v[0]; });

function putLine(args, env, node, newline) {
  argc(node, 'PUT_LINE', newline === null ? 0 : 1, 1, args.length);
  const v = args.length ? ev(args[0], env) : null;
  if (isBool(v)) { const e = plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'PUT_LINE\''); e.hint = 'BOOLEAN kann nicht direkt ausgegeben werden. Nutze z. B. CASE WHEN b THEN \'TRUE\' ELSE \'FALSE\' END.'; throw e; }
  if (v instanceof Rec) { const e = plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'PUT_LINE\''); e.hint = 'Ein ganzer Record kann nicht ausgegeben werden – gib die Felder einzeln aus, z. B. r.name.'; throw e; }
  if (v instanceof Coll) { const e = plsErr('00306', 'Falsche Anzahl oder Typen von Argumenten in Aufruf von \'PUT_LINE\''); e.hint = 'Eine Collection muss elementweise in einer Schleife ausgegeben werden.'; throw e; }
  const s = v === null ? '' : toStr(v);
  if (!SESSION.outEnabled) return;
  if (newline) { SESSION.out.push(SESSION.lineBuf + s); tr({ t: 'out', text: SESSION.lineBuf + s }); SESSION.lineBuf = ''; }
  else SESSION.lineBuf += s;
  if (SESSION.out.length > 20000) { SESSION.out.splice(0, SESSION.out.length - 20000); SESSION.outTrunc = true; }
}
BUILTIN_PROC['DBMS_OUTPUT.PUT_LINE'] = (a, e, n) => putLine(a, e, n, true);
BUILTIN_PROC['DBMS_OUTPUT.PUT'] = (a, e, n) => putLine(a, e, n, false);
BUILTIN_PROC['DBMS_OUTPUT.NEW_LINE'] = () => { SESSION.out.push(SESSION.lineBuf); SESSION.lineBuf = ''; };
BUILTIN_PROC['DBMS_OUTPUT.ENABLE'] = () => { SESSION.outEnabled = true; };
BUILTIN_PROC['DBMS_OUTPUT.DISABLE'] = () => { SESSION.outEnabled = false; };
BUILTIN_PROC['RAISE_APPLICATION_ERROR'] = (args, env, node) => {
  argc(node, 'RAISE_APPLICATION_ERROR', 2, 3, args.length);
  const num = toNum(ev(args[0], env)); const msg = toStr(ev(args[1], env)) || '';
  if (num > -20000 || num < -20999) throw new OraError('ORA-21000', 'Fehlernummernargument für raise_application_error von ' + num + ' liegt außerhalb des Bereichs (-20000 bis -20999)');
  const e = new OraError('ORA-' + String(-num).padStart(5, '0'), msg);
  throw e;
};
BUILTIN_PROC['DBMS_LOCK.SLEEP'] = () => { }; BUILTIN_PROC['DBMS_SESSION.SLEEP'] = () => { };
BUILTIN_PROC['DBMS_RANDOM.SEED'] = (a, env) => { const v = ev(a[0], env); RAND_SEED = (isNum(v) ? Math.abs(Math.trunc(v)) : Array.from(String(v)).reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 2147483646 + 1; };
BUILTIN_PROC['DBMS_RANDOM.INITIALIZE'] = BUILTIN_PROC['DBMS_RANDOM.SEED'];
BUILTIN_PROC['DBMS_SESSION.RESET_PACKAGE'] = () => { SESSION.pkgState = {}; };
BUILTIN_PROC['DBMS_STATS.GATHER_TABLE_STATS'] = () => { }; BUILTIN_PROC['DBMS_STATS.GATHER_SCHEMA_STATS'] = () => { };
BUILTIN_PROC['DBMS_MVIEW.REFRESH'] = () => { };
BUILTIN_PROC['DBMS_UTILITY.EXEC_DDL_STATEMENT'] = (a, env) => execImmediate({ e: a[0] }, env);
BUILTIN_PROC['DBMS_SQL.RETURN_RESULT'] = (args, env) => {
  const v = ev(args[0], env);
  if (!(v instanceof CursorState) || !v.isOpen) throw oraErr('01001');
  SESSION.implicitResults.push({ cols: v.cols, types: v.types, rows: v.rows.slice(v.pos) });
  v.isOpen = false;
};

// DBMS_METADATA / DBMS_TRANSACTION (Teilmenge – genug für DDL-Anzeige und Transaktionsstatus)
BUILTIN_PROC['DBMS_METADATA.SET_TRANSFORM_PARAM'] = () => { };
def('DBMS_METADATA.GET_DDL', 2, 3, v => {
  const kind = S(v[0]).toUpperCase(), name = S(v[1]).toUpperCase();
  const fail = () => { throw new OraError('ORA-31603', 'Objekt "' + name + '" vom Typ ' + kind + ' im Schema "' + SCHEMA + '" nicht gefunden'); };
  if (kind === 'TABLE') { const t = DB.tables[name]; if (!t) fail(); return tableDDL(t); }
  if (kind === 'VIEW') { const x = DB.views[name]; if (!x) fail(); return x.text || ('CREATE OR REPLACE VIEW ' + x.name + ' AS\n' + x.qText); }
  if (kind === 'SEQUENCE') { const s = DB.seqs[name]; if (!s) fail(); return 'CREATE SEQUENCE ' + s.name + ' START WITH ' + s.next + ' INCREMENT BY ' + s.inc; }
  if (kind === 'PROCEDURE' || kind === 'FUNCTION') { const p = DB.procs[name]; if (!p || p.kind !== kind) fail(); return p.text; }
  if (kind === 'TRIGGER') { const t = DB.triggers[name]; if (!t) fail(); return t.text; }
  if (kind === 'PACKAGE' || kind === 'PACKAGE_SPEC' || kind === 'PACKAGE_BODY') { const p = DB.pkgs[name]; if (!p) fail(); return kind === 'PACKAGE_BODY' ? (p.bodyText || '') : (p.specText || p.text || ''); }
  if (kind === 'INDEX') { const i = DB.indexes[name]; if (!i) fail(); return 'CREATE ' + (i.unique ? 'UNIQUE ' : '') + 'INDEX ' + i.name + ' ON ' + i.table + ' (' + i.cols.join(', ') + ')'; }
  fail();
});
def('DBMS_TRANSACTION.LOCAL_TRANSACTION_ID', 0, 1, () => hasTx() && dirtyTables().length ? '7.21.' + (1000 + SESSION.undo.length) : null, { nulls: true });
