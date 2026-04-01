# Publish To GitHub

## 1. Create a new repo

Suggested name:

- `proxy-pwa-launcher`

## 2. Initialize and commit

From this folder:

`C:\Users\rober\Documents\New project\proxy-pwa-launcher-github-repo`

run:

```powershell
git init
git add .
git commit -m "Initial proxy PWA launcher"
```

## 3. Push to GitHub

Use one of these safe methods:

### Option A: GitHub CLI with browser login

```powershell
gh auth login
gh repo create proxy-pwa-launcher --public --source . --remote origin --push
```

### Option B: GitHub website + Git remote

Create an empty repo on GitHub, then run:

```powershell
git branch -M main
git remote add origin https://github.com/<your-user>/proxy-pwa-launcher.git
git push -u origin main
```

GitHub will ask for a personal access token if you use HTTPS.

## 4. Enable GitHub Pages

The workflow in `.github/workflows/deploy-proxy-pwa-pages.yml` will publish the
`public/` folder.

After the action finishes, the install URLs will be:

- `https://<your-user>.github.io/proxy-pwa-launcher/android.html`
- `https://<your-user>.github.io/proxy-pwa-launcher/ios.html`

## 5. Run the backend helper

The PWA still needs the backend helper running somewhere reachable by the phone:

```powershell
npm install
node server.js
```

Then open the PWA on the phone, enter the backend helper URL, and connect.
