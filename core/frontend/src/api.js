const API_BASE = import.meta.env.VITE_API_URL || '';

export const auth = {
  getToken() {
    return localStorage.getItem('strava_hub_token');
  },
  setToken(token) {
    localStorage.setItem('strava_hub_token', token);
  },
  getAthlete() {
    const raw = localStorage.getItem('strava_hub_athlete');
    return raw ? JSON.parse(raw) : null;
  },
  setAthlete(athlete) {
    localStorage.setItem('strava_hub_athlete', JSON.stringify(athlete));
  },
  clear() {
    localStorage.removeItem('strava_hub_token');
    localStorage.removeItem('strava_hub_athlete');
  },
  isAuthenticated() {
    return !!this.getToken();
  },
};

export async function loginWithStrava() {
  const clientId = import.meta.env.VITE_STRAVA_CLIENT_ID || '12345';
  const redirectUri = encodeURIComponent(window.location.origin);
  const scope = 'read,activity:read_all';
  const url = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=auto&scope=${scope}`;
  window.location.href = url;
}

export async function exchangeStravaCode(code) {
  const res = await fetch(`${API_BASE}/auth/strava`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to authenticate with Strava');
  }
  const data = await res.json();
  auth.setToken(data.token);
  auth.setAthlete(data.athlete);
  return data;
}

export async function getAthleteStatus() {
  const token = auth.getToken();
  if (!token) return null;

  const res = await fetch(`${API_BASE}/user/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      auth.clear();
    }
    throw new Error('Failed to fetch athlete status');
  }
  return res.json();
}

export async function triggerManualSync(days = 60) {
  const token = auth.getToken();
  const res = await fetch(`${API_BASE}/user/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    throw new Error('Failed to enqueue sync request');
  }
  return res.json();
}

export async function disconnectAccount() {
  const token = auth.getToken();
  const res = await fetch(`${API_BASE}/user`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  auth.clear();
  return res.ok;
}

export async function fetchRegisteredApps() {
  try {
    const res = await fetch(`${API_BASE}/api/apps`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.apps || [];
  } catch (e) {
    console.error('Failed to load apps catalog', e);
    return [];
  }
}
