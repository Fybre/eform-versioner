'use strict';

/**
 * Therefore's REST API has no "list eForms" operation (confirmed against the live
 * WSDL — GetEForm/SaveEForm/CopyEForm/DeleteEForm are the only eForm ops, and
 * GetCategoriesTree only returns document categories/cases, not eForm folders).
 * FormNo is a sequential integer, so we discover forms by probing GetEForm(FormNo, 0)
 * across a range and collecting the hits. We stop once we've seen a long enough run
 * of consecutive misses past the highest hit found, so tenants with a modest form
 * count don't require scanning an arbitrary ceiling.
 */
async function scanForms(client, { maxProbe = 2000, missStreakStop = 60, concurrency = 12, onProgress } = {}) {
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
        });
      }
    }

    if (onProgress) onProgress({ probed: formNo - 1, found: results.length });

    if (formNo - 1 - highestHit >= missStreakStop && highestHit > 0) {
      stop = true;
    }
  }

  // Resolve folder names (sequential-ish, small cache-bound concurrency).
  for (const r of results) {
    r.folderName = await resolveFolderName(r.folderNo);
  }

  results.sort((a, b) => a.formNo - b.formNo);
  return results;
}

module.exports = { scanForms };
