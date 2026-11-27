// Rauchtest: Beispielschema und alle Beispiele laufen ohne unerwartete Fehler durch
const fs = require('fs'); const path = require('path');
const E = require('../engine_node.js');
const C = {}; eval(fs.readFileSync(path.join(__dirname, '..', 'ui', 'content.js'), 'utf8').replace(/^const (\w+)/gm, 'C.$1'));
const EXPECTED = new Set(['ORA-20001', 'ORA-20010']); // absichtliche Fehler-Demos
let bad = 0;
const run = (label, sql, allowed) => { E.resetDB(); E.runScript(C.SEED_SQL); for (const r of E.runScript(sql).results) if (r.error && !(allowed || EXPECTED).has(r.error.code)) { bad++; console.log('FEHLER', label, r.error.code, r.error.message); } };
E.resetDB(); const seed = E.runScript(C.SEED_SQL).results.filter(r => r.error); if (seed.length) { bad += seed.length; console.log('Beispielschema:', seed.map(r => r.error.message)); }
for (const e of C.EXAMPLES) run('Beispiel ' + e.name, e.sql);
console.log('Beispiele', C.EXAMPLES.length, '· unerwartete Fehler', bad);
if (bad) process.exitCode = 1;
