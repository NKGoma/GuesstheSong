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
};
const SS = {
  CODE_VERIFIER: 'norster_code_verifier',
  OAUTH_STATE:   'norster_oauth_state',
};

// ==================== STATE ====================
let S = {
  // Auth
  clientId: localStorage.getItem(LS.CLIENT_ID) || '',
  accessToken: localStorage.getItem(LS.ACCESS_TOKEN) || null,
  refreshToken: localStorage.getItem(LS.REFRESH_TOKEN) || null,
  tokenExpiry: parseInt(localStorage.getItem(LS.TOKEN_EXPIRY)) || 0,

  // Playlist
  playlists: [],
  selectedPlaylist: null,
  tracks: [],
  queue: [],

  // Players
  players: [],          // [{name, tokens, score}]
  currentPlayerIdx: 0,
  startingTokens: 3,
  difficulty: 'original',

  // Turn
  currentTrack: null,
  revealed: false,
  isPlaying: false,
  songHasPlayed: false,
  yearGuess: null,

  // Device
  selectedDeviceId: null,
  devices: [],

  // Phase
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
  const data = encoder.encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ==================== AUTH ====================
async function startAuth() {
  const verifier = randomStr(128);
  const challenge = await sha256base64url(verifier);
  const state = randomStr(16);

  sessionStorage.setItem(SS.CODE_VERIFIER, verifier);
  sessionStorage.setItem(SS.OAUTH_STATE, state);

  const redirectUri = getRedirectUri();
  const params = new URLSearchParams({
    client_id: S.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: state,
    scope: SCOPES,
    show_dialog: 'false',
  });

  window.location.href = `${SPOTIFY_AUTH}?${params}`;
}

async function handleOAuthCallback(code, returnedState) {
  const storedState = sessionStorage.getItem(SS.OAUTH_STATE);
  const verifier = sessionStorage.getItem(SS.CODE_VERIFIER);

  if (returnedState !== storedState) {
    showToast('Auth state mismatch — please try again', 'error');
    showScreen('start');
    return;
  }

  sessionStorage.removeItem(SS.OAUTH_STATE);
  sessionStorage.removeItem(SS.CODE_VERIFIER);

  // Clean URL
  window.history.replaceState({}, document.title, window.location.pathname);

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
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
    const data = await res.json();
    saveTokens(data);
    await continueAfterAuth();
  } catch (err) {
    console.error(err);
    showToast('Login failed. Check your Client ID.', 'error');
    showScreen('start');
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
  if (Date.now() >= S.tokenExpiry) {
    return await refreshTokens();
  }
  return true;
}

function logout() {
  localStorage.removeItem(LS.ACCESS_TOKEN);
  localStorage.removeItem(LS.REFRESH_TOKEN);
  localStorage.removeItem(LS.TOKEN_EXPIRY);
  S.accessToken = null;
  S.refreshToken = null;
  S.tokenExpiry = 0;
  showScreen('start');
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

  if (res.status === 204 || res.status === 202 || res.status === 200 && res.headers.get('content-length') === '0') {
    return true;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
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
    // Extract relative path from next URL
    if (data.next) {
      const nextUrl = new URL(data.next);
      url = nextUrl.pathname.replace('/v1', '') + nextUrl.search;
    } else {
      url = null;
    }
  }
  return items.filter(p => p && p.id);
}

async function fetchPlaylistTracks(playlistId) {
  let items = [];
  let url = `/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,name,uri,is_local,duration_ms,artists,album(name,release_date,release_date_precision,images)))`;
  while (url) {
    const data = await spotifyFetch(url);
    if (!data) break;
    items = items.concat(data.items || []);
    if (data.next) {
      const nextUrl = new URL(data.next);
      url = nextUrl.pathname.replace('/v1', '') + nextUrl.search;
    } else {
      url = null;
    }
  }
  // Process and filter
  return items
    .map(item => {
      const t = item?.track;
      if (!t || t.is_local || !t.id || !t.uri) return null;
      const releaseDate = t.album?.release_date || '';
      const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : null;
      if (!year || isNaN(year) || year < 1900 || year > new Date().getFullYear()) return null;
      return {
        id: t.id,
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        year,
        uri: t.uri,
        album: t.album?.name || '',
        art: t.album?.images?.[0]?.url || null,
      };
    })
    .filter(Boolean);
}

async function getDevices() {
  const data = await spotifyFetch('/me/player/devices');
  return data?.devices || [];
}

async function playTrack(trackUri, deviceId) {
  const body = { uris: [trackUri] };
  const path = deviceId ? `/me/player/play?device_id=${deviceId}` : '/me/player/play';
  return spotifyFetch(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

async function pausePlayback() {
  return spotifyFetch('/me/player/pause', { method: 'PUT' });
}

async function resumePlayback() {
  return spotifyFetch('/me/player/play', { method: 'PUT' });
}

async function transferPlayback(deviceId) {
  return spotifyFetch('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });
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
  S.revealed = false;
  S.isPlaying = false;
  S.songHasPlayed = false;
  S.currentTrack = null;
  S.yearGuess = null;
  S.players.forEach(p => { p.tokens = S.startingTokens; p.score = 0; });
}

function currentPlayer() {
  return S.players[S.currentPlayerIdx];
}

function drawNextTrack() {
  if (S.queue.length === 0) {
    S.queue = shuffleArray([...Array(S.tracks.length).keys()]);
  }
  const idx = S.queue.shift();
  return S.tracks[idx];
}

function nextPlayerTurn() {
  S.currentPlayerIdx = (S.currentPlayerIdx + 1) % S.players.length;
  S.currentTrack = null;
  S.revealed = false;
  S.isPlaying = false;
  S.songHasPlayed = false;
  S.yearGuess = null;
  renderGameTurn();
}

function checkWin() {
  return S.players.find(p => p.score >= WINNING_SCORE) || null;
}

// ==================== UI SCREENS ====================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${id}`);
  if (el) el.classList.add('active');
  S.phase = id;
}

// ==================== START SCREEN ====================
function renderStartScreen() {
  const hasToken = !!S.accessToken && Date.now() < S.tokenExpiry;
  document.getElementById('btn-new-game').style.display = hasToken ? '' : 'none';
  document.getElementById('btn-connect-spotify').style.display = hasToken ? 'none' : '';
  document.getElementById('btn-setup-client').style.display = '';
  if (hasToken) {
    document.getElementById('user-status').textContent = 'Connected to Spotify';
    document.getElementById('user-status').style.color = 'var(--spotify)';
  } else {
    document.getElementById('user-status').textContent = '';
  }
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
  showToast('Client ID saved!', 'success');
  showScreen('start');
  renderStartScreen();
}

// ==================== PLAYLIST SCREEN ====================
async function loadPlaylists() {
  showScreen('playlists');
  const grid = document.getElementById('playlist-grid');
  grid.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading your playlists…</p></div>`;

  try {
    S.playlists = await fetchAllPlaylists();
    renderPlaylistGrid();
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="loading-state"><p style="color:var(--danger)">Failed to load playlists. ${err.message}</p></div>`;
  }
}

function renderPlaylistGrid() {
  const grid = document.getElementById('playlist-grid');
  if (!S.playlists.length) {
    grid.innerHTML = `<div class="loading-state"><p>No playlists found.</p></div>`;
    return;
  }
  grid.className = 'playlist-grid';
  grid.innerHTML = S.playlists.map(p => {
    const img = p.images?.[0]?.url;
    const art = img
      ? `<img src="${img}" alt="" loading="lazy">`
      : `<div class="playlist-art-fallback">🎵</div>`;
    return `
      <div class="playlist-card" data-id="${p.id}">
        <div class="playlist-art">${art}</div>
        <div class="playlist-info">
          <div class="playlist-name">${escHtml(p.name)}</div>
          <div class="playlist-count">${p.tracks?.total || '?'} songs</div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.playlist-card').forEach(card => {
    card.addEventListener('click', () => selectPlaylist(card.dataset.id));
  });
}

async function selectPlaylist(id) {
  S.selectedPlaylist = S.playlists.find(p => p.id === id);
  if (!S.selectedPlaylist) return;

  showScreen('loading-tracks');
  document.getElementById('loading-playlist-name').textContent = S.selectedPlaylist.name;

  try {
    S.tracks = await fetchPlaylistTracks(id);
    if (S.tracks.length < 5) {
      showToast('Not enough songs with years in this playlist (need 5+)', 'error');
      await loadPlaylists();
      return;
    }
    showScreen('players');
    renderPlayersScreen();
  } catch (err) {
    console.error(err);
    showToast(`Failed to load tracks: ${err.message}`, 'error');
    await loadPlaylists();
  }
}

// ==================== PLAYERS SCREEN ====================
function renderPlayersScreen() {
  document.getElementById('selected-playlist-name').textContent = S.selectedPlaylist?.name || '';
  document.getElementById('selected-track-count').textContent = `${S.tracks.length} songs with years`;
  renderPlayerList();
  renderDifficultyOptions();
  updateTokenDisplay();
}

function renderPlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = S.players.map((p, i) => `
    <div class="player-item">
      <div class="player-avatar">${(p.name || 'P').charAt(0).toUpperCase()}</div>
      <input type="text" value="${escHtml(p.name)}" placeholder="Player ${i + 1}"
             data-idx="${i}" class="player-name-input" maxlength="20">
      <button class="player-remove" data-idx="${i}" aria-label="Remove">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.player-name-input').forEach(inp => {
    inp.addEventListener('input', e => {
      S.players[+e.target.dataset.idx].name = e.target.value.trim() || `Player ${+e.target.dataset.idx + 1}`;
    });
  });
  list.querySelectorAll('.player-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      if (S.players.length <= 2) { showToast('Minimum 2 players', 'error'); return; }
      S.players.splice(+e.target.dataset.idx, 1);
      renderPlayerList();
    });
  });
}

function addPlayer() {
  if (S.players.length >= 8) { showToast('Maximum 8 players', 'error'); return; }
  S.players.push({ name: `Player ${S.players.length + 1}`, tokens: S.startingTokens, score: 0 });
  renderPlayerList();
}

function renderDifficultyOptions() {
  const diffs = {
    original: { emoji: '🎯', label: 'Original', desc: 'Place songs in chronological order' },
    pro:      { emoji: '⭐', label: 'Pro', desc: 'Also name the artist & title for a token bonus' },
    expert:   { emoji: '🔥', label: 'Expert', desc: 'Also guess the exact year for a token bonus' },
  };
  const container = document.getElementById('difficulty-options');
  container.innerHTML = Object.entries(diffs).map(([key, d]) => `
    <div class="difficulty-option ${S.difficulty === key ? 'selected' : ''}" data-diff="${key}">
      <span class="diff-emoji">${d.emoji}</span>
      <div class="diff-info">
        <h3>${d.label}</h3>
        <p>${d.desc}</p>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.difficulty-option').forEach(el => {
    el.addEventListener('click', () => {
      S.difficulty = el.dataset.diff;
      renderDifficultyOptions();
    });
  });
}

function updateTokenDisplay() {
  document.getElementById('token-value').textContent = S.startingTokens;
}

function changeTokens(delta) {
  S.startingTokens = Math.max(1, Math.min(5, S.startingTokens + delta));
  updateTokenDisplay();
}

function startGame() {
  // Validate player names
  S.players = S.players.map((p, i) => ({
    ...p,
    name: p.name.trim() || `Player ${i + 1}`,
    tokens: S.startingTokens,
    score: 0,
  }));
  initGame();
  showScreen('device');
  loadDevices();
}

// ==================== DEVICE SCREEN ====================
let devicePollInterval = null;

async function loadDevices() {
  renderDeviceScreen('loading');
  try {
    S.devices = await getDevices();
    renderDeviceScreen('ready');
  } catch (err) {
    renderDeviceScreen('error');
  }
}

function renderDeviceScreen(state) {
  const status = document.getElementById('device-status');
  const list = document.getElementById('device-list');
  const startBtn = document.getElementById('btn-start-game');

  if (state === 'loading') {
    status.innerHTML = `<div class="device-icon">📱</div><h2>Finding Spotify</h2><p>Looking for active Spotify devices…</p>`;
    list.innerHTML = `<div class="loading-state" style="padding:20px"><div class="spinner"></div></div>`;
    if (startBtn) startBtn.disabled = true;
    return;
  }

  if (state === 'error') {
    status.innerHTML = `<div class="device-icon">⚠️</div><h2>Connection issue</h2><p>Could not reach Spotify. Check your internet and try again.</p>`;
    list.innerHTML = '';
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const activeDevices = S.devices.filter(d => d);
  if (activeDevices.length === 0) {
    status.innerHTML = `<div class="device-icon">🎵</div><h2>Open Spotify</h2><p>No active devices found. Open the Spotify app and play any song, then come back and tap <strong>Check Again</strong>.</p>`;
    list.innerHTML = '';
    if (startBtn) startBtn.disabled = true;
    S.selectedDeviceId = null;
    return;
  }

  status.innerHTML = `<div class="device-icon">✅</div><h2>Spotify Found</h2><p>Select the device where music should play:</p>`;

  list.innerHTML = activeDevices.map(d => {
    const icons = { Computer: '💻', Smartphone: '📱', Speaker: '🔊', Tablet: '📟' };
    const icon = icons[d.type] || '🎵';
    const sel = S.selectedDeviceId === d.id ? 'selected' : '';
    return `
      <div class="device-item ${sel}" data-id="${d.id}">
        <span class="device-type">${icon}</span>
        <span class="device-name">${escHtml(d.name)}</span>
        ${d.is_active ? '<span class="device-active">Active</span>' : ''}
        ${sel ? '<span class="check-icon">✓</span>' : ''}
      </div>`;
  }).join('');

  // Auto-select active device
  if (!S.selectedDeviceId) {
    const active = activeDevices.find(d => d.is_active) || activeDevices[0];
    S.selectedDeviceId = active.id;
    renderDeviceScreen('ready');
    return;
  }

  list.querySelectorAll('.device-item').forEach(el => {
    el.addEventListener('click', () => {
      S.selectedDeviceId = el.dataset.id;
      renderDeviceScreen('ready');
    });
  });

  if (startBtn) startBtn.disabled = !S.selectedDeviceId;
}

function openSpotifyApp() {
  // Try to open Spotify app via URI scheme
  window.location.href = 'spotify://';
}

// ==================== GAME SCREEN ====================
function renderGameTurn() {
  const player = currentPlayer();

  // Player tabs
  renderPlayerTabs();

  // Score bar
  const scoreBar = document.getElementById('score-bar');
  const segments = Array.from({ length: WINNING_SCORE }, (_, i) =>
    `<div class="score-segment ${i < player.score ? 'filled' : ''}"></div>`
  ).join('');
  scoreBar.innerHTML = segments;
  document.getElementById('score-label').textContent = `${player.score} / ${WINNING_SCORE} songs`;

  // Token display
  renderTokens(player.tokens);

  // Song card — reset to hidden
  showSongCard(false);

  // Controls
  document.getElementById('btn-play').disabled = false;
  document.getElementById('btn-reveal').disabled = true;
  document.getElementById('reveal-btn-text').textContent = '👁 Reveal Song';

  // Show pre-actions, hide post-actions
  setPostActions(false);

  // Year guess section
  const yearSection = document.getElementById('year-guess-section');
  if (S.difficulty === 'expert') {
    yearSection.classList.add('visible');
    S.yearGuess = new Date().getFullYear();
    document.getElementById('year-guess-input').value = S.yearGuess;
  } else {
    yearSection.classList.remove('visible');
  }
}

function renderPlayerTabs() {
  const tabs = document.getElementById('player-tabs');
  tabs.innerHTML = S.players.map((p, i) => `
    <div class="player-tab ${i === S.currentPlayerIdx ? 'active' : ''}">
      <span class="player-tab-name">${escHtml(p.name.split(' ')[0])}</span>
      <span class="player-tab-score">${p.score}🎵</span>
    </div>
  `).join('');
  document.getElementById('current-player-name').textContent = currentPlayer().name + "'s turn";
}

function renderTokens(count) {
  const container = document.getElementById('player-tokens');
  const max = Math.max(count, S.startingTokens);
  container.innerHTML = Array.from({ length: max }, (_, i) =>
    `<div class="token-dot ${i < count ? '' : 'empty'}"></div>`
  ).join('');
  document.getElementById('token-count-label').textContent = `${count} token${count !== 1 ? 's' : ''}`;
}

function showSongCard(revealed) {
  const hiddenOverlay = document.getElementById('art-blur-overlay');
  const artImg = document.getElementById('song-art-img');
  const hiddenInfo = document.getElementById('song-hidden-info');
  const revealInfo = document.getElementById('song-reveal-info');
  const track = S.currentTrack;

  if (!revealed || !track) {
    hiddenOverlay.classList.remove('hidden');
    artImg.classList.add('hidden');
    hiddenInfo.classList.remove('hidden');
    revealInfo.classList.remove('visible');
    artImg.src = '';
  } else {
    // Show real info
    if (track.art) {
      artImg.src = track.art;
      artImg.classList.remove('hidden');
      hiddenOverlay.classList.add('hidden');
    } else {
      artImg.classList.add('hidden');
      hiddenOverlay.classList.remove('hidden');
      hiddenOverlay.innerHTML = `<div class="art-mystery">🎵</div>`;
    }
    hiddenInfo.classList.add('hidden');
    revealInfo.classList.add('visible');
    document.getElementById('song-title-reveal').textContent = track.name;
    document.getElementById('song-artist-reveal').textContent = track.artist;
    document.getElementById('song-year-reveal').textContent = track.year;
    document.getElementById('song-album-reveal').textContent = track.album;
  }
}

function setPostActions(show) {
  const pre = document.getElementById('game-actions-pre');
  const post = document.getElementById('game-actions-post');
  if (show) {
    pre.classList.add('hidden');
    post.classList.add('visible');
  } else {
    pre.classList.remove('hidden');
    post.classList.remove('visible');
  }
}

// ==================== TURN ACTIONS ====================
async function handlePlayPause() {
  const btn = document.getElementById('btn-play');
  if (S.isPlaying) {
    // Pause
    btn.textContent = '▶';
    document.getElementById('playing-indicator').style.display = 'none';
    S.isPlaying = false;
    try { await pausePlayback(); } catch {}
    return;
  }

  // Pick a track if none
  if (!S.currentTrack) {
    S.currentTrack = drawNextTrack();
    if (!S.currentTrack) { showToast('No more songs!', 'error'); return; }
  }

  btn.textContent = '⏸';
  btn.disabled = true;
  document.getElementById('playing-indicator').style.display = 'flex';

  try {
    await playTrack(S.currentTrack.uri, S.selectedDeviceId);
    S.isPlaying = true;
    S.songHasPlayed = true;
    document.getElementById('btn-reveal').disabled = false;
  } catch (err) {
    showToast(`Playback failed: ${err.message}. Is Spotify Premium active?`, 'error');
    // Fallback: open Spotify with the track
    const trackId = S.currentTrack.uri.split(':').pop();
    document.getElementById('playing-indicator').style.display = 'none';
    showToast('Tap to open in Spotify app instead', 'info');
    document.getElementById('btn-open-spotify-fallback').style.display = '';
    document.getElementById('btn-open-spotify-fallback').href = `https://open.spotify.com/track/${trackId}`;
    document.getElementById('btn-reveal').disabled = false;
    S.songHasPlayed = true;
  } finally {
    btn.disabled = false;
  }
}

async function handleReveal() {
  if (!S.currentTrack) return;

  // In expert mode, check year guess before revealing
  if (S.difficulty === 'expert') {
    const guess = parseInt(document.getElementById('year-guess-input').value);
    S.yearGuess = guess;
  }

  // Pause playback
  if (S.isPlaying) {
    try { await pausePlayback(); } catch {}
    S.isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    document.getElementById('playing-indicator').style.display = 'none';
  }

  S.revealed = true;
  showSongCard(true);

  // Check year guess for Expert mode
  if (S.difficulty === 'expert' && S.yearGuess) {
    if (S.yearGuess === S.currentTrack.year) {
      const player = currentPlayer();
      player.tokens = Math.min(5, player.tokens + 1);
      renderTokens(player.tokens);
      showToast(`🎯 Exact year! +1 token for ${player.name}`, 'success');
    } else {
      showToast(`Year was ${S.currentTrack.year}`, 'info');
    }
  }

  // Pro mode prompt — handled via post-action buttons with "Named it?" button
  document.getElementById('reveal-btn-text').textContent = 'Revealed!';
  document.getElementById('btn-reveal').disabled = true;
  setPostActions(true);

  // Show "Named it?" button only in pro/expert
  document.getElementById('btn-named-it').style.display =
    (S.difficulty === 'pro' || S.difficulty === 'expert') ? '' : 'none';
}

function handleNamedIt() {
  const player = currentPlayer();
  player.tokens = Math.min(5, player.tokens + 1);
  renderTokens(player.tokens);
  showToast(`🎤 +1 token for naming it!`, 'success');
  document.getElementById('btn-named-it').style.display = 'none';
}

function handleCorrect() {
  const player = currentPlayer();
  player.score++;
  showToast(`✅ Correct! ${player.name} now has ${player.score} song${player.score !== 1 ? 's' : ''}`, 'success');

  const winner = checkWin();
  if (winner) {
    showEndScreen(winner);
    return;
  }
  nextPlayerTurn();
}

function handleWrong() {
  const player = currentPlayer();
  showToast(`❌ Not quite — discard that one`, 'error');
  nextPlayerTurn();
}

function handleSkip() {
  const player = currentPlayer();
  if (player.tokens < 1) {
    showToast('Not enough tokens to skip', 'error');
    return;
  }
  player.tokens--;
  renderTokens(player.tokens);
  showToast(`⏭ Skipped — 1 token used`, 'info');
  // Put track back at end of queue, get new one
  if (S.currentTrack) {
    // We don't know the index, just discard and move on
  }
  S.currentTrack = null;
  S.revealed = false;
  S.isPlaying = false;
  S.songHasPlayed = false;
  if (S.isPlaying) { pausePlayback().catch(() => {}); }
  renderGameTurn();
}

// ==================== END SCREEN ====================
function showEndScreen(winner) {
  showScreen('end');
  document.getElementById('winner-name').textContent = winner.name;

  const sorted = [...S.players].sort((a, b) => b.score - a.score);
  const scoreList = document.getElementById('final-scores');
  scoreList.innerHTML = sorted.map(p => `
    <div class="score-row ${p === winner ? 'winner-row' : ''}">
      <span class="score-player-name">${p === winner ? '🏆 ' : ''}${escHtml(p.name)}</span>
      <span class="score-player-score">${p.score}</span>
    </div>
  `).join('');
}

// ==================== TOASTS ====================
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ==================== UTILITIES ====================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function continueAfterAuth() {
  await loadPlaylists();
}

// ==================== INIT ====================
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Check for OAuth callback
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  const state = params.get('state');

  if (error) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Spotify login was cancelled', 'error');
    showScreen('start');
    renderStartScreen();
    return;
  }

  if (code && S.clientId) {
    await handleOAuthCallback(code, state);
    return;
  }

  // Normal start
  if (S.accessToken && Date.now() < S.tokenExpiry) {
    showScreen('start');
    renderStartScreen();
  } else if (S.refreshToken) {
    const ok = await refreshTokens();
    showScreen('start');
    renderStartScreen();
  } else {
    showScreen('start');
    renderStartScreen();
  }

  // Default players
  if (S.players.length === 0) {
    S.players = [
      { name: 'Player 1', tokens: 3, score: 0 },
      { name: 'Player 2', tokens: 3, score: 0 },
    ];
  }

  bindEvents();
}

function bindEvents() {
  // Start screen
  document.getElementById('btn-connect-spotify').addEventListener('click', () => {
    if (!S.clientId) {
      showToast('Set your Spotify Client ID first', 'error');
      showScreen('config');
      renderConfigScreen();
      return;
    }
    startAuth();
  });

  document.getElementById('btn-new-game').addEventListener('click', async () => {
    await loadPlaylists();
  });

  document.getElementById('btn-setup-client').addEventListener('click', () => {
    showScreen('config');
    renderConfigScreen();
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    if (confirm('Disconnect Spotify and return to start?')) logout();
  });

  // Config screen
  document.getElementById('btn-save-client-id').addEventListener('click', saveClientId);
  document.getElementById('btn-config-back').addEventListener('click', () => {
    showScreen('start'); renderStartScreen();
  });

  // Playlist screen
  document.getElementById('btn-playlists-back').addEventListener('click', () => {
    showScreen('start'); renderStartScreen();
  });

  // Players screen
  document.getElementById('btn-add-player').addEventListener('click', addPlayer);
  document.getElementById('btn-players-back').addEventListener('click', () => loadPlaylists());
  document.getElementById('btn-start-game-setup').addEventListener('click', startGame);
  document.getElementById('btn-token-minus').addEventListener('click', () => changeTokens(-1));
  document.getElementById('btn-token-plus').addEventListener('click', () => changeTokens(1));

  // Device screen
  document.getElementById('btn-open-spotify').addEventListener('click', openSpotifyApp);
  document.getElementById('btn-check-devices').addEventListener('click', loadDevices);
  document.getElementById('btn-start-game').addEventListener('click', () => {
    if (!S.selectedDeviceId) { showToast('Select a device first', 'error'); return; }
    showScreen('game');
    renderGameTurn();
  });
  document.getElementById('btn-device-back').addEventListener('click', () => {
    showScreen('players'); renderPlayersScreen();
  });

  // Game screen
  document.getElementById('btn-play').addEventListener('click', handlePlayPause);
  document.getElementById('btn-reveal').addEventListener('click', handleReveal);
  document.getElementById('btn-correct').addEventListener('click', handleCorrect);
  document.getElementById('btn-wrong').addEventListener('click', handleWrong);
  document.getElementById('btn-skip').addEventListener('click', handleSkip);
  document.getElementById('btn-named-it').addEventListener('click', handleNamedIt);
  document.getElementById('btn-game-menu').addEventListener('click', () => {
    if (confirm('End game and return to start?')) {
      if (S.isPlaying) pausePlayback().catch(() => {});
      showScreen('start'); renderStartScreen();
    }
  });

  // Year guess controls
  document.getElementById('btn-year-minus').addEventListener('click', () => {
    const inp = document.getElementById('year-guess-input');
    inp.value = Math.max(1900, +inp.value - 1);
  });
  document.getElementById('btn-year-plus').addEventListener('click', () => {
    const inp = document.getElementById('year-guess-input');
    inp.value = Math.min(new Date().getFullYear(), +inp.value + 1);
  });

  // End screen
  document.getElementById('btn-play-again').addEventListener('click', () => {
    initGame();
    showScreen('game');
    renderGameTurn();
  });
  document.getElementById('btn-end-home').addEventListener('click', () => {
    showScreen('start'); renderStartScreen();
  });
}

// ==================== BOOT ====================
document.addEventListener('DOMContentLoaded', init);
