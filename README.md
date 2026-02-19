# 🎵 Norster — Music Timeline Game

A mobile-first web app that plays like Hitster, but with **your own Spotify playlists**.

Listen to a song → place your token on the timeline → Reveal → Correct or Wrong.
First to 10 songs wins.

---

## What You Need

- A laptop with GitHub Pages set up (already done ✅)
- A Spotify account (**Premium recommended** for remote playback control)
- An iPhone (or any smartphone)

---

## One-Time Setup (takes ~5 minutes)

### Step 1 — Enable GitHub Pages

1. Go to your repo on GitHub: `github.com/NKGoma/GuesstheSong`
2. Click **Settings** → **Pages** (left sidebar)
3. Under "Source", select **Deploy from a branch**
4. Choose branch: `main` (or `master`), folder: `/ (root)`
5. Click **Save**
6. After ~1 minute, your app lives at:
   `https://nkgoma.github.io/GuesstheSong/`

### Step 2 — Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Log in with your Spotify account
3. Click **Create App**
4. Fill in:
   - **App name**: Norster (anything works)
   - **App description**: My music game
   - **Redirect URI**: `https://nkgoma.github.io/GuesstheSong/`
     > ⚠️ This must be **exact** — no trailing slash differences
5. Check the "Web API" checkbox
6. Click **Save**
7. On the next page, copy your **Client ID** (looks like `3a8f2b1c4d5e6f7a...`)

### Step 3 — Set Up the App on Your Phone

1. Open Safari on your iPhone
2. Go to `https://nkgoma.github.io/GuesstheSong/`
3. Tap **⚙️ Spotify Setup**
4. The app shows your redirect URI — confirm it matches what you entered in Step 2
5. Paste your **Client ID** and tap **Save**
6. Tap **Connect Spotify** and log in
7. Done! ✅

### Step 4 — Add to iPhone Home Screen

1. In Safari, tap the **Share** button (box with arrow pointing up)
2. Scroll down and tap **"Add to Home Screen"**
3. Name it "Norster" and tap **Add**
4. The app icon appears on your home screen like a real app

---

## How to Play

### Before each game

1. Open Norster from your home screen
2. Tap **New Game**
3. Pick a **Spotify playlist** (all your playlists appear)
4. Add **player names** and choose difficulty
5. Choose starting tokens (default: 3)

### Connecting Spotify for Playback

The app controls the Spotify app on your phone remotely:

1. On the Device Setup screen, tap **Open Spotify** → it opens the Spotify app
2. In Spotify, tap play on any song briefly
3. Come back to Norster and tap **Check Again**
4. Select your phone from the device list
5. Tap **Start Game**

> Music plays through Spotify while Norster stays on screen.

### During a Turn

| Step | What to do |
|------|------------|
| 1 | Tap **▶ Play** — Spotify plays the hidden song |
| 2 | Listen and decide where the song fits on your **physical timeline** |
| 3 | Place your physical token at that position |
| 4 | Tap **👁 Reveal** — song name, artist, and year appear |
| 5 | Check if you placed it correctly |
| 6 | Tap **✓** (correct) or **✗** (wrong) |

### Physical Components (the fun part!)

- Each player has a **metal strip** (their timeline)
- **Round tokens** go on the strip to mark each song's position
- Tokens are placed **face-down** before you reveal
- Flip them to check order
- First player to 10 **correctly placed** songs wins

### Tokens

- Start with 3 (adjustable)
- Use tokens to **Skip** a hard song (costs 1 token)
- **Earn tokens** in Pro/Expert mode by naming the song
- Maximum 5 tokens per player

### Difficulty Modes

| Mode | What you need to do |
|------|---------------------|
| 🎯 Original | Just place songs in the right order |
| ⭐ Pro | Also name the artist & title → +1 token if correct |
| 🔥 Expert | Also guess the exact year before reveal → +1 token if correct |

---

## Troubleshooting

**"Playback failed" error**
→ Spotify Premium is required for remote control. Without it, you'll get a link to open tracks manually.

**No devices found**
→ Open Spotify app → play any song → come back → tap "Check Again"

**Login doesn't work**
→ Double-check your Client ID and that the Redirect URI in Spotify's dashboard exactly matches your GitHub Pages URL

**App doesn't update after changes**
→ In Safari: tap the Share button → tap "Clear Cache" (or hard-refresh: hold reload button)

---

## Tech Stack

- Vanilla HTML / CSS / JavaScript (no framework needed)
- Spotify Web API (PKCE OAuth — secure, no backend server)
- Progressive Web App (PWA) — works offline, installable on home screen
- Hosted free on GitHub Pages
