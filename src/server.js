'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const sessionRoutes = require('./routes/session');
const eformRoutes = require('./routes/eforms');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'eform-versioner-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      secure: process.env.COOKIE_SECURE === 'true',
    },
  })
);

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
