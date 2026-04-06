require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const fs             = require('fs');
const { createClient } = require('@libsql/client');

const app = express();
app.set('trust proxy', true);

const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(
  corsOrigin
    ? { origin: corsOrigin, optionsSuccessStatus: 200 }
    : undefined
));

app.use(express.json());

// ─── Load config files ─────────────────────────────────────────────────────
const ITEMS_PATH    = path.join(__dirname, 'items.json');
const FALLBACK_PATH = path.join(__dirname, '..', 'shop-config.json');
const SHOP_CONFIG   = JSON.parse(
  fs.existsSync(ITEMS_PATH)
    ? fs.readFileSync(ITEMS_PATH, 'utf8')
    : fs.readFileSync(FALLBACK_PATH, 'utf8')
);
if (fs.existsSync(ITEMS_PATH)) console.log('📦  Item catalog loaded from backend/items.json');

const LAYOUT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'layout-config.json'), 'utf8')
);

// ─── Database (Turso / libSQL) ──────────────────────────────────────────────
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL  || 'file:bitgarden.db',
  authToken: process.env.TURSO_AUTH_TOKEN    || undefined,
});

// ─── Async helpers ──────────────────────────────────────────────────────────

async function getInventoryMap(userId) {
  const { rows } = await db.execute({
    sql: 'SELECT item_name, quantity FROM inventory WHERE user_id = ?',
    args: [userId],
  });
  return Object.fromEntries(rows.map(r => [r.item_name, r.quantity]));
}

async function adjustInventory(userId, itemName, delta) {
  await db.execute({
    sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, MAX(0, ?))
          ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = MAX(0, quantity + ?)`,
    args: [userId, itemName, delta, delta],
  });
}

async function syncFarmState(userId) {
  const { rows } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE user_id = ? ORDER BY id ASC',
    args: [userId],
  });
  const state = {
    pots: rows
      .filter(r => r.item_type === 'plant')
      .map(r => ({ pot_id: r.pot_id, seed: r.item_name, placed_at: Number(r.placed_at) })),
    animals: rows
      .filter(r => r.item_type === 'animal')
      .map(r => ({ animal: r.item_name, x: Number(r.home_x), y: Number(r.home_y), placed_at: Number(r.placed_at) })),
  };
  await db.execute({
    sql: 'UPDATE users SET farm_state = ? WHERE id = ?',
    args: [JSON.stringify(state), userId],
  });
  return state;
}

async function getUser(userId) {
  const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
  return rows[0] ?? null;
}

async function getUserByName(username) {
  const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
  return rows[0] ?? null;
}

// ─── JWT helper ─────────────────────────────────────────────────────────────

function parseAlbOidcJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

// ─── Routes ────────────────────────────────────────────────────────────────

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  try {
    const oidcData = req.headers['x-amzn-oidc-data'];
    let rawUsername = null;
    if (oidcData) {
      const claims = parseAlbOidcJwt(oidcData);
      if (claims) {
        const email = claims.preferred_username || claims.email || '';
        const emailPrefix = email.includes('@') ? email.split('@')[0] : email;
        rawUsername = claims.given_name || emailPrefix || claims.sub;
      }
    }

    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    rawUsername = rawUsername || (isLocal ? 'LocalDevUser' : null);

    if (!rawUsername) {
      return res.status(401).json({ error: 'Unauthenticated: no identity header present.' });
    }

    const username = rawUsername.trim();
    let user = await getUserByName(username);

    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      const profileImage =
        `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(username)}`;
      try {
        const tx = await db.transaction('write');
        const r = await tx.execute({
          sql: 'INSERT INTO users (username, coins, fertilizer, profile_image) VALUES (?, 5, 5, ?)',
          args: [username, profileImage],
        });
        await tx.commit();
        user = await getUser(Number(r.lastInsertRowid));
      } catch (txErr) {
        console.error('[auth/me] provision error:', txErr);
        return res.status(500).json({ error: 'Account provisioning failed.' });
      }
    }

    res.json({ ...user, is_new_user: isNewUser });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/users
app.get('/api/users', async (_req, res) => {
  const { rows } = await db.execute("SELECT * FROM users WHERE username != 'LocalDevUser' ORDER BY id ASC");
  res.json(rows);
});

// GET /api/garden/:userId
app.get('/api/garden/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { rows: kudos } = await db.execute({
    sql: 'SELECT * FROM kudos WHERE receiver_id = ? ORDER BY timestamp DESC LIMIT 50',
    args: [userId],
  });

  const slots = LAYOUT_CONFIG.map(slot => ({ ...slot, plant: null }));
  res.json({ user, slots, kudos });
});

// GET /api/farm/:userId
app.get('/api/farm/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { rows: farm_items } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE user_id = ? ORDER BY id ASC',
    args: [userId],
  });

  const inventory  = await getInventoryMap(userId);
  const farm_state = await syncFarmState(userId);

  res.json({ user, farm_items, inventory, farm_state });
});

// POST /api/kudos/leave
app.post('/api/kudos/leave', async (req, res) => {
  const { sender_id, sender_name, receiver_id, message } = req.body;
  if (!(sender_name ?? '').trim()) return res.status(400).json({ error: 'sender_name is required.' });
  if (!(message    ?? '').trim()) return res.status(400).json({ error: 'message is required.'     });

  const receiver = await getUser(Number(receiver_id));
  if (!receiver) return res.status(404).json({ error: 'Receiver not found.' });

  await db.execute({
    sql: 'INSERT INTO kudos (sender_id, sender_name, receiver_id, message) VALUES (?, ?, ?, ?)',
    args: [sender_id ? Number(sender_id) : null, sender_name.trim(), Number(receiver_id), message.trim()],
  });

  // Receiver gets +2 coins; sender gets +1 fertilizer
  await db.execute({ sql: 'UPDATE users SET coins = coins + 2 WHERE id = ?', args: [Number(receiver_id)] });

  let updatedSender = null;
  if (sender_id) {
    await db.execute({ sql: 'UPDATE users SET fertilizer = fertilizer + 1 WHERE id = ?', args: [Number(sender_id)] });
    updatedSender = await getUser(Number(sender_id));
  }

  const updatedReceiver = await getUser(Number(receiver_id));
  res.json({ success: true, receiver: updatedReceiver, sender: updatedSender });
});

// POST /api/shop/buy
app.post('/api/shop/buy', async (req, res) => {
  const { user_id, item_name } = req.body;
  const userId = Number(user_id);

  if (!item_name || !item_name.trim()) {
    return res.status(400).json({ error: 'item_name is required.' });
  }

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const allItems  = [...SHOP_CONFIG.seeds, ...SHOP_CONFIG.animals];
  const nameLower = item_name.toLowerCase().trim();
  const item = allItems.find(i => i.name.toLowerCase() === nameLower)
            ?? allItems.find(i => i.id.toLowerCase()   === nameLower);
  const cost = item?.cost ?? 5;

  if (user.coins < cost) {
    return res.status(400).json({ error: `Not enough coins. Need ${cost}🪙, have ${user.coins}🪙.` });
  }

  const canonicalName = item?.name ?? item_name.trim();

  await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE id = ?', args: [cost, userId] });
  await adjustInventory(userId, canonicalName, 1);

  res.json({
    user:      await getUser(userId),
    inventory: await getInventoryMap(userId),
  });
});

// GET /api/inventory/:userId
app.get('/api/inventory/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ inventory: await getInventoryMap(userId) });
});

// POST /api/farm/place
app.post('/api/farm/place', async (req, res) => {
  const { user_id, item_name, item_type, pot_id, home_x, home_y } = req.body;
  const userId = Number(user_id);

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = await getInventoryMap(userId);
  if ((inv[item_name] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${item_name} in inventory.` });
  }

  if (item_type === 'plant' && pot_id != null) {
    const { rows } = await db.execute({
      sql: 'SELECT id FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?',
      args: [userId, 'plant', String(pot_id)],
    });
    if (rows.length > 0) return res.status(400).json({ error: 'That pot is already occupied.' });
  }

  await adjustInventory(userId, item_name, -1);

  const r = await db.execute({
    sql: 'INSERT INTO farm_items (user_id, item_type, item_name, pot_id, home_x, home_y) VALUES (?, ?, ?, ?, ?, ?)',
    args: [
      userId, item_type, item_name,
      pot_id  != null ? String(pot_id)  : null,
      home_x  != null ? Number(home_x)  : null,
      home_y  != null ? Number(home_y)  : null,
    ],
  });

  const { rows: [farm_item] } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE id = ?', args: [Number(r.lastInsertRowid)],
  });
  res.status(201).json({ farm_item, inventory: await getInventoryMap(userId) });
});

// POST /api/farm/save
app.post('/api/farm/save', async (req, res) => {
  const { user_id, farm_state: rawState } = req.body;
  const userId = Number(user_id);

  if (!rawState) return res.status(400).json({ error: 'farm_state is required.' });

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const pots    = rawState.pots    ?? [];
  const animals = rawState.animals ?? [];

  const { rows: existingRows } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE user_id = ?', args: [userId],
  });
  const existingPlacedAt = {};
  for (const row of existingRows) {
    if (row.item_type === 'plant' && row.pot_id) {
      existingPlacedAt[`plant:${row.pot_id}`] = Number(row.placed_at);
    } else if (row.item_type === 'animal' && row.item_name) {
      existingPlacedAt[`animal:${row.item_name}`] = Number(row.placed_at);
    }
  }

  const tx = await db.transaction('write');
  try {
    await tx.execute({ sql: 'DELETE FROM farm_items WHERE user_id = ?', args: [userId] });

    const now = Date.now();

    for (const pot of pots) {
      if (!pot.pot_id || !pot.seed) continue;
      let placedAt;
      const rawPlacedAt = Number(pot.placed_at ?? 0);
      if (rawPlacedAt > 1e11) {
        placedAt = rawPlacedAt;
      } else if (pot.elapsed_time != null && Number(pot.elapsed_time) >= 0) {
        placedAt = now - Math.floor(Number(pot.elapsed_time) * 1000);
      } else {
        placedAt = existingPlacedAt[`plant:${String(pot.pot_id)}`] ?? now;
      }
      await tx.execute({
        sql: 'INSERT INTO farm_items (user_id, item_type, item_name, pot_id, placed_at) VALUES (?, ?, ?, ?, ?)',
        args: [userId, 'plant', pot.seed, String(pot.pot_id), placedAt],
      });
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
      await tx.execute({
        sql: 'INSERT INTO farm_items (user_id, item_type, item_name, home_x, home_y, placed_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [userId, 'animal', a.animal, Number(a.x ?? 0), Number(a.y ?? 0), placedAt],
      });
    }

    await tx.execute({
      sql: 'UPDATE users SET farm_state = ? WHERE id = ?',
      args: [JSON.stringify({ pots, animals }), userId],
    });

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    console.error('[farm/save] tx error:', err);
    return res.status(500).json({ error: 'Farm save failed.' });
  }

  res.json({ success: true, farm_state: { pots, animals } });
});

// POST /api/farm/plant-seed
app.post('/api/farm/plant-seed', async (req, res) => {
  const { user_id, pot_id, seed } = req.body;
  const userId = Number(user_id);

  const rawPotId  = String(pot_id ?? '').trim();
  const normPotId = /^\d+$/.test(rawPotId) ? `pot${rawPotId}` : rawPotId;

  if (pot_id == null || !normPotId || !seed) {
    return res.status(400).json({ error: 'pot_id and seed are required.' });
  }

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = await getInventoryMap(userId);
  if ((inv[seed] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${seed} in inventory.` });
  }

  const { rows: occupied } = await db.execute({
    sql: 'SELECT id FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?',
    args: [userId, 'plant', normPotId],
  });
  if (occupied.length > 0) return res.status(400).json({ error: `Pot ${normPotId} is already occupied.` });

  await adjustInventory(userId, seed, -1);
  await db.execute({
    sql: 'INSERT INTO farm_items (user_id, item_type, item_name, pot_id, placed_at) VALUES (?, ?, ?, ?, ?)',
    args: [userId, 'plant', seed, normPotId, Date.now()],
  });
  await syncFarmState(userId);

  res.json({ success: true, inventory: await getInventoryMap(userId) });
});

// POST /api/farm/place-animal
app.post('/api/farm/place-animal', async (req, res) => {
  const { user_id, animal, x, y } = req.body;
  const userId = Number(user_id);

  if (!animal) return res.status(400).json({ error: 'animal is required.' });

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const inv = await getInventoryMap(userId);
  if ((inv[animal] ?? 0) < 1) {
    return res.status(400).json({ error: `No ${animal} in inventory.` });
  }

  await adjustInventory(userId, animal, -1);
  await db.execute({
    sql: 'INSERT INTO farm_items (user_id, item_type, item_name, home_x, home_y, placed_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [userId, 'animal', animal, Number(x ?? 0), Number(y ?? 0), Date.now()],
  });
  await syncFarmState(userId);

  res.json({ success: true, inventory: await getInventoryMap(userId) });
});

// POST /api/farm/harvest
app.post('/api/farm/harvest', async (req, res) => {
  try {
    const { user_id, pot_id, crop, viewed_farm_id } = req.body;
    const userId = Number(user_id);

    if (viewed_farm_id == null || String(viewed_farm_id) !== String(userId)) {
      return res.status(403).json({ error: 'Crop theft blocked: you do not own this farm.' });
    }

    const normPotId = String(pot_id ?? '').trim().toLowerCase().startsWith('pot')
      ? String(pot_id).trim().toLowerCase()
      : `pot${pot_id}`;

    if (pot_id == null || !crop) {
      return res.status(400).json({ error: 'pot_id and crop are required.' });
    }

    const { rows: [item] } = await db.execute({
      sql: 'SELECT * FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?',
      args: [userId, 'plant', normPotId],
    });
    if (!item) return res.status(404).json({ error: `No plant found in pot ${normPotId}.` });
    if (String(item.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden: you do not own this farm.' });
    }

    const tx = await db.transaction('write');
    try {
      const harvestKey = `harvested_${crop}`;
      await tx.execute({
        sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
              ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = MAX(0, quantity + 1)`,
        args: [userId, harvestKey],
      });
      await tx.execute({ sql: 'DELETE FROM farm_items WHERE id = ?', args: [item.id] });
      await tx.commit();
    } catch (txError) {
      await tx.rollback();
      console.error('[farm/harvest] transaction rolled back:', txError);
      return res.status(500).json({ error: txError.message || 'Transaction failed.' });
    }

    await syncFarmState(userId);
    res.json({ success: true, inventory: await getInventoryMap(userId) });
  } catch (error) {
    console.error('Harvest Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/sell
// Sells one unit of a fully harvested crop from inventory for its sell_value in coins.
app.post('/api/sell', async (req, res) => {
  try {
    const { user_id, crop_name } = req.body;
    const userId = Number(user_id);

    if (!crop_name) return res.status(400).json({ error: 'crop_name is required.' });

    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Inventory key for harvested crops uses the "harvested_<crop>" convention.
    // Use case-insensitive lookup because the harvest route stores Title-Case keys
    // (e.g. "harvested_Pumpkin") while crop_name may arrive as any casing.
    const cropLower = crop_name.toLowerCase().trim();
    const invKeyLower = `harvested_${cropLower}`;
    const { rows: [invRow] } = await db.execute({
      sql: 'SELECT item_name, quantity FROM inventory WHERE user_id = ? AND LOWER(item_name) = ?',
      args: [userId, invKeyLower],
    });
    const actualKey = invRow?.item_name;          // preserve exact DB casing
    const qty       = Number(invRow?.quantity ?? 0);

    if (qty < 1) return res.status(400).json({ error: `No harvested ${crop_name} to sell.` });

    // Look up sell_value from config (match by crop field or by name).
    const seedEntry = SHOP_CONFIG.seeds.find(s =>
      s.crop?.toLowerCase() === cropLower ||
      s.name.toLowerCase()  === cropLower
    );
    const sellValue = seedEntry?.sell_value ?? 1;

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 0)
              ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = MAX(0, quantity - 1)`,
        args: [userId, actualKey],
      });
      await tx.execute({
        sql: 'UPDATE users SET coins = coins + ? WHERE id = ?',
        args: [sellValue, userId],
      });
      await tx.commit();
    } catch (txErr) {
      await tx.rollback();
      return res.status(500).json({ error: txErr.message || 'Transaction failed.' });
    }

    res.json({
      success:    true,
      sold:       crop_name,
      sell_value: sellValue,
      user:       await getUser(userId),
      inventory:  await getInventoryMap(userId),
    });
  } catch (err) {
    console.error('[sell]', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// POST /api/farm/fertilize
app.post('/api/farm/fertilize', async (req, res) => {
  try {
    const { user_id, pot_id, viewed_farm_id } = req.body;
    const userId = Number(user_id);

    if (viewed_farm_id == null || String(viewed_farm_id) !== String(userId)) {
      return res.status(403).json({ error: 'Action blocked: you do not own the farm you are trying to modify.' });
    }

    if (pot_id == null) return res.status(400).json({ error: 'pot_id is required.' });

    const normPotId = String(pot_id).trim().toLowerCase().startsWith('pot')
      ? String(pot_id).trim().toLowerCase()
      : `pot${pot_id}`;

    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.fertilizer < 1) return res.status(400).json({ error: 'No fertilizer available.' });

    const { rows: [item] } = await db.execute({
      sql: 'SELECT * FROM farm_items WHERE user_id = ? AND item_type = ? AND pot_id = ?',
      args: [userId, 'plant', normPotId],
    });
    if (!item) return res.status(404).json({ error: `No plant found in pot ${normPotId}.` });
    if (String(item.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Action blocked: you do not own the farm you are trying to modify.' });
    }

    const skipMs = Math.floor(Number(SHOP_CONFIG.fertilizer_skip_seconds ?? 1800) * 1000);

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: 'UPDATE users SET fertilizer = fertilizer - 1 WHERE id = ?',
        args: [userId],
      });

      const newPlacedAt = Number(item.placed_at) - skipMs;
      const plantResult = await tx.execute({
        sql: 'UPDATE farm_items SET placed_at = ? WHERE id = ?',
        args: [newPlacedAt, item.id],
      });

      if (plantResult.rowsAffected === 0) {
        throw new Error(`Plant update affected 0 rows (item.id=${item.id}) — rolled back`);
      }

      await tx.commit();
    } catch (txError) {
      await tx.rollback();
      console.error('[farm/fertilize] transaction rolled back:', txError);
      return res.status(500).json({ error: txError.message || 'Transaction failed.' });
    }

    await syncFarmState(userId);

    const updatedItem = (await db.execute({ sql: 'SELECT * FROM farm_items WHERE id = ?', args: [item.id] })).rows[0];
    const updatedUser = await getUser(userId);

    res.json({
      success:       true,
      user:          updatedUser,
      new_placed_at: Number(updatedItem.placed_at),
      skipped_ms:    skipMs,
      inventory:     await getInventoryMap(userId),
    });
  } catch (error) {
    console.error('Fertilize Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// POST /api/harvest  — legacy endpoint
app.post('/api/harvest', async (req, res) => {
  const { user_id, farm_item_id, crop_name } = req.body;
  const userId = Number(user_id);

  const { rows: [item] } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE id = ? AND user_id = ?',
    args: [Number(farm_item_id), userId],
  });
  if (!item) return res.status(404).json({ error: 'Farm item not found.' });

  await adjustInventory(userId, `harvested_${crop_name}`, 1);
  await db.execute({ sql: 'DELETE FROM farm_items WHERE id = ?', args: [item.id] });

  res.json({ success: true, inventory: await getInventoryMap(userId) });
});

// POST /api/fertilize  — legacy endpoint
app.post('/api/fertilize', async (req, res) => {
  const { user_id, farm_item_id } = req.body;
  const userId = Number(user_id);

  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.fertilizer < 1) return res.status(400).json({ error: 'No fertilizer available.' });

  const { rows: [item] } = await db.execute({
    sql: 'SELECT * FROM farm_items WHERE id = ? AND user_id = ?',
    args: [Number(farm_item_id), userId],
  });
  if (!item) return res.status(404).json({ error: 'Farm item not found.' });

  const skipSeconds = SHOP_CONFIG.fertilizer_skip_seconds ?? 1800;

  await db.execute({ sql: 'UPDATE users SET fertilizer = fertilizer - 1 WHERE id = ?', args: [userId] });
  await db.execute({
    sql: 'UPDATE farm_items SET placed_at = placed_at - ? WHERE id = ?',
    args: [skipSeconds * 1000, item.id],
  });

  const updatedItem = (await db.execute({ sql: 'SELECT * FROM farm_items WHERE id = ?', args: [item.id] })).rows[0];
  const updatedUser = await getUser(userId);

  res.json({
    user:          updatedUser,
    farm_item:     updatedItem,
    new_placed_at: Number(updatedItem.placed_at),
    skipped_seconds: skipSeconds,
  });
});

// GET /api/config
app.get('/api/config', (_req, res) => {
  res.json({ shop: SHOP_CONFIG, layout: LAYOUT_CONFIG });
});

// GET /api/neighborhood/board
app.get('/api/neighborhood/board', async (_req, res) => {
  try {
    const { rows: [farmer] } = await db.execute(`
      SELECT u.id, u.username, COUNT(fi.id) AS item_count
      FROM farm_items fi
      JOIN users u ON u.id = fi.user_id
      WHERE u.username != 'LocalDevUser'
      GROUP BY fi.user_id
      ORDER BY item_count DESC
      LIMIT 1
    `);

    const { rows: [tycoon] } = await db.execute(
      "SELECT id, username, coins FROM users WHERE username != 'LocalDevUser' ORDER BY coins DESC LIMIT 1"
    );

    const { rows: [newest] } = await db.execute(
      "SELECT id, username FROM users WHERE username != 'LocalDevUser' ORDER BY id DESC LIMIT 1"
    );

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

// ─── Dev helpers (disabled in production) ────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/add-resources', async (req, res) => {
    const { user_id, coins = 20, fertilizer = 10 } = req.body;
    const user = await getUser(Number(user_id));
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.execute({
      sql: 'UPDATE users SET coins = coins + ?, fertilizer = fertilizer + ? WHERE id = ?',
      args: [Number(coins), Number(fertilizer), Number(user_id)],
    });

    res.json({ user: await getUser(Number(user_id)) });
  });
}

// ─── Serve React frontend (production) ──────────────────────────────────────
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  const isTurso = !!process.env.TURSO_DATABASE_URL;
  console.log(`\n🌱 BitGarden backend running → http://localhost:${PORT}`);
  console.log(`  Database: ${isTurso ? 'Turso (libSQL)' : 'local SQLite file'}`);
  console.log(`  Economy : Kudos sender → +1 🌿  |  Kudos receiver → +1 🪙`);
  console.log(`  Shop    : ${SHOP_CONFIG.seeds.length} seeds, ${SHOP_CONFIG.animals.length} animals`);
  console.log(`  Fertilizer skips: ${SHOP_CONFIG.fertilizer_skip_seconds}s per use\n`);
});
