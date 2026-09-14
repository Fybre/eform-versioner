'use strict';

const express = require('express');
const { ThereforeClient, ThereforeApiError, deriveBaseUrl } = require('../lib/thereforeClient');

const router = express.Router();

router.post('/connect', async (req, res) => {
  const { tenant, username, password } = req.body || {};
  if (!tenant || !username || !password) {
    return res.status(400).json({ error: 'tenant, username and password are all required' });
  }

  let derived;
  try {
    derived = deriveBaseUrl(tenant);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = new ThereforeClient({
    baseUrl: derived.baseUrl,
    tenantName: derived.tenantName,
    username,
    password,
  });

  try {
    await client.testConnection();
  } catch (err) {
    const msg = err instanceof ThereforeApiError ? err.message : `Connection failed: ${err.message}`;
    return res.status(401).json({ error: msg });
  }

  req.session.therefore = {
    baseUrl: derived.baseUrl,
    tenantName: derived.tenantName,
    tenantInput: tenant,
    username,
    password,
  };

  res.json({
    ok: true,
    tenant: derived.tenantName || tenant,
    baseUrl: derived.baseUrl,
    username,
  });
});

router.post('/disconnect', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/', (req, res) => {
  const t = req.session.therefore;
  if (!t) return res.json({ connected: false });
  res.json({ connected: true, tenant: t.tenantName || t.tenantInput, baseUrl: t.baseUrl, username: t.username });
});

module.exports = router;
