'use strict';

/** GetEForm/SaveEForm carry FormDefinition (and DefaultSubmission) as base64-encoded JSON text. */

function decodeToJson(b64) {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function decodeToString(b64) {
  if (!b64) return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeFromString(str) {
  return Buffer.from(str || '', 'utf8').toString('base64');
}

function encodeFromJson(obj) {
  return encodeFromString(JSON.stringify(obj));
}

module.exports = { decodeToJson, decodeToString, encodeFromString, encodeFromJson };
