#!/usr/bin/env node
// init-turso.js — creates all tables in Turso (run once, idempotent)
// Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node init-turso.js

require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log('Connecting to Turso…');

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      coins         INTEGER NOT NULL DEFAULT 5,
      fertilizer    INTEGER NOT NULL DEFAULT 5,
      farm_state    TEXT    NOT NULL DEFAULT '{"pots":[],"animals":[]}',
      profile_image TEXT
    );

    CREATE TABLE IF NOT EXISTS farm_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      item_type       TEXT    NOT NULL,
      item_name       TEXT    NOT NULL,
      pot_id          TEXT,
      home_x          REAL,
      home_y          REAL,
      placed_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      fertilize_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL,
      item_name TEXT    NOT NULL,
      quantity  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS kudos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id   INTEGER,
      sender_name TEXT    NOT NULL,
      receiver_id INTEGER NOT NULL,
      message     TEXT    NOT NULL,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  console.log('✅ All tables created successfully.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
