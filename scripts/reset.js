#!/usr/bin/env node
// Reset script: deletes everything grunt has persisted on this machine so the
// next startup behaves like a fresh install.
//
// Removes:
//   - SQLite DB (grunt.sqlite + WAL/SHM siblings) at the per-OS user data dir
//     (or $GRUNT_DB_PATH if set).
//   - Encrypted secrets store (secrets.enc, secrets.salt) at the per-OS
//     secrets dir (or $GRUNT_SECRETS_DIR if set).
//   - OS keychain entry that protects the secrets file (service "grunt",
//     account "secrets-encryption-key").
//   - REPOS_PATH contents (cloned repos + task logs) when REPOS_PATH is set.
//   - Docker images tagged grunt/runner:* (so the next startup rebuilds).
//
// Prompts y/N by default. Pass --yes to skip the prompt.
//
// Run with: npm run reset    (add "-- --yes" to skip the prompt)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline");

const APP_NAME = "grunt";
const KEYCHAIN_SERVICE = "grunt";
const KEYCHAIN_USERNAME = "secrets-encryption-key";
const RUNNER_IMAGE = "grunt/runner";

function getUserDataDir() {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  const base =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, APP_NAME);
}

function getSecretsDir() {
  if (process.env.GRUNT_SECRETS_DIR) return process.env.GRUNT_SECRETS_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, APP_NAME);
  }
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, APP_NAME);
}

function getDbFilePath() {
  if (process.env.GRUNT_DB_PATH) return process.env.GRUNT_DB_PATH;
  return path.join(getUserDataDir(), "grunt.sqlite");
}

function tryRemove(p) {
  try {
    if (!fs.existsSync(p)) return { path: p, status: "missing" };
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      fs.unlinkSync(p);
    }
    return { path: p, status: "removed" };
  } catch (err) {
    return { path: p, status: "error", error: err.message };
  }
}

function removeKeychainEntry() {
  let Entry;
  try {
    ({ Entry } = require("@napi-rs/keyring"));
  } catch (err) {
    return { status: "error", error: `@napi-rs/keyring unavailable: ${err.message}` };
  }
  try {
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME);
    const existing = entry.getPassword();
    if (!existing) return { status: "missing" };
    entry.deletePassword();
    return { status: "removed" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function removeRunnerImages() {
  // Resolve the set of image IDs tagged grunt/runner:*. Using `docker images`
  // with a reference filter avoids hardcoding tag names — both grunt/runner:latest
  // and grunt/runner:<hash> get matched.
  const list = spawnSync(
    "docker",
    ["images", "--filter", `reference=${RUNNER_IMAGE}`, "-q"],
    { encoding: "utf8" }
  );
  if (list.error) {
    return { status: "skipped", reason: `docker not available: ${list.error.message}` };
  }
  if (list.status !== 0) {
    return { status: "skipped", reason: `docker images exited ${list.status}: ${(list.stderr || "").trim()}` };
  }
  const ids = Array.from(
    new Set(
      (list.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  if (ids.length === 0) return { status: "missing" };
  const rm = spawnSync("docker", ["rmi", "-f", ...ids], { encoding: "utf8" });
  if (rm.status !== 0) {
    return {
      status: "error",
      error: `docker rmi exited ${rm.status}: ${(rm.stderr || rm.stdout || "").trim()}`,
    };
  }
  return { status: "removed", count: ids.length };
}

function summarizeFile(label, result) {
  if (result.status === "removed") return `  [removed] ${label}: ${result.path}`;
  if (result.status === "missing") return `  [skip   ] ${label}: not present (${result.path})`;
  return `  [ERROR  ] ${label}: ${result.path} — ${result.error}`;
}

async function confirm(message) {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;
  if (!process.stdin.isTTY) {
    console.error("stdin is not a TTY — re-run with --yes to skip the confirmation prompt.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(message, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const dbFile = getDbFilePath();
  const secretsDir = getSecretsDir();
  const secretsFile = path.join(secretsDir, "secrets.enc");
  const saltFile = path.join(secretsDir, "secrets.salt");
  const reposPath = process.env.REPOS_PATH || null;

  console.log("This will delete the following grunt state on this machine:");
  console.log(`  - SQLite DB:       ${dbFile} (and -wal/-shm siblings)`);
  console.log(`  - Secrets file:    ${secretsFile}`);
  console.log(`  - Salt file:       ${saltFile}`);
  console.log(`  - Keychain entry:  service="${KEYCHAIN_SERVICE}" account="${KEYCHAIN_USERNAME}"`);
  if (reposPath) {
    console.log(`  - Cloned repos:    ${reposPath} (entire directory)`);
  } else {
    console.log("  - Cloned repos:    (REPOS_PATH not set — skipping)");
  }
  console.log(`  - Docker images:   ${RUNNER_IMAGE}:* (forces rebuild on next startup)`);
  console.log("");

  const ok = await confirm("Proceed? [y/N] ");
  if (!ok) {
    console.log("Aborted.");
    process.exit(1);
  }

  console.log("");
  const results = [];

  results.push(summarizeFile("DB",        tryRemove(dbFile)));
  results.push(summarizeFile("DB (wal)",  tryRemove(`${dbFile}-wal`)));
  results.push(summarizeFile("DB (shm)",  tryRemove(`${dbFile}-shm`)));
  results.push(summarizeFile("Secrets",   tryRemove(secretsFile)));
  results.push(summarizeFile("Salt",      tryRemove(saltFile)));

  const kc = removeKeychainEntry();
  if (kc.status === "removed") results.push(`  [removed] Keychain entry`);
  else if (kc.status === "missing") results.push(`  [skip   ] Keychain entry: not present`);
  else results.push(`  [ERROR  ] Keychain entry — ${kc.error}`);

  if (reposPath) {
    results.push(summarizeFile("Repos dir", tryRemove(reposPath)));
  }

  const dk = removeRunnerImages();
  if (dk.status === "removed") results.push(`  [removed] Docker: deleted ${dk.count} image(s) tagged ${RUNNER_IMAGE}`);
  else if (dk.status === "missing") results.push(`  [skip   ] Docker: no ${RUNNER_IMAGE} images present`);
  else if (dk.status === "skipped") results.push(`  [skip   ] Docker: ${dk.reason}`);
  else results.push(`  [ERROR  ] Docker — ${dk.error}`);

  for (const line of results) console.log(line);
  console.log("");
  console.log("Done. Next `npm start` (or `npm run dev`) will behave like a fresh install.");
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
