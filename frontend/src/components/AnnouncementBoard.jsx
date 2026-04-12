import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Count-up hook ────────────────────────────────────────────────────────────
// Animates from 0 → target over `duration`ms with ease-out-cubic.
// Returns null when target is null (stat not applicable).
function useCountUp(target, duration = 750) {
  const [count, setCount] = useState(0);
  const rafRef = useRef(null);

  useEffect(() => {
    if (target == null) return;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(target * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return target == null ? null : count;
}

// ─── Pixel-art icon helper ────────────────────────────────────────────────────
function PixelIcon({ src, alt = '', size = 34 }) {
  return (
    <img
      src={src} alt={alt} width={size} height={size}
      style={{ imageRendering: 'pixelated', objectFit: 'contain', display: 'block' }}
    />
  );
}

// ─── Single stat card ─────────────────────────────────────────────────────────
function StatCard({ variant, label, icon, name, userId, count, formatDetail, extra, empty, delay, onNavigate }) {
  const displayed = useCountUp(count);
  const clickable  = !!userId;

  return (
    <div
      className={`ab-card ab-card--${variant}${clickable ? ' ab-card--link' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
      onClick={() => clickable && onNavigate(userId)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? e => (e.key === 'Enter' || e.key === ' ') && onNavigate(userId) : undefined}
    >
      <div className="ab-card__pin" aria-hidden="true" />
      <div className="ab-card__icon" aria-hidden="true">{icon}</div>
      <p  className="ab-card__label">{label}</p>
      {name ? (
        <>
          <p className="ab-card__name">{name}</p>
          {formatDetail && displayed != null && (
            <p className="ab-card__detail">{formatDetail(displayed)}</p>
          )}
          {!formatDetail && extra && (
            <p className="ab-card__detail">{extra}</p>
          )}
        </>
      ) : (
        <p className="ab-card__empty">{empty}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function AnnouncementBoard() {
  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/neighborhood/board')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleNavigate = (userId) => { window.location.href = `/garden/${userId}`; };

  return (
    <div className="ab-board">
      <div className="ab-sign">★ COMMUNITY BOARD ★</div>

      {loading ? (
        <div className="ab-skeleton">
          {[0, 100, 200].map(d => (
            <div key={d} className="ab-skeleton__card" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
      ) : !stats ? (
        <p className="ab-error">board unavailable</p>
      ) : (
        <div className="ab-cards">
          <StatCard
            variant="farmer"
            label="Farmer of the Day"
            icon={<PixelIcon src="/icons/farm_of_the_day.png" alt="Farmer of the Day" />}
            name={stats.farmer?.username ?? null}
            userId={stats.farmer?.id ?? null}
            count={stats.farmer?.count ?? null}
            formatDetail={(n) => `${n} item${n !== 1 ? 's' : ''} growing`}
            empty="no one growing yet"
            delay={120}
            onNavigate={handleNavigate}
          />
          <StatCard
            variant="tycoon"
            label="Richest Farmer"
            icon={<PixelIcon src="/icons/money.png" alt="Richest Farmer" />}
            name={stats.tycoon?.username ?? null}
            userId={stats.tycoon?.id ?? null}
            count={stats.tycoon?.coins ?? null}
            formatDetail={(n) => `${n} coin${n !== 1 ? 's' : ''}`}
            empty="no coins yet"
            delay={230}
            onNavigate={handleNavigate}
          />
          <StatCard
            variant="newest"
            label="Newest Neighbor"
            icon={<PixelIcon src="/icons/new_neighbor.png" alt="Newest Neighbor" />}
            name={stats.newest?.username ?? null}
            userId={stats.newest?.id ?? null}
            count={null}
            extra="just joined!"
            empty="no one yet"
            delay={340}
            onNavigate={handleNavigate}
          />
        </div>
      )}
    </div>
  );
}
