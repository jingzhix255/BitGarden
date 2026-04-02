import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useSession } from '../App.jsx';
import {
  POT_W, POT_H,
  PLANT_VISUALS, PLANT_SPRITES, getVisualDef, computeUpgradeCost,
  getPlantSpriteStyle,
} from '../constants.js';

// ─── Toast stack ─────────────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

// ─── Plant body — CSS sprite sheet renderer ───────────────────────────────
// Renders the correct frame from /public/Basic Plants.png.
// X-axis = current_stage column, Y-axis = plant_type row.
// To change frame size, update SPRITE_FRAME_SIZE in constants.js.
function PlantBody({ plant }) {
  const cfg         = PLANT_SPRITES[plant.plant_type] ?? PLANT_SPRITES.succulent;
  const col         = plant.current_stage - 1;
  const soilOverlap = cfg.soilOverlap ?? 0;
  const label       = `${PLANT_VISUALS[plant.plant_type]?.name ?? plant.plant_type} · Stage ${plant.current_stage}`;

  // ── Pixel-exact path: <img> with inline overflow clip ────────────────────
  // Using position:relative + left on the img (normal-flow shift) rather than
  // position:absolute, so overflow:hidden on the parent reliably clips to one frame.
  if (cfg.srcW && cfg.srcH && cfg.scale) {
    const totalW = cfg.srcW  * cfg.scale;
    const totalH = cfg.srcH  * cfg.scale;
    const frameW = totalW / cfg.frameCount;
    const xOff   = -Math.round(col * frameW);
    return (
      <div
        className="plant-body"
        style={{
          width:        cfg.displayW,
          height:       cfg.displayH,
          bottom:       soilOverlap,
          overflow:     'hidden',
          mixBlendMode: cfg.blendMode ?? 'normal',
        }}
        title={label}
      >
        <img
          src={cfg.src}
          alt=""
          draggable="false"
          style={{
            display:        'block',
            position:       'relative',
            left:           xOff,
            top:            0,
            width:          totalW,
            height:         totalH,
            maxWidth:       'none',      // override Tailwind Preflight: img { max-width: 100% }
            imageRendering: 'pixelated',
            userSelect:     'none',
            pointerEvents:  'none',
          }}
        />
      </div>
    );
  }

  // ── Percentage path: background-image (plant1 / bonsai) ───────────────────
  const spriteStyle = getPlantSpriteStyle(plant.plant_type, plant.current_stage);
  return (
    <div
      className="plant-body"
      style={{ ...spriteStyle, bottom: soilOverlap }}
      title={label}
    />
  );
}

// ─── Single pot slot ──────────────────────────────────────────────────────────
// Slot height is fixed at POT_H (the dirt patch only).
// PlantBody is absolutely positioned so its bottom overlaps the dirt by
// soilOverlap px — this grounds the plant visually without shifting the anchor.
function GardenSlot({ slot, isOwner, onClickEmpty, onClickPlant }) {
  const { id, left, top, zIndex, plant } = slot;

  const handleClick = () => {
    if (!isOwner) return;
    if (plant) onClickPlant(plant);
    else       onClickEmpty(id);
  };

  return (
    <div
      className="garden-slot"
      style={{ left, top, zIndex, width: POT_W, height: POT_H }}
    >
      {plant && <PlantBody plant={plant} />}

      <div
        className={`pot ${plant ? 'pot--filled' : 'pot--empty'}`}
        onClick={handleClick}
        title={
          isOwner
            ? plant
              ? `${PLANT_VISUALS[plant.plant_type]?.name ?? plant.plant_type} · Stage ${plant.current_stage} — click to upgrade`
              : 'Empty pot — click to plant'
            : plant
              ? `${PLANT_VISUALS[plant.plant_type]?.name ?? plant.plant_type} · Stage ${plant.current_stage}`
              : 'Empty pot'
        }
      >
        {!plant && isOwner && <span className="pot-add-icon">＋</span>}
        {plant && (
          <span className="pot-stage-badge">
            {plant.current_stage}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Plant modal (owner: plant a seed) ───────────────────────────────────────
function PlantModal({ potIndex, plantConfig, onConfirm, onClose }) {
  const [selected, setSelected] = useState('succulent');

  const plantTypes = plantConfig ? Object.entries(plantConfig.plants).map(([key, val]) => ({
    key,
    name: val.name ?? key,
    archetype: val.archetype,
  })) : [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3 className="modal-title">🌱 Plant a Seed</h3>
        <p className="modal-sub">Choose a plant for pot #{potIndex + 1}</p>

        <div className="plant-type-grid">
          {plantTypes.map(({ key, name, archetype }) => {
            const visual  = getVisualDef(key, 1);
            const maxStage = plantConfig
              ? plantConfig.archetypes[archetype]?.costs.length + 1
              : '?';
            return (
              <button
                key={key}
                className={`plant-type-card ${selected === key ? 'plant-type-card--active' : ''}`}
                onClick={() => setSelected(key)}
              >
                <div
                  className="plant-type-preview"
                  style={{ backgroundColor: getVisualDef(key, Math.ceil(maxStage / 2)).color }}
                >
                  <span>{getVisualDef(key, Math.ceil(maxStage / 2)).emoji}</span>
                </div>
                <div className="plant-type-name">{name}</div>
                <div className="plant-type-meta">{maxStage} stages</div>
              </button>
            );
          })}
        </div>

        <p className="modal-note">Seeds are free — earn resources by receiving Kudos 🌟</p>
        <button
          className="modal-action-btn"
          onClick={() => onConfirm(potIndex, selected)}
        >
          Plant Seed
        </button>
      </div>
    </div>
  );
}

// ─── Upgrade modal (owner: upgrade or remove a plant) ───────────────────────
function UpgradeModal({ plant, plantConfig, userResources, onUpgrade, onRemove, onClose }) {
  const costInfo = computeUpgradeCost(plantConfig, plant.plant_type, plant.current_stage);
  const currentVisual = getVisualDef(plant.plant_type, plant.current_stage);
  const nextVisual    = !costInfo?.atMax
    ? getVisualDef(plant.plant_type, plant.current_stage + 1)
    : null;
  const plantName = plantConfig?.plants?.[plant.plant_type]?.name ?? plant.plant_type;

  const canAfford = costInfo && !costInfo.atMax &&
    userResources.water      >= costInfo.cost.w &&
    userResources.fertilizer >= costInfo.cost.f;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3 className="modal-title">{currentVisual.emoji} {plantName}</h3>
        <p className="modal-sub">{currentVisual.label} · Stage {plant.current_stage} / {costInfo?.max_stage}</p>

        {/* Stage transition preview */}
        <div className="upgrade-preview">
          <div className="upgrade-preview-plant">
            <div
              className="upgrade-preview-bar"
              style={{ height: currentVisual.height, backgroundColor: currentVisual.color }}
            />
            <span className="upgrade-preview-label">Stage {plant.current_stage}</span>
          </div>
          {nextVisual && (
            <>
              <div className="upgrade-preview-arrow">→</div>
              <div className="upgrade-preview-plant">
                <div
                  className="upgrade-preview-bar upgrade-preview-bar--next"
                  style={{ height: nextVisual.height, backgroundColor: nextVisual.color }}
                />
                <span className="upgrade-preview-label">Stage {plant.current_stage + 1}</span>
              </div>
            </>
          )}
        </div>

        {costInfo?.atMax ? (
          <p className="modal-max">✨ This plant has reached its final form!</p>
        ) : (
          <>
            {/* Cost display */}
            <div className="upgrade-cost-row">
              <span className="upgrade-cost-label">Cost:</span>
              <span className={`upgrade-cost-val ${userResources.water < costInfo.cost.w ? 'cost--low' : ''}`}>
                💧 {costInfo.cost.w}
              </span>
              <span className={`upgrade-cost-val ${userResources.fertilizer < costInfo.cost.f ? 'cost--low' : ''}`}>
                🌿 {costInfo.cost.f}
              </span>
            </div>
            <div className="upgrade-balance-row">
              <span className="upgrade-cost-label">Balance:</span>
              <span>💧 {userResources.water}</span>
              <span>🌿 {userResources.fertilizer}</span>
            </div>

            <button
              className="modal-action-btn"
              disabled={!canAfford}
              onClick={() => onUpgrade(plant.id)}
            >
              {canAfford
                ? `Upgrade to Stage ${plant.current_stage + 1}`
                : 'Not enough resources'}
            </button>
          </>
        )}

        <button className="modal-remove-btn" onClick={() => onRemove(plant.id)}>
          Remove plant
        </button>
      </div>
    </div>
  );
}

// ─── Kudos board modal ───────────────────────────────────────────────────────
function KudosBoardModal({ kudos, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3 className="modal-title">📌 Notice Board</h3>
        {kudos.length === 0 ? (
          <p className="modal-empty">No kudos yet — be the first visitor to leave one!</p>
        ) : (
          <ul className="kudos-list">
            {kudos.map(k => (
              <li key={k.id} className="kudos-item">
                <div className="kudos-item-top">
                  <span className="kudos-sender">{k.sender_name}</span>
                  <span className="kudos-time">{k.timestamp.slice(0, 10)}</span>
                </div>
                <p className="kudos-msg">"{k.message}"</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Leave kudo modal (visitor) ──────────────────────────────────────────────
function LeaveKudoModal({ senderName, receiverId, onSuccess, onClose }) {
  const [msg,     setMsg]     = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSend = async () => {
    if (!msg.trim()) { setError('Please write a message.'); return; }
    setLoading(true); setError('');
    try {
      const res  = await fetch('/api/kudos/leave', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sender_id: currentUser?.id, sender_name: senderName, receiver_id: receiverId, message: msg.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to send.'); return; }
      onSuccess();
      onClose();
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3 className="modal-title">💌 Leave a Kudo</h3>
        <p className="modal-sub">From: <strong>{senderName}</strong></p>
        <textarea
          className="kudo-textarea"
          placeholder="Write something kind…"
          value={msg}
          onChange={e => setMsg(e.target.value)}
          rows={4}
          maxLength={280}
          autoFocus
        />
        {error && <p className="modal-error">{error}</p>}
        <button className="modal-action-btn" onClick={handleSend} disabled={loading}>
          {loading ? 'Sending…' : 'Send Kudo 💌'}
        </button>
      </div>
    </div>
  );
}

// ─── Main Garden component ────────────────────────────────────────────────────
export default function Garden() {
  const { currentUser, setCurrentUser } = useSession();
  const { userId }  = useParams();
  const navigate    = useNavigate();
  const gardenUserId = Number(userId);
  const isOwner      = currentUser?.id === gardenUserId;

  // The Godot game is the owner's main view — redirect away from the legacy garden
  if (isOwner) return <Navigate to="/farm" replace />;

  const [gardenData,  setGardenData]  = useState(null);   // { user, slots, kudos }
  const [plantConfig, setPlantConfig] = useState(null);   // raw plant-config from /api/config
  const [loading,     setLoading]     = useState(true);
  const [modal,       setModal]       = useState(null);   // { type, ...data }
  const [toasts,      setToasts]      = useState([]);

  // ── Toast helper ──
  const toast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(ts => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 3200);
  }, []);

  // ── Data fetching ──
  const fetchGarden = useCallback(async () => {
    try {
      const res  = await fetch(`/api/garden/${gardenUserId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load garden.');
      setGardenData(data);
      // Keep logged-in user's own balance fresh
      if (isOwner) {
        const updated = { ...currentUser, ...data.user };
        setCurrentUser(updated);
        localStorage.setItem('bitgarden_user', JSON.stringify(updated));
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [gardenUserId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/garden/${gardenUserId}`).then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
    ]).then(([garden, config]) => {
      setGardenData(garden);
      setPlantConfig(config.plants);          // plant-config.json data
      if (isOwner) {
        const updated = { ...currentUser, ...garden.user };
        setCurrentUser(updated);
        localStorage.setItem('bitgarden_user', JSON.stringify(updated));
      }
    }).catch(e => toast(e.message ?? 'Failed to load.', 'error'))
      .finally(() => setLoading(false));
  }, [gardenUserId]);

  // ── Owner actions ──
  const handlePlant = async (potIndex, plantType) => {
    setModal(null);
    try {
      const res  = await fetch('/api/plants/plant', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: gardenUserId, pot_index: potIndex, plant_type: plantType }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error, 'error'); return; }
      toast(`${PLANT_VISUALS[plantType]?.name ?? plantType} planted! 🌱`);
      fetchGarden();
    } catch { toast('Network error.', 'error'); }
  };

  const handleUpgrade = async (plantId) => {
    setModal(null);
    try {
      const res  = await fetch('/api/plants/upgrade', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ plant_id: plantId }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error, 'error'); return; }
      const visual = getVisualDef(data.plant.plant_type, data.plant.current_stage);
      toast(`${visual.emoji} Upgraded to Stage ${data.plant.current_stage}: ${visual.label}!`, 'success');
      fetchGarden();
    } catch { toast('Network error.', 'error'); }
  };

  const handleRemove = async (plantId) => {
    setModal(null);
    try {
      const res = await fetch('/api/plants/remove', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ plant_id: plantId }),
      });
      if (!res.ok) { toast('Failed to remove plant.', 'error'); return; }
      toast('Plant removed.');
      fetchGarden();
    } catch { toast('Network error.', 'error'); }
  };

  // ── Visitor action ──
  const handleKudoSuccess = () => {
    toast('Kudo sent! 💌 They earned 1💧 and 1🌿!', 'success');
    fetchGarden();
  };

  // ── Loading / error ──
  if (loading) {
    return (
      <div className="garden-loading">
        <span>🌱</span>
        <p>Growing garden…</p>
      </div>
    );
  }
  if (!gardenData) return null;

  const { user: owner, slots, kudos } = gardenData;

  // Current user resources (for upgrade modal)
  const userResources = {
    coins:      isOwner ? (currentUser?.coins      ?? 0) : 0,
    fertilizer: isOwner ? (currentUser?.fertilizer ?? 0) : 0,
  };

  return (
    <div className="garden-page">
      <Toast toasts={toasts} />

      {/* ── Header ── */}
      <header className="garden-header">
        <button className="garden-back-btn" onClick={() => navigate('/neighborhood')}>
          ← Neighborhood
        </button>

        <h1 className="garden-owner-name">{owner.username}'s Garden</h1>

        {isOwner ? (
          <div className="garden-hud">
            <span className="hud-resource" title="Coins">🪙 {currentUser.coins ?? 0}</span>
            <span className="hud-resource" title="Fertilizer">🌿 {currentUser.fertilizer ?? 0}</span>
            <button
              className="dev-btn"
              title="DEV: Add +10 💧 and +10 🌿"
              onClick={async () => {
                const res  = await fetch('/api/dev/add-resources', {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ user_id: currentUser.id, coins: 20, fertilizer: 10 }),
                });
                const data = await res.json();
                if (res.ok) { toast('⚗ Dev: +20🪙 +10🌿 added', 'info'); fetchGarden(); }
                else        { toast(data.error, 'error'); }
              }}
            >
              ⚗ Dev
            </button>
          </div>
        ) : (
          <button
            className="garden-kudo-btn"
            onClick={() => setModal({ type: 'leaveKudo' })}
          >
            💌 Leave a Kudo
          </button>
        )}
      </header>

      {/* ── 2.5D Garden scene ── */}
      <div className="garden-scene-wrap">
        <div className="garden-scene">

          {/* Notice board — top-center, behind all pots */}
          <button
            className="notice-board"
            onClick={() => setModal({ type: 'kudosBoard' })}
            title="Click to read the notice board"
          >
            <span>📌</span>
            <span className="notice-board-title">Notice Board</span>
            {kudos.length > 0 && (
              <span className="notice-board-badge">{kudos.length}</span>
            )}
          </button>

          {/* 10 pot slots — positions from layout-config via API */}
          {slots.map(slot => (
            <GardenSlot
              key={slot.id}
              slot={slot}
              isOwner={isOwner}
              onClickEmpty={idx  => setModal({ type: 'plant',   potIndex: idx })}
              onClickPlant={plant => setModal({ type: 'upgrade', plant })}
            />
          ))}
        </div>

        {/* Owner hint bar */}
        {isOwner && (
          <p className="garden-hint">
            Click an empty pot to plant · Click a plant to upgrade
          </p>
        )}
        {!isOwner && (
          <p className="garden-hint">
            You're visiting {owner.username}'s garden — leave a Kudo to help their plants grow!
          </p>
        )}
      </div>

      {/* ── Modals ── */}
      {modal?.type === 'plant' && (
        <PlantModal
          potIndex={modal.potIndex}
          plantConfig={plantConfig}
          onConfirm={handlePlant}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'upgrade' && (
        <UpgradeModal
          plant={modal.plant}
          plantConfig={plantConfig}
          userResources={userResources}
          onUpgrade={handleUpgrade}
          onRemove={handleRemove}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'kudosBoard' && (
        <KudosBoardModal
          kudos={kudos}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'leaveKudo' && (
        <LeaveKudoModal
          senderName={currentUser.username}
          receiverId={gardenUserId}
          onSuccess={handleKudoSuccess}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
