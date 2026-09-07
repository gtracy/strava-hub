import React, { useState } from 'react';
import { disconnectAccount } from '../api';

export default function DataActionsModal({ mode, onClose, onDisconnectSuccess }) {
  const [loading, setLoading] = useState(false);
  const [exportComplete, setExportComplete] = useState(false);

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await disconnectAccount();
      if (onDisconnectSuccess) onDisconnectSuccess();
      onClose();
    } catch (e) {
      alert(`Error disconnecting: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSimulateExport = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setExportComplete(true);
    }, 1200);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{mode === 'export' ? 'Export Raw Athlete Archive' : 'Disconnect Strava & Purge Data'}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        {mode === 'export' ? (
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              Strava Hub maintains your detailed activity records in S3 and indexed metadata in DynamoDB.
              You can trigger a compiled JSON archive of your stored data.
            </p>

            {exportComplete ? (
              <div style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
                <h4 style={{ color: 'var(--accent-green)', marginBottom: '0.25rem' }}>Export Ready!</h4>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  All stored activity JSON payloads and GPS polylines have been packaged. (Placeholder demo action).
                </p>
              </div>
            ) : (
              <div style={{ marginBottom: '1.5rem' }}>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  Click below to package your activities into an exportable payload.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
              {!exportComplete && (
                <button className="btn btn-strava" onClick={handleSimulateExport} disabled={loading}>
                  {loading ? 'Compiling Archive...' : 'Download My Data (Placeholder)'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              Are you sure you want to disconnect? This will immediately revoke Strava Hub's OAuth access token
              with Strava and remove your profile from the multi-tenant database.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleDisconnect} disabled={loading}>
                {loading ? 'Disconnecting...' : 'Yes, Disconnect & Purge'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
