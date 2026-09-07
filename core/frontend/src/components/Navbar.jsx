import React from 'react';
import { auth, loginWithStrava } from '../api';

export default function Navbar({ athlete, onLogout }) {
  return (
    <header>
      <div className="container nav-content">
        <a href="/" className="brand">
          <svg viewBox="0 0 24 24">
            <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7.24 14.228h4.17z" />
          </svg>
          <span>Strava Hub</span>
          <span className="brand-tag">Platform</span>
        </a>

        <div>
          {athlete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {athlete.profile && (
                <img
                  src={athlete.profile}
                  alt={athlete.firstname || 'Athlete'}
                  style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid var(--strava-orange)' }}
                />
              )}
              <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                {athlete.firstname ? `${athlete.firstname} ${athlete.lastname || ''}` : `Athlete ${athlete.athleteId}`}
              </span>
              <button className="btn btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }} onClick={onLogout}>
                Sign Out
              </button>
            </div>
          ) : (
            <button className="btn btn-strava" onClick={loginWithStrava}>
              Connect with Strava
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
