'use strict';

class ThereforeApiError extends Error {
  constructor(message, { status, wsError, op } = {}) {
    super(message);
    this.name = 'ThereforeApiError';
    this.status = status;
    this.wsError = wsError;
    this.op = op;
  }
}

/**
 * Turns a bare tenant name ("craigdemo"), a full host (craigdemo.thereforeonline.com),
 * or a full base URL into the restun base URL to call.
 */
function deriveBaseUrl(tenantInput) {
  const raw = String(tenantInput || '').trim();
  if (!raw) throw new Error('Tenant is required');

  let hostOrUrl = raw;
  if (!/^https?:\/\//i.test(hostOrUrl)) {
    hostOrUrl = `https://${hostOrUrl}`;
  }

  let url;
  try {
    url = new URL(hostOrUrl);
  } catch {
    throw new Error(`Could not parse tenant/URL: ${raw}`);
  }

  // Bare tenant name (no dot) => assume Therefore Online cloud.
  if (!url.hostname.includes('.')) {
    url = new URL(`https://${url.hostname}.thereforeonline.com`);
  }

  const isThereforeOnline = url.hostname.toLowerCase().endsWith('.thereforeonline.com');
  const tenantName = isThereforeOnline ? url.hostname.split('.')[0] : null;

  const baseUrl = `${url.protocol}//${url.host}/theservice/v0001/restun`;
  return { baseUrl, tenantName, isThereforeOnline };
}

class ThereforeClient {
  constructor({ baseUrl, tenantName, username, password }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tenantName = tenantName;
    this.username = username;
    this.password = password;
  }

  async post(op, body = {}) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
    };
    if (this.tenantName) headers.TenantName = this.tenantName;

    let res;
    try {
      res = await fetch(`${this.baseUrl}/${op}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ThereforeApiError(`Network error calling ${op}: ${err.message}`, { op });
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ThereforeApiError(`Non-JSON response from ${op} (status ${res.status})`, {
          status: res.status,
          op,
        });
      }
    }

    if (!res.ok || (json && json.WSError)) {
      const wsError = json && json.WSError;
      const message = wsError ? wsError.ErrorMessage || wsError.ErrorCodeString : `HTTP ${res.status}`;
      throw new ThereforeApiError(`${op} failed: ${message}`, { status: res.status, wsError, op });
    }

    return json || {};
  }

  async testConnection() {
    return this.post('GetConnectionToken', {});
  }

  async getFolder(folderNo) {
    const res = await this.post('GetFolder', { FolderNo: folderNo });
    return res.Folder;
  }

  /** VersionNo 0 = latest */
  async getEForm(formNo, versionNo = 0) {
    const res = await this.post('GetEForm', { FormNo: formNo, VersionNo: versionNo });
    return res.EForm;
  }

  async saveEForm({ formNo, versionNo = 0, name, formDefinition, defaultSubmission, folderNo, anonymousAccessEnabled }) {
    const res = await this.post('SaveEForm', {
      FormNo: formNo,
      VersionNo: versionNo,
      Name: name,
      FormDefinition: formDefinition,
      DefaultSubmission: defaultSubmission || '',
      FolderNo: folderNo,
      AnonymousAccessEnabled: !!anonymousAccessEnabled,
    });
    return res; // { FormNo, VersionNo, FormID }
  }
}

module.exports = { ThereforeClient, ThereforeApiError, deriveBaseUrl };
