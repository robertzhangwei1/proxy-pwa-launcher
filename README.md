# Proxy PWA Launcher

This repo is set up for a real shared deployment:

- `GitHub Pages` serves the installable Android and iOS PWAs
- `One hosted backend` runs Puppeteer and Chromium for all users
- `Each installed app` gets its own private session token, so users do not
  share tabs, screenshots, or proxy state

## Architecture

1. `Frontend`
   - static files in `public/`
   - installable from GitHub Pages
   - mobile-first Android and iOS remote-browser shells
2. `Backend`
   - `server.js`
   - launches Chromium with proxy settings
    - supports multiple isolated users at once
    - cleans up idle sessions automatically

The real browser engine still runs in the backend Chromium session, but the
phone app is now interactive: URL bar, back/forward, reload, tap, scroll, and
typing all go to that hosted browser.

## What changed for multi-user hosting

- single global session replaced with per-install session isolation
- every install stores its own random session token in local storage
- all API requests include that token in the `X-Launcher-Token` header
- backend sessions are cleaned up after inactivity
- backend concurrency is capped with `MAX_CONCURRENT_SESSIONS`
- browser profiles are isolated per user and deleted on stop/timeout

## Built-in proxy route

The shared backend is already configured with:

- host: `geo.iproyal.com`
- port: `12321`
- username: `5YzAQaZQMzdWkYTM`
- password: stored in Fly secrets
- mode: manual proxy
- location format: `country-gb_city-kent`

Users do not need to enter any proxy details in the app.

## Frontend deployment

The static PWA is already GitHub Pages friendly.

Useful routes:

- `/`
- `/android.html`
- `/ios.html`

If you want every user to connect to one shared backend automatically, set the
backend URL in `public/runtime-config.js`:

```js
window.PROXY_LAUNCHER_CONFIG = {
  defaultBackendBaseUrl: "https://proxy-launcher.example.com",
};
```

Then push that change to GitHub Pages.

## Backend deployment

This repo now includes:

- `Dockerfile`
- `.dockerignore`
- `.env.example`
- `fly.toml`

That means you can deploy the backend to any container host that supports Node
and Puppeteer, for example your own VPS or a managed container platform.

## Fly.io setup

This repo is now preconfigured for Fly.io with `fly.toml`.

Fly docs I used:

- [Deploy with a Dockerfile](https://fly.io/docs/languages-and-frameworks/dockerfile/)
- [Deploy an app](https://fly.io/docs/launch/deploy/)
- [App configuration (`fly.toml`)](https://fly.io/docs/reference/configuration/)
- [Scale VM size and memory](https://fly.io/docs/flyctl/scale-vm/)

Suggested low-cost starting shape for this Puppeteer backend:

- `shared-cpu-1x`
- `2 GB RAM`
- `1 Machine`
- `auto_stop_machines = "stop"` so it can scale down when idle

### First deploy on Fly.io

From this repo directory:

```powershell
fly launch --no-deploy
fly scale count 1
fly deploy
```

Why `fly scale count 1`:

- Fly's docs note that a first deploy can create one or two Machines depending
  on app configuration.
- This project is a shared session backend, so starting with one Machine keeps
  cost and behavior predictable.

### After Fly creates your app

Set the public backend URL in Fly so the server can report its real origin:

```powershell
fly secrets set PUBLIC_BASE_URL=https://<your-fly-app>.fly.dev
```

Then update `public/runtime-config.js` so the GitHub Pages PWA points to the
shared backend automatically:

```js
window.PROXY_LAUNCHER_CONFIG = {
  defaultBackendBaseUrl: "https://<your-fly-app>.fly.dev",
};
```

Push that frontend change to GitHub Pages after the backend is live.

### Recommended environment variables

Copy `.env.example` and adjust:

- `PUBLIC_BASE_URL`
  - the final public backend origin, for example
    `https://proxy-launcher.example.com`
- `CORS_ALLOW_ORIGIN`
  - the allowed frontend origin, for example
    `https://robertzhangwei1.github.io`
- `MAX_CONCURRENT_SESSIONS`
  - how many live browsers the shared service may run at once
- `SESSION_IDLE_TIMEOUT_MINUTES`
  - how long to keep an inactive user session alive

### Local container build

```powershell
docker build -t proxy-pwa-launcher .
docker run --env-file .env -p 4317:4317 proxy-pwa-launcher
```

### Local non-container run

```powershell
npm install
node server.js
```

## Mobile install flow for real users

1. Open the GitHub Pages Android or iOS URL on the phone.
2. Install the page as a PWA.
3. Open the installed app.
4. Tap `Launch Browser`.
5. Use the URL bar to open any website.
6. Tap inside the live page to click or focus fields.
7. Swipe vertically on the live page to scroll.
8. Use the Typing Tray to send text to the focused field.

## Native wrappers

This repo also includes Capacitor native wrapper projects:

- `android/`
- `ios/`
- `capacitor.config.json`

The Android wrapper can be built into a debug APK and published from GitHub
Actions.

The iOS wrapper project is included in the repo and can be zipped into GitHub
release assets, but Apple signing is still required before a native iPhone app
can be installed outside the App Store.

## API routes

- `GET /api/meta`
- `GET /api/health`
- `GET /api/session`
- `POST /api/proxy/resolve`
- `POST /api/session/start`
- `POST /api/session/navigate`
- `POST /api/session/back`
- `POST /api/session/forward`
- `POST /api/session/reload`
- `POST /api/session/resize`
- `POST /api/session/tap`
- `POST /api/session/scroll`
- `POST /api/session/type`
- `POST /api/session/key`
- `POST /api/session/stop`
- `GET /api/session/screenshot`

## Important notes

- The hosted backend is now shareable across multiple users.
- Session isolation is per installed app, not per login account.
- This is functional multi-user isolation, not a full auth system.
- If you plan to expose the backend widely on the public internet, add your own
  auth, rate limiting, and abuse protection in front of it.
