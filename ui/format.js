// ===== Formatierer (Prettify) für SQL und PL/SQL =====
const FMT = (() => {
  const OPS2 = [':=', '=>', '..', '||', '<>', '!=', '^=', '~=', '<=', '>=', '**', '<<', '>>'];
  function fmtLex(src) {
    const out = []; let i = 0, nl = 0; const n = src.length;
    const push = (t, v) => { out.push({ t, v, u: t === 'w' ? v.toUpperCase() : v, nl }); nl = 0; };
    while (i < n) {
      const c = src[i];
      if (c === '\n') { nl++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '-' && src[i + 1] === '-') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('lcom', src.slice(i, j).replace(/\s+$/, '')); i = j; continue; }
      if (c === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('bcom', src.slice(i, j)); i = j; continue; }
      if (c === '/') {
        const ls = src.lastIndexOf('\n', i - 1) + 1; let le = src.indexOf('\n', i); if (le < 0) le = n;
        if (!src.slice(ls, i).trim() && !src.slice(i + 1, le).trim()) { push('slash', '/'); i++; continue; }
      }
      if ((c === 'q' || c === 'Q' || c === 'n' || c === 'N') && src[i + 1] === "'" ) {
        if (c === 'n' || c === 'N') { let j = i + 2; while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; } j++; } push('str', src.slice(i, j)); i = j; continue; }
        const open = src[i + 2]; const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] || open; const e = src.indexOf(close + "'", i + 3); const j = e < 0 ? n : e + 2; push('str', src.slice(i, j)); i = j; continue;
      }
      if (c === "'") { let j = i + 1; while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; } j++; } push('str', src.slice(i, j)); i = j; continue; }
      if (c === '"') { let j = src.indexOf('"', i + 1); j = j < 0 ? n : j + 1; push('qid', src.slice(i, j)); i = j; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && src[i - 1] !== '.')) { let j = i; while (j < n && /[0-9]/.test(src[j])) j++; if (src[j] === '.' && src[j + 1] !== '.') { j++; while (j < n && /[0-9]/.test(src[j])) j++; } if (/[eE]/.test(src[j] || '') && /[0-9+-]/.test(src[j + 1] || '')) { j += 2; while (j < n && /[0-9]/.test(src[j])) j++; } push('num', src.slice(i, j)); i = j; continue; }
      if (/[A-Za-z_À-ɏ]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_$#À-ɏ]/.test(src[j])) j++; push('w', src.slice(i, j)); i = j; continue; }
      if (c === ':' && /[A-Za-z0-9_]/.test(src[i + 1] || '')) { let j = i + 1; while (j < n && /[\w$#]/.test(src[j])) j++; push('bind', src.slice(i, j)); i = j; continue; }
      const two = src.substr(i, 2);
      if (OPS2.includes(two)) { push('op', two); i += 2; continue; }
      push('op', c); i++;
    }
    out.push({ t: 'eof', v: '', u: '', nl });
    return out;
  }
  const CLAUSE = new Set(['FROM', 'WHERE', 'HAVING', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'VALUES', 'SET', 'RETURNING', 'OFFSET']);
  const JOINW = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL']);
  const SPACE_BEFORE_PAREN = new Set(['IN', 'VALUES', 'AS', 'AND', 'OR', 'NOT', 'EXISTS', 'ON', 'USING', 'FROM', 'JOIN', 'INTO', 'WHERE', 'SELECT', 'THEN', 'ELSE', 'WHEN', 'RETURN', 'IS', 'OVER', 'CHECK', 'KEY', 'REFERENCES', 'UNIQUE', 'BY', 'ALL', 'ANY', 'SOME', 'CASE', 'WITHIN', 'HAVING', 'SET', 'ADD', 'MODIFY', 'TABLE', 'UNION', 'MINUS', 'INTERSECT', 'LOOP', 'IF', 'ELSIF', 'WHILE', 'UPDATE', 'RECORD', 'OF', 'DEFAULT', 'PARTITION', 'ROLLUP', 'CUBE', 'SETS', 'LIKE', 'BETWEEN', 'TO']);

  function format(src, opts) {
    opts = opts || {};
    const caseMode = opts.caseMode || 'upper';
    const KWS = opts.keywords || new Set();
    const toks = fmtLex(src);
    const lines = []; let line = ''; let atStart = true;
    let lvl = 0;                 // PL/SQL-Einrücktiefe
    const blocks = [];           // {k:'decl'|'body'|'if'|'loop'|'case', inH}
    let pl = false, header = false, trig = false, stmtStart = true, stmtKind = null, caseExpr = 0;
    const parens = [];           // {k:'sub'|'ddl'|'call', col}
    const qs = [];               // {col, depth, clause, kind}
    let between = false, prev = null, prev2 = null;
    const IND = 2;
    const cur = () => line.length;
    const nlTo = (col) => { lines.push(line.replace(/\s+$/, '')); line = ' '.repeat(Math.max(0, col)); atStart = true; };
    const blank = () => { if (lines.length && lines[lines.length - 1] !== '') { if (!atStart || line.trim()) nlTo(0); lines.push(''); line = ''; atStart = true; } };
    const ensureLine = (col) => { if (!atStart || line.trim()) nlTo(col); else line = ' '.repeat(Math.max(0, col)); };
    const word = (t) => {
      if (t.t !== 'w') return t.v;
      if (KWS.has(t.u)) return caseMode === 'upper' ? t.u : caseMode === 'lower' ? t.v.toLowerCase() : t.v;
      return t.v;
    };
    const needSpace = (p, t) => {
      if (atStart || !p) return false;
      const pv = p.v, v = t.v;
      if (p.t === 'op' && (pv === '(' || pv === '.' || pv === '%' || pv === '<<')) return false;
      if (t.t === 'op' && (v === ')' || v === ',' || v === ';' || v === '.' || v === '%' || v === '>>')) return false;
      if (t.t === 'op' && v === '(') {
        if (p.t === 'w') return SPACE_BEFORE_PAREN.has(p.u) || (stmtKind === 'TABLE' && !parens.length) || !!(prev2 && prev2.t === 'w' && ['INTO', 'REFERENCES', 'TABLE', 'ON', 'VIEW'].includes(prev2.u));
        return !(p.t === 'qid');
      }
      if (p.t === 'op' && (pv === '-' || pv === '+') && prev2 && ((prev2.t === 'op' && prev2.v !== ')') || (prev2.t === 'w' && KWS.has(prev2.u) && !['END', 'NULL'].includes(prev2.u)))) return false;
      return true;
    };
    const put = (t, txt) => { if (needSpace(prev, t)) line += ' '; line += txt; atStart = false; };
    const stmtIndent = () => lvl * IND;
    const topQ = () => qs.length ? qs[qs.length - 1] : null;
    const depth = () => parens.length;
    const plStmtNL = () => { stmtStart = true; nlTo(stmtIndent()); };

    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]; const nx = toks[k + 1] || { t: 'eof', u: '' };
      if (t.t === 'eof') break;
      // Kommentare
      if (t.t === 'lcom' || t.t === 'bcom') {
        if (t.nl === 0 && atStart && !line.trim() && lines.length && lines[lines.length - 1] !== '') { lines[lines.length - 1] += ' ' + t.v; continue; }
        if (t.nl > 0 || atStart) { if (t.nl > 1) blank(); ensureLine(atStart && line.length ? line.length : (pl ? stmtIndent() : (topQ() ? topQ().col : 0))); line += t.v; atStart = false; }
        else { line += ' ' + t.v; atStart = false; }
        if (t.t === 'lcom') { const col = stmtStart ? (pl ? stmtIndent() : 0) : (topQ() ? topQ().col + IND : stmtIndent() + IND); nlTo(col); }
        continue;
      }
      if (t.t === 'slash') {
        ensureLine(0); line = '/'; nlTo(0); lines.push(''); line = ''; atStart = true;
        lvl = 0; blocks.length = 0; pl = false; header = false; trig = false; stmtStart = true; stmtKind = null; parens.length = 0; qs.length = 0; caseExpr = 0; prev = null; prev2 = null;
        continue;
      }
      const U = t.t === 'w' ? t.u : null;
      // Anweisungsbeginn
      if (stmtStart) {
        if (t.nl > 1 && (lines.length || line.trim())) blank();
        if (!pl) {
          if (U === 'DECLARE' || U === 'BEGIN' || (t.v === '<<')) pl = true;
          if (U === 'CREATE') { let j = k + 1; const seen = []; while (j < toks.length && seen.length < 6 && toks[j].t === 'w') { seen.push(toks[j].u); j++; } if (seen.some(w => ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'TYPE'].includes(w)) && !seen.includes('TABLE')) { pl = true; header = true; trig = seen.includes('TRIGGER'); } stmtKind = seen.includes('TABLE') ? 'TABLE' : null; }
        }
        if (pl && (U === 'PROCEDURE' || U === 'FUNCTION') && blocks.length && blocks[blocks.length - 1].k === 'decl') header = true;
        ensureLine(stmtIndent());
        stmtStart = false;
        if (pl && U === 'CASE') { put(t, word(t)); blocks.push({ k: 'case', inW: false }); prev2 = prev; prev = t; continue; }
        if (['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(U)) qs.push({ col: cur(), depth: depth(), clause: U === 'SELECT' ? 'select' : U.toLowerCase(), kind: U });
      }
      // Klammern
      if (t.t === 'op' && t.v === '(') {
        const isSub = nx.t === 'w' && (nx.u === 'SELECT' || nx.u === 'WITH');
        if (!isSub && stmtKind === 'TABLE' && !parens.length && !pl) {
          put(t, '('); parens.push({ k: 'ddl', start: lines.length + 1 }); nlTo(IND); prev2 = prev; prev = t; continue;
        }
        put(t, '('); parens.push({ k: isSub ? 'sub' : 'call' }); prev2 = prev; prev = t; continue;
      }
      if (t.t === 'op' && t.v === ')') {
        const p = parens.pop();
        while (qs.length && topQ().depth > depth()) qs.pop();
        if (p && p.k === 'ddl') {
          if (line.trim()) nlTo(0);
          const rows = []; for (let r = p.start; r < lines.length; r++) { const m = lines[r].match(/^(\s+)(\S+)\s+(.*)$/); if (m && !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(m[2])) rows.push([r, m]); }
          const w = Math.max(0, ...rows.map(x => x[1][2].length));
          for (const [r, m] of rows) lines[r] = m[1] + m[2].padEnd(w) + ' ' + m[3];
          line = ' '.repeat(stmtIndent()); line += ')'; atStart = false; prev2 = prev; prev = t; continue;
        }
        put(t, ')'); prev2 = prev; prev = t; continue;
      }
      if (t.t === 'op' && t.v === ',') {
        put(t, ',');
        const p = parens[parens.length - 1];
        if (p && p.k === 'ddl') nlTo(IND);
        else { const q = topQ(); if (q && q.depth === depth() && q.clause === 'select') nlTo(q.col + 7); else if (q && q.depth === depth() && q.clause === 'set') nlTo(q.col + 4); }
        prev2 = prev; prev = t; continue;
      }
      if (t.t === 'op' && t.v === ';') {
        put(t, ';');
        while (qs.length && topQ().depth >= depth()) qs.pop();
        if (!parens.length) {
          header = false; stmtKind = null; between = false; caseExpr = 0;
          if (pl && blocks.length) plStmtNL(); else { stmtStart = true; nlTo(0); if (!blocks.length && !pl) { } }
        }
        prev2 = prev; prev = t; continue;
      }
      if (trig && U && !parens.length) {
        if (U === 'BEGIN' || U === 'DECLARE') trig = false;
        else if (['BEFORE', 'AFTER', 'INSTEAD', 'FOR', 'WHEN', 'REFERENCING'].includes(U) && !(U === 'FOR' && prev && prev.u === 'INSTEAD')) { ensureLine(IND); put(t, word(t)); prev2 = prev; prev = t; continue; }
      }
      // PL/SQL-Struktur
      if (pl && U && !parens.length) {
        const top = blocks[blocks.length - 1];
        if (U === 'DECLARE') { ensureLine(stmtIndent()); put(t, word(t)); blocks.push({ k: 'decl' }); lvl++; plStmtNL(); prev2 = prev; prev = t; continue; }
        if ((U === 'IS' || U === 'AS') && header) { put(t, word(t)); header = false; blocks.push({ k: 'decl' }); lvl++; plStmtNL(); prev2 = prev; prev = t; continue; }
        if (U === 'BEGIN') {
          if (top && top.k === 'decl') { top.k = 'body'; lvl--; ensureLine(stmtIndent()); put(t, word(t)); lvl++; }
          else { ensureLine(stmtIndent()); put(t, word(t)); blocks.push({ k: 'body' }); lvl++; }
          plStmtNL(); prev2 = prev; prev = t; continue;
        }
        if (U === 'EXCEPTION' && top && top.k === 'body' && nx.u === 'WHEN') { lvl--; ensureLine(stmtIndent()); put(t, word(t)); lvl++; top.exc = true; stmtStart = false; prev2 = prev; prev = t; continue; }
        if (U === 'WHEN' && top && top.k === 'body' && top.exc && caseExpr === 0) { if (top.inH) { lvl--; top.inH = false; } ensureLine(stmtIndent()); put(t, word(t)); prev2 = prev; prev = t; continue; }
        if (U === 'WHEN' && top && top.k === 'case' && caseExpr === 0) { if (top.inW) { lvl--; top.inW = false; } else { lvl++; } ensureLine(stmtIndent()); put(t, word(t)); prev2 = prev; prev = t; continue; }
        if (U === 'THEN' && caseExpr === 0) {
          put(t, word(t));
          if (top && top.k === 'body' && top.exc) { top.inH = true; lvl++; plStmtNL(); }
          else if (top && top.k === 'case') { top.inW = true; lvl++; plStmtNL(); }
          else { blocks.push({ k: 'if' }); lvl++; plStmtNL(); }
          prev2 = prev; prev = t; continue;
        }
        if ((U === 'ELSIF' || U === 'ELSE') && caseExpr === 0 && top && (top.k === 'if' || top.k === 'case')) {
          if (top.k === 'if') { lvl--; blocks.pop(); }
          else if (top.inW) { lvl--; top.inW = false; }
          if (top.k === 'case') { ensureLine(stmtIndent()); put(t, word(t)); top.inW = true; lvl++; plStmtNL(); prev2 = prev; prev = t; continue; }
          ensureLine(stmtIndent()); put(t, word(t));
          if (U === 'ELSE') { blocks.push({ k: 'if' }); lvl++; plStmtNL(); }
          prev2 = prev; prev = t; continue;
        }
        if (U === 'LOOP' && !(prev && prev.u === 'END')) { put(t, word(t)); blocks.push({ k: 'loop' }); lvl++; plStmtNL(); prev2 = prev; prev = t; continue; }
        if (U === 'CASE' && caseExpr === 0 && prev && prev.u === 'END') { put(t, word(t)); prev2 = prev; prev = t; continue; }
        if (U === 'CASE') { caseExpr++; put(t, word(t)); prev2 = prev; prev = t; continue; }
        if (U === 'END') {
          if (caseExpr > 0) { caseExpr--; put(t, word(t)); prev2 = prev; prev = t; continue; }
          const b = blocks.pop();
          if (b) { if (b.inH || b.inW) lvl--; lvl--; if (b.k === 'case' && !b.inW) lvl += 0; }
          lvl = Math.max(0, lvl);
          ensureLine(stmtIndent()); put(t, word(t)); prev2 = prev; prev = t; continue;
        }
      } else if (U === 'CASE') { caseExpr++; }
      else if (U === 'END' && caseExpr > 0) { caseExpr--; }
      // SQL-Klauseln
      if (U) {
        const q = topQ();
        const atQ = q && q.depth === depth();
        if (U === 'SELECT' && q && q.depth === depth() && q.clause !== 'select' && q.clause !== 'with' && prev && !(prev.t === 'op' && prev.v === '(')) {
          ensureLine(q.col); const col = cur(); put(t, word(t)); qs.push({ col, depth: depth(), clause: 'select', kind: 'SELECT' }); prev2 = prev; prev = t; continue;
        }
        if (U === 'SELECT' && (!q || q.depth !== depth() || (prev && prev.t === 'op' && prev.v === '('))) {
          const col = cur() + (needSpace(prev, t) ? 1 : 0); put(t, word(t)); qs.push({ col, depth: depth(), clause: 'select', kind: 'SELECT' }); prev2 = prev; prev = t; continue;
        }
        if (U === 'SELECT' && q && q.clause === 'with' && q.depth === depth()) {
          ensureLine(q.col); const col = cur(); put(t, word(t)); qs.push({ col, depth: depth(), clause: 'select', kind: 'SELECT' }); prev2 = prev; prev = t; continue;
        }
        if (atQ) {
          let isClause = CLAUSE.has(U) || (U === 'INTO' && q.kind === 'SELECT') ||
            (U === 'GROUP' || U === 'ORDER' || U === 'CONNECT' || (U === 'START' && nx.u === 'WITH')) && ['BY', 'WITH', 'SIBLINGS'].includes(nx.u) ||
            (U === 'FETCH' && q.kind === 'SELECT') || (U === 'USING' && q.kind === 'MERGE') || (U === 'WHEN' && q.kind === 'MERGE' && caseExpr === 0);
          if (JOINW.has(U) && !(prev && JOINW.has(prev.u))) isClause = true;
          if (U === 'SET' && q.kind !== 'UPDATE' && q.kind !== 'MERGE') isClause = false;
          if (U === 'VALUES' && (q.kind === 'MERGE' || t.nl === 0)) isClause = false;
          if (U === 'FROM' && q.kind === 'DELETE' && prev && prev.u === 'DELETE') isClause = false;
          if (U === 'INTO' && q.kind === 'SELECT' && prev && prev.u === 'COLLECT') isClause = false;
          if (U === 'INTO' && q.kind === 'SELECT' && prev && prev.u === 'BULK') isClause = false;
          if (U === 'BULK' && q.kind === 'SELECT') isClause = true;
          if (isClause) {
            ensureLine(q.col); put(t, word(t));
            q.clause = U === 'SET' ? 'set' : (U === 'UNION' || U === 'INTERSECT' || U === 'MINUS' || U === 'EXCEPT') ? 'union' : U.toLowerCase();
            if (q.clause === 'union') { /* folgendes SELECT neu */ q.clause = 'unionwait'; }
            between = false; prev2 = prev; prev = t; continue;
          }
          if (U === 'BETWEEN') between = true;
          if ((U === 'AND' || U === 'OR') && ['where', 'having', 'on', 'join', 'inner', 'left', 'right', 'full', 'when', 'start', 'connect'].includes(q.clause) && caseExpr === 0) {
            if (U === 'AND' && between) { between = false; }
            else { ensureLine(q.col + IND); put(t, word(t)); prev2 = prev; prev = t; continue; }
          }
        }
        if (U === 'SELECT' && q && q.clause === 'unionwait') { ensureLine(q.col); q.clause = 'select'; put(t, word(t)); prev2 = prev; prev = t; continue; }
        if ((U === 'SELECT' || U === 'WITH') && !q) { const col = cur() + (needSpace(prev, t) ? 1 : 0); put(t, word(t)); qs.push({ col, depth: depth(), clause: U === 'WITH' ? 'with' : 'select', kind: U }); prev2 = prev; prev = t; continue; }
      }
      // Normales Token
      put(t, t.t === 'w' ? word(t) : t.v);
      prev2 = prev; prev = t;
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }
  function sameTokens(a, b) {
    const norm = s => fmtLex(s).filter(t => t.t !== 'eof').map(t => (t.t === 'w' ? t.u : t.t === 'lcom' || t.t === 'bcom' ? t.v.replace(/\s+/g, ' ') : t.v)).join('\u0001');
    return norm(a) === norm(b);
  }
  return { format, sameTokens, fmtLex };
})();
