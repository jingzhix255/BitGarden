const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Load config files ─────────────────────────────────────────────────────
// Items catalog lives in backend/items.json — safe from Godot re-exports.
// (Previously in farm_build/items.json, but Godot exports wipe that folder.)
const ITEMS_PATH = path.join(__dirname, 'items.json');
const FALLBACK_PATH = path.join(__dirname, '..', 'shop-config.json');
const SHOP_CONFIG = JSON.parse(
  fs.existsSync(ITEMS_PATH)
    ? fs.readFileSync(ITEMS_PATH, 'utf8')
    : fs.readFileSync(FALLBACK_PATH, 'utf8')
);
if (fs.existsSync(ITEMS_PATH)) {
  console.log('📦  Item catalog loaded from backend/items.json');
}

// Keep layout config available for the garden social view
const LAYOUT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'layout-config.json'), 'utf8')
);

// ─── Database ──────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'bitgarden.db');

// Auto-migrate: wipe DB if either old schema is detected.
//  v1 → v2: added coins/fertilizer, removed water_balance
//  v2 → v3: pot_id changed from INTEGER to TEXT (Godot sends "pot0" strings)
let db = new DatabaseSync(DB_PATH);
const hasOldEconomy = db.prepare(
  "SELECT 1 FROM pragma_table_info('users') WHERE name='water_balance'"
).get();
const hasPotIdInteger = db.prepare(
  "SELECT 1 FROM pragma_table_info('farm_items') WHERE name='pot_id' AND type='INTEGER'"
).get();
if (hasOldEconomy || hasPotIdInteger) {
  db.close();
  fs.unlinkSync(DB_PATH);
  db = new DatabaseSync(DB_PATH);
  console.log('🔄  Schema migration — database wiped and recreated.\n');
}

db.exec(`
  -- ── Users ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    coins         INTEGER NOT NULL DEFAULT 0,
    fertilizer    INTEGER NOT NULL DEFAULT 0,
    farm_state    TEXT    NOT NULL DEFAULT '{"pots":[],"animals":[]}',
    profile_image TEXT
  );

  -- ── Farm items (plants + animals placed in the Godot scene) ────────────
  -- Plants reference a fixed pot_id string from the Godot scene's Area2D nodes.
  -- Animals store a world-space home position for the tether AI.
  CREATE TABLE IF NOT EXISTS farm_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    item_type  TEXT    NOT NULL,   -- 'plant' | 'animal'
    item_name  TEXT    NOT NULL,   -- display name, e.g. 'Pumpkin', 'Cow'
    pot_id     TEXT,               -- plants only  (e.g. "pot0", "pot1")
    home_x     REAL,               -- animals only
    home_y     REAL,               -- animals only
    placed_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ── Inventory (owned but not yet placed) ───────────────────────────────
  CREATE TABLE IF NOT EXISTS inventory (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    item_name TEXT    NOT NULL,
    quantity  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, item_name)
  );

  -- ── Kudos ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS kudos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER,          -- NULL = anonymous / guest
    sender_name TEXT    NOT NULL,
    receiver_id INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// v3 → v4: non-destructive — add farm_state column to existing users tables.
// CREATE TABLE above already includes it for fresh DBs; this handles upgrades.
const hasFarmStateCol = db.prepare(
  "SELECT 1 FROM pragma_table_info('users') WHERE name='farm_state'"
).get();
if (!hasFarmStateCol) {
  db.exec(`ALTER TABLE users ADD COLUMN farm_state TEXT NOT NULL DEFAULT '{"pots":[],"animals":[]}'`);
  console.log('✅  Added farm_state column to users table (non-destructive migration).\n');
}

// v6: non-destructive — add profile_image column to existing users tables.
const hasProfileImageCol = db.prepare(
  "SELECT 1 FROM pragma_table_info('users') WHERE name='profile_image'"
).get();
if (!hasProfileImageCol) {
  db.exec('ALTER TABLE users ADD COLUMN profile_image TEXT');
}

// v5: Normalise placed_at to milliseconds (raw SQL only — syncFarmState called after helpers).
{
  const nowMs = Date.now();
  db.prepare(
    'UPDATE farm_items SET placed_at = placed_at * 1000 WHERE placed_at > 0 AND placed_at < 100000000000'
  ).run();
  db.prepare(
    'UPDATE farm_items SET placed_at = ? WHERE placed_at IS NULL OR placed_at = 0'
  ).run(nowMs);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a { item_name: quantity } map for a user's inventory. */
function getInventoryMap(userId) {
  const rows = db.prepare('SELECT item_name, quantity FROM inventory WHERE user_id = ?').all(userId);
  return Object.fromEntries(rows.map(r => [r.item_name, r.quantity]));
}

/** Upsert a quantity delta into inventory (clamped to 0). */
function adjustInventory(userId, itemName, delta) {
  db.prepare(`
    INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, MAX(0, ?))
    ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = MAX(0, quantity + ?)
  `).run(userId, itemName, delta, delta);
}

/**
 * Re-build farm_state JSON from the farm_items rows and persist it on the
 * users row.  Call this after any mutation to farm_items so the stored JSON
 * stays in sync and GET /api/farm always has a fast, accurate snapshot.
 */
function syncFarmState(userId) {
  const rows = db.prepare('SELECT * FROM farm_items WHERE user_id = ? ORDER BY id ASC').all(userId);
  const state = {
    pots: rows
      .filter(r => r.item_type === 'plant')
      .map(r => ({ pot_id: r.pot_id, seed: r.item_name, placed_at: r.placed_at })),
    animals: rows
      .filter(r => r.item_type === 'animal')
      .map(r => ({ animal: r.item_name, x: r.home_x, y: r.home_y, placed_at: r.placed_at })),
  };
  db.prepare('UPDATE users SET farm_state = ? WHERE id = ?').run(JSON.stringify(state), userId);
  return state;
}

// v5 (continued): Rebuild farm_state JSON for all users now that helpers exist.
// This ensures every stored snapshot includes placed_at for animals.
{
  const allUsers = db.prepare('SELECT id FROM users').all();
  for (const u of allUsers) syncFarmState(u.id);
  if (allUsers.length > 0) {
    console.log(`✅  Refreshed farm_state for ${allUsers.length} user(s) — placed_at now in ms.\n`);
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

// POST /api/login
// Body: { username, profile_image? }
// New users receive 5 starting coins, 5 fertilizer, and have their profile_image saved.
// The entire registration is wrapped in a transaction so partial writes never persist.
app.post('/api/login', (req, res) => {
  const username      = (req.body.username      ?? '').trim();
  const profile_image = (req.body.profile_image ?? '').trim() || null;

  if (!username) return res.status(400).json({ error: 'username is required.' });

  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) {
    // New registration — wrap in a transaction so the user row and starting
    // resources are either both committed or both rolled back.
    try {
      db.exec('BEGIN');
      const r = db.prepare(
        'INSERT INTO users (username, coins, fertilizer, profile_image) VALUES (?, 5, 5, ?)'
      ).run(username, profile_image);
      const newId = Number(r.lastInsertRowid);
      db.exec('COMMIT');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
    } catch (err) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Registration failed.' });
    }
  } else if (profile_image && !user.profile_image) {
    // Returning user — backfill profile_image if it was never saved.
    db.prepare('UPDATE users SET profile_image = ? WHERE id = ?').run(profile_image, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  res.json(user);
});

// GET /api/users
app.get('/api/users', (_req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id ASC').all());
});

// GET /api/garden/:userId  — social profile view (kudos, no plant management)
app.get('/api/garden/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const user   = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const kudos = db.prepare(
    'SELECT * FROM kudos WHERE receiver_id = ? ORDER BY timestamp DESC LIMIT 50'
  ).all(userId);

  // Legacy: return empty slots so Garden.jsx doesn't break
  const slots = LAYOUT_CONFIG.map(slot => ({ ...slot, plant: null }));

  res.json({ user, slots, kudos });
});

// GET /api/farm/:userId  — full farm state for Godot bridge
app.get('/api/farm/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const user   = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const farm_items = db.prepare(
    'SELECT * FROM farm_items WHERE user_id = ? ORDER BY id ASC'
  ).all(userId);

  const inventory = getInventoryMap(userId);

  // Always rebuild from farm_items so the snapshot is never stale.
  // This guarantees placed_at is always present and in milliseconds.
  const farm_state = syncFarmState(userId);

  res.json({ user, farm_items, inventory, farm_state });
});

// POST /api/kudos/leave
// Sender gets +1 fertilizer, receiver gets +1 coin.
app.post('/api/kudos/leave', (req, res) => {
  const { sender_id, sender_name, receiver_id, message } = req.body;
  if (!(sender_name ?? '').trim()) return res.status(400).json({ error: 'sender_name is required.' });
  if (!(message    ?? '').trim()) return res.status(400).json({ error: 'message is required.'     });

  const receiver = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(receiver_id));
  if (!receiver) return res.status(404).json({ error: 'Receiver not found.' });

  db.prepare(
    'INSERT INTO kudos (sender_id, sender_name, receiver_id, message) VALUES (?, ?, ?, ?)'
  ).run(sender_id ? Number(sender_id) : null, sender_name.trim(), Number(receiver_id), message.trim());

  // Receiver gets +1 coin
  db.prepare('UPDATE users SET coins = coins + 1 WHERE id = ?').run(Number(receiver_id));

  // Sender gets +1 fertilizer (if they're a registered user)
  let updatedSender = null;
  if (sender_id) {
    db.prepare('UPDATE users SET fertilizer = fertilizer + 1 WHERE id = ?').run(Number(sender_id));
    updatedSender = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(sender_id));
  }

  const updatedReceiver = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(receiver_id));
  res.json({ success: true, receiver: updatedReceiver, sender: updatedSender });
});

// POST /api/shop/buy  — spend coins to add an item to inventory
// item_name is the display name (e.g. "Pumpkin", "Cow") to match what Godot uses.
app.post('/api/shop/buy', (req, res) => {
  const { user_id, item_name } = req.body;
  const userId = Number(user_id);

  if (!item_name || !item_name.trim()) {
    return res.status(400).json({ error: 'item_name is required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Case-insensitive lookup: match by display name or by id (legacy).
  // If the item is not in items.json (new Godot item added after deploy),
  // fall back to a default cost of 5 coins so the shop never hard-fails.
  const allItems  = [...SHOP_CONFIG.seeds, ...SHOP_CONFIG.animals];
  const nameLower = item_name.toLowerCase().trim();
  const item = allItems.find(i => i.name.toLowerCase() === nameLower)
            ?? allItems.find(i => i.id.toLowerCase()   === nameLower);
  const cost = item?.cost ?? 5;  // graceful fallback for items not yet in items.json

  if (user.coins < cost) {
    return res.status(400).json({ error: `Not enough coins. Need ${cost}🪙, have ${user.coins}🪙.` });
  }

  // Use the canonical display name from config when available, otherwise use
  // exactly what was sent (already Title Case from the React translator).
  const canonicalName = item?.name ?? item_name.trim();

  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(cost, userId);
  adjustInventory(userId, canonicalName, 1);

  res.json({
    user:      db.prepare('SELECT * FROM users WHERE id = ?').get(userId),
    inventory: getInventoryMap(userId),
  });
});

// GET /api/inventory/:userId
app.get('/api/inventory/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const user   = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ inventory: getInventoryMap(userId) });
});

// POST /api/farm/place  — move an item from inventory onto the farm
// Body: { user_id, item_name, item_type, pot_id? (plants), home_x?, home_y? (animals) }
app.post('/api/farm/place', (req, res) => {
  const { user_id, item_name, item_type, pot_id, home_x, home_y } = req.body;
  const userId = Number(user_id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = getInventoryMap(userId);
  if ((inv[item_name] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${item_name} in inventory.` });
  }

  // For plants: check pot isn't already occupied
  if (item_type === 'plant' && pot_id != null) {
    const occupied = db.prepare(
      'SELECT id FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?'
    ).get(userId, 'plant', String(pot_id));
    if (occupied) return res.status(400).json({ error: 'That pot is already occupied.' });
  }

  adjustInventory(userId, item_name, -1);

  const r = db.prepare(`
    INSERT INTO farm_items (user_id, item_type, item_name, pot_id, home_x, home_y)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, item_type, item_name,
    pot_id  != null ? String(pot_id)  : null,
    home_x  != null ? Number(home_x)  : null,
    home_y  != null ? Number(home_y)  : null,
  );

  const farm_item = db.prepare('SELECT * FROM farm_items WHERE id = ?').get(Number(r.lastInsertRowid));
  res.status(201).json({ farm_item, inventory: getInventoryMap(userId) });
});

// POST /api/farm/save  — save the complete farm layout in one shot
// Body: { user_id, farm_state }
// farm_state = { pots: [{ pot_id, seed, placed_at? }], animals: [{ animal, x, y, placed_at? }] }
// This is the authoritative save.  It replaces all existing farm_items for the
// user and persists the JSON to users.farm_state so GET /api/farm always returns
// the correct state without re-computation.
app.post('/api/farm/save', (req, res) => {
  const { user_id, farm_state: rawState } = req.body;
  const userId = Number(user_id);

  if (!rawState) return res.status(400).json({ error: 'farm_state is required.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const pots    = rawState.pots    ?? [];
  const animals = rawState.animals ?? [];

  // Snapshot existing placed_at values BEFORE the DELETE so we can preserve
  // them for any item Godot didn't supply a timestamp for.
  // Godot only receives elapsed_time (not placed_at), so auto-save payloads
  // will never carry placed_at — we must reconstruct or preserve it here.
  const existingPlacedAt = {};
  for (const row of db.prepare('SELECT * FROM farm_items WHERE user_id = ?').all(userId)) {
    if (row.item_type === 'plant' && row.pot_id) {
      existingPlacedAt[`plant:${row.pot_id}`] = row.placed_at;
    } else if (row.item_type === 'animal' && row.item_name) {
      existingPlacedAt[`animal:${row.item_name}`] = row.placed_at;
    }
  }

  // Replace all farm items for this user atomically
  db.prepare('DELETE FROM farm_items WHERE user_id = ?').run(userId);

  const now = Date.now();  // ms — consistent with plant-seed INSERT

  for (const pot of pots) {
    if (!pot.pot_id || !pot.seed) continue;

    // Priority: explicit placed_at → reconstruct from elapsed_time → preserve existing → now
    let placedAt;
    const rawPlacedAt = Number(pot.placed_at ?? 0);
    if (rawPlacedAt > 1e11) {
      placedAt = rawPlacedAt;                                           // valid ms timestamp
    } else if (pot.elapsed_time != null && Number(pot.elapsed_time) >= 0) {
      placedAt = now - Math.floor(Number(pot.elapsed_time) * 1000);    // reconstruct from elapsed
    } else {
      placedAt = existingPlacedAt[`plant:${String(pot.pot_id)}`] ?? now; // preserve or new
    }

    db.prepare(
      'INSERT INTO farm_items (user_id, item_type, item_name, pot_id, placed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, 'plant', pot.seed, String(pot.pot_id), placedAt);
  }

  for (const a of animals) {
    if (!a.animal) continue;

    let placedAt;
    const rawPlacedAt = Number(a.placed_at ?? 0);
    if (rawPlacedAt > 1e11) {
      placedAt = rawPlacedAt;
    } else if (a.elapsed_time != null && Number(a.elapsed_time) >= 0) {
      placedAt = now - Math.floor(Number(a.elapsed_time) * 1000);
    } else {
      placedAt = existingPlacedAt[`animal:${a.animal}`] ?? now;
    }

    db.prepare(
      'INSERT INTO farm_items (user_id, item_type, item_name, home_x, home_y, placed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, 'animal', a.animal, Number(a.x ?? 0), Number(a.y ?? 0), placedAt);
  }

  // Persist the JSON snapshot on the users row
  db.prepare('UPDATE users SET farm_state = ? WHERE id = ?')
    .run(JSON.stringify({ pots, animals }), userId);

  res.json({ success: true, farm_state: { pots, animals } });
});

// POST /api/farm/plant-seed  — Godot: player placed a seed in a pot
// Body: { user_id, pot_id, seed }   (seed = display name e.g. "Pumpkin")
app.post('/api/farm/plant-seed', (req, res) => {
  const { user_id, pot_id, seed } = req.body;
  const userId = Number(user_id);

  // Normalise pot_id: Godot may send integer 0 for the first pot.
  // "0" → "pot0",  0 → "pot0",  "pot0" → "pot0"
  const rawPotId = String(pot_id ?? '').trim();
  const normPotId = /^\d+$/.test(rawPotId) ? `pot${rawPotId}` : rawPotId;

  // Use != null so that numeric 0 is valid (falsy but meaningful)
  if (pot_id == null || !normPotId || !seed) {
    return res.status(400).json({ error: 'pot_id and seed are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = getInventoryMap(userId);

  if ((inv[seed] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${seed} in inventory.` });
  }

  // Check pot isn't already occupied (use normalised ID for all DB queries)
  const occupied = db.prepare(
    'SELECT id FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?'
  ).get(userId, 'plant', normPotId);
  if (occupied) return res.status(400).json({ error: `Pot ${normPotId} is already occupied.` });

  adjustInventory(userId, seed, -1);
  db.prepare(
    'INSERT INTO farm_items (user_id, item_type, item_name, pot_id, placed_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'plant', seed, normPotId, Date.now());  // ms — frontend converts to elapsed_time
  syncFarmState(userId);   // keep users.farm_state in sync

  res.json({ success: true, inventory: getInventoryMap(userId) });
});

// POST /api/farm/place-animal  — Godot: player placed an animal on the farm
// Body: { user_id, animal, x, y }   (animal = display name e.g. "Cow")
app.post('/api/farm/place-animal', (req, res) => {
  const { user_id, animal, x, y } = req.body;
  const userId = Number(user_id);

  if (!animal) return res.status(400).json({ error: 'animal is required.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = getInventoryMap(userId);

  if ((inv[animal] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${animal} in inventory.` });
  }

  adjustInventory(userId, animal, -1);
  db.prepare(
    'INSERT INTO farm_items (user_id, item_type, item_name, home_x, home_y, placed_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, 'animal', animal, Number(x ?? 0), Number(y ?? 0), Date.now());
  syncFarmState(userId);   // keep users.farm_state in sync

  res.json({ success: true, inventory: getInventoryMap(userId) });
});

// POST /api/farm/harvest  — Godot: player harvested a crop from a pot
// Body: { user_id, pot_id, crop }
app.post('/api/farm/harvest', (req, res) => {
  try {
    const { user_id, pot_id, crop, viewed_farm_id } = req.body;
    const userId    = Number(user_id);

    // Hard server-side crop-theft guard: the farm the frontend was VIEWING
    // must match the authenticated user.  Ghost listeners / stale iframes
    // always send the wrong viewed_farm_id and are blocked here immediately.
    if (viewed_farm_id == null || String(viewed_farm_id) !== String(userId)) {
      return res.status(403).json({ error: 'Crop theft blocked: you do not own this farm.' });
    }
    const normPotId = String(pot_id ?? '').trim().toLowerCase().startsWith('pot')
      ? String(pot_id).trim().toLowerCase()
      : `pot${pot_id}`;

    if (pot_id == null || !crop) {
      return res.status(400).json({ error: 'pot_id and crop are required.' });
    }

    // Scope the lookup to THIS user's farm so pot_id collisions across users
    // never trigger a false 403 — ownership is enforced at the DB level.
    const item = db.prepare(
      'SELECT * FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?'
    ).get(userId, 'plant', normPotId);

    if (!item) {
      return res.status(404).json({ error: `No plant found in pot ${normPotId}.` });
    }

    // Secondary type-safe guard (belt-and-suspenders after the scoped query above).
    if (String(item.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden: you do not own this farm.' });
    }

    // Manual transaction — db.transaction() is better-sqlite3 only; node:sqlite needs exec().
    try {
      db.exec('BEGIN');
      const harvestKey = `harvested_${crop}`;
      adjustInventory(userId, harvestKey, 1);
      db.prepare('DELETE FROM farm_items WHERE id = ?').run(item.id);
      syncFarmState(userId);
      db.exec('COMMIT');
    } catch (txError) {
      db.exec('ROLLBACK');
      console.error('[farm/harvest] transaction rolled back:', txError);
      return res.status(500).json({ error: txError.message || 'Transaction failed.' });
    }

    res.json({ success: true, inventory: getInventoryMap(userId) });
  } catch (error) {
    console.error('Harvest Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/farm/fertilize  — Godot: player used fertilizer on a pot
// Body: { user_id, pot_id }
// Deducts 1 fertilizer from the user; shifts the plant's placed_at BACK by
// fertilizer_skip_seconds (converting to ms since placed_at is in ms).
// Calls syncFarmState so the new placed_at persists across refreshes.
app.post('/api/farm/fertilize', (req, res) => {
  try {
    const { user_id, pot_id, viewed_farm_id } = req.body;
    const userId = Number(user_id);

    // Hard server-side ownership guard — viewed_farm_id must match the
    // authenticated user. Ghost listeners / stale iframes are blocked instantly.
    if (viewed_farm_id == null || String(viewed_farm_id) !== String(userId)) {
      return res.status(403).json({ error: 'Action blocked: you do not own the farm you are trying to modify.' });
    }

    if (pot_id == null) return res.status(400).json({ error: 'pot_id is required.' });

    const normPotId = String(pot_id).trim().toLowerCase().startsWith('pot')
      ? String(pot_id).trim().toLowerCase()
      : `pot${pot_id}`;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.fertilizer < 1) return res.status(400).json({ error: 'No fertilizer available.' });

    // Scope lookup to THIS user — pot_id alone could match another user's plant.
    const item = db.prepare(
      'SELECT * FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?'
    ).get(userId, 'plant', normPotId);

    if (!item) {
      return res.status(404).json({ error: `No plant found in pot ${normPotId}.` });
    }

    // Belt-and-suspenders type-safe ownership guard after the scoped query.
    if (String(item.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Action blocked: you do not own the farm you are trying to modify.' });
    }

    // placed_at is stored as INTEGER milliseconds — skipMs must be the same type.
    // Math.floor + Number() guards against any string/bigint coercion from config.
    const skipMs = Math.floor(Number(SHOP_CONFIG.fertilizer_skip_seconds ?? 1800) * 1000);

    // Manual transaction — node:sqlite does not support db.transaction().
    try {
      db.exec('BEGIN');

      db.prepare('UPDATE users SET fertilizer = fertilizer - 1 WHERE id = ?').run(userId);

      // Subtract skipMs from placed_at.  Bind both values as integers so SQLite
      // never falls back to floating-point arithmetic or a no-op TEXT operation.
      const plantResult = db.prepare(
        'UPDATE farm_items SET placed_at = CAST(placed_at AS INTEGER) - CAST(? AS INTEGER) WHERE id = CAST(? AS INTEGER)'
      ).run(skipMs, item.id);

      // Safety check: if 0 rows changed the item row disappeared between our
      // SELECT and this UPDATE — roll back so the user keeps their fertilizer.
      if (plantResult.changes === 0) {
        throw new Error(`Plant update affected 0 rows (item.id=${item.id}) — rolled back`);
      }

      syncFarmState(userId);
      db.exec('COMMIT');
    } catch (txError) {
      db.exec('ROLLBACK');
      console.error('[farm/fertilize] transaction rolled back:', txError);
      return res.status(500).json({ error: txError.message || 'Transaction failed.' });
    }

    const updatedItem = db.prepare('SELECT * FROM farm_items WHERE id = ?').get(item.id);
    const updatedUser = db.prepare('SELECT * FROM users       WHERE id = ?').get(userId);

    res.json({
      success:       true,
      user:          updatedUser,
      new_placed_at: updatedItem.placed_at,
      skipped_ms:    skipMs,
      inventory:     getInventoryMap(userId),
    });
  } catch (error) {
    console.error('Fertilize Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/harvest  — legacy endpoint (kept for backward compat)
// Body: { user_id, farm_item_id, crop_name }
app.post('/api/harvest', (req, res) => {
  const { user_id, farm_item_id, crop_name } = req.body;
  const userId = Number(user_id);

  const item = db.prepare('SELECT * FROM farm_items WHERE id = ? AND user_id = ?')
    .get(Number(farm_item_id), userId);
  if (!item) return res.status(404).json({ error: 'Farm item not found.' });

  adjustInventory(userId, `harvested_${crop_name}`, 1);
  db.prepare('DELETE FROM farm_items WHERE id = ?').run(item.id);

  res.json({ success: true, inventory: getInventoryMap(userId) });
});

// POST /api/fertilize  — Godot signals a player used fertilizer on a plant
// Deducts 1 fertilizer; shifts placed_at back by fertilizer_skip_seconds so
// Godot's real-time math sees the plant as older (i.e., more grown).
app.post('/api/fertilize', (req, res) => {
  const { user_id, farm_item_id } = req.body;
  const userId = Number(user_id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.fertilizer < 1) {
    return res.status(400).json({ error: 'No fertilizer available.' });
  }

  const item = db.prepare('SELECT * FROM farm_items WHERE id = ? AND user_id = ?')
    .get(Number(farm_item_id), userId);
  if (!item) return res.status(404).json({ error: 'Farm item not found.' });

  const skipSeconds = SHOP_CONFIG.fertilizer_skip_seconds ?? 1800;

  db.prepare('UPDATE users SET fertilizer = fertilizer - 1 WHERE id = ?').run(userId);
  db.prepare(
    'UPDATE farm_items SET placed_at = placed_at - ? WHERE id = ?'
  ).run(skipSeconds, item.id);

  const updatedItem = db.prepare('SELECT * FROM farm_items WHERE id = ?').get(item.id);
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  res.json({
    user:          updatedUser,
    farm_item:     updatedItem,
    new_placed_at: updatedItem.placed_at,
    skipped_seconds: skipSeconds,
  });
});

// GET /api/config  — shop config + layout for the frontend
app.get('/api/config', (_req, res) => {
  res.json({ shop: SHOP_CONFIG, layout: LAYOUT_CONFIG });
});

// GET /api/neighborhood/board  — community stats for the Announcement Board
// Derives three leaderboard-style stats from existing tables with no new schema.
app.get('/api/neighborhood/board', (_req, res) => {
  try {
    // Stat 1 — Farmer of the Day: user with the most active items in their farm
    const farmer = db.prepare(`
      SELECT u.id, u.username, COUNT(fi.id) AS item_count
      FROM farm_items fi
      JOIN users u ON u.id = fi.user_id
      GROUP BY fi.user_id
      ORDER BY item_count DESC
      LIMIT 1
    `).get();

    // Stat 2 — Richest Farmer: user with the highest coin balance
    const tycoon = db.prepare(
      'SELECT id, username, coins FROM users ORDER BY coins DESC LIMIT 1'
    ).get();

    // Stat 3 — Newest Neighbor: most recently registered account (highest auto-increment id)
    const newest = db.prepare(
      'SELECT id, username FROM users ORDER BY id DESC LIMIT 1'
    ).get();

    res.json({
      farmer: farmer ? { id: farmer.id, username: farmer.username, count: farmer.item_count } : null,
      tycoon: tycoon ? { id: tycoon.id, username: tycoon.username, coins: tycoon.coins      } : null,
      newest: newest ? { id: newest.id, username: newest.username                            } : null,
    });
  } catch (err) {
    console.error('[neighborhood/board]', err);
    res.status(500).json({ error: 'Could not load community board.' });
  }
});

// ─── Dev helpers ────────────────────────────────────────────────────────────
// POST /api/dev/add-resources  — quickly add coins + fertilizer for testing
app.post('/api/dev/add-resources', (req, res) => {
  const { user_id, coins = 20, fertilizer = 10 } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user) return res.status(404).json({ error: 'User not found.' });

  db.prepare(
    'UPDATE users SET coins = coins + ?, fertilizer = fertilizer + ? WHERE id = ?'
  ).run(Number(coins), Number(fertilizer), Number(user_id));

  res.json({ user: db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id)) });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🌱 BitGarden backend running → http://localhost:${PORT}\n`);
  console.log(`  Economy : Kudos sender → +1 🌿  |  Kudos receiver → +1 🪙`);
  console.log(`  Shop    : ${SHOP_CONFIG.seeds.length} seeds, ${SHOP_CONFIG.animals.length} animals`);
  console.log(`  Fertilizer skips: ${SHOP_CONFIG.fertilizer_skip_seconds}s per use\n`);
});
