import React, { useState } from 'react';
import DocModal from './DocModal';

export default function AppCatalog({ apps = [] }) {
  const [selectedApp, setSelectedApp] = useState(null);

  return (
    <div style={{ marginTop: '3rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.25rem' }}>
          Mini-App Ecosystem
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          Discover standalone services and integrations that subscribe to your raw activity stream in real-time.
        </p>
      </div>

      {apps.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No mini-apps registered yet.</p>
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((app) => (
            <div key={app.id} className="app-card">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span className="app-tag" style={{ color: 'var(--strava-orange)', borderColor: 'rgba(252, 76, 2, 0.3)' }}>
                    {app.category || 'General'}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    v{app.version}
                  </span>
                </div>

                <div className="app-card-title">{app.name}</div>
                <div className="app-card-desc">{app.description}</div>

                <div className="app-tags">
                  {app.capabilities?.map((cap) => (
                    <span key={cap} className="app-tag">
                      {cap}
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  by {app.author}
                </span>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                  onClick={() => setSelectedApp(app)}
                >
                  Docs & Specs &rarr;
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedApp && (
        <DocModal app={selectedApp} onClose={() => setSelectedApp(null)} />
      )}
    </div>
  );
}
