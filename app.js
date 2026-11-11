(() => {
  'use strict';
  const P = window.TodoParser;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- storage ---------- */
  const LS_ITEMS = 'todo.v1.items', LS_SET = 'todo.v1.settings', LS_META = 'todo.v1.meta';
  function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Could not save on this device'); } }

  let items = load(LS_ITEMS, []);
  let settings = Object.assign({ owner: '', repo: '', path: 'todos.json', branch: '', token: '' }, load(LS_SET, {}));
  let meta = Object.assign({ dirty: false, lastSyncAt: null, lastError: null }, load(LS_META, {}));
  let localVersion = 0;

  /* ---------- dates ---------- */
  const todayKey = () => P.ymd(new Date());
  let selected = todayKey();
  let weekStart = P.mondayOf(new Date());
  let lastTodayKey = todayKey();

  const fmtTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
  };
  const fmtShort = (key) => P.fromYmd(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  /* ---------- data ops ---------- */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const find = (id) => items.find((i) => i.id === id);

  function commit() {
    localVersion++;
    save(LS_ITEMS, items);
    meta.dirty = true;
    save(LS_META, meta);
    render();
    scheduleSync();
  }
  function addItem({ text, date, time }) {
    const now = Date.now();
    items.push({ id: uid(), text, date, time: time || null, done: false, doneAt: null, createdAt: now, updatedAt: now, deleted: false });
    commit();
  }
  function toggle(id) {
    const it = find(id); if (!it) return;
    it.done = !it.done; it.doneAt = it.done ? Date.now() : null; it.updatedAt = Date.now();
    save('todo.v1.tipSeen', true);
    commit();
  }
  function updateItem(id, patch) {
    const it = find(id); if (!it) return;
    Object.assign(it, patch, { updatedAt: Date.now() });
    commit();
  }
  function removeItem(id) { updateItem(id, { deleted: true }); }

  function merge(a, b) {
    const map = new Map();
    for (const it of [...a, ...b]) {
      const cur = map.get(it.id);
      if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) map.set(it.id, it);
    }
    const cutoff = Date.now() - 30 * 864e5; // drop old tombstones
    return [...map.values()].filter((i) => !(i.deleted && (i.updatedAt || 0) < cutoff));
  }

  /* ---------- rendering ---------- */
  function render() { renderHeader(); renderWeek(); renderList(); renderStatus(); }

  function renderHeader() {
    const today = todayKey();
    const tomorrow = P.ymd(P.addDays(new Date(), 1));
    const yesterday = P.ymd(P.addDays(new Date(), -1));
    const d = P.fromYmd(selected);
    $('#kicker').textContent = selected === today ? 'Today' : selected === tomorrow ? 'Tomorrow' : selected === yesterday ? 'Yesterday'
      : 'Week of ' + P.mondayOf(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('#title').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    $('#todayBtn').hidden = selected === today;
  }

  function renderWeek() {
    const today = todayKey();
    const live = items.filter((i) => !i.deleted && !i.done);
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = P.addDays(weekStart, i);
      const key = P.ymd(d);
      const n = live.filter((x) => x.date === key).length;
      const dots = '<i></i>'.repeat(Math.min(n, 3));
      html += `<button class="day${key === selected ? ' sel' : ''}${key === today ? ' today' : ''}${key < today ? ' past' : ''}" data-key="${key}" aria-label="${esc(fmtShort(key))}${n ? ', ' + n + ' open' : ''}">
        <span class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3)}</span>
        <span class="num">${d.getDate()}</span><span class="dots">${dots}</span></button>`;
    }
    $('#days').innerHTML = html;
  }

  function sortDay(list) {
    return list.slice().sort((a, b) => {
      if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      if (a.time) return -1;
      if (b.time) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  function rowHtml(i, opts) {
    opts = opts || {};
    const bits = [];
    if (opts.showDate) bits.push(`<span class="when">${esc(fmtShort(i.date))}</span>`);
    if (i.time) bits.push(`<span class="time">${fmtTime(i.time)}</span>`);
    return `<li class="row${i.done ? ' done' : ''}${opts.overdue ? ' overdue' : ''}" data-id="${i.id}">
      <button class="check" aria-label="${i.done ? 'Mark not done' : 'Mark done'}"></button>
      <div class="body"><span class="txt">${esc(i.text)}</span>${bits.length ? `<div class="meta">${bits.join('')}</div>` : ''}</div>${opts.overdue ? '<button class="mv" aria-label="Move to today">→ Today</button>' : ''}</li>`;
  }

  function renderList() {
    const live = items.filter((i) => !i.deleted);
    const today = todayKey();
    const day = live.filter((i) => i.date === selected);
    const open = sortDay(day.filter((i) => !i.done));
    const done = day.filter((i) => i.done).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
    const overdue = selected === today
      ? live.filter((i) => !i.done && i.date < today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)))
      : [];
    let html = '';
    if (overdue.length) {
      html += `<div class="section warn">Overdue</div><ul class="rows">${overdue.map((i) => rowHtml(i, { overdue: true, showDate: true })).join('')}</ul>`;
    }
    if (open.length) {
      if (overdue.length) html += '<div class="section">Today</div>';
      html += `<ul class="rows" style="${overdue.length ? 'margin-top:0' : ''}">${open.map((i) => rowHtml(i)).join('')}</ul>`;
    }
    if (done.length) {
      html += `<div class="section">Done · ${done.length}</div><ul class="rows">${done.map((i) => rowHtml(i)).join('')}</ul>`;
    }
    if (!open.length && !done.length && !overdue.length) {
      html = `<div class="empty">${selected === today ? 'Nothing on the list.<br>Tap Add and say it.' : 'Nothing planned for this day.'}</div>`;
    } else if (!open.length && !overdue.length) {
      html = `<div class="empty" style="padding:24px 20px 0">All done for the day ✓</div>` + html;
    }
    if ((open.length || overdue.length) && !load('todo.v1.tipSeen', false)) {
      html += '<p class="tip">Tap the circle to mark a task done. Tap the task to edit it.</p>';
    }
    $('#list').innerHTML = html;
  }

  /* ---------- navigation ---------- */
  function selectDay(key) { selected = key; weekStart = P.mondayOf(P.fromYmd(key)); render(); }
  function shiftDays(n) { selectDay(P.ymd(P.addDays(P.fromYmd(selected), n))); }

  function tickDay() {
    const now = todayKey();
    if (now !== lastTodayKey) {
      const followToday = selected === lastTodayKey;
      lastTodayKey = now;
      if (followToday) selectDay(now); else render();
    }
  }

  /* ---------- add / edit sheet ---------- */
  const S = { mode: 'add', id: null, dateTouched: false, timeTouched: false, defaultDate: null };

  function openSheet(mode, item) {
    S.mode = mode; S.id = item ? item.id : null; S.dateTouched = false; S.timeTouched = false;
    const editing = mode === 'edit';
    $('#sTitle').textContent = editing ? 'Edit task' : mode === 'followup' ? 'Follow up' : 'New task';
    $('#sSave').textContent = editing ? 'Save' : 'Add';
    $('#sDelete').hidden = !editing;
    $('#sFollow').hidden = !editing;
    $('#sHint').hidden = editing;
    $('#sPreview').hidden = editing;
    if (editing) {
      $('#sText').value = item.text; $('#sDate').value = item.date; $('#sTime').value = item.time || '';
      S.dateTouched = S.timeTouched = true;
    } else if (mode === 'followup') {
      S.defaultDate = P.ymd(P.addDays(new Date(), 1));
      $('#sText').value = 'Follow up: ' + item.text; $('#sDate').value = S.defaultDate; $('#sTime').value = '';
    } else {
      S.defaultDate = selected;
      $('#sText').value = ''; $('#sDate').value = selected; $('#sTime').value = '';
    }
    $('#sPreview').textContent = '';
    $('#sheet').hidden = false;
    const t = $('#sText');
    t.focus();
    try { t.setSelectionRange(t.value.length, t.value.length); } catch (e) { /* ignore */ }
    if (!editing) reparse();
  }
  function closeSheet() { $('#sheet').hidden = true; if (document.activeElement) document.activeElement.blur(); }

  function reparse() {
    if (S.mode === 'edit') return;
    const raw = $('#sText').value;
    const r = P.parse(raw);
    if (!S.dateTouched) $('#sDate').value = r.dateFound ? r.date : S.defaultDate;
    if (!S.timeTouched) $('#sTime').value = r.timeFound ? r.time : '';
    $('#sPreview').textContent = raw.trim() ? '→ ' + r.text : '';
  }

  function saveSheet() {
    const raw = $('#sText').value.trim();
    if (!raw) { toast('Say or type a task first'); return; }
    const date = $('#sDate').value || S.defaultDate || selected;
    const time = $('#sTime').value || null;
    if (S.mode === 'edit') {
      updateItem(S.id, { text: raw, date, time });
    } else {
      addItem({ text: P.parse(raw).text, date, time });
      if (date !== selected) selectDay(date);
    }
    closeSheet();
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ---------- GitHub sync ---------- */
  const configured = () => !!(settings.owner && settings.repo && settings.token && settings.path);
  let syncing = false, pendingSync = false, syncTimer;

  const utf8ToB64 = (str) => { let bin = ''; new TextEncoder().encode(str).forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
  const b64ToUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

  class SyncError extends Error {}
  const errFor = (status) =>
    status === 401 ? new SyncError('GitHub rejected the token (wrong or expired). Make a new one in GitHub settings.')
      : status === 403 ? new SyncError('Token lacks permission (needs Contents: read & write on this repo), or GitHub is rate limiting.')
        : new SyncError('GitHub returned error ' + status + '.');

  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 1500); }

  async function sync(manual) {
    if (!configured()) { renderStatus(); return; }
    if (syncing) { pendingSync = true; return; }
    if (!navigator.onLine) { renderStatus(); if (manual) toast('Offline. Will sync when you are back online.'); return; }
    syncing = true; renderStatus();
    const headers = { Authorization: 'Bearer ' + settings.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const repoUrl = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo);
    const fileUrl = repoUrl + '/contents/' + settings.path.split('/').map(encodeURIComponent).join('/');
    try {
      const startVersion = localVersion;
      const res = await fetch(fileUrl + (settings.branch ? '?ref=' + encodeURIComponent(settings.branch) : ''), { headers, cache: 'no-store' });
      let sha = null, remoteItems = [];
      if (res.status === 200) {
        const j = await res.json();
        sha = j.sha;
        const parsed = JSON.parse(b64ToUtf8(j.content));
        remoteItems = Array.isArray(parsed.items) ? parsed.items : [];
      } else if (res.status === 404) {
        const rr = await fetch(repoUrl, { headers, cache: 'no-store' });
        if (rr.status === 401) throw errFor(401);
        if (rr.status !== 200) throw new SyncError('Repo not found, or the token has no access to it. Check the username, repo name and token.');
        // repo exists, file does not yet: it will be created below
      } else {
        throw errFor(res.status);
      }

      const merged = merge(items, remoteItems);
      const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const differs = JSON.stringify(remoteItems.slice().sort(byId)) !== JSON.stringify(merged.slice().sort(byId));
      let conflict = false;

      if (sha === null || differs) {
        const body = {
          message: 'Sync ' + new Date().toISOString(),
          content: utf8ToB64(JSON.stringify({ version: 1, items: merged }, null, 1))
        };
        if (sha) body.sha = sha;
        if (settings.branch) body.branch = settings.branch;
        const put = await fetch(fileUrl, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
        if (put.status === 409 || put.status === 422) conflict = true; // file changed under us: loop once more
        else if (!put.ok) throw errFor(put.status);
      }

      items = merge(items, merged);
      save(LS_ITEMS, items);
      if (conflict) {
        pendingSync = true;
      } else {
        if (localVersion === startVersion) meta.dirty = false; else pendingSync = true;
        meta.lastSyncAt = Date.now(); meta.lastError = null;
      }
      save(LS_META, meta);
    } catch (e) {
      if (e instanceof SyncError) { meta.lastError = e.message; save(LS_META, meta); }
      else if (manual) toast('No connection. Will retry.'); // network failure: stay "not synced yet"
    } finally {
      syncing = false;
      render();
      if (pendingSync) { pendingSync = false; setTimeout(() => sync(), 400); }
    }
  }

  function renderStatus() {
    let state, label;
    if (!configured()) { state = 'off'; label = 'Set up sync'; }
    else if (syncing) { state = 'busy'; label = 'Syncing…'; }
    else if (meta.lastError) { state = 'err'; label = 'Sync problem'; }
    else if (meta.dirty) { state = 'pending'; label = 'Not synced yet'; }
    else { state = 'ok'; label = 'Synced'; }
    $('#syncBtn').dataset.state = state;
    $('#syncText').textContent = label;
  }

  /* ---------- settings sheet ---------- */
  function openSettings() {
    $('#gOwner').value = settings.owner; $('#gRepo').value = settings.repo; $('#gPath').value = settings.path;
    $('#gToken').value = settings.token; $('#gBranch').value = settings.branch;
    refreshGStatus();
    $('#settings').hidden = false;
  }
  function refreshGStatus() {
    const el = $('#gStatus');
    el.classList.toggle('err', !!meta.lastError);
    el.textContent = meta.lastError ? meta.lastError
      : meta.lastSyncAt ? 'Last synced ' + new Date(meta.lastSyncAt).toLocaleString()
        : configured() ? 'Not synced yet.' : 'Sync is off. Fill in the fields below to turn it on.';
  }
  function saveSettings() {
    settings = {
      owner: $('#gOwner').value.trim(), repo: $('#gRepo').value.trim(),
      path: $('#gPath').value.trim() || 'todos.json', token: $('#gToken').value.trim(), branch: $('#gBranch').value.trim()
    };
    save(LS_SET, settings);
    meta.lastError = null; save(LS_META, meta);
    renderStatus();
    if (!configured()) { refreshGStatus(); toast('Fill in username, repo and token'); return; }
    sync(true).then(() => { refreshGStatus(); if (!meta.lastError) toast('Synced'); });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tasks-' + todayKey() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function importJson(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const incoming = Array.isArray(data) ? data : data.items;
        if (!Array.isArray(incoming)) throw new Error('bad file');
        const valid = incoming.filter((i) => i && i.id && i.text && /^\d{4}-\d{2}-\d{2}$/.test(i.date || ''));
        items = merge(items, valid);
        commit();
        toast('Imported ' + valid.length + ' tasks');
      } catch (e) { toast('That file is not a valid export'); }
    };
    r.readAsText(file);
  }

  /* ---------- theme ---------- */
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#themeBtn').textContent = t === 'dark' ? '☀︎' : '☾';
    const m = $('#themeColor'); if (m) m.setAttribute('content', t === 'dark' ? '#0a1020' : '#f3f6fb');
  }
  function toggleTheme() { const t = currentTheme() === 'dark' ? 'light' : 'dark'; save('todo.v1.theme', t); applyTheme(t); }

  /* ---------- wiring ---------- */
  function wire() {
    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#days').addEventListener('click', (e) => { const b = e.target.closest('.day'); if (b) selectDay(b.dataset.key); });
    $('#prevWk').addEventListener('click', () => shiftDays(-7));
    $('#nextWk').addEventListener('click', () => shiftDays(7));
    $('#todayBtn').addEventListener('click', () => selectDay(todayKey()));
    $('#fab').addEventListener('click', () => openSheet('add'));
    $('#gearBtn').addEventListener('click', openSettings);
    $('#syncBtn').addEventListener('click', () => {
      if (!configured()) openSettings();
      else if (meta.lastError) openSettings();
      else sync(true).then(() => { if (!meta.lastError && !meta.dirty) toast('Synced'); });
    });

    $('#list').addEventListener('click', (e) => {
      const row = e.target.closest('.row'); if (!row) return;
      if (e.target.closest('.mv')) { updateItem(row.dataset.id, { date: todayKey() }); toast('Moved to today'); }
      else if (e.target.closest('.check')) toggle(row.dataset.id);
      else { const it = find(row.dataset.id); if (it) openSheet('edit', it); }
    });

    let sx = 0, sy = 0;
    $('#list').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    $('#list').addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 40) shiftDays(dx < 0 ? 1 : -1);
    }, { passive: true });

    $('#sText').addEventListener('input', reparse);
    $('#sText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveSheet(); } });
    $('#sDate').addEventListener('change', () => { S.dateTouched = true; });
    $('#sTime').addEventListener('change', () => { S.timeTouched = true; });
    $('#sClearTime').addEventListener('click', () => { $('#sTime').value = ''; S.timeTouched = true; });
    $('#sSave').addEventListener('click', saveSheet);
    $('#sCancel').addEventListener('click', closeSheet);
    $('#sDelete').addEventListener('click', () => { removeItem(S.id); closeSheet(); toast('Deleted'); });
    $('#sFollow').addEventListener('click', () => { const it = find(S.id); if (it) openSheet('followup', it); });
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

    $('#gSave').addEventListener('click', saveSettings);
    $('#gClose').addEventListener('click', () => { $('#settings').hidden = true; });
    $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; });
    $('#gExport').addEventListener('click', exportJson);
    $('#gImportBtn').addEventListener('click', () => $('#gImport').click());
    $('#gImport').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickDay(); sync(); } });
    window.addEventListener('online', () => sync());
    window.addEventListener('focus', tickDay);
    setInterval(tickDay, 30000);
  }

  /* ---------- boot ---------- */
  function boot() {
    wire();
    applyTheme(currentTheme());
    render();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* ignore */ }
    sync();
  }
  boot();

  // exposed for tests only
  window.__todo = { sync, get items() { return items; }, get meta() { return meta; }, setSettings(s) { settings = Object.assign(settings, s); save(LS_SET, settings); renderStatus(); } };
})();
