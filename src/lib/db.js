'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'eform-versioner.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS forms_catalog (
    tenant TEXT NOT NULL,
    form_no INTEGER NOT NULL,
    name TEXT,
    folder_no INTEGER,
    folder_name TEXT,
    latest_version_no INTEGER,
    scanned_at TEXT,
    PRIMARY KEY (tenant, form_no)
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    form_no INTEGER NOT NULL,
    label TEXT,
    notes TEXT,
    form_name TEXT,
    form_definition TEXT NOT NULL,
    default_submission TEXT,
    folder_no INTEGER,
    anonymous_access_enabled INTEGER,
    source_version_no INTEGER,
    created_at TEXT NOT NULL,
    created_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_form ON snapshots (tenant, form_no);
`);

const DATA_DIR_PATH = DATA_DIR;

module.exports = { db, DATA_DIR: DATA_DIR_PATH };
