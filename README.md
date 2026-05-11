# 🌱 BitGarden

A pixel-art farming game for Hiya teammates. Buy seeds, grow crops, place animals, and leave kudos on your colleagues' farms. Built with Godot 4 (HTML5 export), React, and Node.js.

**Live:** [bitgarden.ez.hiya.dev](https://bitgarden.ez.hiya.dev)

https://github.com/jingzhix255/BitGarden/raw/main/bit-garden-compressed.mp4

---

## What's in the game

### Your Farm
The main view is a Godot 4 pixel-art scene embedded in the React frontend. Every player gets their own farm with pot slots for plants and open grass for animals.

- **Buy seeds and animals** from the shop using coins
- **Plant seeds** into any empty pot — they grow through 6 stages in real time
- **Place animals** anywhere on the grass — purely cosmetic, they roam around
- **Harvest fully grown crops** — they move into your inventory
- **Sell harvested crops** from your inventory for coins
- **Fertilize plants** to skip 12 hours of growth per use (costs 1 fertilizer)

### The Neighborhood
A community hub showing every player's farm card. Visit any colleague's farm to see their plants, animals, and kudos — but you can only modify your own.

- **Rolling kudos banner** — a live scrolling ticker of the latest messages sent across all farms, with pill cards that expand on hover to show the full message
- **Announcement board** — three daily community stats: Farmer of the Day (most active farm), Richest Farmer (most coins), and Newest Neighbor
- **Daily weather system** — consistent weather for each calendar day (Clear, Rain, Storm, Windy, Fog), each with full atmospheric CSS animations. Click the weather widget for an interactive effect
- **Search** — filter farms by name

### Kudos
Leave a note on any colleague's farm via the mailbox button. The sender gets +1 fertilizer; the receiver gets +2 coins.

---

## Economy

| Resource | How to earn | How to spend |
|---|---|---|
| 🪙 Coins | Receive a kudo (+2), sell harvested crops | Buy seeds and animals from the shop |
| 🌿 Fertilizer | Send a kudo (+1) | Fertilize plants to skip 12h of growth |

**New players start with:** 5 coins · 3 fertilizer

### Seeds (13 varieties)

| Crop | Cost | Sell value | Grow time |
|---|---|---|---|
| Cabbage | 2 🪙 | 4 🪙 | 90s |
| Tomato | 3 🪙 | 5 🪙 | 2 min |
| Broccoli | 3 🪙 | 5 🪙 | 2 min |
| Cauliflower | 3 🪙 | 5 🪙 | 2 min |
| Pumpkin | 3 🪙 | 6 🪙 | 2 min |
| Sunflower | 4 🪙 | 7 🪙 | 2.5 min |
| Cherry | 4 🪙 | 7 🪙 | 2.5 min |
| Peach | 4 🪙 | 7 🪙 | 2.5 min |
| Banana | 4 🪙 | 8 🪙 | 3 min |
| Strawberry | 4 🪙 | 8 🪙 | 3 min |
| Blackberry | 5 🪙 | 9 🪙 | 3.5 min |
| Apricot | 5 🪙 | 9 🪙 | 3.5 min |
| Watermelon | 5 🪙 | 10 🪙 | 4 min |

### Animals (cosmetic only, 9 varieties)

| Animal | Cost |
|---|---|
| Rabbit | 6 🪙 |
| Pig | 7 🪙 |
| Sheep / Goat / Pelican | 8 🪙 |
| Cow | 10 🪙 |
| Fox | 12 🪙 |
| Ostrich | 15 🪙 |
| Capybara | 20 🪙 |

---

## Tech stack

| Layer | Technology |
|---|---|
| Game engine | Godot 4 (exported to HTML5, embedded as a canvas) |
| Frontend | React 18 + Vite, VT323 pixel font, vanilla CSS animations |
| Backend | Node.js + Express |
| Database | Turso (libSQL / cloud SQLite) |
| Auth | Okta via EasyDeploy ALB OIDC proxy — no passwords, no login page |
| Deployment | GitHub Actions → EasyDeploy → AWS App Runner |

### Godot ↔ React bridge
Godot sends `postMessage` events (`GODOT_READY`, `PLANT_SEED`, `PLACE_ANIMAL`, `HARVEST_PLANT`, `FERTILIZE_PLANT`) to React. React responds by calling `window.loadFarmState(json)` to push authoritative database state back into the game engine. This keeps the visual state and database always in sync — Godot never stores game state locally.

---

## Running locally

**Prerequisites:** Node.js 18+, a Turso database (or omit `TURSO_*` vars to use a local SQLite file)

```bash
# 1. Install dependencies
npm install --prefix backend
npm install --prefix frontend

# 2. Set environment variables (copy and fill in)
cp backend/.env.example backend/.env

# 3. Start the backend (port 3001)
node backend/server.js

# 4. In another terminal, start the frontend dev server (port 5173)
npm run dev --prefix frontend
```

Open [http://localhost:5173](http://localhost:5173). Auth falls back to `LocalDevUser` automatically when Okta headers are absent.

**Dev tips:**
- Press `W` on the Neighborhood page to cycle through weather states
- The kudos banner shows realistic mock data when the database has no kudos yet

### Environment variables

| Variable | Description |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://...` URL from Turso dashboard (omit for local SQLite) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `CORS_ORIGIN` | Allowed origin in production (e.g. `https://bitgarden.ez.hiya.dev`) |
| `PORT` | HTTP port (defaults to `8080`) |
| `NODE_ENV` | Set to `production` to disable dev-only routes |

---

## Deployment

Push to `main` — GitHub Actions triggers the EasyDeploy pipeline, which builds the React frontend, bundles it into the Express server's static folder, and deploys to AWS App Runner behind the Okta-protected ALB.

The build command:
```
npm install --prefix backend && npm install --prefix frontend && npm run build --prefix frontend
```

The start command:
```
node backend/server.js
```

In production, Express serves the compiled `frontend/dist` as static files from the same process as the API, so there is no separate frontend server.
