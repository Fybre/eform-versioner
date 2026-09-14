'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const sessionRoutes = require('./routes/session');
const eformRoutes = require('./routes/eforms');

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_SESSION_SECRET = 'eform-versioner-dev-secret-change-me';
const sessionSecret = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
if (sessionSecret === DEFAULT_SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to start: SESSION_SECRET is unset (or default) while NODE_ENV=production. Set a real random SESSION_SECRET.');
    process.exit(1);
  }
  console.warn('Warning: using the default SESSION_SECRET. Set SESSION_SECRET to a random value before deploying this anywhere shared.');
}

app.use(express.json({ limit: '20mb' }));
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      secure: process.env.COOKIE_SECURE === 'true',
    },
  })
);

// Unauthenticated — used by Docker/orchestrator health checks.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.use('/api/session', sessionRoutes);
app.use('/api/eforms', eformRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`eform-versioner listening on http://localhost:${PORT}`);
});
