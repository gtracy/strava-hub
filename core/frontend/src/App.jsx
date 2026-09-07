import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import SyncStatusCard from './components/SyncStatusCard';
import DataActionsModal from './components/DataActionsModal';
import AppCatalog from './components/AppCatalog';
import { auth, exchangeStravaCode, getAthleteStatus, fetchRegisteredApps, loginWithStrava } from './api';

export default function App() {
  const [athlete, setAthlete] = useState(auth.getAthlete());
  const [apps, setApps] = useState([]);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [modalMode, setModalMode] = useState(null); // 'export' | 'disconnect' | null
  const [error, setError] = useState(null);

  // Check for Strava OAuth callback (?code=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      setLoadingAuth(true);
      window.history.replaceState({}, document.title, window.location.pathname);
      exchangeStravaCode(code)
        .then((data) => {
          setAthlete(data.athlete);
          setLoadingAuth(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoadingAuth(false);
        });
    } else if (auth.isAuthenticated()) {
      // Refresh status from backend
      getAthleteStatus()
        .then((status) => {
          if (status) {
            setAthlete(status);
            auth.setAthlete(status);
          }
        })
        .catch(() => {
          // Token may have expired
          setAthlete(null);
        });
    }

    // Load available apps catalog
    fetchRegisteredApps().then(setApps);
  }, []);

  const handleRefresh = async () => {
    try {
      const status = await getAthleteStatus();
      if (status) {
        setAthlete(status);
        auth.setAthlete(status);
      }
    } catch (e) {
      console.error('Failed to refresh status', e);
    }
  };

  const handleLogout = () => {
    auth.clear();
    setAthlete(null);
  };

  return (
    <div>
      <Navbar athlete={athlete} onLogout={handleLogout} />

      <main className="container">
        {loadingAuth && (
          <div className="card" style={{ marginTop: '2rem', textAlign: 'center' }}>
            <h2>Connecting your Strava account...</h2>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              Exchanging authorization code and setting up your multi-tenant activity store.
            </p>
          </div>
        )}

        {error && (
          <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid var(--accent-red)', borderRadius: '0.5rem', color: 'var(--accent-red)' }}>
            <strong>Authentication Error:</strong> {error}
          </div>
        )}

        {athlete ? (
          <div style={{ marginTop: '2.5rem' }}>
            <div style={{ marginBottom: '2rem' }}>
              <h1 style={{ fontSize: '2.25rem', fontWeight: 800 }}>
                Welcome back, {athlete.firstname || 'Athlete'}!
              </h1>
              <p style={{ color: 'var(--text-secondary)' }}>
                Your Strava activities are automatically synced in the background and stored in your hybrid storage layer.
              </p>
            </div>

            <SyncStatusCard
              athlete={athlete}
              onRefresh={handleRefresh}
              onOpenDataModal={(mode) => setModalMode(mode)}
            />

            <AppCatalog apps={apps} />
          </div>
        ) : (
          <div>
            <section className="hero">
              <h1>The Open-Source Strava Foundation Platform</h1>
              <p>
                Subscribe to Strava activity data once. Automatically store and update rich route and telemetry payloads.
                Power an ecosystem of independent, decoupled mini-apps with zero Strava rate limit collisions.
              </p>
              <button className="btn btn-strava" style={{ fontSize: '1.1rem', padding: '0.8rem 1.75rem' }} onClick={loginWithStrava}>
                Connect with Strava to Get Started &rarr;
              </button>
            </section>

            <AppCatalog apps={apps} />
          </div>
        )}

        {modalMode && (
          <DataActionsModal
            mode={modalMode}
            onClose={() => setModalMode(null)}
            onDisconnectSuccess={() => setAthlete(null)}
          />
        )}
      </main>

      <footer style={{ borderTop: '1px solid var(--card-border)', marginTop: '5rem', padding: '2rem 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        <div className="container">
          <p>Strava Hub — An open-source, extensible data foundation for the Strava developer ecosystem.</p>
        </div>
      </footer>
    </div>
  );
}
