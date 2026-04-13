import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../App.jsx';

// ─── Godot name translator ───────────────────────────────────────────────────
// Converts ANY backend/DB format → the exact Title Case string Godot expects.
// The explicit map is the source of truth for all known items; new items added
// to the game are handled automatically by the generic Title Case fallback.
const GODOT_NAMES = {
  // ── Seeds (both bare and _seeds variant) ─────────────────────────────────
  pumpkin:            'Pumpkin',     pumpkin_seeds:     'Pumpkin',
  strawberry:         'Strawberry',  strawberry_seeds:  'Strawberry',
  cherry:             'Cherry',      cherry_seeds:      'Cherry',
  sunflower:          'Sunflower',   sunflower_seeds:   'Sunflower',
  broccoli:           'Broccoli',    broccoli_seeds:    'Broccoli',
  blackberry:         'Blackberry',  blackberry_seeds:  'Blackberry',
  banana:             'Banana',      banana_seeds:      'Banana',
  peach:              'Peach',       peach_seeds:       'Peach',
  cabbage:            'Cabbage',     cabbage_seeds:     'Cabbage',
  apricot:            'Apricot',     apricot_seeds:     'Apricot',
  cauliflower:        'Cauliflower', cauliflower_seeds: 'Cauliflower',
  watermelon:         'Watermelon',  watermelon_seeds:  'Watermelon',
  tomato:             'Tomato',      tomato_seeds:      'Tomato',
  // ── Animals ───────────────────────────────────────────────────────────────
  cow:      'Cow',
  pelican:  'Pelican',
  sheep:    'Sheep',
  fox:      'Fox',
  pig:      'Pig',
  goat:     'Goat',
  ostrich:  'Ostrich',
  rabbit:   'Rabbit',
  capybara: 'Capybara',
};

/**
 * Translate any DB/backend item name to the exact Title Case string Godot
 * uses in its dictionaries.  Idempotent: "Pumpkin" → "Pumpkin".
 */
function toGodotName(raw) {
  if (!raw) return '';
  const key = raw.toLowerCase().trim();
  if (GODOT_NAMES[key]) return GODOT_NAMES[key];
  return key
    .replace(/_seeds$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Persistent Godot canvas ──────────────────────────────────────────────────
// Created once, never destroyed by React.  On mount we just parent it into the
// current container div so the engine keeps rendering to the *same* WebGL context.
let __godotCanvas = null;
function getGodotCanvas() {
  if (!__godotCanvas) {
    __godotCanvas = document.createElement('canvas');
    __godotCanvas.id = 'godot-canvas';
    __godotCanvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;display:block;border:none;';
  }
  return __godotCanvas;
}

/**
 * Normalise a pot identifier to the "potN" string format Godot expects.
 *   0        → "pot0"
 *   "0"      → "pot0"
 *   "pot0"   → "pot0"   (idempotent)
 *   1        → "pot1"
 */
function normalizePotId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^pot\d+$/i.test(s)) return s.toLowerCase(); // already "pot0" etc.
  if (/^\d+$/.test(s))     return `pot${s}`;        // bare integer → "pot0"
  return s;
}

// ─── Pixel-art icon helper ───────────────────────────────────────────────────
// Renders a crisp pixel-art image at the requested size with a consistent
// visual footprint.  Silently hides itself if the asset is missing.
function PixelImg({ src, alt = '', size = 20, style = {} }) {
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      onError={e => { e.currentTarget.style.display = 'none'; }}
      style={{
        imageRendering: 'pixelated',
        objectFit: 'contain',
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

export default function FarmGame() {
  const { currentUser }          = useSession();
  const { userId: paramUserId }  = useParams();          // set when visiting /garden/:userId
  const navigate                 = useNavigate();
  const godotContainerRef        = useRef(null);
  const godotEngineRef           = useRef(null);

  // Loading screen state
  const [godotLoading, setGodotLoading]     = useState(true);
  const [loadProgress, setLoadProgress]     = useState(0);

  // Onboarding — show once per device for owners
  const ONBOARD_KEY = 'bitgarden_onboarded';
  const [onboardStep, setOnboardStep] = useState(() =>
    localStorage.getItem(ONBOARD_KEY) ? null : 0
  );
  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARD_KEY, '1');
    setOnboardStep(null);
  };
  const nextOnboardStep = () => {
    if (onboardStep >= ONBOARD_STEPS.length - 1) dismissOnboarding();
    else setOnboardStep(s => s + 1);
  };

  // Who owns this farm? Owner mode when viewing your own, visitor mode otherwise.
  const viewedUserId = paramUserId ? Number(paramUserId) : currentUser.id;
  const isOwner      = viewedUserId === currentUser.id;

  // Ref tracking the CURRENT viewedUserId — always up-to-date inside any closure,
  // even stale ones.  We check this directly instead of a derived isOwner boolean
  // so navigating between two neighbors (both isOwner=false) still re-evaluates correctly.
  const viewedUserIdRef = useRef(viewedUserId);
  useEffect(() => { viewedUserIdRef.current = viewedUserId; }, [viewedUserId]);

  const [viewedUser,  setViewedUser]  = useState(null);
  const [myUser,      setMyUser]      = useState(currentUser);

  // Always-current myUser ref — lets closures read live fertilizer/coins without
  // being stale (myUser itself is captured at effect-registration time).
  // Must be declared AFTER myUser to avoid temporal dead zone.
  const myUserRef = useRef(myUser);
  useEffect(() => { myUserRef.current = myUser; }, [myUser]);
  const [farmItems,   setFarmItems]   = useState([]);
  const [inventory,   setInventory]   = useState({});
  const [shopCfg,     setShopCfg]     = useState({ seeds: [], animals: [] });
  const [tab,         setTab]         = useState('Shop');
  const [equipped,    setEquipped]    = useState(null);
  const [status,      setStatus]      = useState('');
  const [popCoins,    setPopCoins]    = useState(false);
  const [popFert,     setPopFert]     = useState(false);
  const prevCoinsRef = useRef(null);
  const prevFertRef  = useRef(null);

  // Fertilize pop-up animation — increments on each successful fertilize
  const [fertAnimKey, setFertAnimKey] = useState(0);
  // In-flight guard: prevents queuing multiple simultaneous fertilize calls
  const fertInFlightRef = useRef(false);

  // ── Godot catalog (populated by GODOT_READY handshake) ──────────────────
  const [availablePlants,  setAvailablePlants]  = useState([]);
  const [availableAnimals, setAvailableAnimals] = useState([]);

  // ── Godot bridge state ────────────────────────────────────────────────────
  // Both are state (reactive) so the useEffect below can watch them together.
  // Refs mirror them so async event handlers always read the latest value
  // without needing to be re-registered.
  const [isGodotReady, setIsGodotReady] = useState(false);
  const [farmState,    setFarmState]    = useState(null);
  const isGodotReadyRef = useRef(false);
  const farmStateRef    = useRef(null);

  const [kudos, setKudos] = useState([]);

  // ── Kudo UI state ─────────────────────────────────────────────────────────
  const [showCompose,   setShowCompose]   = useState(false);
  const [expandedKudo,  setExpandedKudo]  = useState(null);
  const [readKudoIds,   setReadKudoIds]   = useState(
    () => new Set(JSON.parse(localStorage.getItem('bgReadKudos') ?? '[]'))
  );
  const markRead = useCallback((id) => {
    setReadKudoIds(prev => {
      const next = new Set(prev);
      next.add(String(id));
      localStorage.setItem('bgReadKudos', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // ── Pop animation when coins/fertilizer change ────────────────────────────
  useEffect(() => {
    const coins = myUser?.coins;
    const fert  = myUser?.fertilizer;
    if (prevCoinsRef.current !== null && coins !== prevCoinsRef.current) {
      setPopCoins(true);
      setTimeout(() => setPopCoins(false), 400);
    }
    if (prevFertRef.current !== null && fert !== prevFertRef.current) {
      setPopFert(true);
      setTimeout(() => setPopFert(false), 400);
    }
    prevCoinsRef.current = coins;
    prevFertRef.current  = fert;
  }, [myUser?.coins, myUser?.fertilizer]);

  // ── Load item catalog from backend API ───────────────────────────────────
  // items.json now lives in backend/ (safe from Godot re-exports), served via /api/config.
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => setShopCfg(d.shop ?? { seeds: [], animals: [] }))
      .catch(err => console.error('[FarmGame] Failed to load shop config:', err));
  }, []);

  // ── Fetch farm state for the viewed user ────────────────────────────────
  // loadFarm ONLY fetches data and updates React state.  The bridge useEffect
  // below reacts to the farmState change and pushes the payload to Godot.
  const loadFarm = useCallback(async () => {
    try {
      const res  = await fetch(`/api/farm/${viewedUserId}`);
      const data = await res.json();

      setViewedUser(data.user);
      setFarmItems(data.farm_items ?? []);

      // Fetch kudos for the right panel (works for both owner and visitor)
      fetch(`/api/garden/${viewedUserId}`)
        .then(r => r.ok ? r.json() : { kudos: [] })
        .then(d => setKudos(d.kudos ?? []))
        .catch(() => setKudos([]));

      if (isOwner) {
        setMyUser(data.user);
        myUserRef.current = data.user;
        setInventory(data.inventory ?? {});
      } else {
        const me = await fetch(`/api/farm/${currentUser.id}`);
        if (me.ok) { const d = await me.json(); setMyUser(d.user); myUserRef.current = d.user; }
      }

      const raw = data.farm_state ?? { pots: [], animals: [] };
      const newFarmState = {
        pots: (raw.pots ?? []).map(p => {
          const rawTs      = Number(p.placed_at ?? 0);
          const placedMs   = rawTs > 0 && rawTs < 1e11 ? rawTs * 1000 : rawTs;
          const safePlaced = placedMs > 0 ? placedMs : Date.now();
          return {
            pot_id:          normalizePotId(p.pot_id),
            seed:            toGodotName(p.seed),
            placed_at:       safePlaced,
            fertilize_count: Number(p.fertilize_count ?? 0),
          };
        }),
        animals: (raw.animals ?? []).map(a => {
          const rawTs    = Number(a.placed_at ?? 0);
          const placedMs = rawTs > 0 && rawTs < 1e11 ? rawTs * 1000 : rawTs;
          const safePlacedMs = placedMs > 0 ? placedMs : Date.now();
          return {
            animal:    toGodotName(a.animal),
            x:         Number(a.x ?? 0),
            y:         Number(a.y ?? 0),
            placed_at: safePlacedMs,
          };
        }),
      };

      farmStateRef.current = newFarmState;
      setFarmState(newFarmState);
    } catch (err) {
      console.error('[FarmGame] loadFarm error:', err);
    }
  }, [viewedUserId, isOwner, currentUser.id]);

  // ── Messages from Godot ───────────────────────────────────────────────────
  // IMPORTANT: viewedUserId is in the dep array so the listener is torn down
  // and re-registered on every farm navigation — no ghost listeners.
  useEffect(() => {
    // Capture both IDs at the time this effect runs so the closure is always
    // consistent.  viewedUserIdRef.current provides a belt-and-suspenders
    // runtime check on top, catching any edge-case timing issues.
    const myId     = currentUser.id;
    const theirId  = viewedUserId;          // stable for this effect's lifetime

    const onMessage = async (event) => {
      if (!event.data) return;
      const { type } = event.data;
      const payload = event.data;

      // ── Handshake ──────────────────────────────────────────────────────
      if (type === 'GODOT_READY') {
        isGodotReadyRef.current = true;
        setIsGodotReady(true);
        const plants  = (event.data.plants  ?? []).map(toGodotName);
        const animals = (event.data.animals ?? []).map(toGodotName);
        setAvailablePlants(plants);
        setAvailableAnimals(animals);

        // Belt-and-suspenders: push farm data directly at 500ms and 1000ms.
        // Catches the race where the bridge effect already ran before
        // loadFarmState was registered or before Godot's scene tree was ready.
        const pushIfReady = () => {
          const fs = farmStateRef.current;
          if (!fs || typeof window.loadFarmState !== 'function') return;
          const fmtD = (ms) => {
            if (!ms || ms <= 0) return '';
            const d = new Date(ms);
            return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
          };
          window.loadFarmState(JSON.stringify({
            farm_owner_id: theirId,
            is_owner: myId === theirId,
            fertilizer: myUserRef.current?.fertilizer ?? 0,
            pots: (fs.pots ?? []).map(p => ({
              pot_id: normalizePotId(p.pot_id),
              seed: toGodotName(p.seed),
              elapsed_time: Math.max(0, Math.floor((Date.now() - (p.placed_at ?? 0)) / 1000)),
              fertilize_count: Number(p.fertilize_count ?? 0),
              planted_date: fmtD(p.placed_at),
            })),
            animals: (fs.animals ?? []).map(a => ({
              animal: toGodotName(a.animal),
              x: Number(a.x ?? 0),
              y: Number(a.y ?? 0),
              elapsed_time: Math.max(0, Math.floor((Date.now() - (a.placed_at ?? 0)) / 1000)),
              planted_date: fmtD(a.placed_at),
            })),
          }));
        };
        setTimeout(pushIfReady, 500);
        setTimeout(pushIfReady, 1000);

        // If loadFarm hasn't fetched data yet, kick it off now
        if (!farmStateRef.current) loadFarm();

        return;
      }

      // ── Triple-lock ownership gate ─────────────────────────────────────
      const payloadFarmOwner = payload.farm_owner_id != null
        ? Number(payload.farm_owner_id) : null;

      const isActualOwner =
        myId === theirId &&
        myId === viewedUserIdRef.current &&
        (payloadFarmOwner === null || payloadFarmOwner === theirId);

      if (!isActualOwner) {
        if (type === 'HARVEST_CROP' || type === 'HARVEST_PLANT' ||
            type === 'USE_FERTILIZER' || type === 'FERTILIZE_PLANT') {
          flash("👀 You're a visitor — only the owner can tend this farm");
        }
        return;
      }

      try {
        // ── PLANT_SEED ───────────────────────────────────────────────────
        if (type === 'PLANT_SEED') {
          const pot_id = normalizePotId(payload.pot_id);
          const seed   = toGodotName(payload.seed);
          const res = await fetch('/api/farm/plant-seed', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: myId, pot_id, seed }),
          });
          if (res.ok) {
            const r = await res.json();
            setInventory(r.inventory);
            setEquipped(null);
            const now = Date.now();
            setFarmState(prev => {
              const updated = { ...(prev ?? { pots: [], animals: [] }) };
              updated.pots = [...(updated.pots ?? []), { pot_id, seed, placed_at: now, fertilize_count: 0 }];
              return updated;
            });
            setFarmItems(prev => [
              ...prev,
              { user_id: myId, item_type: 'plant', item_name: seed, pot_id, placed_at: now },
            ]);
            flash(`🌱 Planted ${seed}!`);
          } else {
            const r = await res.json().catch(() => ({ error: 'Request failed' }));
            flash(`❌ ${r.error}`);
            if (res.status === 400) loadFarm();
          }
        }

        // ── PLACE_ANIMAL ─────────────────────────────────────────────────
        if (type === 'PLACE_ANIMAL') {
          const { x, y } = payload;
          const animal = toGodotName(payload.animal);
          const res = await fetch('/api/farm/place-animal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: myId, animal, x, y }),
          });
          if (res.ok) {
            const r = await res.json();
            setInventory(r.inventory);
            setEquipped(null);
            const now = Date.now();
            setFarmState(prev => {
              const updated = { ...(prev ?? { pots: [], animals: [] }) };
              updated.animals = [...(updated.animals ?? []), { animal, x: Number(x ?? 0), y: Number(y ?? 0), placed_at: now }];
              return updated;
            });
            setFarmItems(prev => [
              ...prev,
              { user_id: myId, item_type: 'animal', item_name: animal, home_x: Number(x ?? 0), home_y: Number(y ?? 0), placed_at: now },
            ]);
            flash(`🐾 Placed ${animal}!`);
          } else {
            const r = await res.json().catch(() => ({ error: 'Request failed' }));
            flash(`❌ ${r.error}`);
          }
        }

        // ── HARVEST_CROP / HARVEST_PLANT ─────────────────────────────────
        if (type === 'HARVEST_CROP' || type === 'HARVEST_PLANT') {
          const pot_id = normalizePotId(payload.pot_id);
          const crop   = toGodotName(payload.crop ?? payload.seed);
          const res = await fetch('/api/farm/harvest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: myId, pot_id, crop, viewed_farm_id: theirId }),
          });
          if (res.ok) {
            const r = await res.json();
            setInventory(r.inventory);
            setFarmItems(prev => prev.filter(
              fi => !(fi.item_type === 'plant' && normalizePotId(fi.pot_id) === pot_id)
            ));
            setTab('Inventory');
            flash(`🌾 Harvested ${crop}!`);
          } else {
            const r = await res.json().catch(() => ({ error: 'Request failed' }));
            flash(`❌ ${r.error}`);
          }
        }

        // ── USE_FERTILIZER / FERTILIZE_PLANT ─────────────────────────────
        if (type === 'USE_FERTILIZER' || type === 'FERTILIZE_PLANT') {
          const pot_id = normalizePotId(payload.pot_id);

          const currentFert = myUserRef.current?.fertilizer ?? 0;
          if (currentFert < 1) { flash('❌ No fertilizer left!'); return; }
          if (fertInFlightRef.current) return;
          fertInFlightRef.current = true;

          try {
            const res = await fetch('/api/farm/fertilize', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: myId, pot_id, viewed_farm_id: theirId }),
            });
            if (res.ok) {
              const r = await res.json();
              setMyUser(r.user);
              myUserRef.current = r.user;

              setFarmState(prev => {
                if (!prev) return prev;
                const updated = {
                  ...prev,
                  pots: (prev.pots ?? []).map(p =>
                    normalizePotId(p.pot_id) === pot_id
                      ? { ...p, fertilize_count: r.fertilize_count }
                      : p
                  ),
                };
                farmStateRef.current = updated;
                return updated;
              });

              setFertAnimKey(k => k + 1);
              flash('🌿 +1 stage growth!');
            } else {
              const r = await res.json().catch(() => ({ error: 'No fertilizer available.' }));
              flash(`❌ ${r.error}`);
            }
          } finally {
            fertInFlightRef.current = false;
          }
        }
      } catch (err) {
        console.error('[FarmGame] message handler error:', err);
      }
    };

    window.addEventListener('message', onMessage);
    // Cleanup is mandatory — removes exactly this listener reference so
    // no ghost listeners accumulate across farm navigations.
    return () => window.removeEventListener('message', onMessage);
  }, [currentUser.id, viewedUserId]);  // viewedUserId ensures re-register on every farm change


  // ── Reload farm on same-component param changes (/garden/3 → /garden/5) ──
  // The engine loading effect handles the initial load on mount/remount.
  // This effect only handles the case where React keeps the component mounted
  // but the URL param changes (same <Route>, different userId).
  useEffect(() => {
    if (isGodotReadyRef.current) loadFarm();
  }, [viewedUserId, loadFarm]);

  // ── Load Godot engine inline ─────────────────────────────────────────────
  // The canvas lives OUTSIDE of React (see getGodotCanvas()) so it is never
  // destroyed on unmount.  On every mount we just parent it into the current
  // container div — the engine keeps its WebGL context.
  useEffect(() => {
    const container = godotContainerRef.current;
    if (!container) return;

    const canvas = getGodotCanvas();

    // Always parent the persistent canvas into the current container
    if (canvas.parentNode !== container) {
      container.insertBefore(canvas, container.firstChild);
    }

    const syncSize = () => {
      const { width, height } = container.getBoundingClientRect();
      canvas.width  = Math.floor(width);
      canvas.height = Math.floor(height);
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    // ── REMOUNT PATH: engine already running from a prior mount ──────────
    if (window.__godotEngine) {
      godotEngineRef.current = window.__godotEngine;
      isGodotReadyRef.current = true;
      setLoadProgress(100);
      setGodotLoading(false);
      setIsGodotReady(true);
      loadFarm();
      return () => ro.disconnect();
    }

    // ── FIRST LOAD: inject the script and boot the engine ────────────────
    const bootEngine = () => {
      const GODOT_CONFIG = {
        args: [],
        canvasResizePolicy: 0,
        emscriptenPoolSize: 8,
        ensureCrossOriginIsolationHeaders: false,
        executable: '/farm_build/index',
        experimentalVK: false,
        fileSizes: { 'index.pck': 537936, 'index.wasm': 37685705 },
        focusCanvas: true,
        gdextensionLibs: [],
        godotPoolSize: 4,
        canvas,
      };
      // eslint-disable-next-line no-undef
      const engine = new Engine(GODOT_CONFIG);
      godotEngineRef.current = engine;
      window.__godotEngine = engine;

      engine.startGame({
        onProgress: (current, total) => {
          if (total > 0) setLoadProgress(Math.round((current / total) * 100));
        },
      }).then(() => {
        setLoadProgress(100);
        setTimeout(() => setGodotLoading(false), 400);
        loadFarm();
      }).catch((err) => {
        console.error('[Godot] Failed to start:', err);
        setGodotLoading(false);
      });
    };

    if (document.querySelector('script[src="/farm_build/index.js"]')) {
      if (typeof Engine !== 'undefined') bootEngine();
      return () => ro.disconnect();
    }

    const script = document.createElement('script');
    script.src = '/farm_build/index.js';
    script.async = true;
    script.onload = bootEngine;
    document.head.appendChild(script);

    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Bridge: push farmState to Godot whenever it changes ─────────────────
  // This is the ONLY path that calls window.loadFarmState.  loadFarm() just
  // fetches data and calls setFarmState(); this effect reacts to that update
  // and pushes the constructed payload to Godot.
  //
  // On cold start, Godot may send GODOT_READY before registering
  // window.loadFarmState.  To handle this race, we poll briefly (up to 2s)
  // when the function isn't available yet rather than silently bailing.
  useEffect(() => {
    if (!isGodotReady || !farmState) return;

    const fmtD = (ms) => {
      if (!ms || ms <= 0) return '';
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    };

    const buildAndPush = () => {
      if (typeof window.loadFarmState !== 'function') return false;
      const payload = JSON.stringify({
        farm_owner_id: viewedUserId,
        is_owner: currentUser.id === viewedUserId,
        fertilizer: myUserRef.current?.fertilizer ?? 0,
        pots: (farmState.pots ?? []).map(p => ({
          pot_id:          normalizePotId(p.pot_id),
          seed:            toGodotName(p.seed),
          elapsed_time:    Math.max(0, Math.floor((Date.now() - (p.placed_at ?? 0)) / 1000)),
          fertilize_count: Number(p.fertilize_count ?? 0),
          planted_date:    fmtD(p.placed_at),
        })),
        animals: (farmState.animals ?? []).map(a => ({
          animal:       toGodotName(a.animal),
          x:            Number(a.x ?? 0),
          y:            Number(a.y ?? 0),
          elapsed_time: Math.max(0, Math.floor((Date.now() - (a.placed_at ?? 0)) / 1000)),
          planted_date: fmtD(a.placed_at),
        })),
      });
      window.loadFarmState(payload);
      return true;
    };

    if (buildAndPush()) {
      // Safety net: re-push after 500ms in case Godot's scene tree wasn't
      // fully ready when the first call arrived (common on cold start).
      const retry = setTimeout(() => buildAndPush(), 500);
      return () => clearTimeout(retry);
    }

    // loadFarmState may not be registered yet — poll briefly
    let attempts = 0;
    const timer = setInterval(() => {
      if (buildAndPush() || ++attempts >= 20) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [isGodotReady, farmState, viewedUserId, currentUser.id]);

  // ── Shop ──────────────────────────────────────────────────────────────────
  // Send item.name (display name) so it lands in inventory under the same key
  // that Godot uses in PLANT_SEED / PLACE_ANIMAL payloads.
  const buyItem = async (item) => {
    if ((myUser?.coins ?? 0) < item.cost) { flash(`❌ Need ${item.cost}🪙`, 'error'); return; }
    const res = await fetch('/api/shop/buy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.id, item_name: item.name }),
    });
    if (res.ok) { const r = await res.json(); setMyUser(r.user); setInventory(r.inventory); flash(`Bought ${item.name}!`); }
    else         flash(`❌ ${(await res.json()).error}`, 'error');
  };

  // ── Sell a harvested crop ────────────────────────────────────────────────
  const sellCrop = async (cropName) => {
    const res = await fetch('/api/sell', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.id, crop_name: cropName }),
    });
    const r = await res.json();
    if (res.ok) {
      setMyUser(r.user);
      setInventory(r.inventory);
      flash(`🪙 Sold ${toGodotName(cropName)} for +${r.sell_value} coins!`);
    } else {
      flash(`❌ ${r.error}`);
    }
  };

  // ── Equip an item — calls Godot's exposed JS function ───────────────────
  // type: "seed" | "animal"   name: any format — normalized to Title Case via toGodotName
  const equipItem = (type, name) => {
    if (!isOwner) return;

    const godotName = toGodotName(name);   // ensure Title Case before crossing the bridge
    const isSame    = equipped?.type === type && equipped?.name === godotName;
    const next      = isSame ? null : { type, name: godotName };
    setEquipped(next);

    if (window.setGodotEquippedItem) {
      window.setGodotEquippedItem(next?.type ?? null, next?.name ?? null);
    }
    flash(next ? `🖱 Click the farm to place ${godotName}` : 'Unequipped');
  };

  // ── Status flash ─────────────────────────────────────────────────────────
  const flashTimer = useRef(null);
  const flash = (msg) => {
    setStatus(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setStatus(''), 3000);
  };

  const allShopItems   = [...(shopCfg.seeds ?? []), ...(shopCfg.animals ?? [])];
  const placeableItems = Object.entries(inventory).filter(([k, q]) => !k.startsWith('harvested_') && q > 0);

  const farmTitle = `${viewedUser?.username ?? '…'}'s Farm`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#111', fontFamily: VT323 }}>

      {/* ── Floating toast ────────────────────────────────────────────── */}
      {status && <div className="fg-toast">{status}</div>}

      {/* ── Main 3-column layout ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── LEFT: Shop / Inventory (owner) or Farm info (visitor) ── */}
        <div style={{ width: 260, flexShrink: 0, background: '#111', borderRight: '2px solid #1e1e1e', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {isOwner ? (
            <OwnerSidebar
              tab={tab} setTab={setTab}
              shopCfg={shopCfg}
              myUser={myUser}
              inventory={inventory}
              placeableItems={placeableItems}
              allShopItems={allShopItems}
              equipped={equipped}
              onBuy={buyItem}
              onEquip={equipItem}
              onSell={sellCrop}
              availablePlants={availablePlants}
              availableAnimals={availableAnimals}
            />
          ) : (
            <VisitorFarmInfo farmItems={farmItems} shopCfg={shopCfg} />
          )}
        </div>

        {/* ── CENTER: Godot canvas (inline — no iframe, nginx blocks iframes) ── */}
        <div ref={godotContainerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#242424' }}>
          {/* ── Loading screen overlay ── */}
          {godotLoading && (
            <div className="fg-loading-overlay" style={{ opacity: loadProgress >= 100 ? 0 : 1, transition: 'opacity 0.4s ease-out' }}>
              <div className="fg-loading-scene">
                {/* Animated pixel sun */}
                <div className="fg-loading-sun" />

                {/* Ground strip */}
                <div className="fg-loading-ground" />

                {/* Animated sprout */}
                <div className="fg-loading-sprout">
                  <div className="fg-loading-sprout__stem" />
                  <div className="fg-loading-sprout__leaf fg-loading-sprout__leaf--l" />
                  <div className="fg-loading-sprout__leaf fg-loading-sprout__leaf--r" />
                </div>
              </div>

              {/* Title */}
              <div className="fg-loading-title">Preparing your farm…</div>

              {/* Progress bar */}
              <div className="fg-loading-bar-track">
                <div className="fg-loading-bar-fill" style={{ width: `${loadProgress}%` }} />
              </div>
              <div className="fg-loading-percent">{loadProgress}%</div>

              {/* Flavor tip */}
              <div className="fg-loading-tip">
                {loadProgress < 30 ? 'Tilling the soil…' :
                 loadProgress < 60 ? 'Planting seeds…' :
                 loadProgress < 90 ? 'Watering crops…' :
                 'Almost harvest time!'}
              </div>
            </div>
          )}
          {/* ── Fertilize confirmation pop ── */}
          {fertAnimKey > 0 && (
            <div key={fertAnimKey} className="fg-fert-pop" aria-hidden="true">
              <img src="/icons/fertilizer.png" alt="" width={20} height={20}
                style={{ imageRendering: 'pixelated', verticalAlign: 'middle', marginRight: 6 }} />
              +1 Stage
            </div>
          )}

          {/* Farm title banner pinned to bottom-center over the Godot scene */}
          <div style={{ position: 'absolute', bottom: 24, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <div className="fg-farm-banner">
                <span className="fg-farm-banner__star">★</span>
                <img
                  src={`https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(viewedUser?.username ?? '')}`}
                  alt={viewedUser?.username}
                  className="fg-farm-banner__avatar"
                />
                <span className="fg-farm-banner__title">{farmTitle}</span>
                <span className="fg-farm-banner__star">★</span>
              </div>
              {isOwner && kudos.filter(k => !readKudoIds.has(String(k.id))).length > 0 && (
                <KudoBannerSticker
                  count={kudos.filter(k => !readKudoIds.has(String(k.id))).length}
                  onClick={() => setExpandedKudo(kudos.find(k => !readKudoIds.has(String(k.id))))}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT: Kudos received ────────────────────────────────── */}
        <div style={{ width: 250, flexShrink: 0, background: '#111', borderLeft: '2px solid #1e1e1e', display: 'flex', flexDirection: 'column', overflow: 'visible', position: 'relative', zIndex: 5 }}>
          <KudosPanel
            kudos={kudos}
            readKudoIds={readKudoIds}
            onOpenKudo={kudo => setExpandedKudo(kudo)}
          />
          {!isOwner && <MailboxFAB onClick={() => setShowCompose(true)} />}
        </div>
      </div>

      {/* ── Modals (portalled above everything) ─────────────────────────── */}
      {showCompose && (
        <ComposeModal
          viewedUser={viewedUser}
          currentUser={currentUser}
          onClose={() => setShowCompose(false)}
          onKudoSent={(updatedSender) => {
            setMyUser(updatedSender);
            fetch(`/api/garden/${viewedUserId}`)
              .then(r => r.json()).then(d => setKudos(d.kudos ?? []));
          }}
          onError={msg => flash(`❌ ${msg}`, 'error')}
        />
      )}
      {expandedKudo && (
        <KudoReadModal
          kudo={expandedKudo}
          onClose={() => { if (isOwner) markRead(expandedKudo.id); setExpandedKudo(null); }}
        />
      )}

      {/* ── Bottom bar ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        padding: '6px 16px', background: '#111',
        borderTop: '2px solid #2a2a2a', flexShrink: 0,
      }}>
        {isOwner
          ? <button onClick={() => navigate('/neighbors')} className="fg-top-btn">👥 Neighbors</button>
          : <button onClick={() => navigate('/neighbors')} className="fg-top-btn">← Back</button>
        }
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: '1.6rem', color: '#ee6a0e' }}>
          <PixelImg src="/icons/money.png" alt="coins" size={22} />
          <span className={popCoins ? 'fg-stat--pop' : ''}>{myUser?.coins ?? 0}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '1.6rem', color: '#86efac' }}>
          <PixelImg src="/icons/fertilizer.png" alt="fertilizer" size={22} />
          <span className={popFert ? 'fg-stat--pop' : ''}>{myUser?.fertilizer ?? 0}</span>
        </span>
      </div>

      {/* ── Onboarding tooltip overlay ────────────────────────────────── */}
      {isOwner && !godotLoading && onboardStep != null && (
        <OnboardingOverlay
          step={onboardStep}
          onNext={nextOnboardStep}
          onSkip={dismissOnboarding}
        />
      )}
    </div>
  );
}

// ─── Owner sidebar ────────────────────────────────────────────────────────────
function OwnerSidebar({
  tab, setTab, shopCfg, myUser,
  inventory, placeableItems, allShopItems,
  equipped, onBuy, onEquip, onSell,
  availablePlants, availableAnimals,
}) {
  const shopSeedNames   = availablePlants.length
    ? availablePlants : shopCfg.seeds.map(s => toGodotName(s.name));
  const shopAnimalNames = availableAnimals.length
    ? availableAnimals : shopCfg.animals.map(a => toGodotName(a.name));

  const seedCardFor = (name) => {
    const meta = shopCfg.seeds.find(s => toGodotName(s.name) === name || toGodotName(s.id) === name);
    return { name, cost: meta?.cost ?? 0 };
  };
  const animalCardFor = (name) => {
    const meta = shopCfg.animals.find(a => toGodotName(a.name) === name || toGodotName(a.id) === name);
    return { name, cost: meta?.cost ?? 0 };
  };

  const isAnimalKey = (key) => {
    const g = toGodotName(key);
    return availableAnimals.includes(g)
        || shopCfg.animals?.some(a => toGodotName(a.name) === g || toGodotName(a.id) === g);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '2px solid #1e1e1e', flexShrink: 0 }}>
        {['Shop', 'Inventory'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`fg-tab${tab === t ? ' fg-tab--active' : ''}`}>{t}</button>
        ))}
      </div>

      <div key={tab} className="fg-scroll fg-tab-content" style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>

        {/* ── Shop tab ─────────────────────────────────────── */}
        {tab === 'Shop' && (
          <>
            <p style={sectionLabel}>🌱 Seeds</p>
            <div className="fg-stagger" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {shopSeedNames.map(name => (
                <ShopCard key={name} item={seedCardFor(name)} coins={myUser?.coins ?? 0} onBuy={onBuy} />
              ))}
            </div>
            <p style={sectionLabel}>🐾 Animals</p>
            <div className="fg-stagger" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {shopAnimalNames.map(name => (
                <ShopCard key={name} item={animalCardFor(name)} coins={myUser?.coins ?? 0} onBuy={onBuy} />
              ))}
            </div>
          </>
        )}

        {/* ── Inventory tab ─────────────────────────────────── */}
        {tab === 'Inventory' && (
          <>
            {placeableItems.length === 0 && (
              <p style={{ color: '#444', fontSize: '1.3rem', textAlign: 'center', marginTop: '1rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>
                🛒 No seeds or animals yet.<br/>
                <span style={{ fontSize: '1.1rem', color: '#333' }}>Head to the Shop tab!</span>
              </p>
            )}

            {placeableItems.filter(([k]) => !isAnimalKey(k)).length > 0 && (
              <>
                <p style={sectionLabel}>🌱 Plants</p>
                <div className="fg-inv-grid fg-stagger">
                  {placeableItems.filter(([k]) => !isAnimalKey(k)).map(([key, qty]) => {
                    const godotName = toGodotName(key);
                    const isEq      = equipped?.name === godotName;
                    return (
                      <button key={key} onClick={() => onEquip('seed', godotName)} className={`fg-inv-card fg-inv-card--placeable${isEq ? ' fg-inv-card--equipped' : ''}`}>
                        <ItemIcon name={godotName} size={36} />
                        <span style={{ fontSize: '1.15rem', color: isEq ? '#86efac' : '#b9e6b1', textAlign: 'center', lineHeight: 1 }}>{godotName}</span>
                        <span style={{ fontSize: '1rem', color: isEq ? '#86efac' : '#555' }}>×{qty}{isEq ? ' ✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {placeableItems.filter(([k]) => isAnimalKey(k)).length > 0 && (
              <>
                <p style={sectionLabel}>🐾 Animals</p>
                <div className="fg-inv-grid fg-stagger">
                  {placeableItems.filter(([k]) => isAnimalKey(k)).map(([key, qty]) => {
                    const godotName = toGodotName(key);
                    const isEq      = equipped?.name === godotName;
                    return (
                      <button key={key} onClick={() => onEquip('animal', godotName)} className={`fg-inv-card fg-inv-card--placeable${isEq ? ' fg-inv-card--equipped' : ''}`}>
                        <ItemIcon name={godotName} size={36} />
                        <span style={{ fontSize: '1.15rem', color: isEq ? '#86efac' : '#b9e6b1', textAlign: 'center', lineHeight: 1 }}>{godotName}</span>
                        <span style={{ fontSize: '1rem', color: isEq ? '#86efac' : '#555' }}>×{qty}{isEq ? ' ✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {(() => {
              const harvestedItems = Object.entries(inventory)
                .filter(([k, q]) => k.startsWith('harvested_') && q > 0);
              return harvestedItems.length > 0 ? (
                <>
                  <p style={sectionLabel}>🌾 Harvested</p>
                  <div className="fg-stagger" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {harvestedItems.map(([key, qty]) => {
                      const crop = key.replace('harvested_', '');
                      const meta = shopCfg.seeds?.find(
                        s => s.crop === crop || toGodotName(s.name).toLowerCase() === crop.toLowerCase()
                      );
                      const sellValue = meta?.sell_value ?? '?';
                      return (
                        <div key={key} className="fg-harvest-row">
                          <ItemIcon name={toGodotName(crop)} size={28} />
                          <span className="fg-harvest-row__name">{toGodotName(crop)}</span>
                          <span className="fg-harvest-row__qty">×{qty}</span>
                          <button
                            className="fg-sell-btn"
                            onClick={() => onSell(crop)}
                            title={`Sell 1 for ${sellValue} coins`}
                          >
                            <PixelImg src="/icons/money.png" alt="coin" size={14} />
                            <span>+{sellValue}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null;
            })()}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Visitor left panel: what's growing ──────────────────────────────────────
function VisitorFarmInfo({ farmItems, shopCfg }) {

  const plants  = farmItems.filter(f => f.item_type === 'plant');
  const animals = farmItems.filter(f => f.item_type === 'animal');

  return (
    <div className="fg-scroll" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '12px', overflowY: 'auto' }}>
      {farmItems.length === 0 ? (
        <p style={{ color: '#444', fontSize: '1.3rem', textAlign: 'center', marginTop: '2rem', lineHeight: 1.4 }}>
          🌱 Nothing growing here yet.
        </p>
      ) : (
        <>
          {plants.length > 0 && (
            <>
              <p style={sectionLabel}>🌿 Plants</p>
              <div className="fg-inv-grid fg-stagger">
                {plants.map(item => {
                  const rawTs    = Number(item.placed_at ?? 0);
                  const placedMs = rawTs > 0 && rawTs < 1e11 ? rawTs * 1000 : rawTs;
                  const dateStr  = placedMs > 0
                    ? new Date(placedMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '—';
                  const gName = toGodotName(item.item_name);
                  return (
                    <div key={item.id} className="fg-inv-card fg-inv-card--placeable" style={{ cursor: 'default', pointerEvents: 'none' }}>
                      <ItemIcon name={gName} size={36} />
                      <span style={{ fontSize: '1.15rem', color: '#b9e6b1', textAlign: 'center', lineHeight: 1 }}>{gName}</span>
                      <span style={{ fontSize: '1rem', color: '#666' }}>{dateStr}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {animals.length > 0 && (
            <>
              <p style={sectionLabel}>🐾 Animals</p>
              <div className="fg-inv-grid fg-stagger">
                {animals.map(item => {
                  const rawTs    = Number(item.placed_at ?? 0);
                  const placedMs = rawTs > 0 && rawTs < 1e11 ? rawTs * 1000 : rawTs;
                  const dateStr  = placedMs > 0
                    ? new Date(placedMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '—';
                  const gName = toGodotName(item.item_name);
                  return (
                    <div key={item.id} className="fg-inv-card fg-inv-card--placeable" style={{ cursor: 'default', pointerEvents: 'none' }}>
                      <ItemIcon name={gName} size={36} />
                      <span style={{ fontSize: '1.15rem', color: '#b9e6b1', textAlign: 'center', lineHeight: 1 }}>{gName}</span>
                      <span style={{ fontSize: '1rem', color: '#666' }}>{dateStr}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Right panel: kudos list ──────────────────────────────────────────────────
const POSTIT_COLORS = ['#fef08a', '#fdba74', '#86efac', '#93c5fd', '#f9a8d4', '#e9d5ff'];

function KudosPanel({ kudos, readKudoIds, onOpenKudo }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px 6px', borderBottom: '2px solid #1e1e1e', flexShrink: 0 }}>
        <span style={{ fontSize: '1.5rem', color: '#b9e6b1' }}>Kudos</span>
      </div>

      {/* Kudos list */}
      <div className="fg-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 10px 14px 12px' }}>
        {kudos.length === 0 ? (
          <p style={{ color: '#444', fontSize: '1.2rem', textAlign: 'center', marginTop: '2rem', lineHeight: 1.5 }}>
            No kudos yet.<br/>
            <span style={{ fontSize: '1rem', color: '#333' }}>Be the first to spread good vibes!</span>
          </p>
        ) : (
          kudos.map((kudo, idx) => {
            const bg        = POSTIT_COLORS[idx % POSTIT_COLORS.length];
            const seed      = idx * 1693 + 47;
            const rot       = ((seed % 27) - 13);
            const skew      = ((seed * 3) % 9) - 4;
            const mb        = 18 + (seed % 20);
            const tapeRot   = ((seed * 7) % 11) - 5;
            const tapeLeft  = 30 + (seed % 40);
            const italic    = seed % 3 === 0;
            const isUnread  = readKudoIds && !readKudoIds.has(String(kudo.id));
            return (
              <div
                key={kudo.id}
                className="fg-kudo-sticker"
                onClick={() => onOpenKudo?.(kudo)}
                style={{
                  background:   bg,
                  transform:    `rotate(${rot}deg) skewX(${skew * 0.4}deg)`,
                  marginBottom: mb,
                  animation:    `fg-fade-up 0.32s cubic-bezier(0.25, 1, 0.5, 1) ${idx * 70}ms both`,
                  cursor:       'pointer',
                  outline:      isUnread ? '2px solid rgba(0,0,0,0.15)' : 'none',
                }}
              >
                {/* Unread dot */}
                {isUnread && (
                  <span className="kg-unread-dot" />
                )}
                {/* Masking-tape strip */}
                <div style={{
                  position: 'absolute', top: -10, left: `${tapeLeft}%`,
                  transform: `translateX(-50%) rotate(${tapeRot}deg)`,
                  width: 40, height: 18,
                  background: 'rgba(255,255,255,0.52)',
                  border: '1px solid rgba(180,180,160,0.35)',
                  borderRadius: 2, pointerEvents: 'none',
                }} />
                <p style={{
                  fontSize: '1.1rem', color: '#1a1a1a', margin: 0, lineHeight: 1.4,
                  fontStyle: italic ? 'italic' : 'normal',
                }}>
                  {kudo.message}
                </p>
                <p style={{ fontSize: '0.9rem', color: '#555', margin: '10px 0 0', textAlign: 'right' }}>
                  — {kudo.sender_name}
                  <br />
                  <span style={{ fontSize: '0.78rem', color: '#777' }}>
                    {new Date(kudo.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}


// ─── Floating mailbox FAB (visitor only) ─────────────────────────────────────
function MailboxFAB({ onClick }) {
  return (
    <button className="kg-fab" onClick={onClick} title="Leave a Kudo">
      <PixelImg src="/icons/send_kudo.png" alt="Send Kudo" size={32} />
    </button>
  );
}

// ─── Tiny unread sticky taped to the farm banner ──────────────────────────────
function KudoBannerSticker({ count, onClick }) {
  return (
    <div className="kg-banner-sticker" onClick={onClick} style={{ pointerEvents: 'auto' }}>
      <PixelImg src="/icons/receive_kudo.png" alt="New Kudo" size={24} />
      {count > 1 && (
        <span className="kg-banner-sticker__badge">{count}</span>
      )}
    </div>
  );
}

// ─── Full-size kudo reading modal with fly-out animation ──────────────────────
function KudoReadModal({ kudo, onClose }) {
  const [flyOut, setFlyOut] = useState(false);
  const bg   = POSTIT_COLORS[(kudo.id ?? 0) % POSTIT_COLORS.length];
  const seed = (kudo.id ?? 0) * 1693 + 47;
  const rot  = ((seed % 27) - 13) * 0.25;

  const handleClose = () => {
    setFlyOut(true);
    setTimeout(onClose, 480);
  };

  return createPortal(
    <div className="kg-backdrop" onClick={e => e.target === e.currentTarget && handleClose()}>
      <div className={`kg-read-modal${flyOut ? ' kg-fly-out' : ''}`} style={{ background: bg }}>
        <div className="kg-read-tape" style={{ transform: `translateX(-50%) rotate(${rot}deg)` }} />
        <button className="kg-read-close" onClick={handleClose}>✕</button>
        <p className="kg-read-message">{kudo.message}</p>
        <p className="kg-read-meta">
          — {kudo.sender_name}
          {kudo.timestamp && (
            <span className="kg-read-date">
              {' '}· {new Date(kudo.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          )}
        </p>
      </div>
    </div>,
    document.body
  );
}

// ─── Parchment compose modal (visitor sends kudo) ─────────────────────────────
function ComposeModal({ viewedUser, currentUser, onClose, onKudoSent, onError }) {
  const [msg,     setMsg]     = useState('');
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [closing, setClosing] = useState(false);

  const handleClose = () => { setClosing(true); setTimeout(onClose, 220); };

  const sendKudo = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/kudos/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_id:   currentUser.id,
          sender_name: currentUser.username,
          receiver_id: viewedUser?.id,
          message:     msg.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onError(data.error ?? 'Failed to send'); return; }
      setSent(true);
      setMsg('');
      onKudoSent(data.sender);
    } catch { onError('Network error'); }
    finally { setSending(false); }
  };

  return createPortal(
    <div className={`kg-backdrop${closing ? ' kg-backdrop--out' : ''}`}
         onClick={e => e.target === e.currentTarget && handleClose()}>
      <div className={`kg-modal${closing ? ' kg-modal--out' : ''}`}>
        <button className="kg-modal-close" onClick={handleClose}>✕</button>

        {/* Stationery header */}
        <div className="kg-modal-header">
          <div className="kg-modal-header__avatar">
            <img
              src={`https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(viewedUser?.username ?? '')}`}
              alt={viewedUser?.username}
              width="52"
              height="52"
            />
          </div>
          <div>
            <p className="kg-modal-header__title">Leave a Kudo</p>
            <p className="kg-modal-header__sub">for {viewedUser?.username ?? '…'}</p>
          </div>
        </div>

        {sent ? (
          <div className="kg-modal-sent">
            <p className="kg-modal-sent__title">Kudo sent! ✓</p>
            <p className="kg-modal-sent__hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
              They get +1 <PixelImg src="/icons/money.png" alt="coin" size={18} />
              &nbsp;·&nbsp;
              You get +1 <PixelImg src="/icons/fertilizer.png" alt="fertilizer" size={18} />
            </p>
            <div className="kg-modal-sent__btns">
              <button className="kg-modal-btn" onClick={() => setSent(false)}>Send another</button>
              <button className="kg-modal-btn kg-modal-btn--done" onClick={handleClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="kg-modal-lines" />
            <textarea
              className="kg-modal-textarea"
              value={msg}
              onChange={e => setMsg(e.target.value)}
              placeholder="Write something kind…"
              rows={5}
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) sendKudo(); }}
            />
            <div className="kg-modal-footer">
              <button
                className={`kg-modal-send${msg.trim() && !sending ? ' kg-modal-send--active' : ''}`}
                onClick={sendKudo}
                disabled={sending || !msg.trim()}
              >
                {sending ? 'Sending…' : 'Send Kudo'}
              </button>
              <span className="kg-modal-footer__hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
                +1 <PixelImg src="/icons/money.png" alt="coin" size={16} /> for them
                &nbsp;·&nbsp;
                +1 <PixelImg src="/icons/fertilizer.png" alt="fertilizer" size={16} /> for you
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── Pixel-art item icon with graceful fallback ───────────────────────────────
function ItemIcon({ name, size = 24 }) {
  const slug = (name ?? '').toLowerCase().replace(/\s+/g, '');
  return (
    <span style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
      <img
        src={`/icons/${slug}.png`}
        alt={name}
        style={{ width: size, height: size, imageRendering: 'pixelated', objectFit: 'contain', display: 'block' }}
        onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
      />
    </span>
  );
}

// ─── Shop card — matches Figma design ─────────────────────────────────────────
function ShopCard({ item, coins, onBuy }) {
  const canAfford = coins >= item.cost;
  const deficit   = item.cost - coins;
  return (
    <div
      className={`fg-shop-card${canAfford ? '' : ' fg-shop-card--unaffordable'}`}
      onClick={() => canAfford && onBuy(item)}
    >
      <ItemIcon name={item.name} size={40} />
      <span style={{ fontSize: '1.25rem', color: '#b9e6b1', textAlign: 'center', lineHeight: 1 }}>
        {item.name}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <PixelImg src="/icons/money.png" alt="coins" size={18} />
        <span style={{ fontSize: '1.3rem', color: canAfford ? '#ee6a0e' : '#c04040' }}>
          {item.cost}
        </span>
      </span>
      {!canAfford && (
        <span style={{ fontSize: '1rem', color: '#7a3535', fontFamily: VT323, lineHeight: 1 }}>
          need {deficit} more
        </span>
      )}
    </div>
  );
}

// ─── Shared constants & styles ────────────────────────────────────────────────
const VT323 = "'VT323', monospace";

const topBtnStyle = {
  fontFamily: VT323, fontSize: '1.3rem',
  background: '#252525', color: '#b9e6b1',
  border: '1px solid #3a3a3a', borderRadius: 8,
  padding: '2px 14px', cursor: 'pointer',
};

const actionBtnStyle = {
  fontFamily: VT323, fontSize: '1.3rem',
  background: '#1a3a1a', color: '#86efac',
  border: '1px solid #3a7d44', borderRadius: 8,
  padding: '4px 14px', cursor: 'pointer',
};

const sectionLabel = {
  fontFamily: VT323, fontSize: '1.1rem', color: '#555',
  textTransform: 'uppercase', letterSpacing: '0.12em',
  margin: '10px 0 6px',
};

const invNameStyle = (active) => ({
  fontSize: '1.25rem', color: active ? '#86efac' : '#b9e6b1',
});

// ─── Onboarding overlay ──────────────────────────────────────────────────────
const ONBOARD_STEPS = [
  {
    title: 'Welcome to your farm!',
    text: 'Browse seeds and animals in the Shop and buy them with your coins.',
    spotlight: 'ob-spot--shop',
    tooltipPos: 'ob-tip--shop',
    arrow: 'left',
  },
  {
    title: 'Plant seeds in pots',
    text: 'Select a seed from your Inventory, then click any dirt pot on the farm to plant it. Fertilize to speed up growth!',
    spotlight: 'ob-spot--pots',
    tooltipPos: 'ob-tip--pots',
    arrow: 'top',
  },
  {
    title: 'Place animals on the grass',
    text: 'Select an animal from your Inventory, then click anywhere on the green grass to place it. Watch your farm come alive!',
    spotlight: 'ob-spot--grass',
    tooltipPos: 'ob-tip--grass',
    arrow: 'top',
  },
  {
    title: 'Earn coins & fertilizer',
    text: 'Visit neighbors and leave a Kudo — you earn fertilizer, they earn a coin. Spread good vibes!',
    spotlight: 'ob-spot--economy',
    tooltipPos: 'ob-tip--economy',
    arrow: 'bottom',
  },
];

function OnboardingOverlay({ step, onNext, onSkip }) {
  const s = ONBOARD_STEPS[step];
  if (!s) return null;

  return (
    <div className="ob-backdrop" onClick={onNext}>
      {/* Spotlight cutout */}
      <div className={`ob-spotlight ${s.spotlight}`} />

      {/* Tooltip card */}
      <div
        className={`ob-tooltip ${s.tooltipPos}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`ob-arrow ob-arrow--${s.arrow}`} />
        <div className="ob-step-badge">Step {step + 1} of 3</div>
        <h3 className="ob-title">{s.title}</h3>
        <p className="ob-text">{s.text}</p>
        <div className="ob-controls">
          <button className="ob-skip" onClick={onSkip}>Skip</button>
          <div className="ob-dots">
            {ONBOARD_STEPS.map((_, i) => (
              <span key={i} className={`ob-dot ${i === step ? 'ob-dot--active' : ''}`} />
            ))}
          </div>
          <button className="ob-next" onClick={onNext}>
            {step >= ONBOARD_STEPS.length - 1 ? "Let's go!" : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
