import { spawn } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "desktop-dist");
const UNPACKED_DIR = path.join(DIST_DIR, "win-unpacked");
const ROOT_CONFIG = path.join(PROJECT_ROOT, "proxy-browser.desktop.json");
const EXAMPLE_CONFIG = path.join(PROJECT_ROOT, "proxy-browser.desktop.example.json");
const BUNDLED_CONFIG = path.join(UNPACKED_DIR, "proxy-browser.desktop.json");
const ZIP_BUNDLE = path.join(DIST_DIR, "proxy-browser-desktop-bundle.zip");

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: false,
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });

    child.once("error", reject);
  });
}

function generatedConfigFromEnv() {
  const password = process.env.DESKTOP_PROXY_PASSWORD || process.env.DEFAULT_PROXY_PASSWORD || "";

  if (!password) {
    return null;
  }

  return JSON.stringify(
    {
      defaultTargetUrl: process.env.DESKTOP_DEFAULT_URL || "https://www.google.com",
      browserPath: process.env.DESKTOP_BROWSER_PATH || "",
      proxy: {
        protocol: process.env.DESKTOP_PROXY_PROTOCOL || process.env.DEFAULT_PROXY_PROTOCOL || "http",
        host: process.env.DESKTOP_PROXY_HOST || process.env.DEFAULT_PROXY_HOST || "geo.iproyal.com",
        port: process.env.DESKTOP_PROXY_PORT || process.env.DEFAULT_PROXY_PORT || "12321",
        username:
          process.env.DESKTOP_PROXY_USERNAME ||
          process.env.DEFAULT_PROXY_USERNAME ||
          "5YzAQaZQMzdWkYTM",
        password,
        bypass:
          process.env.DESKTOP_PROXY_BYPASS ||
          process.env.DEFAULT_PROXY_BYPASS ||
          "localhost;127.0.0.1;<local>",
      },
    },
    null,
    2
  );
}

async function resolveConfigContent() {
  if (fsSync.existsSync(ROOT_CONFIG)) {
    return fs.readFile(ROOT_CONFIG, "utf8");
  }

  const fromEnv = generatedConfigFromEnv();

  if (fromEnv) {
    return fromEnv;
  }

  return fs.readFile(EXAMPLE_CONFIG, "utf8");
}

async function main() {
  await runProcess("npx.cmd", ["electron-builder", "--win", "dir"]);
  await fs.mkdir(UNPACKED_DIR, { recursive: true });

  const configContent = await resolveConfigContent();
  await fs.writeFile(BUNDLED_CONFIG, configContent, "utf8");
  await fs.rm(ZIP_BUNDLE, { force: true }).catch(() => {});

  await runProcess("powershell.exe", [
    "-Command",
    `Compress-Archive -Path '${UNPACKED_DIR}' -DestinationPath '${ZIP_BUNDLE}' -Force`,
  ]);

  console.log(`Desktop bundle ready: ${ZIP_BUNDLE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
