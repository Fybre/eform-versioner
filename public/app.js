'use strict';

const state = {
  connected: false,
  tenant: null,
  forms: [],
  currentForm: null,
  versions: [],
  snapshots: [],
  compare: { from: null, to: null }, // { kind: 'version'|'snapshot', id, label }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#${name}View`).classList.remove('hidden');
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = isError ? 'var(--danger)' : 'var(--text)';
  el.style.color = isError ? 'white' : 'var(--bg)';
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON (e.g. image) handled by caller */ }
  if (!res.ok) {
    const message = (json && json.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

// ---------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------

async function checkSession() {
  const info = await api('/session');
  if (info.connected) {
    state.connected = true;
    state.tenant = info.tenant;
    enterConnectedUi();
    await loadCatalog();
  } else {
    showView('connect');
  }
}

function enterConnectedUi() {
  $('#connectionStatus').classList.remove('hidden');
  $('#connTenant').textContent = state.tenant;
  showView('list');
}

$('#connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tenant = $('#tenantInput').value.trim();
  const username = $('#usernameInput').value.trim();
  const password = $('#passwordInput').value;
  const btn = $('#connectBtn');
  const errEl = $('#connectError');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const info = await api('/session/connect', { method: 'POST', body: { tenant, username, password } });
    state.connected = true;
    state.tenant = info.tenant;
    enterConnectedUi();
    await loadCatalog();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

$('#disconnectBtn').addEventListener('click', async () => {
  await api('/session/disconnect', { method: 'POST' });
  state.connected = false;
  state.forms = [];
  $('#connectionStatus').classList.add('hidden');
  $('#passwordInput').value = '';
  showView('connect');
});

// ---------------------------------------------------------------------------------
// Forms catalog
// ---------------------------------------------------------------------------------

async function loadCatalog() {
  // GET /eforms auto-fetches from Therefore on the server when nothing's cached yet for this
  // tenant, so the first visit can take a moment — show a status line for that case.
  const status = $('#scanStatus');
  status.classList.remove('hidden');
  status.textContent = 'Loading eForms…';
  try {
    const data = await api('/eforms');
    state.forms = data.forms;
    renderFormsTable();
  } finally {
    status.classList.add('hidden');
  }
}

function renderFormsTable() {
  const q = $('#formSearch').value.trim().toLowerCase();
  const filtered = state.forms.filter(
    (f) => !q || (f.name || '').toLowerCase().includes(q) || (f.folderName || '').toLowerCase().includes(q)
  );
  const tbody = $('#formsTableBody');
  tbody.innerHTML = '';
  for (const f of filtered) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${f.formNo}</td>
      <td>${escapeHtml(f.name || '')}</td>
      <td>${escapeHtml(f.folderName || '')}</td>
      <td>v${f.latestVersionNo}</td>
    `;
    tr.addEventListener('click', () => openForm(f.formNo));
    tbody.appendChild(tr);
  }
  $('#formsTable').classList.toggle('hidden', state.forms.length === 0);
  $('#emptyState').classList.toggle('hidden', state.forms.length !== 0);
}

$('#formSearch').addEventListener('input', renderFormsTable);

$('#scanBtn').addEventListener('click', async () => {
  const btn = $('#scanBtn');
  const status = $('#scanStatus');
  btn.disabled = true;
  status.classList.remove('hidden');
  status.textContent = 'Fetching eForms…';
  try {
    const data = await api('/eforms/scan', { method: 'POST', body: {} });
    status.textContent = `Found ${data.count} eForm(s).`;
    await loadCatalog();
  } catch (err) {
    status.textContent = `Refresh failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => status.classList.add('hidden'), 5000);
  }
});

// ---------------------------------------------------------------------------------
// Form detail
// ---------------------------------------------------------------------------------

$('#backBtn').addEventListener('click', async () => {
  showView('list');
  state.currentForm = null;
  await loadCatalog(); // picks up any version created while viewing this form's detail
});

async function openForm(formNo) {
  showView('detail');
  $('#detailName').textContent = 'Loading…';
  $('#detailMeta').textContent = '';
  $('#versionsList').innerHTML = '';
  $('#snapshotsList').innerHTML = '';
  $('#comparePanel').classList.add('hidden');
  state.compare = { from: null, to: null };

  const meta = await api(`/eforms/${formNo}`);
  state.currentForm = meta;
  $('#detailName').textContent = meta.name;
  $('#detailMeta').textContent = `Form No ${meta.formNo} · Folder: ${meta.folderName || '—'} · Latest version v${meta.latestVersionNo}`;

  await Promise.all([loadVersions(formNo), loadSnapshots(formNo)]);

  // Default compare: latest vs. previous version, if one exists.
  if (state.versions.length >= 2) {
    setCompareSide('to', 'version', state.versions[0].versionNo, `Version ${state.versions[0].versionNo}`);
    setCompareSide('from', 'version', state.versions[1].versionNo, `Version ${state.versions[1].versionNo}`);
  }
}

async function loadVersions(formNo) {
  const data = await api(`/eforms/${formNo}/versions`);
  state.versions = data.versions;
  const list = $('#versionsList');
  list.innerHTML = '';
  for (const v of data.versions) {
    const row = document.createElement('div');
    row.className = 'version-row';
    const isLatest = v.versionNo === data.latestVersionNo;
    row.innerHTML = `
      <div class="v-main">
        <div>
          <span class="version-badge ${isLatest ? 'latest-badge' : ''}">v${v.versionNo}${isLatest ? ' · latest' : ''}</span>
        </div>
        <span class="muted small">${v.created ? new Date(v.created).toLocaleString() : ''} ${v.createdByUserName ? '· ' + escapeHtml(v.createdByUserName) : ''}</span>
      </div>
      <div class="row-actions">
        <button data-act="from" class="secondary-btn">Set as From</button>
        <button data-act="to" class="secondary-btn">Set as To</button>
        ${isLatest ? '' : '<button data-act="revert" class="danger-btn">Revert to this</button>'}
      </div>
    `;
    row.querySelector('[data-act="from"]').addEventListener('click', () => setCompareSide('from', 'version', v.versionNo, `Version ${v.versionNo}`));
    row.querySelector('[data-act="to"]').addEventListener('click', () => setCompareSide('to', 'version', v.versionNo, `Version ${v.versionNo}`));
    const revertBtn = row.querySelector('[data-act="revert"]');
    if (revertBtn) revertBtn.addEventListener('click', () => confirmRevert({ fromVersionNo: v.versionNo }, `version ${v.versionNo}`));
    list.appendChild(row);
  }
}

async function loadSnapshots(formNo) {
  const data = await api(`/eforms/${formNo}/snapshots`);
  state.snapshots = data.snapshots;
  const list = $('#snapshotsList');
  list.innerHTML = '';
  if (data.snapshots.length === 0) {
    list.innerHTML = '<p class="muted small">No offline snapshots yet.</p>';
    return;
  }
  for (const s of data.snapshots) {
    const row = document.createElement('div');
    row.className = 'snapshot-row';
    row.innerHTML = `
      <div class="s-main">
        <div><strong>${escapeHtml(s.label || 'Untitled')}</strong></div>
        <span class="muted small">from v${s.sourceVersionNo} · ${new Date(s.createdAt).toLocaleString()} ${s.createdBy ? '· ' + escapeHtml(s.createdBy) : ''}</span>
        ${s.notes ? `<span class="muted small">${escapeHtml(s.notes)}</span>` : ''}
      </div>
      <div class="row-actions">
        <button data-act="from" class="secondary-btn">Set as From</button>
        <button data-act="to" class="secondary-btn">Set as To</button>
        <button data-act="restore" class="danger-btn">Restore</button>
        <button data-act="delete" class="link-btn">delete</button>
      </div>
    `;
    row.querySelector('[data-act="from"]').addEventListener('click', () => setCompareSide('from', 'snapshot', s.id, `Snapshot: ${s.label}`));
    row.querySelector('[data-act="to"]').addEventListener('click', () => setCompareSide('to', 'snapshot', s.id, `Snapshot: ${s.label}`));
    row.querySelector('[data-act="restore"]').addEventListener('click', () => confirmRevert({ snapshotId: s.id }, `snapshot "${s.label}"`));
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete snapshot "${s.label}"? This cannot be undone.`)) return;
      await api(`/eforms/${state.currentForm.formNo}/snapshots/${s.id}`, { method: 'DELETE' });
      await loadSnapshots(state.currentForm.formNo);
    });
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------------
// New version / snapshot actions
// ---------------------------------------------------------------------------------

$('#newVersionBtn').addEventListener('click', async () => {
  if (!state.currentForm) return;
  const btn = $('#newVersionBtn');
  btn.disabled = true;
  try {
    const res = await api(`/eforms/${state.currentForm.formNo}/new-version`, { method: 'POST', body: {} });
    toast(`Created version ${res.versionNo}. Go edit it in Therefore's eForm designer.`);
    await openForm(state.currentForm.formNo);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#snapshotBtn').addEventListener('click', () => {
  if (!state.currentForm) return;
  openModal({
    title: 'Take an offline snapshot',
    body: `
      <label>Label<input type="text" id="snapLabel" value="Snapshot of v${state.currentForm.latestVersionNo}" /></label>
      <label>Notes (optional)<textarea id="snapNotes" rows="3" style="width:100%;padding:9px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);"></textarea></label>
    `,
    confirmText: 'Save snapshot',
    onConfirm: async () => {
      const label = document.getElementById('snapLabel').value.trim();
      const notes = document.getElementById('snapNotes').value.trim();
      await api(`/eforms/${state.currentForm.formNo}/snapshots`, { method: 'POST', body: { label, notes } });
      toast('Offline snapshot saved.');
      await loadSnapshots(state.currentForm.formNo);
    },
  });
});

async function confirmRevert(payload, label) {
  if (!confirm(`Revert to ${label}? This creates a brand-new version in Therefore with that content — nothing is overwritten or deleted.`)) return;
  try {
    const res = await api(`/eforms/${state.currentForm.formNo}/revert`, { method: 'POST', body: payload });
    toast(`Reverted: created version ${res.versionNo} from ${res.revertedFrom}.`);
    await openForm(state.currentForm.formNo);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------------
// Compare / diff
// ---------------------------------------------------------------------------------

function setCompareSide(side, kind, id, label) {
  state.compare[side] = { kind, id, label };
  updateCompareUi();
}

async function updateCompareUi() {
  const { from, to } = state.compare;
  $('#compareFrom').textContent = from ? from.label : '—';
  $('#compareTo').textContent = to ? to.label : '—';

  if (!from || !to) {
    $('#comparePanel').classList.remove('hidden');
    $('#diffSummary').innerHTML = '<p class="muted small">Pick a "From" and "To" version or snapshot above to compare.</p>';
    $('#diffDetails').innerHTML = '';
    $('#revertHereBtn').classList.add('hidden');
    return;
  }

  $('#comparePanel').classList.remove('hidden');
  $('#diffSummary').innerHTML = '<p class="muted small">Loading diff…</p>';
  $('#screenshotFrom').src = `/api/eforms/${state.currentForm.formNo}/screenshot?${sideQuery(from)}`;
  $('#screenshotTo').src = `/api/eforms/${state.currentForm.formNo}/screenshot?${sideQuery(to)}`;
  $('#screenshotFrom').onerror = () => { $('#screenshotFrom').style.display = 'none'; };
  $('#screenshotTo').onerror = () => { $('#screenshotTo').style.display = 'none'; };
  $('#screenshotFrom').style.display = '';
  $('#screenshotTo').style.display = '';

  const revertBtn = $('#revertHereBtn');
  revertBtn.classList.remove('hidden');
  revertBtn.onclick = () => {
    const payload = from.kind === 'snapshot' ? { snapshotId: from.id } : { fromVersionNo: from.id };
    confirmRevert(payload, from.label);
  };

  try {
    const params = new URLSearchParams({
      fromKind: from.kind, from: from.id, toKind: to.kind, to: to.id,
    });
    const data = await api(`/eforms/${state.currentForm.formNo}/diff?${params.toString()}`);
    renderDiff(data.diff);
  } catch (err) {
    $('#diffSummary').innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    $('#diffDetails').innerHTML = '';
  }
}

function sideQuery(side) {
  return side.kind === 'snapshot' ? `snapshotId=${side.id}` : `versionNo=${side.id}`;
}

function renderDiff(diff) {
  const s = diff.summary;
  const pills = [];
  if (s.identical) {
    pills.push('<span class="diff-pill pill-identical">No differences</span>');
  } else {
    if (s.componentsAdded) pills.push(`<span class="diff-pill pill-added">+${s.componentsAdded} added</span>`);
    if (s.componentsRemoved) pills.push(`<span class="diff-pill pill-removed">−${s.componentsRemoved} removed</span>`);
    if (s.componentsChanged) pills.push(`<span class="diff-pill pill-changed">${s.componentsChanged} changed</span>`);
  }
  $('#diffSummary').innerHTML = pills.join('');

  const details = $('#diffDetails');
  details.innerHTML = '';

  if (diff.meta && diff.meta.length) {
    details.appendChild(buildDiffGroup('Form metadata', diff.meta.map((m) => `<div class="diff-item"><span class="path">${escapeHtml(m.field)}</span><div class="field-change"><b>${escapeHtml(String(m.from))}</b> → <b>${escapeHtml(String(m.to))}</b></div></div>`)));
  }
  if (diff.added && diff.added.length) {
    details.appendChild(buildDiffGroup('Added fields', diff.added.map((c) => `<div class="diff-item"><span class="path">${escapeHtml(c.label || c.path)}</span> <span class="muted small">(${escapeHtml(c.type || '')}, key: ${escapeHtml(c.key || c.path)})</span></div>`)));
  }
  if (diff.removed && diff.removed.length) {
    details.appendChild(buildDiffGroup('Removed fields', diff.removed.map((c) => `<div class="diff-item"><span class="path">${escapeHtml(c.label || c.path)}</span> <span class="muted small">(${escapeHtml(c.type || '')}, key: ${escapeHtml(c.key || c.path)})</span></div>`)));
  }
  if (diff.changed && diff.changed.length) {
    details.appendChild(
      buildDiffGroup(
        'Changed fields',
        diff.changed.map(
          (c) => `<div class="diff-item"><span class="path">${escapeHtml(c.label || c.path)}</span>` +
            c.changes.map((fc) => `<div class="field-change">${escapeHtml(fc.field)}: <b>${escapeHtml(String(fc.from))}</b> → <b>${escapeHtml(String(fc.to))}</b></div>`).join('') +
            `</div>`
        )
      )
    );
  }
}

function buildDiffGroup(title, itemsHtml) {
  const div = document.createElement('div');
  div.className = 'diff-group';
  div.innerHTML = `<h3>${escapeHtml(title)}</h3>${itemsHtml.join('')}`;
  return div;
}

// ---------------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------------

function openModal({ title, body, confirmText, onConfirm }) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${escapeHtml(title)}</h2>
        <div>${body}</div>
        <div class="modal-actions">
          <button class="secondary-btn" id="modalCancel">Cancel</button>
          <button class="primary-btn" id="modalConfirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    </div>
  `;
  root.querySelector('#modalCancel').addEventListener('click', () => { root.innerHTML = ''; });
  root.querySelector('#modalConfirm').addEventListener('click', async () => {
    const btn = root.querySelector('#modalConfirm');
    btn.disabled = true;
    try {
      await onConfirm();
      root.innerHTML = '';
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

checkSession();
