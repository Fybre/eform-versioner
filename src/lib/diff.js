'use strict';

const { decodeToJson } = require('./formCodec');

const NESTED_KEYS = ['components', 'columns', 'rows'];
const TRACKED_PROPS = ['type', 'label', 'key', 'input', 'defaultValue', 'placeholder', 'description', 'hidden', 'disabled'];
const TRACKED_VALIDATE_PROPS = ['required', 'minLength', 'maxLength', 'min', 'max', 'pattern', 'custom'];

/** Recursively flattens a form.io component tree into a Map keyed by component `key` (or a synthetic path). */
function flattenComponents(components, path, out) {
  if (!Array.isArray(components)) return out;
  for (const comp of components) {
    if (!comp || typeof comp !== 'object') continue;
    const key = comp.key || `${path}[${comp.type || 'unknown'}]`;
    const fullPath = path ? `${path}.${key}` : key;

    if (comp.type && comp.key) {
      out.set(fullPath, summarizeComponent(comp, fullPath));
    }

    for (const nestedKey of NESTED_KEYS) {
      const nested = comp[nestedKey];
      if (Array.isArray(nested)) {
        if (nestedKey === 'columns' || nestedKey === 'rows') {
          // columns/rows are containers of {components:[...]}
          for (const cell of nested) {
            if (cell && Array.isArray(cell.components)) {
              flattenComponents(cell.components, fullPath, out);
            } else if (Array.isArray(cell)) {
              flattenComponents(cell, fullPath, out);
            }
          }
        } else {
          flattenComponents(nested, fullPath, out);
        }
      }
    }
  }
  return out;
}

function summarizeComponent(comp, fullPath) {
  const summary = { path: fullPath };
  for (const p of TRACKED_PROPS) {
    if (comp[p] !== undefined) summary[p] = comp[p];
  }
  if (comp.validate && typeof comp.validate === 'object') {
    for (const p of TRACKED_VALIDATE_PROPS) {
      if (comp.validate[p] !== undefined) summary[`validate.${p}`] = comp.validate[p];
    }
  }
  return summary;
}

function stableStringify(v) {
  return JSON.stringify(v);
}

/**
 * Produces a structural diff summary between two form.io FormDefinition values.
 * Accepts either base64-encoded FormDefinition strings (as returned by GetEForm) or
 * already-decoded plain objects.
 */
function diffFormDefinitions(oldDefB64, newDefB64) {
  const oldDef = (typeof oldDefB64 === 'object' && oldDefB64) || decodeToJson(oldDefB64) || {};
  const newDef = (typeof newDefB64 === 'object' && newDefB64) || decodeToJson(newDefB64) || {};

  const oldMap = flattenComponents(oldDef.components || [], '', new Map());
  const newMap = flattenComponents(newDef.components || [], '', new Map());

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, comp] of newMap) {
    if (!oldMap.has(key)) added.push(comp);
  }
  for (const [key, comp] of oldMap) {
    if (!newMap.has(key)) removed.push(comp);
  }
  for (const [key, oldComp] of oldMap) {
    if (!newMap.has(key)) continue;
    const newComp = newMap.get(key);
    const fieldChanges = [];
    const allProps = new Set([...Object.keys(oldComp), ...Object.keys(newComp)]);
    allProps.delete('path');
    for (const prop of allProps) {
      const ov = oldComp[prop];
      const nv = newComp[prop];
      if (stableStringify(ov) !== stableStringify(nv)) {
        fieldChanges.push({ field: prop, from: ov, to: nv });
      }
    }
    if (fieldChanges.length) {
      changed.push({ path: key, label: newComp.label || oldComp.label, changes: fieldChanges });
    }
  }

  const metaFields = ['title', 'name', 'display', 'path'];
  const metaChanges = [];
  for (const f of metaFields) {
    if (stableStringify(oldDef[f]) !== stableStringify(newDef[f])) {
      metaChanges.push({ field: f, from: oldDef[f], to: newDef[f] });
    }
  }

  added.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort((a, b) => a.path.localeCompare(b.path));
  changed.sort((a, b) => a.path.localeCompare(b.path));

  return {
    summary: {
      componentsAdded: added.length,
      componentsRemoved: removed.length,
      componentsChanged: changed.length,
      totalOld: oldMap.size,
      totalNew: newMap.size,
      identical: added.length === 0 && removed.length === 0 && changed.length === 0 && metaChanges.length === 0,
    },
    meta: metaChanges,
    added,
    removed,
    changed,
  };
}

module.exports = { diffFormDefinitions };
