# Farming Game - Concept & Technical Architecture

## 1. Core Concept & Gameplay Loop
This is a full-stack web-based farming simulator. A Godot 4 WebAssembly canvas handles the real-time simulation, a React frontend manages the UI and session state, and a Backend Database stores the persistent economy and farm layout.

**The "Kudos" Economy:**
The game is driven by a social interaction system called "Kudos" handled via the web app.
* **Sending Kudos:** When a player sends a Kudos to another user, the backend rewards them with **Fertilizer**.
* **Receiving Kudos:** When a player receives a Kudos, the backend rewards them with **Coins**.
* **The Shop:** Coins are used in the React Shop UI to buy Seeds and Animals, updating the user's database inventory.
* **The Farm:** Players equip Seeds/Animals in React, click the Godot canvas to place them, and use Fertilizer to skip real-time growth timers. Harvested crops are sent back to the database.

## 2. Technical Stack
* **Game Engine:** Godot 4 (Standard/GDScript). Exported as HTML5 WebAssembly.
* **Frontend:** React (handles web UI, game embedding, and API calls).
* **Backend:** REST API (e.g., Node.js/Express, Python, etc.) to handle game logic validation and Kudos routing.
* **Database:** (e.g., PostgreSQL, MongoDB, Firebase) to store user balances, inventory, and persistent farm state.

## 3. Database Architecture (The Source of Truth)
The database tracks everything so players can close the browser and return tomorrow.
* **User Profile:** Stores `coins`, `fertilizer`, and history of `kudos_sent` / `kudos_received`.
* **Inventory:** Stores quantities of owned items (e.g., `pumpkin_seeds: 5`, `cow: 1`, `harvested_strawberries: 12`).
* **Farm State:** Saves the exact layout of the Godot board.
  * **Pots:** `{ pot_id: 1, seed: "Pumpkin", planted_timestamp: 1711160000 }`
  * **Pasture:** `{ animal_id: 1, type: "Cow", home_x: 250, home_y: 300, bought_timestamp: 1711160000 }`

## 4. Godot Architecture (The Simulation)
The Godot game is completely unaware of the database. It only acts as a visual simulation based on initial data passed down from React.
* **Main Scene (`bg.tscn`):** Contains `TileMap` collisions, `Area2D` "Dirt Pots", and an `Area2D` "Pasture".
* **Plants (`plant.tscn`):** Uses real-time math (`Time.get_unix_time_from_system() - planted_timestamp`). Growth calculates automatically even when offline.
* **Animals (`animal.tscn`):** `CharacterBody2D` with an internal State Machine (IDLE, WALK, EAT, SLEEP) and a "Tether" AI to roam around their assigned `home_x`/`home_y` coordinates.
* **Ambient Props:** Lightweight roaming AI (Chickens) and `AnimatedSprite2D` (Ducks, Butterflies) that exist purely for visuals and are not saved to the DB.

## 5. React Architecture (The Bridge & UI)
React acts as the middleman between the Database and the Godot Engine.
* **Game Canvas (`<FarmGame />`):** Embeds `/godot_game/index.html` via an `iframe`.
* **API Communication:** Fetches user state on load, and fires POST requests when Kudos are sent, items are bought, or crops are harvested.
* **UI Panels:** Kudos Dashboard, Warehouse/Inventory (selects `equipped_item` state), and the Shop.

## 6. The JavaScript Bridge (Data Flow)
Communication between React (Parent) and Godot (Iframe) is strictly event-based.

**A. React -> Godot (Commands):**
React calls exposed functions on the iframe's `window` object.
* `window.setEquippedItem(itemName, itemType)`: Tells Godot what the mouse cursor should drop.
* `window.loadFarmState(farmData)`: Sent on initial load. React fetches the DB Farm State and passes it to Godot to spawn the saved plants and animals.

**B. Godot -> React (Events):**
Godot uses `JavaScriptBridge.eval()` to send `window.parent.postMessage` to React.
* `HARVEST_CROP`: Godot says a plant was clicked. React fires an API call to add the crop to the DB and remove the plant from the DB Farm State.
* `USE_FERTILIZER`: Godot says a plant was fertilized. React fires an API call to deduct 1 Fertilizer, then tells Godot to skip the plant's timestamp forward.