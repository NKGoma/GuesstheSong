'use strict';

// ==================== CONSTANTS ====================
const SPOTIFY_AUTH  = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API   = 'https://api.spotify.com/v1';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read'
].join(' ');

const WINNING_SCORE = 10;
const LS = {
  CLIENT_ID:     'norster_client_id',
  ACCESS_TOKEN:  'norster_access_token',
  REFRESH_TOKEN: 'norster_refresh_token',
  TOKEN_EXPIRY:  'norster_token_expiry',
  // PKCE — stored in localStorage so Safari keeps them across cross-origin redirects
  CODE_VERIFIER: 'norster_pkce_verifier',
  OAUTH_STATE:   'norster_pkce_state',
};

// ==================== STATE ====================
let S = {
  clientId: localStorage.getItem(LS.CLIENT_ID) || '',
  accessToken: localStorage.getItem(LS.ACCESS_TOKEN) || null,
  refreshToken: localStorage.getItem(LS.REFRESH_TOKEN) || null,
  tokenExpiry: parseInt(localStorage.getItem(LS.TOKEN_EXPIRY)) || 0,

  playlists: [],
  selectedPlaylist: null,
  tracks: [],
  queue: [],

  players: [],
  currentPlayerIdx: 0,
  startingTokens: 3,
  difficulty: 'original',

  currentTrack: null,
  revealed: false,
  isPlaying: false,
  songHasPlayed: false,
  yearGuess: null,

  selectedDeviceId: null,
  devices: [],

  phase: 'start',
};

// ==================== PKCE HELPERS ====================
function randomStr(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

async function sha256base64url(str) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ==================== AUTH ====================
async function startAuth() {
  const verifier  = randomStr(128);
  const challenge = await sha256base64url(verifier);
  const state     = randomStr(16);

  // Use localStorage (not sessionStorage) — Safari clears sessionStorage on cross-origin redirects
  localStorage.setItem(LS.CODE_VERIFIER, verifier);
  localStorage.setItem(LS.OAUTH_STATE, state);

  const params = new URLSearchParams({
    client_id: S.clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });

  window.location.href = `${SPOTIFY_AUTH}?${params}`;
}

async function handleOAuthCallback(code, returnedState) {
  const storedState = localStorage.getItem(LS.OAUTH_STATE);
  const verifier    = localStorage.getItem(LS.CODE_VERIFIER);

  if (!storedState || returnedState !== storedState) {
    // State mismatch — could be expired session or Safari privacy wiping localStorage
    // Clean up and let user try again
    localStorage.removeItem(LS.OAUTH_STATE);
    localStorage.removeItem(LS.CODE_VERIFIER);
    window.history.replaceState({}, document.title, window.location.pathname);
    showAuthError('Login session expired or was interrupted. Tap Connect Spotify to try again.');
    showScreen('start');
    renderStartScreen();
    return;
  }

  // Clean the URL so a page reload doesn't re-trigger the callback
  window.history.replaceState({}, document.title, window.location.pathname);

  // Show loading state while exchanging token
  showScreen('loading-tracks');
  document.getElementById('loading-playlist-name').textContent = 'Connecting to Spotify…';

  try {
    const res = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: S.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(),
        code_verifier: verifier,
      }),
    });

    // Clean up PKCE data only after a successful exchange attempt
    localStorage.removeItem(LS.OAUTH_STATE);
    localStorage.removeItem(LS.CODE_VERIFIER);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error_description || `Token exchange failed (HTTP ${res.status})`);
    }

    const data = await res.json();
    saveTokens(data);
    await continueAfterAuth();
  } catch (err) {
    console.error('OAuth token exchange error:', err);
    showAuthError(`Could not connect to Spotify: ${err.message}`);
    showScreen('start');
    renderStartScreen();
  }
}

async function refreshTokens() {
  if (!S.refreshToken) return false;
  try {
    const res = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: S.clientId,
        grant_type: 'refresh_token',
        refresh_token: S.refreshToken,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    saveTokens(data);
    return true;
  } catch {
    return false;
  }
}

function saveTokens(data) {
  S.accessToken = data.access_token;
  S.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  if (data.refresh_token) S.refreshToken = data.refresh_token;

  localStorage.setItem(LS.ACCESS_TOKEN, S.accessToken);
  localStorage.setItem(LS.TOKEN_EXPIRY, S.tokenExpiry);
  if (data.refresh_token) localStorage.setItem(LS.REFRESH_TOKEN, S.refreshToken);
}

async function ensureToken() {
  if (!S.accessToken) return false;
  if (Date.now() >= S.tokenExpiry) return await refreshTokens();
  return true;
}

function logout() {
  [LS.ACCESS_TOKEN, LS.REFRESH_TOKEN, LS.TOKEN_EXPIRY].forEach(k => localStorage.removeItem(k));
  S.accessToken = null; S.refreshToken = null; S.tokenExpiry = 0;
  showScreen('start');
  renderStartScreen();
}

function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

// ==================== SPOTIFY API ====================
async function spotifyFetch(path, options = {}) {
  const ok = await ensureToken();
  if (!ok) { logout(); return null; }

  const res = await fetch(`${SPOTIFY_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${S.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (!refreshed) { logout(); return null; }
    return spotifyFetch(path, options);
  }

  if (res.status === 204 || res.status === 202) return true;

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || body?.error_description || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : true;
}

async function fetchAllPlaylists() {
  let items = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const data = await spotifyFetch(url);
    if (!data) break;
    items = items.concat(data.items || []);
    if (data.next) {
      const u = new URL(data.next);
      url = u.pathname.replace('/v1', '') + u.search;
    } else url = null;
  }
  return items.filter(p => p && p.id);
}

async function fetchPlaylistTracks(playlistId) {
  let items = [];
  let url = `/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,name,uri,is_local,artists,album(name,release_date,images)))`;
  while (url) {
    const data = await spotifyFetch(url);
    if (!data) break;
    items = items.concat(data.items || []);
    if (data.next) {
      const u = new URL(data.next);
      url = u.pathname.replace('/v1', '') + u.search;
    } else url = null;
  }
  return items.map(item => {
    const t = item?.track;
    if (!t || t.is_local || !t.id) return null;
    const year = t.album?.release_date ? parseInt(t.album.release_date.substring(0, 4)) : null;
    if (!year || isNaN(year) || year < 1900 || year > new Date().getFullYear()) return null;
    return {
      id: t.id, name: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      year, uri: t.uri,
      album: t.album?.name || '',
      art: t.album?.images?.[0]?.url || null,
    };
  }).filter(Boolean);
}

async function getDevices() {
  const data = await spotifyFetch('/me/player/devices');
  return data?.devices || [];
}

async function playTrack(trackUri, deviceId) {
  const path = deviceId ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}` : '/me/player/play';
  return spotifyFetch(path, { method: 'PUT', body: JSON.stringify({ uris: [trackUri] }) });
}

async function pausePlayback() {
  return spotifyFetch('/me/player/pause', { method: 'PUT' });
}

// ==================== GAME LOGIC ====================
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initGame() {
  S.queue = shuffleArray([...Array(S.tracks.length).keys()]);
  S.currentPlayerIdx = 0;
  S.revealed = S.isPlaying = S.songHasPlayed = false;
  S.currentTrack = S.yearGuess = null;
  S.players.forEach(p => { p.tokens = S.startingTokens; p.score = 0; });
}

function currentPlayer() { return S.players[S.currentPlayerIdx]; }

function drawNextTrack() {
  if (!S.queue.length) S.queue = shuffleArray([...Array(S.tracks.length).keys()]);
  return S.tracks[S.queue.shift()];
}

function nextPlayerTurn() {
  S.currentPlayerIdx = (S.currentPlayerIdx + 1) % S.players.length;
  S.currentTrack = null;
  S.revealed = S.isPlaying = S.songHasPlayed = false;
  S.yearGuess = null;
  renderGameTurn();
}

function checkWin() {
  return S.players.find(p => p.score >= WINNING_SCORE) || null;
}

// ==================== SCREEN SYSTEM ====================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${id}`);
  if (el) el.classList.add('active');
  S.phase = id;
}

// ==================== START SCREEN ====================
function renderStartScreen() {
  const hasToken = !!S.accessToken && Date.now() < S.tokenExpiry;
  document.getElementById('btn-new-game').style.display       = hasToken ? '' : 'none';
  document.getElementById('btn-connect-spotify').style.display = hasToken ? 'none' : '';
  const status = document.getElementById('user-status');
  status.textContent = hasToken ? '● Connected to Spotify' : '';
}

// ==================== CONFIG SCREEN ====================
function renderConfigScreen() {
  document.getElementById('input-client-id').value = S.clientId;
  document.getElementById('redirect-uri-display').textContent = getRedirectUri();
}

function saveClientId() {
  const val = document.getElementById('input-client-id').value.trim();
  if (!val) { showToast('Please enter a Client ID', 'error'); return; }
  S.clientId = val;
  localStorage.setItem(LS.CLIENT_ID, val);
  showToast('Saved!', 'success');
  showScreen('start');
  renderStartScreen();
}

// ==================== PLAYLIST SCREEN ====================
async function loadPlaylists() {
  showScreen('playlists');
  const grid = document.getElementById('playlist-grid');
  grid.innerHTML = `<div class="loading-center"><div class="spinner"></div>Loading playlists…</div>`;

  try {
    S.playlists = await fetchAllPlaylists();
    renderPlaylistGrid();
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="loading-center" style="color:var(--text)">${err.message}</div>`;
  }
}

function renderPlaylistGrid() {
  const grid = document.getElementById('playlist-grid');
  if (!S.playlists.length) {
    grid.innerHTML = `<div class="loading-center">No playlists found.</div>`;
    return;
  }
  grid.className = 'playlist-grid';
  grid.innerHTML = S.playlists.map(p => {
    const img = p.images?.[0]?.url;
    const art = img ? `<img src="${img}" alt="" loading="lazy">` : '🎵';
    return `
      <div class="playlist-tile" data-id="${p.id}">
        <div class="playlist-tile-art">${art}</div>
        <div class="playlist-tile-info">
          <div class="playlist-tile-name">${escHtml(p.name)}</div>
          <div class="playlist-tile-count">${p.tracks?.total ?? '?'} songs</div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.playlist-tile').forEach(el =>
    el.addEventListener('click', () => selectPlaylist(el.dataset.id))
  );
}

async function selectPlaylist(id) {
  S.selectedPlaylist = S.playlists.find(p => p.id === id);
  if (!S.selectedPlaylist) return;

  showScreen('loading-tracks');
  document.getElementById('loading-playlist-name').textContent = S.selectedPlaylist.name;

  try {
    S.tracks = await fetchPlaylistTracks(id);
    if (S.tracks.length < 5) {
      showToast('Need at least 5 songs with release years in this playlist', 'error');
      await loadPlaylists();
      return;
    }
    showScreen('players');
    renderPlayersScreen();
  } catch (err) {
    console.error(err);
    showToast(`Could not load tracks: ${err.message}`, 'error');
    await loadPlaylists();
  }
}

// ==================== PLAYER SETUP ====================
function renderPlayersScreen() {
  document.getElementById('selected-playlist-name').textContent = S.selectedPlaylist?.name || '';
  document.getElementById('selected-track-count').textContent   = `${S.tracks.length} songs with years`;

  // Show art in pill
  const pilArt = document.getElementById('pill-art');
  const imgUrl = S.selectedPlaylist?.images?.[0]?.url;
  pilArt.innerHTML = imgUrl ? `<img src="${imgUrl}" alt="">` : '🎵';

  renderPlayerList();
  renderDifficultyOptions();
  updateTokenDisplay();
}

function renderPlayerList() {
  document.getElementById('player-list').innerHTML = S.players.map((p, i) => `
    <div class="player-row">
      <div class="player-initial">${(p.name || 'P').charAt(0).toUpperCase()}</div>
      <input type="text" value="${escHtml(p.name)}" placeholder="Player ${i + 1}"
             data-idx="${i}" class="player-name-input" maxlength="20">
      <button class="player-row-remove" data-idx="${i}">✕</button>
    </div>
  `).join('');

  document.querySelectorAll('.player-name-input').forEach(inp =>
    inp.addEventListener('input', e => {
      S.players[+e.target.dataset.idx].name =
        e.target.value.trim() || `Player ${+e.target.dataset.idx + 1}`;
    })
  );
  document.querySelectorAll('.player-row-remove').forEach(btn =>
    btn.addEventListener('click', e => {
      if (S.players.length <= 2) { showToast('Minimum 2 players', 'error'); return; }
      S.players.splice(+e.target.dataset.idx, 1);
      renderPlayerList();
    })
  );
}

function addPlayer() {
  if (S.players.length >= 8) { showToast('Maximum 8 players', 'error'); return; }
  S.players.push({ name: `Player ${S.players.length + 1}`, tokens: S.startingTokens, score: 0 });
  renderPlayerList();
}

function renderDifficultyOptions() {
  const opts = {
    original: { label: 'Original', desc: 'Place songs in chronological order' },
    pro:      { label: 'Pro',      desc: 'Also name the artist & title for +1 token' },
    expert:   { label: 'Expert',   desc: 'Also guess the exact year for +1 token' },
  };
  document.getElementById('difficulty-options').innerHTML = Object.entries(opts).map(([k, d]) => `
    <div class="diff-row ${S.difficulty === k ? 'selected' : ''}" data-diff="${k}">
      <div class="diff-row-check"><div class="diff-row-check-dot"></div></div>
      <div>
        <div class="diff-row-label">${d.label}</div>
        <div class="diff-row-desc">${d.desc}</div>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.diff-row').forEach(el =>
    el.addEventListener('click', () => { S.difficulty = el.dataset.diff; renderDifficultyOptions(); })
  );
}

function updateTokenDisplay() {
  document.getElementById('token-value').textContent = S.startingTokens;
}

function changeTokens(delta) {
  S.startingTokens = Math.max(1, Math.min(5, S.startingTokens + delta));
  updateTokenDisplay();
}

function startGame() {
  S.players = S.players.map((p, i) => ({
    ...p, name: p.name.trim() || `Player ${i + 1}`,
    tokens: S.startingTokens, score: 0,
  }));
  initGame();
  showScreen('device');
  loadDevices();
}

// ==================== DEVICE SCREEN ====================
async function loadDevices() {
  renderDeviceStatus('loading');
  try {
    S.devices = await getDevices();
    renderDeviceStatus('ready');
  } catch {
    renderDeviceStatus('error');
  }
}

function renderDeviceStatus(state) {
  const statusEl  = document.getElementById('device-status');
  const listEl    = document.getElementById('device-list');
  const startBtn  = document.getElementById('btn-start-game');

  if (state === 'loading') {
    statusEl.innerHTML = `<div class="device-hero-icon">📱</div><h1>Searching…</h1><p>Looking for active Spotify devices.</p>`;
    listEl.innerHTML = '';
    if (startBtn) startBtn.disabled = true;
    return;
  }
  if (state === 'error') {
    statusEl.innerHTML = `<div class="device-hero-icon">⚠️</div><h1>Connection error</h1><p>Could not reach Spotify. Check your internet and try again.</p>`;
    listEl.innerHTML = '';
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const devices = S.devices.filter(Boolean);
  if (!devices.length) {
    statusEl.innerHTML = `<div class="device-hero-icon">🎵</div><h1>No devices found</h1><p>Open Spotify, play anything for a second, then tap Check Again.</p>`;
    listEl.innerHTML = '';
    if (startBtn) startBtn.disabled = true;
    S.selectedDeviceId = null;
    return;
  }

  // Auto-select the active device
  if (!S.selectedDeviceId) {
    S.selectedDeviceId = (devices.find(d => d.is_active) || devices[0]).id;
  }

  statusEl.innerHTML = `<div class="device-hero-icon">✅</div><h1>Spotify found</h1><p>Select where to play music:</p>`;

  const icons = { Computer: '💻', Smartphone: '📱', Speaker: '🔊', Tablet: '📟' };
  listEl.innerHTML = devices.map(d => `
    <div class="device-item ${S.selectedDeviceId === d.id ? 'selected' : ''}" data-id="${d.id}">
      <span class="device-icon-cell">${icons[d.type] || '🎵'}</span>
      <span class="device-name-cell">${escHtml(d.name)}</span>
      ${d.is_active ? '<span class="device-active-badge">Active</span>' : ''}
      ${S.selectedDeviceId === d.id ? '<span class="device-check">✓</span>' : ''}
    </div>
  `).join('');

  listEl.querySelectorAll('.device-item').forEach(el =>
    el.addEventListener('click', () => { S.selectedDeviceId = el.dataset.id; renderDeviceStatus('ready'); })
  );

  if (startBtn) startBtn.disabled = !S.selectedDeviceId;
}

function openSpotifyApp() {
  window.location.href = 'spotify://';
}

// ==================== GAME SCREEN ====================
function renderGameTurn() {
  const player = currentPlayer();

  // Player rail
  document.getElementById('player-rail').innerHTML = S.players.map((p, i) => `
    <div class="player-rail-tab ${i === S.currentPlayerIdx ? 'active' : ''}">
      <span class="prt-name">${escHtml(p.name.split(' ')[0])}</span>
      <span class="prt-score">${p.score}✦</span>
    </div>
  `).join('');

  // Player name
  document.getElementById('current-player-name').textContent = player.name;

  // Score dots (10 total)
  document.getElementById('score-bar').innerHTML = Array.from({ length: WINNING_SCORE }, (_, i) =>
    `<div class="score-dot ${i < player.score ? 'on' : ''}"></div>`
  ).join('');

  // Token pips
  renderTokens(player.tokens);

  // Reset song card
  resetSongCard();

  // Controls
  document.getElementById('btn-play').textContent = '▶';
  document.getElementById('btn-play').disabled = false;
  document.getElementById('btn-reveal').disabled = true;
  document.getElementById('reveal-btn-text').textContent = 'Reveal';

  // Footer: show skip, hide correct/wrong
  setPostActions(false);

  // Expert year guess bar
  const yBar = document.getElementById('year-guess-section');
  if (S.difficulty === 'expert') {
    yBar.classList.add('on');
    document.getElementById('year-guess-input').value = new Date().getFullYear();
  } else {
    yBar.classList.remove('on');
  }

  // Playing indicator off
  document.getElementById('playing-indicator').classList.remove('on');
  document.getElementById('art-veil-status').textContent = 'Tap play to start';
}

function renderTokens(count) {
  const max = Math.max(count, S.startingTokens);
  document.getElementById('player-tokens').innerHTML = Array.from({ length: max }, (_, i) =>
    `<div class="token-pip ${i < count ? 'on' : ''}"></div>`
  ).join('');
  document.getElementById('token-count-label').textContent = `${count} token${count !== 1 ? 's' : ''}`;
}

function resetSongCard() {
  const artImg    = document.getElementById('song-art-img');
  const veil      = document.getElementById('art-blur-overlay');
  const phBars    = document.getElementById('song-hidden-info');
  const revInfo   = document.getElementById('song-reveal-info');
  const fallback  = document.getElementById('btn-open-spotify-fallback');

  artImg.src = '';
  artImg.classList.add('hidden');
  veil.classList.remove('gone');
  phBars.classList.remove('off');
  revInfo.classList.remove('on');
  if (fallback) fallback.style.display = 'none';
}

function showSongCard(revealed) {
  const track   = S.currentTrack;
  const artImg  = document.getElementById('song-art-img');
  const veil    = document.getElementById('art-blur-overlay');
  const phBars  = document.getElementById('song-hidden-info');
  const revInfo = document.getElementById('song-reveal-info');

  if (!revealed || !track) {
    resetSongCard();
    return;
  }

  // Show album art
  if (track.art) {
    artImg.src = track.art;
    artImg.classList.remove('hidden');
    veil.classList.add('gone');
  }

  // Show text info
  phBars.classList.add('off');
  revInfo.classList.add('on');
  document.getElementById('song-title-reveal').textContent  = track.name;
  document.getElementById('song-artist-reveal').textContent = track.artist;
  document.getElementById('song-year-reveal').textContent   = track.year;
  document.getElementById('song-album-reveal').textContent  = track.album;
}

function setPostActions(show) {
  document.getElementById('game-actions-pre').style.display  = show ? 'none' : 'flex';
  document.getElementById('game-actions-post').style.display = show ? 'flex' : 'none';
}

// ==================== TURN ACTIONS ====================
async function handlePlayPause() {
  const btn       = document.getElementById('btn-play');
  const indicator = document.getElementById('playing-indicator');
  const veilLabel = document.getElementById('art-veil-status');

  // Pause
  if (S.isPlaying) {
    btn.textContent = '▶';
    S.isPlaying = false;
    indicator.classList.remove('on');
    veilLabel.textContent = 'Paused — tap to resume';
    try { await pausePlayback(); } catch {}
    return;
  }

  // Pick track on first play
  if (!S.currentTrack) {
    S.currentTrack = drawNextTrack();
    if (!S.currentTrack) { showToast('No tracks available', 'error'); return; }
  }

  btn.disabled = true;
  indicator.classList.add('on');
  veilLabel.textContent = 'Listening…';

  try {
    await playTrack(S.currentTrack.uri, S.selectedDeviceId);
    btn.textContent = '⏸';
    S.isPlaying = true;
    S.songHasPlayed = true;
    document.getElementById('btn-reveal').disabled = false;
  } catch (err) {
    console.error('Playback error:', err);
    indicator.classList.remove('on');
    veilLabel.textContent = 'Tap play to start';

    // Friendly error messages based on HTTP status
    if (err.status === 403) {
      showToast('Spotify Premium required for remote control', 'error');
    } else if (err.status === 404) {
      showToast('Device went inactive — tap Check Again on the device screen', 'error');
      // Try without specifying a device (use whatever Spotify has active)
      try {
        await playTrack(S.currentTrack.uri, null);
        btn.textContent = '⏸';
        S.isPlaying = true;
        S.songHasPlayed = true;
        document.getElementById('btn-reveal').disabled = false;
        indicator.classList.add('on');
        veilLabel.textContent = 'Listening…';
        btn.disabled = false;
        return;
      } catch {}
    } else {
      showToast(`Playback failed: ${err.message}`, 'error');
    }

    // Fallback: open in Spotify directly
    const trackId = S.currentTrack.uri.split(':').pop();
    const fallback = document.getElementById('btn-open-spotify-fallback');
    fallback.href = `https://open.spotify.com/track/${trackId}`;
    fallback.style.display = 'block';
    document.getElementById('btn-reveal').disabled = false;
    S.songHasPlayed = true;
  } finally {
    btn.disabled = false;
  }
}

async function handleReveal() {
  if (!S.currentTrack) return;

  // Expert: capture year guess before reveal
  if (S.difficulty === 'expert') {
    S.yearGuess = parseInt(document.getElementById('year-guess-input').value);
  }

  // Stop playback
  if (S.isPlaying) {
    try { await pausePlayback(); } catch {}
    S.isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    document.getElementById('playing-indicator').classList.remove('on');
  }

  S.revealed = true;
  showSongCard(true);
  document.getElementById('reveal-btn-text').textContent = 'Revealed';
  document.getElementById('btn-reveal').disabled = true;
  setPostActions(true);

  // Expert: was year correct?
  if (S.difficulty === 'expert' && S.yearGuess) {
    if (S.yearGuess === S.currentTrack.year) {
      currentPlayer().tokens = Math.min(5, currentPlayer().tokens + 1);
      renderTokens(currentPlayer().tokens);
      showToast(`Exact year! +1 token for ${currentPlayer().name}`, 'success');
    } else {
      showToast(`Year was ${S.currentTrack.year}`, 'info');
    }
  }

  // Show "Named it?" button only for Pro / Expert
  document.getElementById('btn-named-it').style.display =
    (S.difficulty !== 'original') ? '' : 'none';
}

function handleNamedIt() {
  const p = currentPlayer();
  p.tokens = Math.min(5, p.tokens + 1);
  renderTokens(p.tokens);
  showToast(`+1 token for naming it!`, 'success');
  document.getElementById('btn-named-it').style.display = 'none';
}

function handleCorrect() {
  const p = currentPlayer();
  p.score++;
  const winner = checkWin();
  if (winner) { showEndScreen(winner); return; }
  showToast(`Correct — ${p.name} has ${p.score} song${p.score !== 1 ? 's' : ''}`, 'success');
  nextPlayerTurn();
}

function handleWrong() {
  showToast('Not quite — discard that one', 'error');
  nextPlayerTurn();
}

function handleSkip() {
  const p = currentPlayer();
  if (p.tokens < 1) { showToast('No tokens left to skip', 'error'); return; }
  p.tokens--;
  S.currentTrack = null;
  S.isPlaying = false;
  S.songHasPlayed = false;
  try { pausePlayback(); } catch {}
  renderGameTurn();
  showToast('Skipped — 1 token used', 'info');
}

// ==================== END SCREEN ====================
function showEndScreen(winner) {
  showScreen('end');
  document.getElementById('winner-name').textContent = winner.name;
  const sorted = [...S.players].sort((a, b) => b.score - a.score);
  document.getElementById('final-scores').innerHTML = sorted.map(p => `
    <div class="score-row ${p === winner ? 'top' : ''}">
      <span class="score-row-name">${p === winner ? '🏆 ' : ''}${escHtml(p.name)}</span>
      <span class="score-row-num">${p.score}</span>
    </div>
  `).join('');
}

// ==================== TOASTS & ERRORS ====================
// Persistent banner for auth errors (not a disappearing toast)
function showAuthError(msg) {
  let banner = document.getElementById('auth-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'auth-error-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:300',
      'background:#2A1010', 'color:#F5A0A0', 'border-bottom:1px solid #5A2020',
      'padding:14px 20px', 'font-size:14px', 'line-height:1.4',
      'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:12px'
    ].join(';');
    document.body.appendChild(banner);
  }
  banner.innerHTML = `
    <span>${escHtml(msg)}</span>
    <button onclick="this.parentElement.remove()"
            style="background:none;border:none;color:#F5A0A0;font-size:20px;cursor:pointer;flex-shrink:0">✕</button>
  `;
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

// ==================== UTILS ====================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function continueAfterAuth() {
  await loadPlaylists();
}

// ==================== BOOT ====================
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Always set up defaults and bind events first so every button works
  // regardless of which path below we take (OAuth callback or normal boot)
  if (!S.players.length) {
    S.players = [
      { name: 'Player 1', tokens: 3, score: 0 },
      { name: 'Player 2', tokens: 3, score: 0 },
    ];
  }
  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');
  const state  = params.get('state');

  if (error) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Spotify login was cancelled', 'error');
    showScreen('start');
    renderStartScreen();
    return;
  }

  if (code) {
    if (!S.clientId) {
      // Client ID somehow missing — re-enter it
      window.history.replaceState({}, document.title, window.location.pathname);
      showToast('Client ID not found — please re-enter it', 'error');
      showScreen('config');
      renderConfigScreen();
      return;
    }
    await handleOAuthCallback(code, state);
    return;
  }

  // Normal boot: try to restore token
  if (!S.accessToken || Date.now() >= S.tokenExpiry) {
    if (S.refreshToken) await refreshTokens();
  }

  showScreen('start');
  renderStartScreen();
}

function bindEvents() {
  // Start screen
  document.getElementById('btn-connect-spotify').addEventListener('click', () => {
    if (!S.clientId) {
      showToast('Enter your Spotify Client ID first', 'error');
      showScreen('config'); renderConfigScreen(); return;
    }
    startAuth();
  });
  document.getElementById('btn-new-game').addEventListener('click', () => loadPlaylists());
  document.getElementById('btn-setup-client').addEventListener('click', () => { showScreen('config'); renderConfigScreen(); });
  document.getElementById('btn-logout').addEventListener('click', () => {
    if (confirm('Disconnect Spotify?')) logout();
  });

  // Config
  document.getElementById('btn-save-client-id').addEventListener('click', saveClientId);
  document.getElementById('btn-config-back').addEventListener('click', () => { showScreen('start'); renderStartScreen(); });

  // Playlists
  document.getElementById('btn-playlists-back').addEventListener('click', () => { showScreen('start'); renderStartScreen(); });

  // Player setup
  document.getElementById('btn-add-player').addEventListener('click', addPlayer);
  document.getElementById('btn-players-back').addEventListener('click', () => loadPlaylists());
  document.getElementById('btn-start-game-setup').addEventListener('click', startGame);
  document.getElementById('btn-token-minus').addEventListener('click', () => changeTokens(-1));
  document.getElementById('btn-token-plus').addEventListener('click',  () => changeTokens(+1));

  // Device
  document.getElementById('btn-open-spotify').addEventListener('click', openSpotifyApp);
  document.getElementById('btn-check-devices').addEventListener('click', loadDevices);
  document.getElementById('btn-start-game').addEventListener('click', () => {
    if (!S.selectedDeviceId) { showToast('Select a device first', 'error'); return; }
    showScreen('game');
    renderGameTurn();
  });
  document.getElementById('btn-device-back').addEventListener('click', () => { showScreen('players'); renderPlayersScreen(); });

  // Game
  document.getElementById('btn-play').addEventListener('click', handlePlayPause);
  document.getElementById('btn-reveal').addEventListener('click', handleReveal);
  document.getElementById('btn-correct').addEventListener('click', handleCorrect);
  document.getElementById('btn-wrong').addEventListener('click', handleWrong);
  document.getElementById('btn-skip').addEventListener('click', handleSkip);
  document.getElementById('btn-named-it').addEventListener('click', handleNamedIt);
  document.getElementById('btn-game-menu').addEventListener('click', () => {
    if (confirm('End game and go home?')) {
      if (S.isPlaying) pausePlayback().catch(() => {});
      showScreen('start'); renderStartScreen();
    }
  });

  // Expert year guess
  document.getElementById('btn-year-minus').addEventListener('click', () => {
    const inp = document.getElementById('year-guess-input');
    inp.value = Math.max(1900, +inp.value - 1);
  });
  document.getElementById('btn-year-plus').addEventListener('click', () => {
    const inp = document.getElementById('year-guess-input');
    inp.value = Math.min(new Date().getFullYear(), +inp.value + 1);
  });

  // When the page becomes visible again (e.g. user switched from Spotify OAuth tab back
  // to the PWA or Safari tab), re-read auth state from localStorage in case a token
  // was saved by the OAuth callback in a different tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.phase === 'start') {
      S.accessToken  = localStorage.getItem(LS.ACCESS_TOKEN)  || null;
      S.refreshToken = localStorage.getItem(LS.REFRESH_TOKEN) || null;
      S.tokenExpiry  = parseInt(localStorage.getItem(LS.TOKEN_EXPIRY)) || 0;
      renderStartScreen();
    }
  });

  // Same for cross-tab localStorage updates (works in regular Safari browser)
  window.addEventListener('storage', e => {
    if (e.key === LS.ACCESS_TOKEN && e.newValue && S.phase === 'start') {
      S.accessToken  = e.newValue;
      S.tokenExpiry  = parseInt(localStorage.getItem(LS.TOKEN_EXPIRY)) || 0;
      renderStartScreen();
    }
  });

  // End
  document.getElementById('btn-play-again').addEventListener('click', () => {
    initGame(); showScreen('game'); renderGameTurn();
  });
  document.getElementById('btn-end-home').addEventListener('click', () => { showScreen('start'); renderStartScreen(); });
}

document.addEventListener('DOMContentLoaded', init);
