// ─── Pot / dirt-patch dimensions (px) ─────────────────────────────────────
// dirt.png is 28×28 — rendered at 2× for pixel-perfect scaling → 56×56
export const POT_W = 56;
export const POT_H = 56;

// ─── Per-type sprite configuration ────────────────────────────────────────
//
// Each plant_type has its own horizontal strip sprite (one row, N columns).
// Frames run left → right:  col 0 = stage 1,  col 1 = stage 2, …
//
// Key variables to tune per asset:
//   src         – path inside /public/
//   frameCount  – number of stages (= columns) in the sprite strip
//   displayW    – rendered width of the visible frame (px)
//   displayH    – rendered height of the visible frame (px)
//                 The sprite is BOTTOM-ALIGNED so the root/soil always lines
//                 up with the dirt patch; any empty sky above is clipped.
//
// No pixel-level frame math is needed — background-position uses percentages
// so it works correctly for any source image dimensions.
//
export const PLANT_SPRITES = {
  // ── cherry.png — 1536×1024, single-row illustration, black background ──
  // 9 visual stages sampled at 5 evenly-spaced points (matching basic_5_stage):
  //   stage 1→0%  stage 2→25%  stage 3→50%  stage 4→75%  stage 5→100%
  //   → seed / sapling / flowering / fruiting / full cherry tree
  // smooth:true disables pixelated rendering — this is painted art, not pixel art.
  succulent: {
    src:        '/cherry.png',
    frameCount: 5,
    displayW:   48,
    displayH:   48,
    soilOverlap: 20,
    blendMode:  'screen',
    smooth:     true,
  },

  // ── plant2.png — 94×16, 5 frames, pixel-art style ──
  // 5× is the ONLY integer scale: frame = 94×80px (exact pixel positions).
  // srcW / srcH / scale trigger the pixel-exact path in getPlantSpriteStyle.
  cactus: {
    src:        '/plant2.png',
    frameCount: 5,
    srcW:       94,   // total source width (all frames)
    srcH:       16,   // source height
    scale:      3,    // 3× — frame renders at ≈56×48px (fits the 56px dirt patch)
    displayW:   56,   // Math.round(18.8 * 3) = 56; 0.4px clip on right edge, invisible
    displayH:   48,   // = srcH * scale = 16 * 3 = 48  (exact ✓)
    soilOverlap: 10,
    blendMode:  'multiply',
  },

  // ── bonsai: placeholder until a dedicated asset arrives ──
  bonsai: {
    src:        '/cherry.png',
    frameCount: 5,
    displayW:   48,
    displayH:   48,
    soilOverlap: 20,
    blendMode:  'screen',
    smooth:     true,
  },
};

/**
 * Returns a React inline-style object that renders the correct sprite frame.
 *
 * X-axis: col = current_stage - 1  (0-indexed, left → right)
 *   background-position-x = col / (frameCount - 1) * 100%
 *
 * Y-axis: always 100% (bottom-aligned) so the plant root sits on the dirt.
 *
 * background-size: `${frameCount * 100}% auto`
 *   → scales the whole strip so exactly ONE frame fills displayW.
 *   → height scales proportionally (auto), then the div clips excess sky.
 */
export const getPlantSpriteStyle = (plant_type, current_stage) => {
  const cfg = PLANT_SPRITES[plant_type] ?? PLANT_SPRITES.succulent;
  const { src, frameCount, displayW, displayH } = cfg;
  const col = current_stage - 1; // 0-indexed

  const shared = {
    width:           displayW,
    height:          displayH,
    backgroundImage: `url('${src}')`,
    backgroundRepeat:'no-repeat',
    // smooth:true → painted/illustrated art; omit pixelated to allow bilinear scaling
    ...(cfg.smooth ? {} : { imageRendering: 'pixelated' }),
    mixBlendMode:    cfg.blendMode ?? 'normal',
  };

  // ── Pixel-exact path (integer scale) ─────────────────────────────────────
  // Used when srcW / srcH / scale are provided.
  // All position offsets are whole integers → no sub-pixel blur.
  if (cfg.srcW && cfg.srcH && cfg.scale) {
    const totalW  = cfg.srcW  * cfg.scale;                  // e.g. 94*3=282
    const totalH  = cfg.srcH  * cfg.scale;                  // e.g. 16*3=48
    const frameW  = totalW / frameCount;                    // e.g. 282/5=56.4
    const xOffset = -Math.round(col * frameW);              // 0,-56,-113,-169,-226
    return {
      ...shared,
      backgroundSize:     `${totalW}px ${totalH}px`,
      backgroundPosition: `${xOffset}px 0px`,              // top-aligned, exact px
    };
  }

  // ── Percentage path (variable-size source) ────────────────────────────────
  // Works for any source dimensions. Y = 100% keeps roots at bottom of div.
  const xPct = frameCount > 1 ? (col / (frameCount - 1)) * 100 : 0;
  return {
    ...shared,
    backgroundSize:     `${frameCount * 100}% auto`,
    backgroundPosition: `${xPct}% 100%`,
  };
};

// ─── Plant visual definitions (placeholder art for Phase 3/4) ──────────────
// Keyed by plant_type matching the backend catalog (succulent / cactus / bonsai).
// Each stage entry: emoji shown at top of plant body, fill color, height in px
// above the pot rim, and a human-readable label.
export const PLANT_VISUALS = {
  succulent: {
    name: 'Cozy Succulent',
    stages: [
      { stage: 1, emoji: '🌱', color: '#8B6F3A', height: 20, label: 'Seedling'    },
      { stage: 2, emoji: '🌿', color: '#6BAE40', height: 34, label: 'Sprout'      },
      { stage: 3, emoji: '🪴', color: '#4A9230', height: 50, label: 'Growing'     },
      { stage: 4, emoji: '🌵', color: '#2E7824', height: 66, label: 'Established' },
      { stage: 5, emoji: '✨', color: '#1A5E1A', height: 80, label: 'Full Bloom'  },
    ],
  },
  cactus: {
    name: 'Desert Cactus',
    stages: [
      { stage: 1, emoji: '🌱', color: '#8B7A32', height: 20, label: 'Seedling' },
      { stage: 2, emoji: '🌵', color: '#78A830', height: 36, label: 'Sprout'   },
      { stage: 3, emoji: '🌵', color: '#5A9228', height: 54, label: 'Growing'  },
      { stage: 4, emoji: '🌵', color: '#3E7C1E', height: 72, label: 'Tall'     },
      { stage: 5, emoji: '🌸', color: '#266616', height: 88, label: 'Blooming' },
    ],
  },
  bonsai: {
    name: 'Office Bonsai',
    // advanced_10_stage — 10 stages
    stages: [
      { stage: 1,  emoji: '🌱', color: '#6B4226', height: 16, label: 'Seed'        },
      { stage: 2,  emoji: '🌱', color: '#7A6030', height: 26, label: 'Germination' },
      { stage: 3,  emoji: '🌿', color: '#5A8A3C', height: 36, label: 'Sapling'     },
      { stage: 4,  emoji: '🌿', color: '#3E7830', height: 46, label: 'Young Tree'  },
      { stage: 5,  emoji: '🌲', color: '#2E6626', height: 56, label: 'Developing'  },
      { stage: 6,  emoji: '🌲', color: '#20541C', height: 64, label: 'Training'    },
      { stage: 7,  emoji: '🌳', color: '#164412', height: 72, label: 'Shaping'     },
      { stage: 8,  emoji: '🌳', color: '#0E360C', height: 78, label: 'Refined'     },
      { stage: 9,  emoji: '🏯', color: '#082A08', height: 84, label: 'Ancient'     },
      { stage: 10, emoji: '🎋', color: '#042004', height: 90, label: 'Legendary'   },
    ],
  },
};

/**
 * Returns the visual definition for a given plant at a given stage.
 * Falls back gracefully if the type or stage is unknown.
 */
export const getVisualDef = (plant_type, current_stage) => {
  const v = PLANT_VISUALS[plant_type] ?? PLANT_VISUALS.succulent;
  return v.stages.find(s => s.stage === current_stage) ?? v.stages[0];
};

/**
 * Mirrors the backend `getUpgradeCost` logic using the raw plant-config
 * object returned by GET /api/config.
 * Returns { cost: {w, f}, max_stage, atMax: false }
 *      or { atMax: true, max_stage }
 */
export const computeUpgradeCost = (plantConfig, plant_type, current_stage) => {
  const plantDef  = plantConfig?.plants?.[plant_type];
  if (!plantDef) return null;
  const archetype = plantConfig.archetypes[plantDef.archetype];
  const costs     = archetype.costs;
  const max_stage = costs.length + 1;
  if (current_stage >= max_stage) return { atMax: true, max_stage };
  return { cost: costs[current_stage - 1], max_stage, atMax: false };
};
