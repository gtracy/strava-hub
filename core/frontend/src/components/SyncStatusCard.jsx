import React, { useState } from 'react';
import { triggerManualSync } from '../api';

export default function SyncStatusCard({ athlete, onRefresh, onOpenDataModal }) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  const handleSync = async () => {
    try {
      setSyncing(true);
      setMessage('');
      await triggerManualSync(60);
      setMessage('✅ Enqueued 60-day historical backfill to SQS!');
      if (onRefresh) onRefresh();
    } catch (err) {
      setMessage(`❌ Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const formattedDate = athlete.lastSyncAt
    ? new Date(athlete.lastSyncAt).toLocaleString()
    : 'Pending initial backfill';

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <span>Athlete Data Synchronization</span>
          <span className="status-badge active">● Live Webhooks Active</span>
        </div>
      </div>

      <div className="status-grid">
        <div className="status-stat">
          <div className="status-stat-label">Connection Status</div>
          <div className="status-stat-val" style={{ color: 'var(--accent-green)', fontSize: '1.25rem' }}>
            Connected
          </div>
        </div>

        <div className="status-stat">
          <div className="status-stat-label">Stored Activities</div>
          <div className="status-stat-val">
            {athlete.totalActivities !== undefined ? athlete.totalActivities : 0}
          </div>
        </div>

        <div className="status-stat">
          <div className="status-stat-label">Last Sync Received</div>
          <div className="status-stat-val" style={{ fontSize: '1rem', fontWeight: 600 }}>
            {formattedDate}
          </div>
        </div>
      </div>

      {message && (
        <div style={{ marginBottom: '1rem', padding: '0.6rem 1rem', borderRadius: '0.5rem', background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)', fontSize: '0.9rem' }}>
          {message}
        </div>
      )}

      <div className="action-row">
        <button
          className="btn btn-secondary"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? 'Queuing Sync...' : '🔄 Re-sync Recent Data (60 Days)'}
        </button>

        <button
          className="btn btn-secondary"
          onClick={() => onOpenDataModal('export')}
        >
          📦 Export Raw Activity Archive
        </button>

        <button
          className="btn btn-danger"
          onClick={() => onOpenDataModal('disconnect')}
        >
          Disconnect & Purge Data
        </button>
      </div>
    </div>
  );
}
