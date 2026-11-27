// ===== Parser (SQL + PL/SQL) =====
const RESERVED = new Set(('ACCESS ADD ALL ALTER AND ANY AS ASC BETWEEN BY CHECK CONNECT CREATE CROSS CURRENT DEFAULT DELETE DESC DISTINCT DROP ELSE ' +
  'EXCEPT EXISTS FETCH FOR FROM FULL GRANT GROUP HAVING IN INNER INSERT INTERSECT INTO IS JOIN LEFT LIKE LIMIT LOOP MINUS MODIFY ' +
  'NATURAL NOT NULL OF OFFSET ON OR ORDER OUTER PARTITION PRIOR RETURNING RETURN RIGHT SELECT SET START THEN TO UNION UNIQUE UPDATE ' +
  'USING VALUES WHEN WHERE WITH BULK COLLECT PIVOT UNPIVOT CONSTRAINT PRIMARY FOREIGN REFERENCES END CASE BEGIN DECLARE ' +
  'EXCEPTION IF ELSIF WINDOW MODEL MERGE NOCOPY LATERAL APPLY').split(' '));
const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'LISTAGG', 'STDDEV', 'VARIANCE', 'MEDIAN', 'STDDEV_POP', 'STDDEV_SAMP', 'VAR_POP', 'VAR_SAMP']);
const WIN_ONLY = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTILE', 'PERCENT_RANK', 'CUME_DIST', 'NTH_VALUE', 'RATIO_TO_REPORT']);

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = lex(src);
    this.i = 0;
    this.plsql = false;
    this.lastEnd = 0;
  }
  get cur() { return this.toks[this.i]; }
  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (t.t !== T_EOF) { this.i++; this.lastEnd = t.end; } return t; }
  isKw(w, k = 0) { const t = this.peek(k); return t.t === T_ID && !t.quoted && t.u === w; }
  isKwAny(ws, k = 0) { const t = this.peek(k); return t.t === T_ID && !t.quoted && ws.includes(t.u); }
  acceptKw(...ws) { for (const w of ws) if (!this.isKw(w)) return false; else this.next(); return true; }
  accept1(w) { if (this.isKw(w)) { this.next(); return true; } return false; }
  expectKw(w) {
    if (!this.accept1(w)) {
      if (w === 'BY' || w === 'INTO' || w === 'AS' || w === 'IS' || w === 'THEN' || w === 'LOOP') this.err('00905', 'Erwartet: ' + w);
      this.err(null, 'Erwartet: ' + w);
    }
  }
  isOp(v, k = 0) { const t = this.peek(k); return t.t === T_OP && t.v === v; }
  acceptOp(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
  expectOp(v) {
    if (!this.acceptOp(v)) {
      if (v === ')') this.err('00907');
      if (v === '(') this.err('00906');
      this.err(null, 'Erwartet: "' + v + '"');
    }
  }
  isId(k = 0) { const t = this.peek(k); return t.t === T_ID; }
  ident() {
    const t = this.cur;
    if (t.t === T_ID) { this.next(); return t.quoted ? t.v : t.u; }
    this.err(this.plsql ? null : '00904', 'Bezeichner erwartet');
  }
  err(num, detail, tok) {
    tok = tok || this.cur;
    if (tok.t === 'bad') { const e = oraErr('00911'); e.hint = tok.msg; e.line = tok.line; e.col = tok.col; e.parse = true; throw e; }
    const sym = tok.t === T_EOF ? 'end-of-file' : (tok.t === T_STR ? "'" + tok.v + "'" : String(tok.txt || tok.v));
    let e;
    if (this.plsql) {
      e = new OraError('ORA-06550', 'Zeile ' + tok.line + ', Spalte ' + tok.col + ':\nPLS-00103: Fand das Symbol "' + sym + '"' + (detail ? ' (' + detail + ')' : ''));
    } else if (num) {
      e = oraErr(num);
      if (detail && num !== '00907' && num !== '00936') e.message += ' – ' + detail;
    } else {
      e = tok.t === T_EOF ? oraErr('00921') : oraErr('00933');
      e.message += ' (bei "' + sym + '"' + (detail ? '; ' + detail : '') + ')';
    }
    e.line = tok.line; e.col = tok.col; e.parse = true;
    if (detail && detail.includes('Erwartet: ";"') && tok.nl) e.hint = 'Vermutlich fehlt am Ende der vorherigen Zeile ein Semikolon.';
    else if (detail === 'Erwartet: "("' && tok.t === T_ID) e.hint = null;
    throw e;
  }
  textFrom(startPos) { return this.src.slice(startPos, this.lastEnd); }

  // ---------- Skript ----------
  parseScript() {
    const out = [];
    while (true) {
      while (this.isOp(';') || this.cur.t === T_SLASH) this.next();
      if (this.cur.t === T_EOF) break;
      const st = this.cur;
      const isPl = this.startsPlsql();
      this.plsql = false;
      let item = { start: st.pos, line: st.line, pl: isPl };
      try {
        const stmt = this.parseTopStatement(isPl);
        item.stmt = stmt;
        item.end = this.lastEnd;
        if (!isPl && !stmt.sqlplus) {
          if (this.isOp(';')) this.next();
          else if (this.cur.t === T_SLASH) this.next();
          else if (this.cur.t !== T_EOF) this.err(null);
        } else if (isPl) {
          if (this.cur.t === T_SLASH) this.next();
        }
      } catch (e) {
        if (!(e instanceof OraError)) throw e;
        item.error = e;
        // Recovery
        if (e.skipLine) { while (this.cur.t !== T_EOF && this.cur.line === st.line) this.next(); item.end = this.lastEnd; item.text = this.src.slice(item.start, item.end); out.push(item); continue; }
        if (isPl) { while (this.cur.t !== T_EOF && this.cur.t !== T_SLASH) this.next(); }
        else { while (this.cur.t !== T_EOF && !this.isOp(';') && this.cur.t !== T_SLASH) this.next(); }
        item.end = this.cur.t === T_EOF ? this.src.length : this.cur.pos;
        if (this.cur.t !== T_EOF) this.next();
      }
      item.text = this.src.slice(item.start, item.end);
      if (item.stmt) item.stmt.srcText = item.text, item.stmt.srcLine = item.line;
      out.push(item);
    }
    return out;
  }
  startsPlsql() {
    if (this.isKwAny(['DECLARE', 'BEGIN']) || this.isOp('<<')) return true;
    if (this.isKw('CREATE')) {
      let k = 1;
      if (this.isKw('OR', k) && this.isKw('REPLACE', k + 1)) k += 2;
      while (this.isKwAny(['EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING'], k)) k++;
      if (this.isKwAny(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'TYPE'], k)) return true;
    }
    return false;
  }
  parseTopStatement(isPl) {
    const t = this.cur;
    if (t.t === T_ID && !t.quoted) {
      switch (t.u) {
        case 'SET': return this.parseSqlplusLine('set');
        case 'DESC': case 'DESCRIBE': { this.next(); const n = this.parseObjName(); this.restOfLine(); return { k: 'desc', name: n, sqlplus: true, ln: t.line }; }
        case 'PROMPT': case 'REM': case 'REMARK': {
          const ln = t.line; this.next();
          let end = this.src.indexOf('\n', t.end); if (end < 0) end = this.src.length;
          const txt = this.src.slice(t.end, end).trim();
          while (this.cur.t !== T_EOF && this.cur.line === ln) this.next();
          this.lastEnd = end;
          return { k: t.u === 'PROMPT' ? 'prompt' : 'noop', text: txt, sqlplus: true, ln };
        }
        case 'SHOW': return this.parseSqlplusLine('show');
        case 'CLEAR': case 'SPOOL': case 'COLUMN': case 'COL': case 'TTITLE': case 'BREAK': case 'COMPUTE': case 'WHENEVER': case 'CONNECT': case 'CONN': case 'TIMING': case 'PAUSE': case 'ACCEPT': case 'DEFINE': case 'UNDEFINE': case 'VARIABLE': case 'VAR': case 'PRINT':
          return this.parseSqlplusLine('ignore');
        case 'EXEC': case 'EXECUTE': {
          if (this.isKw('IMMEDIATE', 1)) break;
          const ln = t.line; this.next();
          this.plsql = true;
          const stmts = [];
          const s = this.parseSimpleStmtNoSemi();
          stmts.push(s);
          return { k: 'block', decls: [], body: stmts, handlers: [], ln, exec: true };
        }
        case 'CALL': {
          const ln = t.line; this.next(); this.plsql = true;
          const e = this.parsePostfix();
          this.plsql = false;
          return { k: 'block', decls: [], body: [{ k: 'callp', e, ln }], handlers: [], ln, exec: true };
        }
      }
    }
    if (isPl) { this.plsql = true; }
    return this.parseStatement();
  }
  restOfLine() { const ln = this.peek(-1) ? this.toks[this.i - 1].line : this.cur.line; while (this.cur.t !== T_EOF && !this.cur.nl && !this.isOp(';')) this.next(); if (this.isOp(';')) this.next(); }
  parseSqlplusLine(kind) {
    const t = this.next(); const words = [t.u];
    while (this.cur.t !== T_EOF && !this.cur.nl && !this.isOp(';')) { const x = this.next(); words.push(x.t === T_ID ? x.u : String(x.v)); }
    if (this.isOp(';')) this.next();
    return { k: 'sqlplus', kind, words, sqlplus: true, ln: t.line };
  }
  parseSimpleStmtNoSemi() {
    const ln = this.cur.line;
    const e = this.parsePostfix();
    if (this.acceptOp(':=')) { const v = this.parseExpr(); return { k: 'assign', target: e, e: v, ln }; }
    return { k: 'callp', e, ln };
  }
  parseObjName() {
    let n = this.ident();
    if (this.acceptOp('.')) n = this.ident();
    return n;
  }

  parseStatement() {
    const t = this.cur;
    if (t.t === T_OP && t.v === '(') return this.parseQueryStmt();
    if (t.t === T_OP && t.v === '<<') return this.parseBlock();
    if (t.t !== T_ID) this.err(this.plsql ? null : '00900');
    if (!this.plsql && ['FOR', 'IF', 'LOOP', 'WHILE', 'DBMS_OUTPUT', 'RETURN', 'RAISE', 'EXIT'].includes(t.u)) {
      const e = oraErr('00900'); e.hint = 'PL/SQL-Anweisungen wie ' + t.u + ' müssen in einem Block stehen: BEGIN ... END; (danach eine Zeile mit /).'; e.line = t.line; e.col = t.col; e.parse = true; throw e;
    }
    if (!this.plsql && ['DELIMITER', 'USE', 'SHOW'].includes(t.u) || (t.u === 'DROP' && this.isKw('DATABASE', 1))) {
      const hints = { DELIMITER: 'DELIMITER gibt es in Oracle nicht. PL/SQL-Blöcke, Prozeduren und Trigger schließt du mit einer eigenen Zeile / ab.', USE: 'In Oracle arbeitest du immer im eigenen Schema (hier STUDENT) – USE entfällt.', SHOW: 'Tabellen anzeigen: SELECT table_name FROM user_tables; – oder links im Objekt-Browser.', DROP: 'Datenbanken werden in Oracle nicht so verwaltet.' };
      const e = oraErr('00900'); e.hint = hints[t.u]; e.line = t.line; e.col = t.col; e.parse = true; e.skipLine = true; throw e;
    }
    if (!this.plsql && this.isOp(':=', 1)) { const e = oraErr('00900'); e.hint = 'Zuweisungen gibt es nur in PL/SQL – innerhalb von BEGIN ... END;'; e.line = t.line; e.col = t.col; e.parse = true; throw e; }
    switch (t.u) {
      case 'SELECT': case 'WITH': return this.parseQueryStmt();
      case 'INSERT': return this.parseInsert();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'MERGE': return this.parseMerge();
      case 'CREATE': return this.parseCreate();
      case 'DROP': return this.parseDrop();
      case 'ALTER': return this.parseAlter();
      case 'TRUNCATE': { this.next(); this.expectKw('TABLE'); const n = this.parseObjName(); while (this.isKwAny(['DROP', 'REUSE', 'STORAGE', 'CASCADE'])) this.next(); return { k: 'truncate', name: n, ln: t.line }; }
      case 'RENAME': { this.next(); const a = this.ident(); this.expectKw('TO'); const b = this.ident(); return { k: 'rename', from: a, to: b, ln: t.line }; }
      case 'COMMIT': { this.next(); this.accept1('WORK'); return { k: 'commit', ln: t.line }; }
      case 'ROLLBACK': { this.next(); this.accept1('WORK'); let to = null; if (this.accept1('TO')) { this.accept1('SAVEPOINT'); to = this.ident(); } return { k: 'rollback', to, ln: t.line }; }
      case 'SAVEPOINT': { this.next(); return { k: 'savepoint', name: this.ident(), ln: t.line }; }
      case 'DECLARE': case 'BEGIN': return this.parseBlock();
      case 'COMMENT': return this.parseComment();
      case 'GRANT': case 'REVOKE': case 'AUDIT': case 'NOAUDIT': case 'ANALYZE': case 'PURGE': case 'FLASHBACK': case 'LOCK': {
        this.next(); while (this.cur.t !== T_EOF && !this.isOp(';') && this.cur.t !== T_SLASH) this.next();
        return { k: 'noop', what: t.u, ln: t.line };
      }
      case 'EXPLAIN': this.err('00900', 'EXPLAIN PLAN wird nicht unterstützt');
    }
    this.err('00900');
  }
  parseComment() {
    const ln = this.cur.line; this.next(); this.expectKw('ON');
    const kind = this.ident();
    let name = this.ident(), col = null;
    if (this.acceptOp('.')) { col = this.ident(); if (this.acceptOp('.')) { name = col; col = this.ident(); } }
    this.expectKw('IS');
    const s = this.cur; if (s.t !== T_STR) this.err(null, 'Zeichenfolge erwartet'); this.next();
    return { k: 'comment', kind, table: name, col, text: s.v, ln };
  }

  // ---------- Queries ----------
  parseQueryStmt() {
    const ln = this.cur.line;
    const q = this.parseQuery(true);
    return { k: 'query', q, ln };
  }
  parseQuery(allowInto) {
    let withs = null;
    if (this.accept1('WITH')) {
      withs = [];
      do {
        const name = this.ident(); let cols = null;
        if (this.acceptOp('(')) { cols = []; do cols.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); }
        this.expectKw('AS'); this.expectOp('(');
        const q = this.parseQuery(); this.expectOp(')');
        withs.push({ name, cols, q });
      } while (this.acceptOp(','));
    }
    let q = this.parseQueryTerm(allowInto);
    while (true) {
      let op = null;
      if (this.accept1('UNION')) op = this.accept1('ALL') ? 'UNION ALL' : 'UNION';
      else if (this.accept1('INTERSECT')) op = 'INTERSECT';
      else if (this.accept1('MINUS') || this.accept1('EXCEPT')) op = 'MINUS';
      if (!op) break;
      const r = this.parseQueryTerm(false);
      q = { k: 'setop', op, l: q, r };
    }
    this.parseOrderFetch(q);
    if (this.isKw('FOR') && this.isKw('UPDATE', 1)) {
      this.next(); this.next();
      if (this.accept1('OF')) { do this.parseColRef(); while (this.acceptOp(',')); }
      if (this.accept1('NOWAIT')) { } else if (this.accept1('WAIT')) this.next(); else if (this.accept1('SKIP')) this.expectKw('LOCKED');
      q.forUpdate = true;
    }
    if (withs) q.with = withs;
    return q;
  }
  parseOrderFetch(q) {
    if (this.isKw('ORDER') && this.isKw('SIBLINGS', 1)) {
      this.next(); this.next(); this.expectKw('BY');
      q.siblings = this.parseOrderList();
    }
    if (this.isKw('ORDER') && this.isKw('BY', 1)) {
      if (q.orderBy) this.err(null);
      this.next(); this.next();
      q.orderBy = this.parseOrderList();
    }
    if (this.isKw('OFFSET')) {
      this.next(); q.offset = this.parseExpr(); this.accept1('ROWS') || this.accept1('ROW');
    }
    if (this.isKw('FETCH')) {
      this.next(); if (!this.accept1('FIRST')) this.expectKw('NEXT');
      let n = { k: 'num', v: 1 };
      if (!this.isKwAny(['ROW', 'ROWS'])) n = this.parseAdditive();
      const pct = this.accept1('PERCENT');
      if (!this.accept1('ROWS')) this.expectKw('ROW');
      let ties = false;
      if (this.accept1('WITH')) { this.expectKw('TIES'); ties = true; } else this.expectKw('ONLY');
      q.fetch = { n, pct, ties };
    }
    if (this.isKw('LIMIT')) { const e = oraErr('00933'); e.hint = 'LIMIT gibt es in Oracle nicht. Nutze FETCH FIRST n ROWS ONLY oder WHERE ROWNUM <= n.'; e.line = this.cur.line; e.col = this.cur.col; e.parse = true; throw e; }
  }
  parseOrderList() {
    const list = [];
    do {
      const e = this.parseExpr();
      let desc = false;
      if (this.accept1('DESC')) desc = true; else this.accept1('ASC');
      let nulls = null;
      if (this.accept1('NULLS')) { if (this.accept1('FIRST')) nulls = 'FIRST'; else { this.expectKw('LAST'); nulls = 'LAST'; } }
      list.push({ e, desc, nulls });
    } while (this.acceptOp(','));
    return list;
  }
  parseQueryTerm(allowInto) {
    if (this.isOp('(')) {
      this.next(); const q = this.parseQuery(); this.expectOp(')'); return q;
    }
    return this.parseSelectCore(allowInto);
  }
  parseSelectCore(allowInto) {
    const ln = this.cur.line;
    if (!this.accept1('SELECT')) this.err('00928');
    const q = { k: 'select', ln, cols: [], from: [] };
    if (this.accept1('DISTINCT') || this.accept1('UNIQUE')) q.distinct = true; else this.accept1('ALL');
    do q.cols.push(this.parseSelectItem()); while (this.acceptOp(','));
    if (this.isKw('BULK')) { this.next(); this.expectKw('COLLECT'); this.expectKw('INTO'); q.bulk = true; q.into = this.parseTargets(); }
    else if (this.accept1('INTO')) { q.into = this.parseTargets(); }
    if (this.accept1('FROM')) {
      do q.from.push(this.parseFromItem()); while (this.acceptOp(','));
    } else if (!this.isOp(';') && this.cur.t !== T_EOF && !this.isOp(')') && this.cur.t !== T_SLASH && !this.isKwAny(['UNION', 'MINUS', 'INTERSECT', 'ORDER', 'WHERE'])) {
      this.err('00923');
    }
    if (this.accept1('WHERE')) q.where = this.parseExpr();
    if (this.isKw('START') || this.isKw('CONNECT')) {
      // hierarchische Abfragen
      for (let r = 0; r < 2; r++) {
        if (this.accept1('START')) { this.expectKw('WITH'); q.startWith = this.parseExpr(); }
        if (this.accept1('CONNECT')) { this.expectKw('BY'); q.nocycle = this.accept1('NOCYCLE'); q.connectBy = this.parseExpr(); }
      }
    }
    for (let r = 0; r < 2; r++) {
      if (this.isKw('GROUP') && this.isKw('BY', 1)) {
        this.next(); this.next(); q.groupBy = [];
        if (this.isKwAny(['ROLLUP', 'CUBE', 'GROUPING'])) {
          const kind = this.next().u; if (kind === 'GROUPING') this.expectKw('SETS');
          this.expectOp('('); do q.groupBy.push(this.parseExpr()); while (this.acceptOp(',')); this.expectOp(')');
          q.rollup = kind;
        } else {
          do q.groupBy.push(this.parseExpr()); while (this.acceptOp(','));
        }
      }
      if (this.accept1('HAVING')) q.having = this.parseExpr();
    }
    return q;
  }
  parseTargets() {
    const t = [];
    do t.push(this.parsePostfix()); while (this.acceptOp(','));
    return t;
  }
  parseSelectItem() {
    const st = this.cur;
    if (this.acceptOp('*')) return { star: true };
    if (this.isId() && this.isOp('.', 1) && this.isOp('*', 2)) {
      const t = this.ident(); this.next(); this.next();
      return { star: true, table: t };
    }
    const e = this.parseExpr();
    const txt = this.textFrom(st.pos);
    let alias = null;
    if (this.accept1('AS')) alias = this.ident();
    else if (this.cur.t === T_ID && (this.cur.quoted || !RESERVED.has(this.cur.u))) alias = this.ident();
    return { e, alias, txt };
  }
  parseFromItem() {
    let l = this.parseTableRef();
    while (true) {
      let type = null, natural = false;
      if (this.accept1('NATURAL')) natural = true;
      if (this.accept1('JOIN')) type = 'INNER';
      else if (this.isKw('INNER') && this.isKw('JOIN', 1)) { this.next(); this.next(); type = 'INNER'; }
      else if (this.isKwAny(['LEFT', 'RIGHT', 'FULL'])) {
        type = this.next().u; this.accept1('OUTER'); this.expectKw('JOIN');
      } else if (this.isKw('CROSS') && this.isKw('JOIN', 1)) { this.next(); this.next(); type = 'CROSS'; }
      else if (natural) this.err(null, 'JOIN erwartet');
      if (!type) break;
      const r = this.parseTableRef();
      const j = { k: 'join', type, natural, l, r };
      if (type !== 'CROSS' && !natural) {
        if (this.accept1('ON')) j.on = this.parseExpr();
        else if (this.accept1('USING')) {
          this.expectOp('('); j.using = []; do j.using.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')');
        } else this.err('00905', 'ON oder USING erwartet');
      }
      l = j;
    }
    return l;
  }
  parseTableRef() {
    if (this.isOp('(')) {
      if (this.isKwAny(['SELECT', 'WITH'], 1) || (this.isOp('(', 1))) {
        this.next(); const q = this.parseQuery(); this.expectOp(')');
        const alias = this.parseTableAlias();
        return { k: 'subq', q, alias };
      }
      this.next(); const j = this.parseFromItem(); this.expectOp(')'); return j;
    }
    if (this.isKw('LATERAL')) { this.next(); return this.parseTableRef(); }
    if (this.isKw('TABLE') && this.isOp('(', 1)) {
      this.next(); this.next(); const e = this.parseExpr(); this.expectOp(')');
      return { k: 'tabfn', e, alias: this.parseTableAlias() };
    }
    const st = this.cur;
    let name = this.ident();
    if (this.acceptOp('.')) name = this.ident();
    if (this.acceptOp('@')) this.ident();
    const alias = this.parseTableAlias();
    return { k: 'tbl', name, alias, line: st.line, col: st.col };
  }
  parseTableAlias() {
    if (this.isKw('AS')) {
      const e = oraErr('00933'); e.hint = 'In Oracle steht vor einem Tabellen-Alias kein AS: FROM kunden k';
      e.line = this.cur.line; e.col = this.cur.col; e.parse = true; throw e;
    }
    if (this.cur.t === T_ID && (this.cur.quoted || !RESERVED.has(this.cur.u))) return this.ident();
    return null;
  }

  // ---------- Ausdrücke ----------
  parseExpr() { return this.parseOr(); }
  parseOr() {
    let l = this.parseAnd();
    while (this.accept1('OR')) l = { k: 'or', l, r: this.parseAnd() };
    return l;
  }
  parseAnd() {
    let l = this.parseNot();
    while (this.accept1('AND')) l = { k: 'and', l, r: this.parseNot() };
    return l;
  }
  parseNot() {
    if (this.accept1('NOT')) return { k: 'not', e: this.parseNot() };
    return this.parsePredicate();
  }
  parsePredicate() {
    if (this.isKw('EXISTS')) { this.next(); this.expectOp('('); const q = this.parseQuery(); this.expectOp(')'); return { k: 'exists', q }; }
    const l = this.parseAdditive();
    const t = this.cur;
    if (t.t === T_OP && ['=', '<>', '!=', '^=', '~=', '<', '>', '<=', '>='].includes(t.v)) {
      this.next();
      let op = t.v; if (op === '!=' || op === '^=' || op === '~=') op = '<>';
      if (this.isKwAny(['ANY', 'SOME', 'ALL'])) {
        const qt = this.next().u === 'ALL' ? 'ALL' : 'ANY';
        this.expectOp('(');
        let node;
        if (this.isKwAny(['SELECT', 'WITH'])) { node = { k: 'cmpq', op, q: qt, l, sub: this.parseQuery() }; }
        else { const list = []; do list.push(this.parseExpr()); while (this.acceptOp(',')); node = { k: 'cmpq', op, q: qt, l, list }; }
        this.expectOp(')');
        return node;
      }
      return { k: 'cmp', op, l, r: this.parseAdditive() };
    }
    if (this.isKw('IS')) {
      this.next(); const not = this.accept1('NOT');
      if (this.accept1('NULL')) return { k: 'isnull', e: l, not };
      if (this.accept1('EMPTY')) return { k: 'isempty', e: l, not };
      if (this.accept1('TRUE')) return { k: 'istrue', e: l, v: true, not };
      if (this.accept1('FALSE')) return { k: 'istrue', e: l, v: false, not };
      this.err('00908' in ORA_MSG ? '00908' : null, 'NULL erwartet');
    }
    let not = false;
    if (this.isKw('NOT') && this.isKwAny(['LIKE', 'BETWEEN', 'IN'], 1)) { this.next(); not = true; }
    if (this.accept1('LIKE')) {
      const pat = this.parseAdditive(); let esc = null;
      if (this.accept1('ESCAPE')) esc = this.parseAdditive();
      return { k: 'like', e: l, pat, esc, not };
    }
    if (this.accept1('BETWEEN')) {
      const lo = this.parseAdditive(); this.expectKw('AND'); const hi = this.parseAdditive();
      return { k: 'between', e: l, lo, hi, not };
    }
    if (this.accept1('IN')) {
      if (!this.isOp('(')) {
        // IN ohne Klammer (einzelner Wert)
        return { k: 'in', e: l, list: [this.parseAdditive()], not };
      }
      this.next();
      if (this.isKwAny(['SELECT', 'WITH'])) { const q = this.parseQuery(); this.expectOp(')'); return { k: 'in', e: l, q, not }; }
      const list = []; do list.push(this.parseExpr()); while (this.acceptOp(','));
      this.expectOp(')');
      return { k: 'in', e: l, list, not };
    }
    if (not) this.err(null);
    return l;
  }
  parseAdditive() {
    let l = this.parseMul();
    while (true) {
      const t = this.cur;
      if (t.t === T_OP && (t.v === '+' || t.v === '-' || t.v === '||')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.parseMul() }; }
      else break;
    }
    return l;
  }
  parseMul() {
    let l = this.parseUnary();
    while (true) {
      const t = this.cur;
      if (t.t === T_OP && (t.v === '*' || t.v === '/')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.parseUnary() }; }
      else if (this.isKw('MOD') && this.plsql && !this.isOp('(', 1)) { this.next(); l = { k: 'bin', op: 'MOD', l, r: this.parseUnary() }; }
      else break;
    }
    return l;
  }
  parseUnary() {
    if (this.acceptOp('-')) return { k: 'neg', e: this.parseUnary() };
    if (this.acceptOp('+')) return this.parseUnary();
    if (this.isKw('PRIOR')) { this.next(); return { k: 'prior', e: this.parseUnary() }; }
    if (this.isKw('CONNECT_BY_ROOT')) { this.next(); return { k: 'cbroot', e: this.parseUnary() }; }
    let l = this.parsePostfix();
    if (this.acceptOp('**')) l = { k: 'bin', op: '**', l, r: this.parseUnary() };
    return l;
  }
  parseArgs() {
    // nach '('
    const args = [];
    if (this.acceptOp(')')) return args;
    do {
      if (this.isId() && this.isOp('=>', 1)) { const name = this.ident(); this.next(); args.push({ named: name, e: this.parseExpr() }); }
      else args.push(this.parseExpr());
    } while (this.acceptOp(','));
    this.expectOp(')');
    return args;
  }
  parsePostfix() {
    const t = this.cur;
    let node = this.parsePrimary();
    while (true) {
      if (this.isOp('.') && (this.peek(1).t === T_ID)) {
        this.next(); const n = this.ident();
        if (node.k === 'id') node.parts.push(n);
        else node = { k: 'member', obj: node, name: n };
        continue;
      }
      if (this.isOp('(') && this.isOp('+', 1) && this.isOp(')', 2) && node.k === 'id') {
        this.next(); this.next(); this.next(); node.outer = true; continue;
      }
      if (this.isOp('(') && (node.k === 'id' || node.k === 'call' || node.k === 'member' || node.k === 'callx')) {
        this.next();
        if (node.k === 'id') {
          const name = node.parts;
          node = this.parseCallRest(name, t);
        } else {
          node = { k: 'callx', obj: node, args: this.parseArgs() };
        }
        continue;
      }
      if (this.isOp('%') && this.peek(1).t === T_ID && ['FOUND', 'NOTFOUND', 'ROWCOUNT', 'ISOPEN', 'BULK_ROWCOUNT'].includes(this.peek(1).u)) {
        this.next(); const a = this.next().u;
        node = { k: 'attr', of: node, attr: a };
        continue;
      }
      break;
    }
    return node;
  }
  parseCallRest(nameParts, t) {
    const fname = nameParts.length === 1 ? nameParts[0] : null;
    if (fname && (AGG_FUNCS.has(fname) || WIN_ONLY.has(fname))) {
      const node = { k: 'agg', fn: fname, args: [] };
      if (this.acceptOp('*')) { node.star = true; this.expectOp(')'); }
      else if (this.acceptOp(')')) { }
      else {
        if (this.accept1('DISTINCT') || this.accept1('UNIQUE')) node.distinct = true; else this.accept1('ALL');
        do node.args.push(this.parseExpr()); while (this.acceptOp(','));
        if (this.accept1('IGNORE')) { this.expectKw('NULLS'); node.ignoreNulls = true; }
        this.expectOp(')');
      }
      if (this.accept1('IGNORE')) { this.expectKw('NULLS'); node.ignoreNulls = true; }
      if (this.isKw('WITHIN')) {
        this.next(); this.expectKw('GROUP'); this.expectOp('('); this.expectKw('ORDER'); this.expectKw('BY');
        node.within = this.parseOrderList(); this.expectOp(')');
      }
      if (this.accept1('OVER')) {
        this.expectOp('(');
        const w = { partition: [], order: null, frame: null };
        if (this.accept1('PARTITION')) { this.expectKw('BY'); do w.partition.push(this.parseExpr()); while (this.acceptOp(',')); }
        if (this.isKw('ORDER')) { this.next(); this.expectKw('BY'); w.order = this.parseOrderList(); }
        if (this.isKwAny(['ROWS', 'RANGE'])) {
          const unit = this.next().u;
          const bound = () => {
            if (this.accept1('UNBOUNDED')) { const d = this.next().u; return { u: true, d }; }
            if (this.accept1('CURRENT')) { this.expectKw('ROW'); return { cur: true }; }
            const n = this.parseAdditive(); const d = this.next().u; return { n, d };
          };
          if (this.accept1('BETWEEN')) { const s = bound(); this.expectKw('AND'); const e = bound(); w.frame = { unit, s, e }; }
          else w.frame = { unit, s: bound(), e: { cur: true } };
        }
        this.expectOp(')');
        node.over = w;
      } else if (WIN_ONLY.has(fname)) {
        this.err('00905', 'OVER(...) erwartet – ' + fname + ' ist eine analytische Funktion');
      }
      return node;
    }
    const args = this.parseArgs();
    return { k: 'call', name: nameParts, args, line: t.line };
  }
  parsePrimary() {
    const t = this.cur;
    if (t.t === T_NUM) { this.next(); return { k: 'num', v: t.v }; }
    if (t.t === T_STR) { this.next(); return t.v === '' ? { k: 'null' } : { k: 'str', v: t.v }; }
    if (t.t === T_BIND) { this.next(); return { k: 'id', parts: [t.v], line: t.line, col: t.col }; }
    if (t.t === T_OP && t.v === '(') {
      this.next();
      if (this.isKwAny(['SELECT', 'WITH'])) { const q = this.parseQuery(); this.expectOp(')'); return { k: 'subq', q }; }
      const e = this.parseExpr();
      if (this.acceptOp(',')) {
        const items = [e]; do items.push(this.parseExpr()); while (this.acceptOp(','));
        this.expectOp(')');
        return { k: 'tuple', items };
      }
      this.expectOp(')');
      return { k: 'paren', e };
    }
    if (t.t === T_ID && !t.quoted) {
      switch (t.u) {
        case 'NULL': this.next(); return { k: 'null' };
        case 'TRUE': this.next(); return { k: 'bool', v: true };
        case 'FALSE': this.next(); return { k: 'bool', v: false };
        case 'DATE': if (this.peek(1).t === T_STR) { this.next(); const s = this.next(); return { k: 'dlit', v: s.v, ts: false }; } break;
        case 'TIMESTAMP': if (this.peek(1).t === T_STR) { this.next(); const s = this.next(); return { k: 'dlit', v: s.v, ts: true }; } break;
        case 'INTERVAL': if (this.peek(1).t === T_STR) {
          this.next(); const s = this.next(); const unit = this.next().u;
          if (this.acceptOp('(')) { this.parseExpr(); this.expectOp(')'); }
          let unit2 = null; if (this.accept1('TO')) unit2 = this.next().u;
          return { k: 'interval', v: s.v, unit, unit2 };
        } break;
        case 'CASE': return this.parseCaseExpr();
        case 'CAST': if (this.isOp('(', 1)) {
          this.next(); this.next(); const e = this.parseExpr(); this.expectKw('AS'); const type = this.parseType(); this.expectOp(')');
          return { k: 'cast', e, type };
        } break;
        case 'EXTRACT': if (this.isOp('(', 1)) {
          this.next(); this.next(); const unit = this.next().u; this.expectKw('FROM'); const e = this.parseExpr(); this.expectOp(')');
          return { k: 'call', name: ['EXTRACT'], args: [{ k: 'str', v: unit }, e], line: t.line };
        } break;
        case 'TRIM': if (this.isOp('(', 1)) {
          this.next(); this.next();
          let mode = 'BOTH', ch = null;
          if (this.isKwAny(['LEADING', 'TRAILING', 'BOTH'])) mode = this.next().u;
          let e = null;
          if (!this.isKw('FROM')) e = this.parseExpr();
          if (this.accept1('FROM')) { ch = e; e = this.parseExpr(); }
          this.expectOp(')');
          return { k: 'call', name: ['TRIM'], args: [e, ch || { k: 'null' }, { k: 'str', v: mode }], line: t.line, trim: true };
        } break;
        case 'SQL': if (this.isOp('%', 1)) { this.next(); this.next(); const a = this.next().u; return { k: 'attr', of: { k: 'id', parts: ['SQL'] }, attr: a, sql: true }; } break;
        case 'NEW': case 'OLD': break;
      }
      if (RESERVED.has(t.u) && !['PRIOR', 'REPLACE'].includes(t.u) && !(t.u === 'LEFT' || t.u === 'RIGHT') ) {
        if (!(this.isOp('(', 1) && ['LEFT', 'RIGHT', 'REPLACE'].includes(t.u))) this.err(this.plsql ? null : '00936');
      }
    }
    if (t.t === T_ID) {
      this.next();
      return { k: 'id', parts: [t.quoted ? t.v : t.u], quoted: !!t.quoted, line: t.line, col: t.col };
    }
    if (t.t === T_OP && t.v === '*') this.err('00936');
    this.err(this.plsql ? null : '00936');
  }
  parseCaseExpr() {
    this.next();
    const node = { k: 'case', whens: [] };
    if (!this.isKw('WHEN')) node.base = this.parseExpr();
    while (this.accept1('WHEN')) {
      const w = this.parseExpr(); this.expectKw('THEN'); const th = this.parseExpr();
      node.whens.push({ w, t: th });
    }
    if (!node.whens.length) this.err('00905', 'WHEN erwartet');
    if (this.accept1('ELSE')) node.else = this.parseExpr();
    this.expectKw('END');
    return node;
  }

  // ---------- Typen ----------
  parseType() {
    const st = this.cur;
    const name = this.ident();
    const T = (b, extra) => Object.assign({ b }, extra || {});
    const num = () => { const t = this.cur; if (t.t !== T_NUM && !this.isOp('*')) this.err(null, 'Zahl erwartet'); this.next(); return t.t === T_NUM ? t.v : 38; };
    let r;
    switch (name) {
      case 'NUMBER': case 'NUMERIC': case 'DECIMAL': case 'DEC': {
        let p = null, s = null;
        if (this.acceptOp('(')) { p = num(); if (this.acceptOp(',')) { const neg = this.acceptOp('-'); s = num(); if (neg) s = -s; } this.expectOp(')'); }
        if (name !== 'NUMBER' && p !== null && s === null) s = 0;
        r = T('NUMBER', { p, s }); break;
      }
      case 'INTEGER': case 'INT': case 'SMALLINT': r = T('NUMBER', { p: 38, s: 0, int: true }); break;
      case 'FLOAT': case 'REAL': case 'BINARY_FLOAT': case 'BINARY_DOUBLE':
        if (this.acceptOp('(')) { num(); this.expectOp(')'); } r = T('NUMBER', { fl: name }); break;
      case 'DOUBLE': this.expectKw('PRECISION'); r = T('NUMBER', { fl: 'DOUBLE PRECISION' }); break;
      case 'PLS_INTEGER': case 'BINARY_INTEGER': case 'NATURAL': case 'NATURALN': case 'POSITIVE': case 'POSITIVEN': case 'SIGNTYPE': case 'SIMPLE_INTEGER':
        r = T('PLS_INTEGER', { sub: name }); break;
      case 'VARCHAR2': case 'VARCHAR': case 'NVARCHAR2': case 'STRING': case 'RAW': {
        let len = null;
        if (this.acceptOp('(')) { len = num(); this.accept1('BYTE') || this.accept1('CHAR'); this.expectOp(')'); }
        r = T('VARCHAR2', { len, orig: name === 'RAW' ? 'RAW' : (name === 'NVARCHAR2' ? 'NVARCHAR2' : 'VARCHAR2') }); break;
      }
      case 'CHAR': case 'NCHAR': case 'CHARACTER': {
        if (this.isKw('VARYING')) { this.next(); let len = null; if (this.acceptOp('(')) { len = num(); this.expectOp(')'); } r = T('VARCHAR2', { len }); break; }
        let len = 1; if (this.acceptOp('(')) { len = num(); this.accept1('BYTE') || this.accept1('CHAR'); this.expectOp(')'); }
        r = T('CHAR', { len }); break;
      }
      case 'LONG': if (this.isKw('RAW')) this.next(); r = T('CLOB', { orig: 'LONG' }); break;
      case 'CLOB': case 'NCLOB': case 'BLOB': case 'XMLTYPE': case 'JSON': r = T('CLOB', { orig: name }); break;
      case 'DATE': r = T('DATE'); break;
      case 'TIMESTAMP': {
        if (this.acceptOp('(')) { num(); this.expectOp(')'); }
        if (this.accept1('WITH')) { this.accept1('LOCAL'); this.expectKw('TIME'); this.expectKw('ZONE'); }
        r = T('TIMESTAMP'); break;
      }
      case 'BOOLEAN': case 'BOOL': r = T('BOOLEAN'); break;
      case 'ROWID': case 'UROWID': r = T('VARCHAR2', { len: 18, orig: 'ROWID' }); break;
      case 'SYS_REFCURSOR': r = T('REFCURSOR'); break;
      case 'INTERVAL': {
        const u = this.next().u; if (this.acceptOp('(')) { num(); this.expectOp(')'); } this.expectKw('TO'); this.next(); if (this.acceptOp('(')) { num(); this.expectOp(')'); }
        r = T('INTERVAL', { unit: u }); break;
      }
      default: {
        const parts = [name];
        while (this.acceptOp('.')) parts.push(this.ident());
        if (this.isOp('%')) {
          this.next(); const a = this.next().u;
          if (a === 'TYPE') r = { ref: 'TYPE', parts };
          else if (a === 'ROWTYPE') r = { ref: 'ROWTYPE', parts };
          else this.err(null, '%TYPE oder %ROWTYPE erwartet');
        } else r = { named: parts };
      }
    }
    r.txt = this.textFrom(st.pos).replace(/\s+/g, ' ').toUpperCase();
    return r;
  }

  // ---------- DML ----------
  parseInsert() {
    const ln = this.cur.line; this.next();
    if (this.isKwAny(['ALL', 'FIRST'])) return this.parseInsertAll(ln);
    this.expectKw('INTO');
    const st = this.cur;
    const table = this.parseObjName();
    let alias = null; if (this.cur.t === T_ID && !RESERVED.has(this.cur.u)) alias = this.ident();
    let cols = null;
    if (this.isOp('(') && !this.isKwAny(['SELECT', 'WITH'], 1)) {
      this.next(); cols = []; do cols.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')');
    }
    const node = { k: 'insert', table, alias, cols, ln, tline: st.line, tcol: st.col };
    if (this.accept1('VALUES')) {
      if (!this.isOp('(')) { node.valuesRec = this.parsePostfix(); }
      else {
        this.next(); node.values = [];
        if (!this.isOp(')')) { do node.values.push(this.parseExpr()); while (this.acceptOp(',')); }
        this.expectOp(')');
        if (this.isOp(',') && this.isOp('(', 1)) {
          // Mehrzeiliges VALUES (Oracle 23ai)
          node.multi = [node.values];
          while (this.acceptOp(',')) { this.expectOp('('); const v = []; do v.push(this.parseExpr()); while (this.acceptOp(',')); this.expectOp(')'); node.multi.push(v); }
        }
      }
    } else if (this.isKwAny(['SELECT', 'WITH']) || this.isOp('(')) {
      node.query = this.parseQuery();
    } else this.err('00926');
    this.parseReturning(node);
    return node;
  }
  parseInsertAll(ln) {
    const mode = this.next().u;
    const intos = [];
    const parseInto = (cond) => {
      this.expectKw('INTO'); const table = this.parseObjName();
      let cols = null;
      if (this.isOp('(')) { this.next(); cols = []; do cols.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); }
      let values = null;
      if (this.accept1('VALUES')) { this.expectOp('('); values = []; do values.push(this.parseExpr()); while (this.acceptOp(',')); this.expectOp(')'); }
      intos.push({ table, cols, values, cond });
    };
    if (this.isKw('WHEN')) {
      while (this.accept1('WHEN')) { const c = this.parseExpr(); this.expectKw('THEN'); while (this.isKw('INTO')) parseInto(c); }
      if (this.accept1('ELSE')) while (this.isKw('INTO')) parseInto({ k: 'else' });
    } else while (this.isKw('INTO')) parseInto(null);
    const query = this.parseQuery();
    return { k: 'insertAll', mode, intos, query, ln };
  }
  parseReturning(node) {
    if (this.isKwAny(['RETURNING', 'RETURN'])) {
      this.next(); node.returning = []; do node.returning.push(this.parseExpr()); while (this.acceptOp(','));
      if (this.isKw('BULK')) { this.next(); this.expectKw('COLLECT'); node.retBulk = true; }
      this.expectKw('INTO'); node.retInto = this.parseTargets();
    }
  }
  parseUpdate() {
    const ln = this.cur.line; this.next();
    const st = this.cur;
    const table = this.parseObjName();
    let alias = null; if (this.cur.t === T_ID && !RESERVED.has(this.cur.u)) alias = this.ident();
    if (!this.accept1('SET')) this.err('00971');
    const sets = [];
    if (this.isKw('ROW') && this.isOp('=', 1)) { this.next(); this.next(); const e = this.parseExpr(); sets.push({ row: true, e }); }
    else do {
      if (this.isOp('(')) {
        this.next(); const cols = []; do cols.push(this.parseColRef()); while (this.acceptOp(',')); this.expectOp(')');
        this.expectOp('='); this.expectOp('('); const q = this.parseQuery(); this.expectOp(')');
        sets.push({ cols, q });
      } else {
        const c = this.parseColRef(); this.expectOp('='); const e = this.parseExpr();
        sets.push({ cols: [c], e });
      }
    } while (this.acceptOp(','));
    const node = { k: 'update', table, alias, sets, ln, tline: st.line, tcol: st.col };
    if (this.accept1('WHERE')) {
      if (this.isKw('CURRENT') && this.isKw('OF', 1)) { this.next(); this.next(); node.currentOf = this.ident(); }
      else node.where = this.parseExpr();
    }
    this.parseReturning(node);
    return node;
  }
  parseColRef() { let c = this.ident(); while (this.acceptOp('.')) c = this.ident(); return c; }
  parseDelete() {
    const ln = this.cur.line; this.next(); this.accept1('FROM');
    const st = this.cur;
    const table = this.parseObjName();
    let alias = null; if (this.cur.t === T_ID && !RESERVED.has(this.cur.u)) alias = this.ident();
    const node = { k: 'delete', table, alias, ln, tline: st.line, tcol: st.col };
    if (this.accept1('WHERE')) {
      if (this.isKw('CURRENT') && this.isKw('OF', 1)) { this.next(); this.next(); node.currentOf = this.ident(); }
      else node.where = this.parseExpr();
    }
    this.parseReturning(node);
    return node;
  }
  parseMerge() {
    const ln = this.cur.line; this.next(); this.expectKw('INTO');
    const table = this.parseObjName();
    let alias = null; if (this.cur.t === T_ID && !RESERVED.has(this.cur.u)) alias = this.ident();
    this.expectKw('USING');
    const src = this.parseTableRef();
    this.expectKw('ON');
    const on = this.parseExpr();
    const node = { k: 'merge', table, alias, src, on, ln };
    while (this.accept1('WHEN')) {
      if (this.accept1('MATCHED')) {
        this.expectKw('THEN'); this.expectKw('UPDATE'); this.expectKw('SET');
        const sets = [];
        do { const c = this.parseColRef(); this.expectOp('='); sets.push({ cols: [c], e: this.parseExpr() }); } while (this.acceptOp(','));
        node.upd = { sets };
        if (this.accept1('WHERE')) node.upd.where = this.parseExpr();
        if (this.accept1('DELETE')) { this.expectKw('WHERE'); node.upd.delWhere = this.parseExpr(); }
      } else {
        this.expectKw('NOT'); this.expectKw('MATCHED'); this.expectKw('THEN'); this.expectKw('INSERT');
        let cols = null;
        if (this.isOp('(')) { this.next(); cols = []; do cols.push(this.parseColRef()); while (this.acceptOp(',')); this.expectOp(')'); }
        this.expectKw('VALUES'); this.expectOp('('); const values = []; do values.push(this.parseExpr()); while (this.acceptOp(',')); this.expectOp(')');
        node.ins = { cols, values };
        if (this.accept1('WHERE')) node.ins.where = this.parseExpr();
      }
    }
    return node;
  }

  // ---------- DDL ----------
  parseCreate() {
    const ln = this.cur.line; const startPos = this.cur.pos; this.next();
    let orReplace = false;
    if (this.accept1('OR')) { this.expectKw('REPLACE'); orReplace = true; }
    while (this.isKwAny(['EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'NOFORCE'])) this.next();
    let force = false; if (this.accept1('FORCE')) force = true;
    let unique = false, temp = false;
    if (this.accept1('GLOBAL') || this.accept1('PRIVATE')) { this.expectKw('TEMPORARY'); temp = true; }
    if (this.accept1('UNIQUE') || this.accept1('BITMAP')) unique = true;
    const what = this.cur.t === T_ID ? this.cur.u : '';
    switch (what) {
      case 'TABLE': return this.parseCreateTable(ln, temp);
      case 'VIEW': case 'MATERIALIZED': {
        if (what === 'MATERIALIZED') { this.next(); }
        this.next();
        const name = this.parseObjName();
        let cols = null;
        if (this.isOp('(')) { this.next(); cols = []; do { cols.push(this.ident()); } while (this.acceptOp(',')); this.expectOp(')'); }
        while (this.isKwAny(['BUILD', 'IMMEDIATE', 'DEFERRED', 'REFRESH', 'COMPLETE', 'FAST', 'ON', 'DEMAND', 'COMMIT'])) this.next();
        this.expectKw('AS');
        const qStart = this.cur.pos;
        const q = this.parseQuery();
        const qText = this.src.slice(qStart, this.lastEnd);
        let withCheck = false, readOnly = false;
        if (this.accept1('WITH')) {
          if (this.accept1('CHECK')) { this.expectKw('OPTION'); withCheck = true; }
          else { this.expectKw('READ'); this.expectKw('ONLY'); readOnly = true; }
          if (this.accept1('CONSTRAINT')) this.ident();
        }
        return { k: 'createView', name, orReplace, force, cols, q, qText, withCheck, readOnly, ln, mat: what === 'MATERIALIZED' };
      }
      case 'INDEX': {
        this.next(); const name = this.parseObjName(); this.expectKw('ON'); const table = this.parseObjName();
        this.expectOp('('); const cols = [];
        do { const st = this.cur; this.parseExpr(); cols.push(this.textFrom(st.pos).toUpperCase().replace(/\s+/g, '')); this.accept1('ASC') || this.accept1('DESC'); } while (this.acceptOp(','));
        this.expectOp(')');
        while (this.cur.t !== T_EOF && !this.isOp(';') && this.cur.t !== T_SLASH) this.next();
        return { k: 'createIndex', name, table, cols, unique, ln };
      }
      case 'SEQUENCE': {
        this.next(); const name = this.parseObjName(); const o = { start: null, inc: 1, min: null, max: null, cycle: false, cache: 20 };
        while (this.cur.t === T_ID) {
          const w = this.next().u;
          const n = () => { const neg = this.acceptOp('-'); const t = this.cur; if (t.t !== T_NUM) this.err(null, 'Zahl erwartet'); this.next(); return neg ? -t.v : t.v; };
          if (w === 'START') { this.expectKw('WITH'); o.start = n(); }
          else if (w === 'INCREMENT') { this.expectKw('BY'); o.inc = n(); }
          else if (w === 'MINVALUE') o.min = n();
          else if (w === 'MAXVALUE') o.max = n();
          else if (w === 'CYCLE') o.cycle = true;
          else if (w === 'CACHE') o.cache = n();
          else if (['NOCYCLE', 'NOCACHE', 'ORDER', 'NOORDER', 'NOMAXVALUE', 'NOMINVALUE', 'NOKEEP', 'KEEP', 'SESSION', 'GLOBAL', 'NOSCALE'].includes(w)) { }
          else this.err(null, 'Unbekannte Sequence-Option');
        }
        return { k: 'createSeq', name, o, ln };
      }
      case 'PROCEDURE': case 'FUNCTION': {
        this.next(); const d = this.parseSubprogram(what, false);
        d.orReplace = orReplace; d.k = 'createProc'; d.ln = ln; d.text = this.src.slice(startPos, this.lastEnd);
        return d;
      }
      case 'TRIGGER': return this.parseCreateTrigger(ln, orReplace, startPos);
      case 'PACKAGE': {
        this.next(); const body = this.accept1('BODY');
        const name = this.parseObjName();
        while (this.isKwAny(['AUTHID', 'CURRENT_USER', 'DEFINER', 'ACCESSIBLE'])) this.next();
        if (!this.accept1('IS')) this.expectKw('AS');
        const decls = this.parseDecls(true, body);
        let init = null;
        if (body && this.accept1('BEGIN')) {
          const b = this.parseStmts(['END', 'EXCEPTION']);
          init = { k: 'block', decls: [], body: b, handlers: this.parseHandlers() };
        }
        this.expectKw('END'); if (this.cur.t === T_ID) this.ident(); this.expectOp(';');
        return { k: body ? 'createPkgBody' : 'createPkg', name, decls, init, orReplace, ln, text: this.src.slice(startPos, this.lastEnd) };
      }
      case 'TYPE': {
        this.next(); const isBody = this.accept1('BODY');
        if (isBody) this.err(null, 'CREATE TYPE BODY wird nicht unterstützt');
        const name = this.parseObjName();
        this.accept1('FORCE');
        if (!this.accept1('IS')) this.expectKw('AS');
        let def;
        if (this.accept1('OBJECT')) {
          this.expectOp('('); const fields = [];
          do { const fname = this.ident(); const type = this.parseType(); fields.push({ name: fname, type }); } while (this.acceptOp(','));
          this.expectOp(')');
          def = { k: 'record', fields, object: true };
        } else if (this.accept1('TABLE')) { this.expectKw('OF'); def = { k: 'table', of: this.parseType() }; }
        else if (this.accept1('VARRAY') || (this.accept1('VARYING') && this.accept1('ARRAY'))) { this.expectOp('('); const n = this.next().v; this.expectOp(')'); this.expectKw('OF'); def = { k: 'varray', size: n, of: this.parseType() }; }
        else this.err(null, 'OBJECT, TABLE OF oder VARRAY erwartet');
        while (this.isKwAny(['NOT', 'FINAL', 'INSTANTIABLE'])) this.next();
        this.acceptOp(';');
        return { k: 'createType', name, def, orReplace, ln, text: this.src.slice(startPos, this.lastEnd) };
      }
      case 'SYNONYM': case 'PUBLIC': {
        if (what === 'PUBLIC') this.next();
        this.expectKw('SYNONYM'); const name = this.parseObjName(); this.expectKw('FOR'); const target = this.parseObjName();
        return { k: 'createSynonym', name, target, orReplace, ln };
      }
      case 'USER': case 'ROLE': case 'TABLESPACE': case 'DIRECTORY': case 'DATABASE':
        while (this.cur.t !== T_EOF && !this.isOp(';') && this.cur.t !== T_SLASH) this.next();
        return { k: 'noop', what: 'CREATE ' + what, ln };
    }
    this.err('00901' in ORA_MSG ? '00901' : '00900', 'Unbekannter CREATE-Befehl');
  }
  parseCreateTable(ln, temp) {
    this.next();
    if (this.isKw('IF')) { this.next(); this.expectKw('NOT'); this.expectKw('EXISTS'); var ifNotExists = true; }
    const name = this.parseObjName();
    const node = { k: 'createTable', name, cols: [], cons: [], ln, temp, ifNotExists };
    if (this.isOp('(') ) {
      this.next();
      do {
        if (this.isKwAny(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'])) node.cons.push(this.parseTableConstraint());
        else {
          if (this.isId() && (this.isOp(',', 1) || this.isOp(')', 1)) && this.isKw('AS', 2) === false && this._ctasCols !== undefined) { }
          node.cols.push(this.parseColumnDef(node));
        }
      } while (this.acceptOp(','));
      this.expectOp(')');
    }
    // physische Attribute überspringen
    while (this.cur.t === T_ID && !this.isKw('AS') && ['TABLESPACE', 'PCTFREE', 'PCTUSED', 'STORAGE', 'LOGGING', 'NOLOGGING', 'COMPRESS', 'NOCOMPRESS', 'ON', 'ORGANIZATION', 'SEGMENT', 'CACHE', 'NOCACHE', 'PARALLEL', 'NOPARALLEL', 'INITRANS', 'MAXTRANS', 'ROW', 'MOVEMENT', 'ENABLE', 'DISABLE', 'HEAP', 'INDEX', 'COMMIT', 'PRESERVE', 'DELETE', 'ROWS', 'CREATION', 'IMMEDIATE', 'DEFERRED'].includes(this.cur.u)) {
      this.next(); if (this.isOp('(')) { let d = 0; do { if (this.isOp('(')) d++; if (this.isOp(')')) d--; this.next(); } while (d > 0 && this.cur.t !== T_EOF); }
      if (this.cur.t === T_ID && /^\d/.test(String(this.cur.v))) this.next();
      if (this.cur.t === T_NUM) this.next();
      if (this.cur.t === T_ID && this.peek(-1) && ['TABLESPACE'].includes(this.toks[this.i - 1].u)) this.next();
    }
    if (this.accept1('AS')) {
      node.asQuery = this.parseQuery();
      if (this.accept1('WITH')) { this.accept1('NO'); this.expectKw('DATA'); }
    }
    if (!node.cols.length && !node.asQuery) this.err('00906');
    return node;
  }
  parseColumnDef(tableNode) {
    const name = this.ident();
    const col = { name };
    if (this.isOp(',') || this.isOp(')')) { col.type = null; return col; }
    col.type = this.parseType();
    if (col.type.ref || (col.type.named && ['TEXT', 'DATETIME', 'TINYINT', 'MEDIUMINT', 'BIGINT', 'DOUBLE', 'LONGTEXT', 'MEDIUMTEXT', 'SERIAL', 'BIT', 'ENUM', 'YEAR', 'TIME', 'MONEY', 'NVARCHAR', 'UUID'].includes(col.type.named[0]))) {
      const my = { TEXT: 'VARCHAR2(4000) oder CLOB', DATETIME: 'DATE oder TIMESTAMP', TINYINT: 'NUMBER(3)', MEDIUMINT: 'NUMBER(7)', BIGINT: 'NUMBER(19)', DOUBLE: 'NUMBER oder BINARY_DOUBLE', LONGTEXT: 'CLOB', MEDIUMTEXT: 'CLOB', SERIAL: 'NUMBER GENERATED ALWAYS AS IDENTITY', BIT: 'NUMBER(1)', ENUM: 'VARCHAR2 mit CHECK (spalte IN (...))', YEAR: 'NUMBER(4)', TIME: 'DATE oder INTERVAL DAY TO SECOND', MONEY: 'NUMBER(12,2)', NVARCHAR: 'NVARCHAR2(n)', UUID: 'RAW(16) oder VARCHAR2(36)' };
      const e = oraErr('00902'); e.message += ' (' + col.type.txt + ')'; const k = (col.type.named || col.type.ref ? (col.type.parts || col.type.named || [''])[0] : '');
      if (my[k]) e.hint = k + ' gibt es in Oracle nicht. Nimm stattdessen ' + my[k] + '.';
      e.line = this.cur.line; e.parse = true; throw e;
    }
    if (col.type.b === 'VARCHAR2' && col.type.len === null && col.type.orig !== 'ROWID') {
      const e = oraErr('00906'); e.hint = 'VARCHAR2 braucht in einer Tabelle eine Länge, z. B. VARCHAR2(50).'; e.line = this.cur.line; e.col = this.cur.col; e.parse = true; throw e;
    }
    while (true) {
      if (this.isKwAny(['AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY'])) { const e = oraErr('00907'); e.hint = 'Statt AUTO_INCREMENT: id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY – oder eine SEQUENCE.'; e.line = this.cur.line; e.col = this.cur.col; e.parse = true; throw e; }
      if (this.isKw('UNSIGNED') || this.isKw('COMMENT')) { const e = oraErr('00907'); e.hint = this.cur.u + ' gibt es in Oracle-Spaltendefinitionen nicht.'; e.line = this.cur.line; e.col = this.cur.col; e.parse = true; throw e; }
      if (this.accept1('DEFAULT')) {
        if (this.isKw('ON') && this.isKw('NULL', 1)) { this.next(); this.next(); }
        const st = this.cur; col.default = this.parseExpr(); col.defaultText = this.textFrom(st.pos); continue;
      }
      if (this.accept1('GENERATED')) {
        let always = true, onNull = false;
        if (this.accept1('BY')) { this.expectKw('DEFAULT'); always = false; if (this.accept1('ON')) { this.expectKw('NULL'); onNull = true; } }
        else this.accept1('ALWAYS');
        this.expectKw('AS');
        if (this.accept1('IDENTITY')) {
          const id = { always, onNull, start: 1, inc: 1 };
          if (this.acceptOp('(')) {
            while (!this.isOp(')')) {
              const w = this.next().u;
              if (w === 'START') { this.expectKw('WITH'); id.start = this.next().v; }
              else if (w === 'INCREMENT') { this.expectKw('BY'); id.inc = this.next().v; }
            }
            this.expectOp(')');
          }
          col.identity = id; col.notNull = true;
        } else { this.expectOp('('); col.virtual = this.parseExpr(); this.expectOp(')'); this.accept1('VIRTUAL'); }
        continue;
      }
      if (this.isKwAny(['CONSTRAINT', 'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'CHECK', 'REFERENCES'])) {
        let cname = null;
        if (this.accept1('CONSTRAINT')) cname = this.ident();
        if (this.accept1('NOT')) { this.expectKw('NULL'); col.notNull = true; col.nnName = cname; }
        else if (this.accept1('NULL')) { }
        else if (this.accept1('PRIMARY')) { this.expectKw('KEY'); tableNode.cons.push({ name: cname, type: 'P', cols: [name] }); }
        else if (this.accept1('UNIQUE')) tableNode.cons.push({ name: cname, type: 'U', cols: [name] });
        else if (this.accept1('CHECK')) { this.expectOp('('); const st = this.cur; const e = this.parseExpr(); const txt = this.textFrom(st.pos); this.expectOp(')'); tableNode.cons.push({ name: cname, type: 'C', cols: [name], check: e, checkText: txt }); }
        else if (this.accept1('REFERENCES')) { const c = this.parseReferences(); c.name = cname; c.cols = [name]; tableNode.cons.push(c); }
        while (this.isKwAny(['ENABLE', 'DISABLE', 'DEFERRABLE', 'INITIALLY', 'DEFERRED', 'IMMEDIATE', 'VALIDATE', 'NOVALIDATE', 'RELY', 'NORELY'])) this.next();
        continue;
      }
      break;
    }
    return col;
  }
  parseReferences() {
    const refTable = this.parseObjName(); let refCols = null;
    if (this.acceptOp('(')) { refCols = []; do refCols.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); }
    let onDelete = null;
    if (this.accept1('ON')) { this.expectKw('DELETE'); if (this.accept1('CASCADE')) onDelete = 'CASCADE'; else { this.expectKw('SET'); this.expectKw('NULL'); onDelete = 'SET NULL'; } }
    return { type: 'R', refTable, refCols, onDelete };
  }
  parseTableConstraint() {
    let name = null;
    if (this.accept1('CONSTRAINT')) name = this.ident();
    const colList = () => { this.expectOp('('); const c = []; do c.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); return c; };
    let c;
    if (this.accept1('PRIMARY')) { this.expectKw('KEY'); c = { type: 'P', cols: colList() }; }
    else if (this.accept1('UNIQUE')) c = { type: 'U', cols: colList() };
    else if (this.accept1('FOREIGN')) { this.expectKw('KEY'); const cols = colList(); this.expectKw('REFERENCES'); c = this.parseReferences(); c.cols = cols; }
    else if (this.accept1('CHECK')) { this.expectOp('('); const st = this.cur; const e = this.parseExpr(); const txt = this.textFrom(st.pos); this.expectOp(')'); c = { type: 'C', check: e, checkText: txt, cols: [] }; }
    else this.err(null, 'Constraint-Typ erwartet');
    while (this.isKwAny(['ENABLE', 'DISABLE', 'DEFERRABLE', 'INITIALLY', 'DEFERRED', 'IMMEDIATE', 'VALIDATE', 'NOVALIDATE', 'USING', 'INDEX', 'RELY'])) this.next();
    c.name = name;
    return c;
  }
  parseDrop() {
    const ln = this.cur.line; this.next();
    let what = this.ident();
    if (what === 'PACKAGE' && this.accept1('BODY')) what = 'PACKAGE BODY';
    if (what === 'MATERIALIZED') { this.expectKw('VIEW'); what = 'VIEW'; }
    if (what === 'PUBLIC') { this.expectKw('SYNONYM'); what = 'SYNONYM'; }
    let ifExists = false;
    if (this.isKw('IF') && this.isKw('EXISTS', 1)) { this.next(); this.next(); ifExists = true; }
    const name = this.parseObjName();
    let cascade = false;
    while (this.cur.t === T_ID && ['CASCADE', 'CONSTRAINTS', 'PURGE', 'FORCE', 'VALIDATE'].includes(this.cur.u)) { if (this.cur.u === 'CASCADE') cascade = true; this.next(); }
    return { k: 'drop', what, name, cascade, ifExists, ln };
  }
  parseAlter() {
    const ln = this.cur.line; this.next();
    const what = this.ident();
    if (what === 'SESSION') {
      this.expectKw('SET'); const params = [];
      while (this.cur.t === T_ID) { const p = this.ident(); this.expectOp('='); const v = this.next(); params.push({ p, v: v.v }); }
      return { k: 'alterSession', params, ln };
    }
    if (what === 'TRIGGER') { const name = this.parseObjName(); const act = this.ident(); return { k: 'alterTrigger', name, act, ln }; }
    if (what === 'SEQUENCE') {
      const name = this.parseObjName(); const o = {};
      while (this.cur.t === T_ID) { const w = this.next().u; const neg = () => { const ng = this.acceptOp('-'); const v = this.next().v; return ng ? -v : v; };
        if (w === 'INCREMENT') { this.expectKw('BY'); o.inc = neg(); } else if (w === 'MAXVALUE') o.max = neg(); else if (w === 'MINVALUE') o.min = neg(); else if (w === 'CYCLE') o.cycle = true; else if (w === 'NOCYCLE') o.cycle = false; else if (w === 'RESTART') { if (this.accept1('START')) { this.expectKw('WITH'); o.restart = neg(); } else o.restart = true; } else if (w === 'CACHE') neg(); }
      return { k: 'alterSeq', name, o, ln };
    }
    if (['PROCEDURE', 'FUNCTION', 'PACKAGE', 'VIEW', 'TYPE', 'INDEX', 'USER', 'SYSTEM', 'DATABASE'].includes(what)) {
      while (this.cur.t !== T_EOF && !this.isOp(';') && this.cur.t !== T_SLASH) this.next();
      return { k: 'noop', what: 'ALTER ' + what, ln };
    }
    if (what !== 'TABLE') this.err('00940' in ORA_MSG ? '00940' : '00900', 'Ungültiger ALTER-Befehl');
    const name = this.parseObjName();
    const acts = [];
    const node = { k: 'alterTable', name, acts, ln };
    do {
      if (this.accept1('ADD')) {
        if (this.isKwAny(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'])) acts.push({ a: 'addCons', c: this.parseTableConstraint() });
        else if (this.isOp('(')) {
          this.next();
          do {
            if (this.isKwAny(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'])) acts.push({ a: 'addCons', c: this.parseTableConstraint() });
            else { const tn = { cons: [] }; const col = this.parseColumnDef(tn); acts.push({ a: 'addCol', col, cons: tn.cons }); }
          } while (this.acceptOp(','));
          this.expectOp(')');
        } else { this.accept1('COLUMN'); const tn = { cons: [] }; const col = this.parseColumnDef(tn); acts.push({ a: 'addCol', col, cons: tn.cons }); }
      } else if (this.accept1('MODIFY')) {
        if (this.accept1('CONSTRAINT')) { const cn = this.ident(); const st = this.ident(); acts.push({ a: 'consState', name: cn, state: st }); continue; }
        const one = () => {
          const cname = this.ident(); const m = { a: 'modCol', name: cname };
          if (!this.isKwAny(['NOT', 'NULL', 'DEFAULT', 'CONSTRAINT']) && !this.isOp(')') && !this.isOp(',')) m.type = this.parseType();
          while (true) {
            if (this.accept1('DEFAULT')) { const st = this.cur; m.default = this.parseExpr(); m.defaultText = this.textFrom(st.pos); }
            else if (this.accept1('CONSTRAINT')) { this.ident(); }
            else if (this.accept1('NOT')) { this.expectKw('NULL'); m.notNull = true; }
            else if (this.accept1('NULL')) m.notNull = false;
            else break;
          }
          acts.push(m);
        };
        if (this.acceptOp('(')) { do one(); while (this.acceptOp(',')); this.expectOp(')'); } else one();
      } else if (this.accept1('DROP')) {
        if (this.accept1('CONSTRAINT')) { acts.push({ a: 'dropCons', name: this.ident(), cascade: this.accept1('CASCADE') }); }
        else if (this.accept1('PRIMARY')) { this.expectKw('KEY'); acts.push({ a: 'dropPk', cascade: this.accept1('CASCADE') }); }
        else if (this.accept1('UNIQUE')) { this.expectOp('('); const c = []; do c.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); acts.push({ a: 'dropUnique', cols: c }); }
        else if (this.accept1('COLUMN')) { acts.push({ a: 'dropCol', names: [this.ident()] }); while (this.isKwAny(['CASCADE', 'CONSTRAINTS'])) this.next(); }
        else if (this.acceptOp('(')) { const c = []; do c.push(this.ident()); while (this.acceptOp(',')); this.expectOp(')'); acts.push({ a: 'dropCol', names: c }); }
        else this.err('01735' in ORA_MSG ? '01735' : null);
      } else if (this.accept1('RENAME')) {
        if (this.accept1('COLUMN')) { const a = this.ident(); this.expectKw('TO'); acts.push({ a: 'renCol', from: a, to: this.ident() }); }
        else if (this.accept1('CONSTRAINT')) { const a = this.ident(); this.expectKw('TO'); acts.push({ a: 'renCons', from: a, to: this.ident() }); }
        else { this.expectKw('TO'); acts.push({ a: 'renTable', to: this.ident() }); }
      } else if (this.isKwAny(['ENABLE', 'DISABLE'])) {
        const st = this.next().u; this.accept1('VALIDATE') || this.accept1('NOVALIDATE');
        if (this.accept1('CONSTRAINT')) acts.push({ a: 'consState', name: this.ident(), state: st });
        else if (this.accept1('ALL')) { this.expectKw('TRIGGERS'); acts.push({ a: 'trigState', state: st }); }
        else if (this.accept1('PRIMARY')) { this.expectKw('KEY'); acts.push({ a: 'consState', pk: true, state: st }); }
        else this.err('01735');
      } else if (this.isKwAny(['READ'])) { this.next(); this.next(); acts.push({ a: 'noop' }); }
      else this.err('01735');
    } while (this.acceptOp(','));
    return node;
  }
  parseCreateTrigger(ln, orReplace, startPos) {
    this.next();
    const name = this.parseObjName();
    let timing;
    if (this.accept1('BEFORE')) timing = 'BEFORE';
    else if (this.accept1('AFTER')) timing = 'AFTER';
    else if (this.accept1('INSTEAD')) { this.expectKw('OF'); timing = 'INSTEAD OF'; }
    else if (this.accept1('FOR')) { this.err(null, 'Compound-Trigger werden nicht unterstützt'); }
    else this.err(null, 'BEFORE, AFTER oder INSTEAD OF erwartet');
    const events = []; let ofCols = null;
    do {
      const ev = this.ident();
      if (!['INSERT', 'UPDATE', 'DELETE'].includes(ev)) this.err(null, 'INSERT, UPDATE oder DELETE erwartet');
      events.push(ev);
      if (ev === 'UPDATE' && this.accept1('OF')) { ofCols = []; do ofCols.push(this.ident()); while (this.acceptOp(',')); }
    } while (this.accept1('OR'));
    this.expectKw('ON');
    const table = this.parseObjName();
    let refNew = 'NEW', refOld = 'OLD';
    if (this.accept1('REFERENCING')) {
      while (this.isKwAny(['NEW', 'OLD', 'PARENT'])) { const w = this.next().u; this.accept1('AS'); const a = this.ident(); if (w === 'NEW') refNew = a; else if (w === 'OLD') refOld = a; }
    }
    let row = false;
    if (this.accept1('FOR')) { this.expectKw('EACH'); this.expectKw('ROW'); row = true; }
    let enabled = true;
    if (this.accept1('DISABLE')) enabled = false; else this.accept1('ENABLE');
    let when = null;
    if (this.accept1('WHEN')) { this.expectOp('('); when = this.parseExpr(); this.expectOp(')'); }
    const bodyLine = this.cur.line;
    let block;
    if (this.isKw('CALL')) { this.next(); const e = this.parsePostfix(); this.acceptOp(';'); block = { k: 'block', decls: [], body: [{ k: 'callp', e, ln: bodyLine }], handlers: [] }; }
    else block = this.parseBlock();
    return { k: 'createTrigger', name, timing, events, ofCols, table, row, when, block, enabled, orReplace, refNew, refOld, ln, text: this.src.slice(startPos, this.lastEnd) };
  }

  // ---------- PL/SQL ----------
  parseSubprogram(kind, specOnly) {
    // nach PROCEDURE/FUNCTION
    const nameTok = this.cur;
    const name = this.parseObjName();
    const params = [];
    if (this.acceptOp('(')) {
      do {
        const pname = this.ident();
        let mode = 'IN';
        if (this.accept1('IN')) { if (this.accept1('OUT')) mode = 'IN OUT'; }
        else if (this.accept1('OUT')) mode = 'OUT';
        this.accept1('NOCOPY');
        const type = this.parseType();
        let def = null;
        if (this.acceptOp(':=') || this.accept1('DEFAULT')) def = this.parseExpr();
        params.push({ name: pname, mode, type, def });
      } while (this.acceptOp(','));
      this.expectOp(')');
    }
    let ret = null;
    if (kind === 'FUNCTION') { this.expectKw('RETURN'); ret = this.parseType(); }
    while (this.isKwAny(['DETERMINISTIC', 'PIPELINED', 'PARALLEL_ENABLE', 'RESULT_CACHE', 'AUTHID', 'CURRENT_USER', 'DEFINER', 'ACCESSIBLE'])) this.next();
    const node = { kind, name, params, ret, line: nameTok.line };
    if (this.isOp(';')) { this.next(); node.spec = true; return node; }
    if (!this.accept1('IS')) this.expectKw('AS');
    if (this.isKw('LANGUAGE') || this.isKw('EXTERNAL')) this.err(null, 'Externe Routinen werden nicht unterstützt');
    const decls = this.parseDecls(false);
    this.expectKw('BEGIN');
    const body = this.parseStmts(['END', 'EXCEPTION']);
    const handlers = this.parseHandlers();
    this.expectKw('END');
    if (this.cur.t === T_ID) this.ident();
    this.expectOp(';');
    node.block = { k: 'block', decls, body, handlers, ln: nameTok.line };
    return node;
  }
  parseBlock() {
    const ln = this.cur.line;
    let label = null;
    if (this.acceptOp('<<')) { label = this.ident(); this.expectOp('>>'); }
    let decls = [];
    if (this.accept1('DECLARE')) decls = this.parseDecls(false);
    this.expectKw('BEGIN');
    const body = this.parseStmts(['END', 'EXCEPTION']);
    const handlers = this.parseHandlers();
    this.expectKw('END');
    if (this.cur.t === T_ID && !this.isOp(';')) this.ident();
    this.expectOp(';');
    return { k: 'block', label, decls, body, handlers, ln };
  }
  parseHandlers() {
    const hs = [];
    if (this.accept1('EXCEPTION')) {
      while (this.accept1('WHEN')) {
        const names = [];
        do { let n = this.ident(); while (this.acceptOp('.')) n = this.ident(); names.push(n); } while (this.accept1('OR'));
        this.expectKw('THEN');
        const body = this.parseStmts(['WHEN', 'END']);
        hs.push({ names, body });
      }
      if (!hs.length) this.err(null, 'WHEN erwartet');
    }
    return hs;
  }
  parseDecls(pkg, pkgBody) {
    const decls = [];
    while (true) {
      const t = this.cur;
      if (t.t === T_EOF) this.err(null);
      if (this.isKw('BEGIN') || this.isKw('END')) break;
      if (this.accept1('PRAGMA')) {
        const p = this.ident();
        if (p === 'EXCEPTION_INIT') {
          this.expectOp('('); const n = this.ident(); this.expectOp(','); const neg = this.acceptOp('-'); const c = this.next().v; this.expectOp(')');
          decls.push({ k: 'pragma', name: n, code: neg ? -c : c, ln: t.line });
        } else { if (this.acceptOp('(')) { let d = 1; while (d > 0 && this.cur.t !== T_EOF) { if (this.isOp('(')) d++; if (this.isOp(')')) d--; this.next(); } } }
        this.expectOp(';'); continue;
      }
      if (this.accept1('CURSOR')) {
        const name = this.ident(); const params = [];
        if (this.acceptOp('(')) {
          do { const pn = this.ident(); this.accept1('IN'); const type = this.parseType(); let def = null; if (this.acceptOp(':=') || this.accept1('DEFAULT')) def = this.parseExpr(); params.push({ name: pn, type, def, mode: 'IN' }); } while (this.acceptOp(','));
          this.expectOp(')');
        }
        if (this.accept1('RETURN')) this.parseType();
        let q = null;
        if (this.accept1('IS')) q = this.parseQuery();
        this.expectOp(';');
        decls.push({ k: 'cursor', name, params, q, ln: t.line }); continue;
      }
      if (this.accept1('TYPE')) {
        const name = this.ident(); this.expectKw('IS');
        let def;
        if (this.accept1('RECORD')) {
          this.expectOp('('); const fields = [];
          do { const fn = this.ident(); const type = this.parseType(); let notNull = false; if (this.accept1('NOT')) { this.expectKw('NULL'); notNull = true; } let init = null; if (this.acceptOp(':=') || this.accept1('DEFAULT')) init = this.parseExpr(); fields.push({ name: fn, type, init, notNull }); } while (this.acceptOp(','));
          this.expectOp(')');
          def = { k: 'record', fields };
        } else if (this.accept1('TABLE')) {
          this.expectKw('OF'); const of = this.parseType();
          if (this.accept1('NOT')) this.expectKw('NULL');
          let indexBy = null;
          if (this.accept1('INDEX')) { this.expectKw('BY'); indexBy = this.parseType(); }
          def = { k: 'table', of, indexBy };
        } else if (this.accept1('VARRAY') || (this.accept1('VARYING') && this.expectKw('ARRAY') === undefined)) {
          this.expectOp('('); const n = this.next().v; this.expectOp(')'); this.expectKw('OF'); const of = this.parseType();
          if (this.accept1('NOT')) this.expectKw('NULL');
          def = { k: 'varray', size: n, of };
        } else if (this.accept1('REF')) {
          this.expectKw('CURSOR'); if (this.accept1('RETURN')) this.parseType(); def = { k: 'refcursor' };
        } else this.err(null, 'RECORD, TABLE, VARRAY oder REF CURSOR erwartet');
        this.expectOp(';');
        decls.push({ k: 'type', name, def, ln: t.line }); continue;
      }
      if (this.accept1('SUBTYPE')) {
        const name = this.ident(); this.expectKw('IS'); const type = this.parseType();
        if (this.accept1('NOT')) this.expectKw('NULL');
        if (this.acceptOp('(')) { while (!this.isOp(')')) this.next(); this.next(); }
        this.expectOp(';');
        decls.push({ k: 'type', name, def: { k: 'subtype', type }, ln: t.line }); continue;
      }
      if (this.isKwAny(['PROCEDURE', 'FUNCTION'])) {
        const kind = this.next().u;
        const sp = this.parseSubprogram(kind, pkg && !pkgBody);
        decls.push({ k: 'subprog', def: sp, ln: t.line }); continue;
      }
      // Variable / Konstante / Exception
      const name = this.ident();
      if (this.accept1('EXCEPTION')) { this.expectOp(';'); decls.push({ k: 'exc', name, ln: t.line }); continue; }
      const constant = this.accept1('CONSTANT');
      const type = this.parseType();
      let notNull = false;
      if (this.accept1('NOT')) { this.expectKw('NULL'); notNull = true; }
      let init = null;
      if (this.acceptOp(':=') || this.accept1('DEFAULT')) init = this.parseExpr();
      else if (this.isOp('=')) { const e = new OraError('ORA-06550', 'Zeile ' + this.cur.line + ', Spalte ' + this.cur.col + ':\nPLS-00103: Fand das Symbol "="'); e.hint = 'Zuweisung in PL/SQL mit := statt ='; e.line = this.cur.line; e.parse = true; throw e; }
      if (constant && !init) this.err(null, 'Konstante braucht einen Wert (:=)');
      this.expectOp(';');
      decls.push({ k: 'var', name, type, constant, notNull, init, ln: t.line });
    }
    return decls;
  }
  parseStmts(terms) {
    const stmts = [];
    while (true) {
      if (this.cur.t === T_EOF) this.err(null, 'END erwartet');
      if (this.isKwAny(terms)) break;
      stmts.push(this.parseStmt());
    }
    if (!stmts.length) this.err(null, 'mindestens eine Anweisung erwartet (z. B. NULL;)');
    return stmts;
  }
  parseStmt() {
    const t = this.cur; const ln = t.line;
    let label = null;
    if (this.acceptOp('<<')) { label = this.ident(); this.expectOp('>>'); }
    const lt = this.cur;
    const kw = lt.t === T_ID && !lt.quoted ? lt.u : null;
    let s;
    switch (kw) {
      case 'NULL': if (this.isOp(';', 1)) { this.next(); this.next(); return { k: 'null_s', ln }; } break;
      case 'IF': {
        this.next(); const conds = [];
        let c = this.parseExpr(); this.expectKw('THEN');
        conds.push({ c, body: this.parseStmts(['ELSIF', 'ELSE', 'END']) });
        let els = null;
        while (true) {
          if (this.accept1('ELSIF')) { c = this.parseExpr(); this.expectKw('THEN'); conds.push({ c, body: this.parseStmts(['ELSIF', 'ELSE', 'END']) }); continue; }
          if (this.isKw('ELSE') && this.isKw('IF', 1)) { const e = new OraError('ORA-06550', 'Zeile ' + this.cur.line + ', Spalte ' + this.cur.col + ':\nPLS-00103: Fand das Symbol "IF"'); e.hint = 'In PL/SQL heißt es ELSIF (nicht ELSE IF oder ELSEIF).'; e.line = this.cur.line; e.parse = true; throw e; }
          if (this.accept1('ELSE')) { els = this.parseStmts(['END']); }
          break;
        }
        this.expectKw('END'); this.expectKw('IF'); this.expectOp(';');
        return { k: 'if', conds, else: els, ln };
      }
      case 'CASE': {
        this.next(); const node = { k: 'case_s', whens: [], ln };
        if (!this.isKw('WHEN')) node.base = this.parseExpr();
        while (this.accept1('WHEN')) { const w = this.parseExpr(); this.expectKw('THEN'); node.whens.push({ w, body: this.parseStmts(['WHEN', 'ELSE', 'END']) }); }
        if (this.accept1('ELSE')) node.else = this.parseStmts(['END']);
        this.expectKw('END'); this.expectKw('CASE'); if (this.cur.t === T_ID) this.ident(); this.expectOp(';');
        return node;
      }
      case 'LOOP': {
        this.next(); const body = this.parseStmts(['END']); this.expectKw('END'); this.expectKw('LOOP'); if (this.cur.t === T_ID) this.ident(); this.expectOp(';');
        return { k: 'loop', label, body, ln };
      }
      case 'WHILE': {
        this.next(); const c = this.parseExpr(); this.expectKw('LOOP');
        const body = this.parseStmts(['END']); this.expectKw('END'); this.expectKw('LOOP'); if (this.cur.t === T_ID) this.ident(); this.expectOp(';');
        return { k: 'while', label, c, body, ln };
      }
      case 'FOR': {
        this.next(); const v = this.ident(); this.expectKw('IN');
        const reverse = this.accept1('REVERSE');
        let node;
        if (this.isOp('(') && this.isKwAny(['SELECT', 'WITH'], 1)) {
          this.next(); const q = this.parseQuery(); this.expectOp(')');
          node = { k: 'forc', label, v, q, ln };
        } else {
          const lo = this.parseAdditive();
          if (this.acceptOp('..')) { const hi = this.parseAdditive(); node = { k: 'fori', label, v, reverse, lo, hi, ln }; }
          else {
            if (lo.k === 'id') node = { k: 'forc', label, v, cursor: lo.parts.join('.'), args: [], ln };
            else if (lo.k === 'call') node = { k: 'forc', label, v, cursor: lo.name.join('.'), args: lo.args, ln };
            else this.err(null, '".." oder Cursor erwartet');
          }
        }
        this.expectKw('LOOP');
        node.body = this.parseStmts(['END']); this.expectKw('END'); this.expectKw('LOOP'); if (this.cur.t === T_ID) this.ident(); this.expectOp(';');
        return node;
      }
      case 'FORALL': {
        this.next(); const v = this.ident(); this.expectKw('IN');
        let lo, hi, indicesOf = null;
        if (this.accept1('INDICES')) { this.expectKw('OF'); indicesOf = this.parsePostfix(); }
        else if (this.accept1('VALUES')) { this.expectKw('OF'); indicesOf = this.parsePostfix(); }
        else { lo = this.parseAdditive(); this.expectOp('..'); hi = this.parseAdditive(); }
        this.accept1('SAVE') && this.expectKw('EXCEPTIONS');
        const stmt = this.parseStmt();
        return { k: 'forall', v, lo, hi, indicesOf, stmt, ln };
      }
      case 'EXIT': case 'CONTINUE': {
        this.next(); let lbl = null;
        if (this.cur.t === T_ID && !this.isKw('WHEN')) lbl = this.ident();
        let when = null; if (this.accept1('WHEN')) when = this.parseExpr();
        this.expectOp(';');
        return { k: kw === 'EXIT' ? 'exit' : 'continue', label: lbl, when, ln };
      }
      case 'RETURN': { this.next(); let e = null; if (!this.isOp(';')) e = this.parseExpr(); this.expectOp(';'); return { k: 'return', e, ln }; }
      case 'RAISE': { this.next(); let name = null; if (this.cur.t === T_ID) { name = this.ident(); while (this.acceptOp('.')) name = this.ident(); } this.expectOp(';'); return { k: 'raise', name, ln }; }
      case 'GOTO': this.err(null, 'GOTO wird nicht unterstützt');
      case 'OPEN': {
        this.next(); const name = this.ident();
        if (this.accept1('FOR')) {
          let q = null, dyn = null;
          if (this.isKwAny(['SELECT', 'WITH']) || this.isOp('(')) q = this.parseQuery(); else dyn = this.parseExpr();
          let using = null; if (this.accept1('USING')) { using = []; do { this.accept1('IN'); using.push(this.parseExpr()); } while (this.acceptOp(',')); }
          this.expectOp(';');
          return { k: 'openfor', name, q, dyn, using, ln };
        }
        let args = []; if (this.acceptOp('(')) args = this.parseArgs();
        this.expectOp(';');
        return { k: 'open', name, args, ln };
      }
      case 'FETCH': {
        this.next(); const name = this.ident(); let bulk = false;
        if (this.accept1('BULK')) { this.expectKw('COLLECT'); bulk = true; }
        this.expectKw('INTO'); const into = this.parseTargets();
        let limit = null; if (this.accept1('LIMIT')) limit = this.parseExpr();
        this.expectOp(';');
        return { k: 'fetch', name, bulk, into, limit, ln };
      }
      case 'CLOSE': { this.next(); const name = this.ident(); this.expectOp(';'); return { k: 'close', name, ln }; }
      case 'EXECUTE': {
        if (this.isKw('IMMEDIATE', 1)) {
          this.next(); this.next(); const e = this.parseExpr();
          const node = { k: 'execimm', e, ln };
          for (let r = 0; r < 3; r++) {
            if (this.isKw('BULK')) { this.next(); this.expectKw('COLLECT'); this.expectKw('INTO'); node.bulk = true; node.into = this.parseTargets(); }
            else if (this.accept1('INTO')) node.into = this.parseTargets();
            else if (this.accept1('USING')) { node.using = []; do { let mode = 'IN'; if (this.accept1('IN')) { if (this.accept1('OUT')) mode = 'IN OUT'; } else if (this.accept1('OUT')) mode = 'OUT'; node.using.push({ mode, e: this.parseExpr() }); } while (this.acceptOp(',')); }
            else if (this.isKwAny(['RETURNING', 'RETURN'])) { this.next(); this.expectKw('INTO'); node.retInto = this.parseTargets(); }
          }
          this.expectOp(';');
          return node;
        }
        break;
      }
      case 'DECLARE': case 'BEGIN': { const b = this.parseBlock(); b.label = b.label || label; return b; }
      case 'SELECT': case 'WITH': case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE': case 'COMMIT': case 'ROLLBACK': case 'SAVEPOINT': case 'LOCK': {
        const st = this.parseStatement(); this.expectOp(';');
        return { k: 'sql', stmt: st, ln };
      }
      case 'CREATE': case 'DROP': case 'ALTER': case 'TRUNCATE': case 'GRANT': {
        const e = new OraError('ORA-06550', 'Zeile ' + ln + ', Spalte ' + lt.col + ':\nPLS-00103: Fand das Symbol "' + kw + '"');
        e.hint = 'DDL ist in PL/SQL nicht direkt erlaubt. Nutze EXECUTE IMMEDIATE \'' + kw + ' ...\';'; e.line = ln; e.parse = true; throw e;
      }
    }
    if (lt.t === T_OP && lt.v === '<<') { return this.parseStmt(); }
    s = this.parseSimpleStmtNoSemi();
    if (this.isOp('=') && s.k === 'callp') {
      const e = new OraError('ORA-06550', 'Zeile ' + this.cur.line + ', Spalte ' + this.cur.col + ':\nPLS-00103: Fand das Symbol "="');
      e.hint = 'Zuweisungen in PL/SQL mit := statt ='; e.line = this.cur.line; e.parse = true; throw e;
    }
    this.expectOp(';');
    s.ln = ln;
    return s;
  }
}

function parseScript(src) { return new Parser(src).parseScript(); }
function parseExprText(src) { const p = new Parser(src); const e = p.parseExpr(); return e; }
