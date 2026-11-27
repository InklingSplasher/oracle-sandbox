// ===== Fehler & Lexer =====
const ORA_MSG = {
  '00001': 'Unique Constraint ({0}) verletzt',
  '00900': 'Ungültige SQL-Anweisung',
  '00904': '{0}: ungültiger Bezeichner',
  '00905': 'Schlüsselwort fehlt',
  '00906': 'Linke Klammer fehlt',
  '00907': 'Rechte Klammer fehlt',
  '00909': 'Ungültige Anzahl von Argumenten',
  '00911': 'Ungültiges Zeichen',
  '00913': 'Zu viele Werte',
  '00918': 'Spalte nicht eindeutig definiert',
  '00923': 'FROM-Schlüsselwort nicht gefunden, wo es erwartet wurde',
  '00933': 'SQL-Befehl wurde nicht korrekt beendet',
  '00936': 'Ausdruck fehlt',
  '00937': 'Keine Gruppenfunktion für Einzelgruppe',
  '00942': 'Tabelle oder View nicht vorhanden',
  '00947': 'Nicht genügend Werte',
  '00955': 'Name wird bereits von einem vorhandenen Objekt verwendet',
  '00957': 'Doppelter Spaltenname',
  '00979': 'Kein GROUP BY-Ausdruck',
  '01001': 'Ungültiger Cursor',
  '01400': 'Einfügen von NULL in ({0}) nicht möglich',
  '01403': 'Keine Daten gefunden',
  '01407': 'Aktualisieren von ({0}) zu NULL nicht möglich',
  '01422': 'Exakter Abruf gibt mehr als die angeforderte Zeilenzahl zurück',
  '01427': 'Unterabfrage für eine Zeile liefert mehr als eine Zeile',
  '01438': 'Wert größer als die angegebene Gesamtstellenanzahl, die für diese Spalte zulässig ist',
  '01476': 'Divisor ist Null',
  '01722': 'Ungültige Zahl',
  '01732': 'Datenmanipulationsvorgang auf dieser View nicht zulässig',
  '01747': 'Ungültige Benutzer.Tabelle.Spalte, Tabelle.Spalte oder Spaltenspezifikation',
  '01789': 'Abfrageblock hat falsche Anzahl von Ergebnisspalten',
  '01790': 'Ausdruck muss denselben Datentyp wie der entsprechende Ausdruck haben',
  '01830': 'Datumsformatbild endet, bevor die gesamte Eingabezeichenfolge konvertiert ist',
  '01843': 'Ungültiger Monat',
  '01847': 'Tag des Monats muss zwischen 1 und letztem Tag des Monats liegen',
  '01858': 'Ein nicht-numerisches Zeichen wurde gefunden, wo ein numerisches erwartet wurde',
  '01861': 'Literal stimmt nicht mit Formatzeichenfolge überein',
  '02260': 'Tabelle kann nur einen Primärschlüssel haben',
  '02270': 'Kein übereinstimmender eindeutiger Schlüssel oder Primärschlüssel für diese Spaltenliste',
  '02289': 'Sequence ist nicht vorhanden',
  '02290': 'CHECK-Constraint ({0}) verletzt',
  '02291': 'Integritäts-Constraint ({0}) verletzt - übergeordneter Schlüssel nicht gefunden',
  '02292': 'Integritäts-Constraint ({0}) verletzt - untergeordneter Datensatz gefunden',
  '02443': 'Constraint kann nicht gelöscht werden - nicht vorhandener Constraint',
  '02449': 'Eindeutige/primäre Schlüssel in Tabelle von Fremdschlüsseln referenziert',
  '04043': 'Objekt {0} ist nicht vorhanden',
  '04080': 'Trigger {0} ist nicht vorhanden',
  '04081': 'Trigger {0} ist bereits vorhanden',
  '04088': 'Fehler bei der Ausführung von Trigger {0}',
  '04091': 'Tabelle {0} wird gerade geändert, Trigger/Funktion sieht dies möglicherweise nicht',
  '06502': 'PL/SQL: numerischer oder Wertefehler{0}',
  '06503': 'PL/SQL: Funktion ohne Wert zurückgegeben',
  '06504': 'PL/SQL: Rückgabetypen von Ergebnismengenvariablen oder Abfrage stimmen nicht überein',
  '06510': 'PL/SQL: Nicht behandelte benutzerdefinierte Exception',
  '06511': 'PL/SQL: Cursor bereits geöffnet',
  '06530': 'Referenz zu nicht initialisiertem Composite',
  '06531': 'Referenz auf nicht initialisierte Collection',
  '06532': 'Index außerhalb der Grenzen',
  '06533': 'Index überschreitet Anzahl',
  '06550': 'Zeile {0}, Spalte {1}:\n{2}',
  '06553': 'PLS-306: Falsche Anzahl oder Typen von Argumenten in Aufruf von {0}',
  '06575': 'Package oder Funktion {0} hat ungültigen Status',
  '06592': 'CASE nicht gefunden bei Ausführung von CASE-Anweisung',
  '08002': 'Sequence {0}.CURRVAL ist in dieser Session noch nicht definiert',
  '08004': 'Sequence {0}.NEXTVAL {1} MAXVALUE und kann nicht instanziiert werden',
  '12899': 'Wert zu groß für Spalte {0} (aktuell: {1}, maximal: {2})',
  '01002': 'Abruf außerhalb Reihenfolge',
  '01031': 'Nicht ausreichende Berechtigungen',
  '00920': 'Ungültiger relationaler Operator',
  '00921': 'Unerwartetes Ende des SQL-Befehls',
  '00902': 'Ungültiger Datentyp',
  '01408': 'Diese Spaltenliste hat bereits einen Index',
  '01418': 'Angegebener Index ist nicht vorhanden',
  '00980': 'Synonymübersetzung nicht mehr gültig',
  '30926': 'Stabile Zeilengruppe in den Quelltabellen kann nicht eingelesen werden',
  '01428': 'Argument {0} liegt außerhalb des Bereichs',
  '01489': 'Ergebnis der Zeichenfolgenverkettung ist zu lang',
  '00932': 'Inkonsistente Datentypen: {0} erwartet, {1} erhalten',
  '01008': 'Nicht alle Variablen sind gebunden',
  '00928': 'SELECT-Schlüsselwort fehlt',
  '00926': 'VALUES-Schlüsselwort fehlt',
  '00971': 'SET-Schlüsselwort fehlt',
  '00969': 'ON-Schlüsselwort fehlt',
  '01735': 'Ungültige ALTER TABLE-Option',
  '01451': 'Zu NULL zu ändernde Spalte kann nicht auf NULL geändert werden',
  '01442': 'Zu NOT NULL zu ändernde Spalte ist bereits NOT NULL',
  '02296': 'Aktivierung nicht möglich ({0}) - Nullwerte gefunden',
  '02437': 'Validierung nicht möglich ({0}) - Primärschlüssel verletzt',
  '02299': 'Validierung nicht möglich ({0}) - doppelte Schlüssel gefunden',
  '02298': 'Validierung nicht möglich ({0}) - übergeordnete Schlüssel nicht gefunden',
  '02293': 'Validierung nicht möglich ({0}) - CHECK-Constraint verletzt',
};

class OraError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;          // z.B. 'ORA-01403' oder 'PLS-00201'
    this.oraStack = [];        // ORA-06512-Zeilen
    this.hint = null;
  }
  get sqlcode() {
    if (this.userExc) return 1;
    const n = parseInt(this.code.replace(/\D/g, ''), 10);
    if (this.code === 'ORA-01403') return 100;
    return -n;
  }
  get sqlerrm() { return this.code + ': ' + this.message; }
}

function oraErr(num, ...args) {
  let m = ORA_MSG[num] || 'Fehler';
  m = m.replace(/\{(\d)\}/g, (_, i) => args[+i] !== undefined ? args[+i] : '');
  return new OraError('ORA-' + num, m);
}
function plsErr(num, msg) { return new OraError('PLS-' + num, msg); }

// ---------- Lexer ----------
const T_ID = 'id', T_NUM = 'num', T_STR = 'str', T_OP = 'op', T_SLASH = 'slash', T_EOF = 'eof', T_BIND = 'bind';
const OPS3 = [];
const OPS2 = [':=', '=>', '..', '||', '<>', '!=', '^=', '~=', '<=', '>=', '**', '<<', '>>'];
const OPS1 = '()+-*/=<>,;.%@:[]';

function lex(src) {
  const toks = [];
  let i = 0, line = 1, lineStart = 0;
  const n = src.length;
  const isIdStart = c => /[A-Za-z_À-ɏ]/.test(c);
  const isId = c => /[A-Za-z0-9_$#À-ɏ]/.test(c);
  let nlBefore = true;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; lineStart = i; nlBefore = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      for (let k = i; k < end; k++) if (src[k] === '\n') { line++; lineStart = k + 1; }
      i = end; continue;
    }
    const startCol = i - lineStart + 1;
    const tok = (t, v, extra) => { const o = Object.assign({ t, v, pos: i0, end: i, line: l0, col: startCol, nl: nlBefore }, extra || {}); toks.push(o); nlBefore = false; return o; };
    const i0 = i, l0 = line;
    // Slash allein in Zeile
    if (c === '/') {
      let a = lineStart, onlyWs = true;
      for (let k = lineStart; k < i; k++) if (!/\s/.test(src[k])) { onlyWs = false; break; }
      let k = i + 1;
      while (k < n && src[k] !== '\n' && /\s/.test(src[k])) k++;
      if (onlyWs && (k >= n || src[k] === '\n')) { i++; tok(T_SLASH, '/'); continue; }
    }
    // q-Quote
    if ((c === 'q' || c === 'Q') && src[i + 1] === "'") {
      const open = src[i + 2];
      const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] || open;
      const e = src.indexOf(close + "'", i + 3);
      if (e < 0) throw lexErr('Zeichenfolge nicht beendet', l0, startCol);
      const v = src.slice(i + 3, e);
      for (const ch of v) if (ch === '\n') line++;
      i = e + 2; tok(T_STR, v); continue;
    }
    if ((c === 'n' || c === 'N') && src[i + 1] === "'") { i++; }
    if (src[i] === "'") {
      let v = ''; i++;
      while (true) {
        if (i >= n) throw lexErr('Zeichenfolge nicht beendet (fehlendes \')', l0, startCol);
        if (src[i] === "'") { if (src[i + 1] === "'") { v += "'"; i += 2; continue; } i++; break; }
        if (src[i] === '\n') { line++; lineStart = i + 1; }
        v += src[i++];
      }
      tok(T_STR, v); continue;
    }
    if (c === '"') {
      const e = src.indexOf('"', i + 1);
      if (e < 0) throw lexErr('Bezeichner in Anführungszeichen nicht beendet', l0, startCol);
      const v = src.slice(i + 1, e); i = e + 1;
      tok(T_ID, v, { quoted: true, u: v }); continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && src[i - 1] !== '.')) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && src[j + 1] !== '.') { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+\-]/.test(src[j + 1] || '')) {
        let k = j + 1; if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] || '')) { j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
      }
      const txt = src.slice(i, j);
      i = j;
      if (/[fFdD]/.test(src[i] || '') && !isId(src[i + 1] || '')) i++; // 1.5f / 2d
      tok(T_NUM, parseFloat(txt), { txt }); continue;
    }
    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isId(src[j])) j++;
      const v = src.slice(i, j); i = j;
      tok(T_ID, v, { u: v.toUpperCase() }); continue;
    }
    if (c === ':' && src[i + 1] !== '=' && /[A-Za-z0-9_]/.test(src[i + 1] || '')) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_$#]/.test(src[j])) j++;
      const v = src.slice(i + 1, j).toUpperCase(); i = j;
      tok(T_BIND, ':' + v); continue;
    }
    const two = src.substr(i, 2);
    if (OPS2.includes(two)) { i += 2; tok(T_OP, two); continue; }
    if (OPS1.includes(c)) { i++; tok(T_OP, c); continue; }
    if (c === '&') { i++; while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++; tok('bad', src.slice(i0, i), { msg: 'Substitutionsvariablen wie ' + src.slice(i0, i) + ' gibt es nur in SQL*Plus/SQL Developer – hier bitte einen festen Wert einsetzen.' }); continue; }
    i++; tok('bad', c, { msg: 'Ungültiges Zeichen "' + c + '"' + (c === '`' ? ' – Backticks gibt es in Oracle nicht; Bezeichner ggf. in "doppelte" Anführungszeichen setzen.' : '') });
  }
  toks.push({ t: T_EOF, v: '<EOF>', pos: n, end: n, line, col: n - lineStart + 1, nl: true });
  return toks;
}
function lexErr(msg, line, col, num) {
  const e = num ? oraErr(num) : new OraError('ORA-06550', msg);
  if (!num) e.message = msg;
  e.line = line; e.col = col;
  return e;
}
