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
   - mobile-first Android and iOS shells
2. `Backend`
   - `server.js`
   - launches Chromium with proxy settings
   - supports multiple isolated users at once
   - cleans up idle sessions automatically

The phone app is still a controller. The actual proxied browsing happens in the
backend Chromium session.

## What changed for multi-user hosting

- single global session replaced with per-install session isolation
- every install stores its own random session token in local storage
- all API requests include that token in the `X-Launcher-Token` header
- backend sessions are cleaned up after inactivity
- backend concurrency is capped with `MAX_CONCURRENT_SESSIONS`
- browser profiles are isolated per user and deleted on stop/timeout

## iProyal preset from the screenshots

The Android and iOS PWAs preload:

- host: `geo.iproyal.com`
- port: `12321`
- username: `5YzAQaZQMzdWkYTM`
- mode: manual proxy
- location hint: `Kent, GB`
- rotation hint: `Randomize IP`

The password is still manual because the screenshots do not expose the full
value safely enough to hardcode.

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

That means you can deploy the backend to any container host that supports Node
and Puppeteer, for example your own VPS or a managed container platform.

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
3. If `public/runtime-config.js` already points at the hosted backend, the app
   is ready immediately.
4. Paste the full iProyal password.
5. Tap `Connect Backend`.
6. Tap `Test Proxy Setup`.
7. Tap `Launch Browser`.

## API routes

- `GET /api/meta`
- `GET /api/health`
- `GET /api/session`
- `POST /api/proxy/resolve`
- `POST /api/session/start`
- `POST /api/session/navigate`
- `POST /api/session/stop`
- `GET /api/session/screenshot`

## Important notes

- The hosted backend is now shareable across multiple users.
- Session isolation is per installed app, not per login account.
- This is functional multi-user isolation, not a full auth system.
- If you plan to expose the backend widely on the public internet, add your own
  auth, rate limiting, and abuse protection in front of it.
