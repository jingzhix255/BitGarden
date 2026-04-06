import { useState, useEffect, createContext, useContext } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Neighborhood from './components/Neighborhood.jsx';
import FarmGame     from './components/FarmGame.jsx';

// ─── Session context ─────────────────────────────────────────────────────────
export const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

function LoadingScreen() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#040904',
      fontFamily: "'VT323', monospace",
      color: '#3a6030',
      fontSize: '1.6rem',
      letterSpacing: '4px',
    }}>
      🌱 Loading…
    </div>
  );
}

function ErrorScreen({ message }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#040904',
      fontFamily: "'VT323', monospace",
      color: '#c04040',
      fontSize: '1.4rem',
      letterSpacing: '2px',
      textAlign: 'center',
      padding: '2rem',
      gap: '0.75rem',
    }}>
      <span>Could not connect to authentication service.</span>
      <span style={{ fontSize: '1rem', color: '#6a3030' }}>{message}</span>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [authError,   setAuthError]   = useState(null);

  // Resolve the current user from the Okta proxy on every fresh page load.
  // In dev, the backend automatically falls back to "LocalDevUser".
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => {
        if (!r.ok) throw new Error(`Auth failed: ${r.status}`);
        return r.json();
      })
      .then(user  => {
        // Only new accounts get the onboarding; suppress it for existing users.
        if (!user.is_new_user) {
          localStorage.setItem('bitgarden_onboarded', '1');
        }
        setCurrentUser(user);
        setLoading(false);
      })
      .catch(err  => { setAuthError(err.message); setLoading(false); });
  }, []);

  // Keep resource counts (coins, fertilizer) fresh after farm interactions.
  const refreshUser = async () => {
    if (!currentUser) return;
    try {
      const res = await fetch(`/api/garden/${currentUser.id}`);
      if (res.ok) {
        const { user } = await res.json();
        setCurrentUser(prev => ({ ...prev, ...user }));
      }
    } catch {}
  };

  // Okta owns authentication — logout redirects to the proxy's logout endpoint.
  const logout = () => {
    setCurrentUser(null);
    window.location.href = '/logout';
  };

  if (loading)   return <LoadingScreen />;
  if (authError) return <ErrorScreen message={authError} />;

  return (
    <SessionContext.Provider value={{ currentUser, logout, refreshUser, setCurrentUser }}>
      <Routes>
        {/* Root always goes to the user's own farm */}
        <Route path="/"               element={<Navigate to="/farm" replace />} />
        <Route path="/farm"           element={<FarmGame />} />
        <Route path="/neighbors"      element={<Neighborhood />} />
        <Route path="/garden/:userId" element={<FarmGame />} />
        {/* Legacy alias */}
        <Route path="/neighborhood"   element={<Navigate to="/neighbors" replace />} />
        <Route path="*"               element={<Navigate to="/farm" replace />} />
      </Routes>
    </SessionContext.Provider>
  );
}
