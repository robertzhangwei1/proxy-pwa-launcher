# Proxy PWA Launcher

This project is now set up for a GitHub-friendly distribution model:

- GitHub Pages hosts the installable Android and iOS PWAs
- A separate backend helper hosts the API and launches Chromium with Puppeteer
- The installed PWA lets you enter the backend helper URL and then controls it

## Important runtime split

GitHub can host the PWA files, but GitHub Pages cannot run the Puppeteer
backend. That means the full setup has two parts:

1. `Frontend`
   - static PWA files from `public/`
   - can be deployed to GitHub Pages
2. `Backend`
   - `server.js`
   - must run on a machine or server you control
   - must be reachable from the phone over HTTP or HTTPS

## What is ready now

- Separate install targets:
  - `android.html`
  - `ios.html`
- Relative asset paths so the app works from a GitHub Pages repo path
- GitHub Pages workflow at:
  - `.github/workflows/deploy-proxy-pwa-pages.yml`
- Backend helper URL field inside the PWA
- CORS enabled on the backend so a Pages-hosted PWA can call the helper API

## iProyal preset from your screenshots

The PWA preloads these values:

- host: `geo.iproyal.com`
- port: `12321`
- username: `5YzAQaZQMzdWkYTM`
- mode: manual proxy
- location hint: `Kent, GB`
- rotation hint: `Randomize IP`

The password is still manual because the screenshots do not reveal the full
value safely enough to hardcode.

## One-tap helpers added

Both Android and iOS PWAs now include:

- `Copy Host`
- `Copy Port`
- `Copy Username`
- `Paste Password`
- `Copy Proxy URL`

## Publish the PWA to GitHub Pages

1. Put this code in a GitHub repo.
2. Make sure your default branch is `main`.
3. In GitHub, enable Pages for the repository.
4. The workflow in `.github/workflows/deploy-proxy-pwa-pages.yml` will publish
   `paradex-ui-bot-copy/proxy-pwa-launcher/public`.

After deployment, your Pages URLs will be:

- `https://<your-user>.github.io/<repo>/`
- `https://<your-user>.github.io/<repo>/android.html`
- `https://<your-user>.github.io/<repo>/ios.html`

## Run the backend helper

From:

`C:\Users\rober\Documents\New project\paradex-ui-bot-copy\proxy-pwa-launcher`

run:

```powershell
node server.js
```

If you want to use the PWA from GitHub Pages, the backend must be reachable from
the phone. The PWA will ask for a backend helper URL such as:

- `https://your-helper.example.com`
- `http://192.168.1.20:4317`

## Install and use on phone

1. Open the GitHub Pages Android or iOS URL on your phone.
2. Install that page as a PWA.
3. Enter the backend helper URL.
4. Tap `Connect Backend`.
5. Paste the full iProyal password.
6. Tap `Test Proxy Setup`.
7. Tap `Launch Browser`.

## Local same-origin mode

If you open `android.html` or `ios.html` directly from the backend helper
server, the backend URL field defaults to the current origin automatically.

## Routes

Frontend:

- `/`
- `/android.html`
- `/ios.html`

Backend:

- `/api/meta`
- `/api/proxy/resolve`
- `/api/session/start`
- `/api/session/navigate`
- `/api/session/screenshot`
- `/api/session/stop`

## Notes

- GitHub Pages makes the installable PWA easy to distribute.
- The actual proxied browsing still happens in the backend Chromium session.
- Passwords and API keys are not stored in local storage.
