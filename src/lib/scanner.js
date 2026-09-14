'use strict';

const EFORM_OBJECT_TYPE = 47; // see ThereforeClient.getObjects doc comment

/**
 * Primary discovery path: GetObjects(Type:47) returns every eForm in the tenant in one
 * call. Verified against a live tenant to exactly match a full FormNo scan. Resolves
 * latestVersionNo (not present on GetObjects' output) with one GetEForm(FormNo, 0) call
 * per form, run with bounded concurrency.
 */
async function listFormsViaObjects(client, { concurrency = 12, onProgress } = {}) {
  const { itemList } = await client.getObjects(1, EFORM_OBJECT_TYPE);
  if (!Array.isArray(itemList)) throw new Error('GetObjects returned no ItemList');

  const folderNameCache = new Map();
  async function resolveFolderName(folderNo) {
    if (!folderNo) return null;
    if (folderNameCache.has(folderNo)) return folderNameCache.get(folderNo);
    try {
      const folder = await client.getFolder(folderNo);
      const name = folder ? folder.Name : null;
      folderNameCache.set(folderNo, name);
      return name;
    } catch {
      folderNameCache.set(folderNo, null);
      return null;
    }
  }

  const results = [];
  for (let i = 0; i < itemList.length; i += concurrency) {
    const batch = itemList.slice(i, i + concurrency);
    const resolved = await Promise.all(
      batch.map(async (item) => {
        let latestVersionNo = null;
        let created = null;
        try {
          const eform = await client.getEForm(item.ID, 0);
          latestVersionNo = eform.VersionNo;
          created = eform.CreatedISO8601 || null;
        } catch {
          // Form is listed but currently unreadable (permissions, etc.) — keep it, just without version info.
        }
        return {
          formNo: item.ID,
          name: item.Name,
          folderNo: item.FolderNo,
          latestVersionNo,
          created,
          anonymousAccessEnabled: (item.Flags & 1) === 1,
          guid: item.Guid,
        };
      })
    );
    results.push(...resolved);
    if (onProgress) onProgress({ probed: i + batch.length, found: results.length, total: itemList.length });
  }

  for (const r of results) {
    r.folderName = await resolveFolderName(r.folderNo);
  }

  results.sort((a, b) => a.formNo - b.formNo);
  return results;
}

/**
 * Fallback discovery path, used only if GetObjects(Type:47) is unavailable or errors on a
 * given server. Therefore's REST API otherwise has no "list eForms" operation — FormNo is a
 * sequential integer, so this probes GetEForm(FormNo, 0) across a range and collects hits,
 * stopping after a long enough run of consecutive misses past the highest hit found.
 */
async function scanFormsByProbing(client, { maxProbe = 2000, missStreakStop = 60, concurrency = 12, onProgress } = {}) {
  const folderNameCache = new Map();
  const results = [];
  let highestHit = 0;
  let formNo = 1;
  let stop = false;

  async function resolveFolderName(folderNo) {
    if (!folderNo) return null;
    if (folderNameCache.has(folderNo)) return folderNameCache.get(folderNo);
    try {
      const folder = await client.getFolder(folderNo);
      const name = folder ? folder.Name : null;
      folderNameCache.set(folderNo, name);
      return name;
    } catch {
      folderNameCache.set(folderNo, null);
      return null;
    }
  }

  while (!stop && formNo <= maxProbe) {
    const batch = [];
    for (let i = 0; i < concurrency && formNo + i <= maxProbe; i++) {
      batch.push(formNo + i);
    }
    formNo += batch.length;

    const batchResults = await Promise.all(
      batch.map(async (n) => {
        try {
          const eform = await client.getEForm(n, 0);
          return { n, eform };
        } catch {
          return { n, eform: null };
        }
      })
    );

    for (const { n, eform } of batchResults) {
      if (eform) {
        highestHit = Math.max(highestHit, n);
        results.push({
          formNo: eform.FormNo,
          name: eform.Name,
          folderNo: eform.FolderNo,
          latestVersionNo: eform.VersionNo,
          created: eform.CreatedISO8601 || null,
          anonymousAccessEnabled: eform.AnonymousAccessEnabled,
        });
      }
    }

    if (onProgress) onProgress({ probed: formNo - 1, found: results.length });

    if (formNo - 1 - highestHit >= missStreakStop && highestHit > 0) {
      stop = true;
    }
  }

  for (const r of results) {
    r.folderName = await resolveFolderName(r.folderNo);
  }

  results.sort((a, b) => a.formNo - b.formNo);
  return results;
}

/** Discovers all eForms in the tenant, preferring the direct GetObjects listing and falling back to a FormNo probe scan. */
async function scanForms(client, opts = {}) {
  try {
    return await listFormsViaObjects(client, opts);
  } catch (err) {
    console.warn(`GetObjects(Type:47) discovery failed (${err.message}); falling back to FormNo probing.`);
    return scanFormsByProbing(client, opts);
  }
}

module.exports = { scanForms, listFormsViaObjects, scanFormsByProbing };
