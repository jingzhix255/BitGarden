import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../App.jsx';

// Pre-computed star positions so the field is deterministic, never random-repaints
const STARS = Array.from({ length: 38 }, (_, i) => {
  const s = (i * 5003 + 1999) % 10000;
  return {
    id:      i,
    left:    (s % 100),
    top:     (s * 7 % 92),
    size:    s % 5 === 0 ? 2 : 1,
    opacity: 0.3 + (s % 6) * 0.1,
    delay:   `${(s % 40) * 80}ms`,
    dur:     `${3000 + (s % 4000)}ms`,
  };
});

export default function Login() {
  const { login }  = useSession();
  const navigate   = useNavigate();
  const [username, setUsername] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [errorKey, setErrorKey] = useState(0); // forces re-mount to re-trigger shake

  const handleSubmit = async (e) => {
    e.preventDefault();
    const name = username.trim();
    if (!name) {
      setError('enter a name, farmer.');
      setErrorKey(k => k + 1);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res  = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'something went wrong.');
        setErrorKey(k => k + 1);
        return;
      }
      login(data);
      navigate('/farm');
    } catch {
      setError('could not reach the server.');
      setErrorKey(k => k + 1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="lp-page">
      {/* ── Star field ── */}
      <div className="lp-stars" aria-hidden="true">
        {STARS.map(s => (
          <span
            key={s.id}
            className="lp-star"
            style={{
              left:              `${s.left}%`,
              top:               `${s.top}%`,
              width:             s.size,
              height:            s.size,
              opacity:           s.opacity,
              animationDelay:    s.delay,
              animationDuration: s.dur,
            }}
          />
        ))}
      </div>

      {/* ── Ground vignette ── */}
      <div className="lp-ground" aria-hidden="true" />

      {/* ── Scene ── */}
      <div className="lp-scene">

        {/* Title — THE hero moment */}
        <div className="lp-hero">
          <h1 className="lp-title">BITGARDEN</h1>
          <p className="lp-tagline">a cozy farming world</p>
        </div>

        <div className="lp-divider" aria-hidden="true">✦ · · · ✦</div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="lp-form" noValidate>
          <input
            type="text"
            className="lp-input"
            placeholder="enter your name, farmer…"
            value={username}
            onChange={e => setUsername(e.target.value)}
            maxLength={32}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {error && (
            <p key={errorKey} className="lp-error">{error}</p>
          )}
          <button type="submit" className="lp-btn" disabled={loading}>
            {loading ? 'ENTERING…' : 'ENTER THE GARDEN'}
          </button>
        </form>

        <p className="lp-hint">new here? your farm will be planted automatically</p>
      </div>
    </div>
  );
}
