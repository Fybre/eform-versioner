'use strict';

const express = require('express');
const { ThereforeClient, ThereforeApiError } = require('../lib/thereforeClient');
const { scanForms } = require('../lib/scanner');
const { diffFormDefinitions } = require('../lib/diff');
const { decodeToJson, decodeToString, encodeFromString } = require('../lib/formCodec');
const { renderFormScreenshot } = require('../lib/render');
const { db } = require('../lib/db');

const router = express.Router();

function requireSession(req, res, next) {
  if (!req.session.therefore) return res.status(401).json({ error: 'Not connected. Connect to a tenant first.' });
  next();
}
router.use(requireSession);

function clientFor(req) {
  const t = req.session.therefore;
  return new ThereforeClient(t);
}

function tenantKey(req) {
  const t = req.session.therefore;
  return t.tenantName || t.tenantInput;
}

function handleApiError(res, err) {
  if (err instanceof ThereforeApiError) {
    return res.status(502).json({ error: err.message, wsError: err.wsError || null });
  }
  console.error(err);
  return res.status(500).json({ error: err.message || 'Internal error' });
}

// ---- Catalog (list of known eForms) ----------------------------------------------------

const upsertCatalogRow = db.prepare(`
  INSERT INTO forms_catalog (tenant, form_no, name, folder_no, folder_name, latest_version_no, scanned_at)
  VALUES (@tenant, @formNo, @name, @folderNo, @folderName, @latestVersionNo, @scannedAt)
  ON CONFLICT(tenant, form_no) DO UPDATE SET
    name=excluded.name, folder_no=excluded.folder_no, folder_name=excluded.folder_name,
    latest_version_no=excluded.latest_version_no, scanned_at=excluded.scanned_at
`);

function upsertCatalog(tenant, items) {
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const f of rows) {
      upsertCatalogRow.run({ tenant, formNo: f.formNo, name: f.name, folderNo: f.folderNo, folderName: f.folderName, latestVersionNo: f.latestVersionNo, scannedAt: now });
    }
  });
  tx(items);
}

function readCatalog(tenant) {
  const rows = db.prepare('SELECT * FROM forms_catalog WHERE tenant = ? ORDER BY form_no').all(tenant);
  return rows.map((r) => ({
    formNo: r.form_no,
    name: r.name,
    folderNo: r.folder_no,
    folderName: r.folder_name,
    latestVersionNo: r.latest_version_no,
    scannedAt: r.scanned_at,
  }));
}

/** If nothing's cached yet for this tenant (first visit), fetch it automatically instead of showing an empty list. */
router.get('/', async (req, res) => {
  const tenant = tenantKey(req);
  let forms = readCatalog(tenant);
  if (forms.length === 0) {
    try {
      const found = await scanForms(clientFor(req), {});
      upsertCatalog(tenant, found);
      forms = readCatalog(tenant);
    } catch (err) {
      return handleApiError(res, err);
    }
  }
  res.json({ forms });
});

/** Refreshes a single form's catalog row after an action that creates a new version, so the list view stays current without a full rescan. */
async function refreshCatalogEntry(req, client, formNo) {
  try {
    const ev = await client.getEForm(formNo, 0);
    let folderName = null;
    if (ev.FolderNo) {
      try {
        const folder = await client.getFolder(ev.FolderNo);
        folderName = folder ? folder.Name : null;
      } catch {
        folderName = null;
      }
    }
    upsertCatalog(tenantKey(req), [{ formNo: ev.FormNo, name: ev.Name, folderNo: ev.FolderNo, folderName, latestVersionNo: ev.VersionNo }]);
  } catch {
    // Best-effort — the action itself already succeeded, so don't fail the request over a cache refresh.
  }
}

router.post('/scan', async (req, res) => {
  const client = clientFor(req);
  const { maxProbe, missStreakStop } = req.body || {};
  try {
    const found = await scanForms(client, {
      maxProbe: Number(maxProbe) || 2000,
      missStreakStop: Number(missStreakStop) || 60,
    });
    upsertCatalog(tenantKey(req), found);
    res.json({ ok: true, count: found.length, forms: found });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---- Single form + versions --------------------------------------------------------------

router.get('/:formNo', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  try {
    const latest = await client.getEForm(formNo, 0);
    let folderName = null;
    if (latest.FolderNo) {
      try {
        const folder = await client.getFolder(latest.FolderNo);
        folderName = folder ? folder.Name : null;
      } catch {
        folderName = null;
      }
    }
    res.json({
      formNo: latest.FormNo,
      name: latest.Name,
      folderNo: latest.FolderNo,
      folderName,
      latestVersionNo: latest.VersionNo,
      created: latest.CreatedISO8601,
      createdByUserName: latest.CreatedByUserName,
      anonymousAccessEnabled: latest.AnonymousAccessEnabled,
      guid: latest.Guid,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

router.get('/:formNo/versions', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  try {
    const latest = await client.getEForm(formNo, 0);
    const latestVersionNo = latest.VersionNo;
    const versionNumbers = [];
    for (let v = 1; v <= latestVersionNo; v++) versionNumbers.push(v);

    const versions = await Promise.all(
      versionNumbers.map(async (v) => {
        if (v === latestVersionNo) {
          return summarizeVersion(latest);
        }
        try {
          const ev = await client.getEForm(formNo, v);
          return summarizeVersion(ev);
        } catch (err) {
          return { versionNo: v, error: err.message };
        }
      })
    );

    versions.sort((a, b) => b.versionNo - a.versionNo);
    res.json({ formNo, latestVersionNo, versions });
  } catch (err) {
    handleApiError(res, err);
  }
});

function summarizeVersion(ev) {
  return {
    versionNo: ev.VersionNo,
    name: ev.Name,
    created: ev.CreatedISO8601,
    createdByUserName: ev.CreatedByUserName,
    anonymousAccessEnabled: ev.AnonymousAccessEnabled,
    sizeBytes: ev.FormDefinition ? Buffer.byteLength(ev.FormDefinition, 'base64') : 0,
  };
}

router.get('/:formNo/versions/:versionNo', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  const versionNo = Number(req.params.versionNo);
  try {
    const ev = await client.getEForm(formNo, versionNo);
    res.json({
      ...summarizeVersion(ev),
      folderNo: ev.FolderNo,
      formDefinition: decodeToJson(ev.FormDefinition),
      defaultSubmission: decodeToString(ev.DefaultSubmission),
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---- Create new version / revert ---------------------------------------------------------

/** Duplicates the current latest version into a brand-new version — the "branch before editing" step. */
router.post('/:formNo/new-version', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  try {
    const latest = await client.getEForm(formNo, 0);
    const result = await client.saveEForm({
      formNo,
      versionNo: 0,
      name: latest.Name,
      formDefinition: latest.FormDefinition,
      defaultSubmission: latest.DefaultSubmission,
      folderNo: latest.FolderNo,
      anonymousAccessEnabled: latest.AnonymousAccessEnabled,
    });
    await refreshCatalogEntry(req, client, formNo);
    res.json({ ok: true, formNo: result.FormNo, versionNo: result.VersionNo, copiedFromVersionNo: latest.VersionNo });
  } catch (err) {
    handleApiError(res, err);
  }
});

/** Loads the content to revert to, from either an older Therefore version or a stored offline snapshot. */
async function loadRevertSource(req, client, formNo, { fromVersionNo, snapshotId }) {
  if (snapshotId) {
    const snap = db.prepare('SELECT * FROM snapshots WHERE id = ? AND tenant = ? AND form_no = ?').get(snapshotId, tenantKey(req), formNo);
    if (!snap) return null;
    return {
      name: snap.form_name,
      formDefinition: encodeFromString(snap.form_definition),
      defaultSubmission: snap.default_submission ? encodeFromString(snap.default_submission) : '',
      folderNo: snap.folder_no,
      anonymousAccessEnabled: !!snap.anonymous_access_enabled,
      sourceLabel: `snapshot #${snap.id} (${snap.label || 'untitled'})`,
    };
  }
  if (fromVersionNo) {
    const ev = await client.getEForm(formNo, Number(fromVersionNo));
    return {
      name: ev.Name,
      formDefinition: ev.FormDefinition,
      defaultSubmission: ev.DefaultSubmission,
      folderNo: ev.FolderNo,
      anonymousAccessEnabled: ev.AnonymousAccessEnabled,
      sourceLabel: `version ${ev.VersionNo}`,
    };
  }
  return undefined;
}

/** Reverts by creating a NEW version whose content matches an older version or a stored snapshot. History is never overwritten. */
router.post('/:formNo/revert', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  const { fromVersionNo, snapshotId } = req.body || {};
  try {
    const source = await loadRevertSource(req, client, formNo, { fromVersionNo, snapshotId });
    if (source === undefined) return res.status(400).json({ error: 'Provide either fromVersionNo or snapshotId' });
    if (source === null) return res.status(404).json({ error: 'Snapshot not found' });

    const result = await client.saveEForm({ formNo, versionNo: 0, ...source });
    await refreshCatalogEntry(req, client, formNo);
    res.json({ ok: true, formNo: result.FormNo, versionNo: result.VersionNo, revertedFrom: source.sourceLabel });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---- Diff ----------------------------------------------------------------------------------

function loadSideContent(req, formNo, kind, id) {
  const client = clientFor(req);
  if (kind === 'snapshot') {
    const snap = db.prepare('SELECT * FROM snapshots WHERE id = ? AND tenant = ? AND form_no = ?').get(id, tenantKey(req), formNo);
    if (!snap) throw new Error(`Snapshot ${id} not found`);
    return Promise.resolve({ formDefinition: JSON.parse(snap.form_definition), label: `Snapshot #${snap.id}` });
  }
  return client.getEForm(formNo, Number(id)).then((ev) => ({
    formDefinition: decodeToJson(ev.FormDefinition),
    label: `Version ${ev.VersionNo}`,
  }));
}

router.get('/:formNo/diff', async (req, res) => {
  const formNo = Number(req.params.formNo);
  const { fromKind = 'version', from, toKind = 'version', to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    const [fromSide, toSide] = await Promise.all([
      loadSideContent(req, formNo, fromKind, from),
      loadSideContent(req, formNo, toKind, to),
    ]);
    const diff = diffFormDefinitions(fromSide.formDefinition, toSide.formDefinition);
    res.json({ from: fromSide.label, to: toSide.label, diff });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---- Offline snapshots -----------------------------------------------------------------------

router.get('/:formNo/snapshots', (req, res) => {
  const formNo = Number(req.params.formNo);
  const rows = db
    .prepare('SELECT id, label, notes, form_name, source_version_no, created_at, created_by FROM snapshots WHERE tenant = ? AND form_no = ? ORDER BY created_at DESC')
    .all(tenantKey(req), formNo);
  res.json({
    snapshots: rows.map((r) => ({
      id: r.id,
      label: r.label,
      notes: r.notes,
      formName: r.form_name,
      sourceVersionNo: r.source_version_no,
      createdAt: r.created_at,
      createdBy: r.created_by,
    })),
  });
});

router.post('/:formNo/snapshots', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  const { label, notes, versionNo } = req.body || {};
  try {
    const ev = await client.getEForm(formNo, versionNo ? Number(versionNo) : 0);
    const info = db
      .prepare(`
        INSERT INTO snapshots (tenant, form_no, label, notes, form_name, form_definition, default_submission, folder_no, anonymous_access_enabled, source_version_no, created_at, created_by)
        VALUES (@tenant, @formNo, @label, @notes, @formName, @formDefinition, @defaultSubmission, @folderNo, @anon, @sourceVersionNo, @createdAt, @createdBy)
      `)
      .run({
        tenant: tenantKey(req),
        formNo,
        label: label || `Snapshot of v${ev.VersionNo}`,
        notes: notes || null,
        formName: ev.Name,
        formDefinition: decodeToString(ev.FormDefinition),
        defaultSubmission: decodeToString(ev.DefaultSubmission),
        folderNo: ev.FolderNo,
        anon: ev.AnonymousAccessEnabled ? 1 : 0,
        sourceVersionNo: ev.VersionNo,
        createdAt: new Date().toISOString(),
        createdBy: req.session.therefore.username,
      });
    res.json({ ok: true, id: info.lastInsertRowid, sourceVersionNo: ev.VersionNo });
  } catch (err) {
    handleApiError(res, err);
  }
});

router.delete('/:formNo/snapshots/:id', (req, res) => {
  const formNo = Number(req.params.formNo);
  db.prepare('DELETE FROM snapshots WHERE id = ? AND tenant = ? AND form_no = ?').run(req.params.id, tenantKey(req), formNo);
  res.json({ ok: true });
});

/** Restores a stored offline snapshot by creating a new Therefore version from it. */
router.post('/:formNo/snapshots/:id/restore', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  try {
    const source = await loadRevertSource(req, client, formNo, { snapshotId: Number(req.params.id) });
    if (!source) return res.status(404).json({ error: 'Snapshot not found' });

    const result = await client.saveEForm({ formNo, versionNo: 0, ...source });
    await refreshCatalogEntry(req, client, formNo);
    res.json({ ok: true, formNo: result.FormNo, versionNo: result.VersionNo, revertedFrom: source.sourceLabel });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---- Screenshot render (best-effort; degrades gracefully without puppeteer) --------------------

router.get('/:formNo/screenshot', async (req, res) => {
  const client = clientFor(req);
  const formNo = Number(req.params.formNo);
  const { versionNo, snapshotId } = req.query;
  try {
    let formDefinitionB64;
    if (snapshotId) {
      const snap = db.prepare('SELECT * FROM snapshots WHERE id = ? AND tenant = ? AND form_no = ?').get(snapshotId, tenantKey(req), formNo);
      if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
      formDefinitionB64 = encodeFromString(snap.form_definition);
    } else {
      const ev = await client.getEForm(formNo, versionNo ? Number(versionNo) : 0);
      formDefinitionB64 = ev.FormDefinition;
    }

    const result = await renderFormScreenshot(formDefinitionB64);
    if (!result.ok) return res.status(424).json({ error: result.reason });
    res.set('Content-Type', 'image/png');
    res.end(Buffer.from(result.buffer));
  } catch (err) {
    handleApiError(res, err);
  }
});

module.exports = router;
