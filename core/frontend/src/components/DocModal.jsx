import React from 'react';

export default function DocModal({ app, onClose }) {
  if (!app) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{app.name}</h2>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              v{app.version} by {app.author} &bull; {app.category}
            </span>
          </div>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <h4 style={{ fontSize: '0.9rem', textTransform: 'uppercase', color: 'var(--strava-orange)', marginBottom: '0.5rem' }}>
            App Capabilities & Event Subscriptions
          </h4>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {app.capabilities?.map((cap) => (
              <span key={cap} className="app-tag" style={{ color: 'var(--accent-blue)', borderColor: 'rgba(56, 189, 248, 0.3)' }}>
                ⚡ {cap}
              </span>
            ))}
            {app.eventSubscriptions?.map((sub, i) => (
              <span key={i} className="app-tag" style={{ color: 'var(--accent-green)', borderColor: 'rgba(16, 185, 129, 0.3)' }}>
                📡 {sub.detailType}
              </span>
            ))}
          </div>
        </div>

        <div className="markdown-body">
          {app.documentation ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#0B1120', padding: '1rem', borderRadius: '0.5rem' }}>
              {app.documentation}
            </pre>
          ) : (
            <p>No documentation provided for this mini-app.</p>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
