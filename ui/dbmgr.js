// ---------- Mehrere Datenbanken & Import ----------
const KV = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try { const r = indexedDB.open('orasim', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
    catch (e) { rej(e); }
  }));
  return {
    async get(k) {
      try { const d = await open(); return await new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result === undefined ? null : r.result); r.onerror = () => rej(r.error); }); }
      catch (e) { return LS.get('orasim.kv.' + k); }
    },
    async set(k, v) {
      try { const d = await open(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); return true; }
      catch (e) { return LS.set('orasim.kv.' + k, v); }
    },
    async del(k) {
      try { const d = await open(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
      catch (e) { try { localStorage.removeItem('orasim.kv.' + k); } catch (x) { } }
    },
  };
})();
function saveDbMeta() { LS.set('orasim.dbs', JSON.stringify({ list: dbList, active: activeDb })); }
function activeMeta() { return dbList.find(d => d.id === activeDb) || { name: '?' }; }
function renderDbBtn() { $('#dbName').textContent = activeMeta().name; applyRemoteUi(); }
function fmtSize(n) { if (!n) return ''; return n > 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
function afterDbLoad(r) {
  hideHud();
  catalog = r.catalog; persistState(r.state);
  selected = null; $('#tabObj').hidden = true; lastRun = null; errLines = new Map(); clearHeat();
  renderDbBtn(); renderTree(); renderTx(); showOut('out'); paint();
}
async function bootDbs() {
  let meta = null; try { meta = JSON.parse(LS.get('orasim.dbs') || 'null'); } catch (e) { }
  if (!meta || !meta.list || !meta.list.length) {
    const id = newId(); dbList = [{ id, name: 'Übung', created: Date.now() }]; activeDb = id; saveDbMeta();
    const old = LS.get('orasim.db');
    if (old) { await KV.set('db:' + id, old); try { localStorage.removeItem('orasim.db'); } catch (e) { } }
  } else { dbList = meta.list; activeDb = dbList.some(d => d.id === meta.active) ? meta.active : dbList[0].id; }
  const am = dbList.find(d => d.id === activeDb);
  if (am && am.remote) {
    const loc = dbList.find(d => !d.remote);
    if (loc) await loadDb(loc.id, true); else { const nid = newId(); dbList.unshift({ id: nid, name: 'Übung', created: Date.now() }); await loadDb(nid, true); }
    switchToRemote(am);
    return;
  }
  await loadDb(activeDb, true);
}
async function loadDb(id, seedIfMissing) {
  if (PL) finishPlay(true);
  if (running) stopRun();
  activeDb = id; saveDbMeta(); renderDbBtn();
  $('#summary').innerHTML = '<span class="running"><span class="spin"></span>Datenbank wird geladen …</span>';
  const st = await KV.get('db:' + id);
  const r = await call({ cmd: 'init', state: st, seed: st ? null : (seedIfMissing ? SEED_SQL : null) });
  if (r.fatal) { toast('Die Datenbank konnte nicht geladen werden.'); return; }
  afterDbLoad(r);
  if (r.warn) toast(r.warn);
}
async function createDb(name, seed) {
  if (PL) finishPlay(true);
  if (running) stopRun();
  const id = newId(); dbList.push({ id, name, created: Date.now() }); activeDb = id; saveDbMeta(); renderDbBtn();
  const r = await call({ cmd: 'reset', seed: seed ? SEED_SQL : null });
  afterDbLoad(r);
  toast('Datenbank „' + name + '“ angelegt' + (seed ? ' – mit Beispielschema.' : '.'));
}
function uniqueDbName(base) { let n = base, k = 2; while (dbList.some(d => d.name === n)) n = base + ' ' + (k++); return n; }
function askName(title, value, okLabel, fn) {
  modal('<h3>' + esc(title) + '</h3><div class="imp"><label style="cursor:auto"><input type="text" id="nameIn" value="' + esc(value) + '" aria-label="Name"></label></div><div class="row"><button class="btn" data-m="no">Abbrechen</button><button class="btn primary" data-m="ok">' + esc(okLabel) + '</button></div>', v => {
    const n = ($('#nameIn').value || '').trim(); closeModal(); if (v === 'ok' && n) fn(n);
  });
  const i = $('#nameIn'); i.focus(); i.select(); i.addEventListener('keydown', e => { if (e.key === 'Enter') $('#dlg .primary').click(); });
}
$('#dbBtn').onclick = (ev) => {
  const cur = activeMeta(); const rem = !!cur.remote;
  const item = d => '<button data-v="sw:' + d.id + '"' + (d.id === activeDb ? ' class="cur"' : '') + '><span>' + (d.remote ? '<i class="ext">extern</i>' : '') + esc(d.name) + '<small>' + (d.remote ? esc(d.remote.label || '') : (d.tables !== undefined ? d.tables + (d.tables === 1 ? ' Tabelle' : ' Tabellen') : '') + (d.size ? ' · ' + fmtSize(d.size) : '')) + '</small></span>' + (d.id === activeDb ? '<span class="chk">✓</span>' : '') + '</button>';
  openPop(ev.currentTarget,
    '<div class="lab">Simulation (im Browser)</div>' + dbList.filter(d => !d.remote).map(item).join('') +
    (dbList.some(d => d.remote) ? '<div class="lab">Externe Oracle-Server</div>' + dbList.filter(d => d.remote).map(item).join('') : '') +
    '<hr><button data-v="newseed">Neue Datenbank mit Beispielschema</button><button data-v="newempty">Neue leere Datenbank</button>' +
    '<button data-v="import">SQL-Dateien importieren …<small>Schema und Daten, z. B. Mondial</small></button>' +
    '<button data-v="connect">Mit Oracle-Server verbinden …<small>Brücke (Oracle Net oder ODBC) oder ORDS</small></button><hr>' +
    (rem ? '<button data-v="edit">Verbindung bearbeiten …</button><button data-v="rename">Umbenennen …</button><button data-v="delete">Aus der Liste entfernen …</button>'
      : '<button data-v="rename">Umbenennen …</button><button data-v="export">Als SQL exportieren</button><button data-v="delete">Löschen …</button>'), v => {
    if (v.startsWith('sw:')) {
      const id = v.slice(3); const m = dbList.find(d => d.id === id); work.classList.remove('side-open');
      if (m && m.remote) { switchToRemote(m); return; }
      if (id !== activeDb) loadDb(id); return;
    }
    if (v === 'newseed') askName('Neue Datenbank mit Beispielschema', uniqueDbName('Übung'), 'Anlegen', n => createDb(n, true));
    else if (v === 'newempty') askName('Neue leere Datenbank', uniqueDbName('Datenbank'), 'Anlegen', n => createDb(n, false));
    else if (v === 'import') $('#importIn').click();
    else if (v === 'connect') openConnect();
    else if (v === 'edit') openConnect(Object.assign({}, cur.remote, { name: cur.name }), cur.id);
    else if (v === 'export') doExport();
    else if (v === 'rename') askName(rem ? 'Verbindung umbenennen' : 'Datenbank umbenennen', cur.name, 'Umbenennen', n => { cur.name = n; saveDbMeta(); renderDbBtn(); });
    else if (v === 'delete' && rem) confirmBox('„' + cur.name + '“ aus der Liste entfernen?', 'Nur der Eintrag in der Sandbox verschwindet – auf dem Server wird nichts gelöscht. Offene, nicht bestätigte Änderungen werden verworfen.', 'Entfernen', async () => {
      if (cur.remote.type === 'bridge') bridgeFetch(cur.remote, '/disconnect', {}).catch(() => { });
      dbList = dbList.filter(d => d.id !== cur.id);
      const loc = dbList.find(d => !d.remote);
      if (loc) await loadDb(loc.id); else { const nid = newId(); dbList.push({ id: nid, name: 'Übung', created: Date.now() }); await loadDb(nid, true); }
      toast('Verbindung entfernt.');
    });
    else if (v === 'delete') confirmBox('Datenbank „' + cur.name + '“ löschen?', 'Alle Tabellen, Daten und Programme dieser Datenbank werden unwiderruflich gelöscht.', 'Löschen', async () => {
      const id = activeDb; await KV.del('db:' + id); dbList = dbList.filter(d => d.id !== id);
      const loc = dbList.find(d => !d.remote);
      if (!loc) { const nid = newId(); dbList.push({ id: nid, name: 'Übung', created: Date.now() }); activeDb = nid; saveDbMeta(); await loadDb(nid, true); }
      else await loadDb(loc.id);
      toast('Datenbank gelöscht.');
    });
  });
};

// Import
function importBase(names) {
  const strip = n => n.replace(/\.[^.]+$/, '').replace(/__\d+_?$|\(\d+\)$/, '').replace(/[-_ .]*(schema|data|daten|create|insert|inserts|ddl|dml|tables|tabellen|struktur|structure)\b.*$/i, '').replace(/[-_ .]+$/, '');
  const b = strip(names[0]) || names[0].replace(/\.[^.]+$/, '');
  return b.charAt(0).toUpperCase() + b.slice(1);
}
async function importFiles(fileObjs) {
  if (!fileObjs.length) return;
  const files = await Promise.all(fileObjs.map(f => f.text().then(text => ({ name: f.name, text, size: f.size }))));
  const score = n => /schema|create|ddl|struct|tabelle|table/i.test(n) ? 0 : /data|daten|insert|dml|inhalt/i.test(n) ? 2 : 1;
  files.sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name));
  const name = uniqueDbName(importBase(files.map(f => f.name)));
  modal('<h3>Datenbank importieren</h3><div class="filelist">' + files.map((f, i) => (i + 1) + '. ' + esc(f.name) + ' · ' + fmtSize(f.size)).join('<br>') + '</div>' +
    '<p>Die Dateien laufen in dieser Reihenfolge – Schema vor Daten. Fehler werden gesammelt, der Import läuft weiter.</p>' +
    '<div class="imp"><label><input type="radio" name="tgt" value="new" checked> In neue Datenbank <input type="text" id="impName" value="' + esc(name) + '" aria-label="Name der neuen Datenbank"></label>' +
    (isRemote() ? '' : '<label><input type="radio" name="tgt" value="cur"> In die aktuelle Datenbank „' + esc(activeMeta().name) + '“</label>') + '</div>' +
    '<div class="row"><button class="btn" data-m="no">Abbrechen</button><button class="btn primary" data-m="ok">Importieren</button></div>', v => {
      if (v !== 'ok') { closeModal(); return; }
      const tgt = document.querySelector('input[name="tgt"]:checked').value; const nm = ($('#impName').value || '').trim() || name;
      doImport(files, tgt, nm);
    });
}
async function doImport(files, tgt, name) {
  if (PL) finishPlay(true);
  if (running) { toast('Bitte warten, bis die laufende Ausführung fertig ist.'); return; }
  if (tgt === 'new') { const id = newId(); dbList.push({ id, name, created: Date.now() }); activeDb = id; saveDbMeta(); renderDbBtn(); }
  modal('<h3>Import läuft …</h3><p id="impInfo">Dateien werden gelesen …</p><div class="prog2"><i id="impBar"></i></div>', () => { });
  running = true;
  const t0 = Date.now();
  const r = await call({ cmd: 'import', fresh: tgt === 'new', files: files.map(f => ({ name: f.name, text: f.text })) }, p => {
    const info = $('#impInfo'), bar = $('#impBar'); if (!info) return;
    info.textContent = 'Datei ' + (p.file + 1) + ' von ' + p.files + ' · ' + p.name + ' · ' + p.done.toLocaleString('de-DE') + ' / ' + p.total.toLocaleString('de-DE') + ' Anweisungen';
    bar.style.width = ((p.file + p.done / p.total) / p.files * 100).toFixed(1) + '%';
  });
  running = false; closeModal(); hideHud();
  if (r.fatal || r.aborted) { toast('Import abgebrochen.'); if (!r.aborted) console.error(r.fatal); return; }
  lastRun = r; catalog = r.catalog; persistState(r.state);
  selected = null; $('#tabObj').hidden = true; errLines = new Map(); clearHeat();
  renderDbBtn(); renderTree(); renderTx(); showOut('out'); paint();
  const nErr = r.files.reduce((a, f) => a + f.errors, 0);
  toast('Import fertig: ' + r.total.toLocaleString('de-DE') + ' Anweisungen in ' + ((Date.now() - t0) / 1000).toFixed(1).replace('.', ',') + ' s' + (nErr ? ', ' + nErr + ' Fehler' : ' – fehlerfrei') + '.');
}
$('#importIn').addEventListener('change', ev => { const fs = Array.from(ev.target.files || []); ev.target.value = ''; importFiles(fs); });
// Drag & Drop
let dragDepth = 0;
const hasFiles = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
document.addEventListener('dragenter', ev => { if (!hasFiles(ev)) return; dragDepth++; $('#dropzone').hidden = false; });
document.addEventListener('dragleave', ev => { if (!hasFiles(ev)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
document.addEventListener('dragover', ev => { if (hasFiles(ev)) ev.preventDefault(); });
document.addEventListener('drop', ev => {
  if (!hasFiles(ev)) return; ev.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
  const fs = Array.from(ev.dataTransfer.files).filter(f => /\.(sql|txt|pls|pks|pkb)$/i.test(f.name) || f.type === 'text/plain');
  if (fs.length) importFiles(fs); else toast('Nur .sql- oder .txt-Dateien lassen sich importieren.');
});
