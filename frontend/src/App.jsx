import { useState, useEffect, createContext, useContext } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login        from './components/Login.jsx';
import Neighborhood from './components/Neighborhood.jsx';
import FarmGame     from './components/FarmGame.jsx';

// ─── Session context ────────────────────────────────────────────────────────
export const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

const SESSION_KEY = 'bitgarden_user';

export default function App() {
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
    catch { return null; }
  });

  const login = (user) => {
    setCurrentUser(user);
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  };

  const logout = () => {
    setCurrentUser(null);
    localStorage.removeItem(SESSION_KEY);
  };

  // Keep session data fresh when the user returns from a garden visit
  const refreshUser = async () => {
    if (!currentUser) return;
    try {
      const res = await fetch(`/api/garden/${currentUser.id}`);
      if (res.ok) {
        const { user } = await res.json();
        const updated = { ...currentUser, ...user };
        setCurrentUser(updated);
        localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
      }
    } catch {}
  };

  return (
    <SessionContext.Provider value={{ currentUser, login, logout, refreshUser, setCurrentUser }}>
      <Routes>
        {/* Default: logged-in users land directly on their own farm */}
        <Route path="/" element={
          currentUser
            ? <Navigate to="/farm" replace />
            : <Login />
        } />

        {/* Primary view: owner's own farm */}
        <Route path="/farm" element={
          currentUser
            ? <FarmGame />
            : <Navigate to="/" replace />
        } />

        {/* Secondary: neighbor list */}
        <Route path="/neighbors" element={
          currentUser
            ? <Neighborhood />
            : <Navigate to="/" replace />
        } />

        {/* Visiting another player's garden — Godot in visitor mode */}
        <Route path="/garden/:userId" element={
          currentUser
            ? <FarmGame />
            : <Navigate to="/" replace />
        } />

        {/* Legacy alias so any old /neighborhood links still work */}
        <Route path="/neighborhood" element={<Navigate to="/neighbors" replace />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionContext.Provider>
  );
}
