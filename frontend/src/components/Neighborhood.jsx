import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../App.jsx';

// ─── Weather System ────────────────────────────────────────────────────────────

const WEATHERS = ['CLEAR', 'RAIN', 'STORM', 'WINDY', 'FOG'];

const WEATHER_META = {
  CLEAR: { icon: '/icons/clear.png',       label: 'Clear Skies',  color: '#ffe066' },
  RAIN:  { icon: '/icons/rain.png',        label: 'Heavy Rain',   color: '#7ec8e3' },
  STORM: { icon: '/icons/thunderstorm.png',label: 'Thunderstorm', color: '#b39ddb' },
  WINDY: { icon: '/icons/breezy.png',      label: 'Breezy',       color: '#86efac' },
  FOG:   { icon: '/icons/fog.png',         label: 'Thick Fog',    color: '#c8c8c8' },
};

/** djb2-style hash → unsigned 32-bit int. */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h = h >>> 0; }
  return h;
}

/** Consistent weather state for the whole calendar day. */
function getDailyWeather() {
  return WEATHERS[hashString(new Date().toDateString()) % WEATHERS.length];
}

// ─── Static particle data (module scope — never re-allocated) ─────────────────
const RAIN_DROPS = Array.from({ length: 55 }, (_, i) => {
  const s = (i * 3571 + 7919) % 10000;
  return { id: i, left: s % 100, delay: `${(s % 25) * 80}ms`,
    dur: `${380 + (s % 250)}ms`, height: 10 + (s % 10),
    opacity: 0.25 + (s % 6) * 0.07, slim: s % 3 === 0 };
});

const LEAF_PARTICLES = Array.from({ length: 28 }, (_, i) => {
  const s = (i * 4567 + 2345) % 10000;
  const colors = ['#86efac', '#4ade80', '#a16207', '#ca8a04', '#6b7c3f'];
  return { id: i, top: 5 + (s % 88), size: 5 + (s % 6),
    delay: `${(s % 35) * 180}ms`, dur: `${1800 + (s % 2800)}ms`,
    color: colors[s % colors.length], drift: `${8 + (s % 18)}px`,
    spin: s % 2 === 0 ? 360 : -360 };
});

// ─── Weather sub-components ───────────────────────────────────────────────────

function RainLayer({ intense }) {
  return (
    <div className={`nb-rain${intense ? ' nb-rain--storm' : ''}`} aria-hidden="true">
      {RAIN_DROPS.map(d => (
        <span key={d.id} className="nb-raindrop" style={{
          left: `${d.left}%`, height: d.height, width: d.slim ? 1 : 2,
          opacity: intense ? Math.min(d.opacity + 0.15, 0.9) : d.opacity,
          animationDelay: d.delay,
          animationDuration: intense ? `${parseFloat(d.dur) * 0.7}ms` : d.dur,
        }} />
      ))}
    </div>
  );
}

function WindLayer({ burst }) {
  // On burst: speed up existing leaves AND spawn a dense gust from the left
  const BURST_LEAVES = burst ? Array.from({ length: 14 }, (_, i) => {
    const colors = ['#86efac', '#4ade80', '#ca8a04', '#a3e635', '#d97706'];
    return { id: `bl${i}`, top: 5 + i * 7, size: 6 + (i % 5),
      delay: `${i * 30}ms`, dur: `${280 + i * 55}ms`,
      color: colors[i % colors.length], drift: `${3 + i * 2}px`,
      spin: i % 2 === 0 ? 720 : -720 };
  }) : [];

  return (
    <div className="nb-wind" aria-hidden="true">
      {LEAF_PARTICLES.map(l => (
        <span key={l.id} className="nb-leaf" style={{
          top: `${l.top}%`, width: l.size, height: l.size, background: l.color,
          animationDelay:    burst ? '0ms' : l.delay,
          animationDuration: burst ? `${Math.round(parseFloat(l.dur) * 0.38)}ms` : l.dur,
          '--leaf-drift': l.drift, '--leaf-spin': `${l.spin}deg`,
          borderRadius: l.size % 2 === 0 ? '2px' : '50% 0 50% 0',
        }} />
      ))}
      {BURST_LEAVES.map(l => (
        <span key={l.id} className="nb-leaf" style={{
          top: `${l.top}%`, width: l.size, height: l.size, background: l.color,
          animationDelay: l.delay, animationDuration: l.dur,
          '--leaf-drift': l.drift, '--leaf-spin': `${l.spin}deg`,
          opacity: 0.9, borderRadius: '50% 0 50% 0',
        }} />
      ))}
    </div>
  );
}

function FogLayer({ blown }) {
  return (
    <div className="nb-fog" aria-hidden="true">
      {/* Wrapper handles the "blown away" opacity transition without fighting the band animations */}
      <div className={`nb-fog__wrap${blown ? ' nb-fog__wrap--blown' : ''}`}>
        <div className="nb-fog__band nb-fog__band--1" />
        <div className="nb-fog__band nb-fog__band--2" />
        <div className="nb-fog__band nb-fog__band--3" />
      </div>
    </div>
  );
}

function WeatherOverlay({ weather, clickActive, clickTrigger }) {
  if (weather === 'CLEAR') return null;
  return (
    <div className="nb-weather-overlay" aria-hidden="true">
      {(weather === 'RAIN' || weather === 'STORM') && <RainLayer intense={weather === 'STORM'} />}
      {weather === 'STORM' && (
        clickActive
          ? <div key={`strike-${clickTrigger}`} className="nb-lightning nb-lightning--strike" />
          : <div className="nb-lightning" />
      )}
      {weather === 'WINDY' && <WindLayer burst={clickActive} />}
      {weather === 'FOG'   && <FogLayer  blown={clickActive} />}
    </div>
  );
}

// ─── Date badge ───────────────────────────────────────────────────────────────
function DateBadge({ weather }) {
  const now     = new Date();
  const dayNum  = now.getDate();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long'  }).toUpperCase();
  const month   = now.toLocaleDateString('en-US', { month:  'long'  }).toUpperCase();
  const year    = now.getFullYear();
  const color   = WEATHER_META[weather]?.color ?? '#ffe066';
  return (
    <div className="nb-date-badge" style={{ '--date-color': color }}>
      <span className="nb-date-badge__num">{dayNum}</span>
      <span className="nb-date-badge__rest">{weekday} · {month} · {year}</span>
    </div>
  );
}

// ─── Weather widget ───────────────────────────────────────────────────────────
function WeatherWidget({ weather, onWidgetClick, clickActive, widgetRef }) {
  const meta   = WEATHER_META[weather];
  const isGust = clickActive && weather === 'WINDY';
  if (!meta) return null;
  return (
    <div
      ref={widgetRef}
      className={`nb-weather-widget${isGust ? ' nb-widget--gust' : ''}`}
      style={{ '--ww-color': meta.color, cursor: 'pointer' }}
      onClick={onWidgetClick}
      title="Click for weather effect"
    >
      <img
        src={meta.icon}
        alt={meta.label}
        width={28}
        height={28}
        className="nb-weather-widget__icon"
        style={{ imageRendering: 'pixelated', objectFit: 'contain' }}
      />
      <span className="nb-weather-widget__label">{meta.label}</span>
    </div>
  );
}

// ─── Firefly data ─────────────────────────────────────────────────────────────
const FIREFLY_DATA = Array.from({ length: 20 }, (_, i) => {
  const s = (i * 6271 + 3571) % 10000;
  const hue = 75 + (s % 30);
  const color = `hsl(${hue}, 80%, 65%)`;
  return { id: i, left: s % 100, top: 15 + (s * 7 % 82), size: 2 + (s % 2),
    delay: `${(s % 70) * 80}ms`, dur: `${7000 + (s % 7000)}ms`,
    glowDur: `${1200 + (s % 1400)}ms`, glowDelay: `${(s * 3 % 50) * 40}ms`,
    dx: `${(s % 50) - 25}px`, color, glow: color.replace('65%', '55%') };
});

function Fireflies() {
  return (
    <div className="nb-fireflies" aria-hidden="true">
      {FIREFLY_DATA.map(f => (
        <span key={f.id} className="nb-firefly" style={{
          left: `${f.left}%`, top: `${f.top}%`, width: f.size, height: f.size,
          background: f.color, boxShadow: `0 0 ${f.size * 4}px ${f.size + 1}px ${f.glow}88`,
          animationDelay: f.delay, animationDuration: f.dur,
          '--dx': f.dx, '--glow-dur': f.glowDur, '--glow-delay': f.glowDelay,
        }} />
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Neighborhood() {
  const { currentUser, logout, refreshUser } = useSession();
  const navigate = useNavigate();
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [query,   setQuery]   = useState('');

  // Weather state — consistent for the whole day
  const [weather,      setWeather]      = useState(getDailyWeather);
  const [clickTrigger, setClickTrigger] = useState(0);
  const [clickActive,  setClickActive]  = useState(false);
  const [ripple,       setRipple]       = useState(null);   // { x, y, id }
  const [bursts,       setBursts]       = useState([]);     // CLEAR particles

  const widgetRef  = useRef(null);
  const contentRef = useRef(null);  // for STORM shake via DOM classList

  // Dev-only: cycle weather with keyboard shortcut W
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = e => {
      if (e.key === 'w' || e.key === 'W')
        setWeather(w => WEATHERS[(WEATHERS.indexOf(w) + 1) % WEATHERS.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleWeatherClick = () => {
    if (clickActive) return;
    const trigger = clickTrigger + 1;
    setClickTrigger(trigger);
    setClickActive(true);
    setTimeout(() => setClickActive(false), 2000);

    // ── STORM: instant lightning + shake ──────────────────────────────────
    if (weather === 'STORM' && contentRef.current) {
      const el = contentRef.current;
      el.classList.remove('nb-shake');
      void el.offsetWidth;          // force reflow → restarts animation
      el.classList.add('nb-shake');
      setTimeout(() => el.classList.remove('nb-shake'), 400);
    }

    // ── RAIN: ripple expanding from widget ────────────────────────────────
    if (weather === 'RAIN' && widgetRef.current) {
      const r = widgetRef.current.getBoundingClientRect();
      setRipple({ x: r.left + r.width / 2, y: r.top + r.height / 2, id: trigger });
      setTimeout(() => setRipple(null), 1100);
    }

    // ── CLEAR: firefly burst from widget ──────────────────────────────────
    if (weather === 'CLEAR' && widgetRef.current) {
      const r  = widgetRef.current.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top  + r.height / 2;
      setBursts(Array.from({ length: 10 }, (_, i) => ({
        id:    `b${trigger}-${i}`,
        x: cx, y: cy,
        angle: i * 36,
        hue:   75 + (i * 13 % 30),
        size:  4 + (i % 4),
        delay: `${i * 40}ms`,
      })));
      setTimeout(() => setBursts([]), 1700);
    }
  };

  useEffect(() => {
    refreshUser();
    fetch('/api/users')
      .then(r => r.json())
      .then(data => { setUsers(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const avatarUrl = username =>
    `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(username)}`;

  return (
    <div className="nb-page">
      {/* ── Atmosphere layers ── */}
      {weather === 'CLEAR' && <Fireflies />}
      <div className="nb-vignette" aria-hidden="true" />
      <WeatherOverlay weather={weather} clickActive={clickActive} clickTrigger={clickTrigger} />

      {/* ── Floating nav ── */}
      <nav className="nb-float-nav">
        <button className="nb-nav-btn nb-nav-btn--farm" onClick={() => navigate('/farm')}>
          ← My Farm
        </button>
        <button className="nb-nav-btn" onClick={logout}>Log out</button>
      </nav>

      {/* ── Shakeable content wrapper ── */}
      <div ref={contentRef}>
        {/* ── Hero ── */}
        <div className="nb-hero">
          <span className="nb-hero-logo">🌱 BitGarden</span>
          <h1 className="nb-hero-title">THE NEIGHBORHOOD</h1>
          <DateBadge weather={weather} />
          <WeatherWidget
            weather={weather}
            onWidgetClick={handleWeatherClick}
            clickActive={clickActive}
            widgetRef={widgetRef}
          />
        </div>

        {/* ── Body ── */}
        <main className="nb-main">
          <div className="nb-search-wrap">
            <input
              className="nb-search"
              type="text"
              placeholder="Search gardens…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button className="nb-search-clear" onClick={() => setQuery('')} aria-label="Clear search">✕</button>
            )}
          </div>

          {loading ? (
            <p className="nb-loading">Loading gardens…</p>
          ) : (() => {
            const filtered = query.trim()
              ? users.filter(u => u.username.toLowerCase().includes(query.trim().toLowerCase()))
              : users;
            return (
              <>
                <p className="nb-section-label">
                  {query.trim()
                    ? `// ${filtered.length} result${filtered.length !== 1 ? 's' : ''} for "${query.trim()}"`
                    : `// ${users.length} garden${users.length !== 1 ? 's' : ''} found`}
                </p>
                {filtered.length === 0 ? (
                  <p className="nb-empty">No gardens matching "{query.trim()}"</p>
                ) : (
                  <div className="nb-grid">
                    {filtered.map((u, i) => (
                      <button
                        key={u.id}
                        className={`nb-card${u.id === currentUser.id ? ' nb-card--mine' : ''}`}
                        style={{ animationDelay: `${i * 55}ms` }}
                        onClick={() => navigate(`/garden/${u.id}`)}
                      >
                        <div className="nb-card-avatar-wrap">
                          <img src={avatarUrl(u.username)} alt={u.username} className="nb-card-avatar" />
                        </div>
                        <div className="nb-card-name">{u.username}</div>
                        {u.id === currentUser.id && <div className="nb-card-badge">YOU</div>}
                        <div className="nb-card-resources">
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <img src="/icons/money.png" alt="coins" width={18} height={18}
                              style={{ imageRendering: 'pixelated', objectFit: 'contain', flexShrink: 0 }} />
                            {u.coins ?? 0}
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <img src="/icons/fertilizer.png" alt="fertilizer" width={18} height={18}
                              style={{ imageRendering: 'pixelated', objectFit: 'contain', flexShrink: 0 }} />
                            {u.fertilizer ?? 0}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </main>
      </div>

      {/* ── RAIN: ripple portal ── */}
      {ripple && createPortal(
        <div key={ripple.id} className="nb-ripple"
          style={{ left: ripple.x, top: ripple.y }} />,
        document.body
      )}

      {/* ── CLEAR: burst particle portals ── */}
      {bursts.map(p => createPortal(
        <div key={p.id} className="nb-burst-particle"
          style={{
            left: p.x, top: p.y,
            width: p.size, height: p.size,
            '--angle': `${p.angle}deg`,
            animationDelay: p.delay,
            background: `hsl(${p.hue}, 80%, 65%)`,
            boxShadow: `0 0 ${p.size * 3}px ${p.size}px hsl(${p.hue}, 70%, 55%)`,
          }} />,
        document.body
      ))}
    </div>
  );
}
