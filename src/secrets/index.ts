import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Entry } from "@napi-rs/keyring";

// Service name used when storing the file-encryption key in the OS keychain
// (macOS Keychain / Windows Credential Manager / Linux libsecret). The username
// distinguishes this credential from any future grunt-owned keychain entries.
export const SERVICE_NAME = "grunt";
export const KEY_USERNAME = "secrets-encryption-key";

const SECRETS_FILENAME = "secrets.enc";
const SALT_FILENAME = "secrets.salt";
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

// scrypt cost parameters. N=2^15 gives ~50–100 ms per derivation on modern
// hardware, which is high enough to deter offline brute-force on the salt
// file while staying snappy at app startup.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// scryptSync's default maxmem is 32 MB and rejects N=2^15. Bump it just enough
// to fit our params with headroom.
const SCRYPT_MAXMEM = 256 * SCRYPT_N * SCRYPT_R;

export type KeySource = "keychain" | "passphrase";

export interface InitResult {
  generated: boolean;
  source: KeySource;
}

// Returns the directory where the encrypted secrets file lives. Honors
// GRUNT_SECRETS_DIR for tests and ad-hoc tooling so the suite never touches
// the user's real data dir.
export function getSecretsDir(): string {
  if (process.env.GRUNT_SECRETS_DIR) {
    return process.env.GRUNT_SECRETS_DIR;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "grunt");
  }
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "grunt");
  }
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "grunt");
}

export function getSecretsFilePath(): string {
  return path.join(getSecretsDir(), SECRETS_FILENAME);
}

function getSaltFilePath(): string {
  return path.join(getSecretsDir(), SALT_FILENAME);
}

function getKeychainEntry(): Entry {
  return new Entry(SERVICE_NAME, KEY_USERNAME);
}

// Probes the keychain backend by attempting to read our entry. On systems
// without a working backend (Linux without libsecret, sandboxed CI, etc.)
// the call throws; on systems where the backend works but no entry exists,
// it returns null. Either of those non-throwing outcomes counts as available.
function isKeychainAvailable(): boolean {
  if (process.env.GRUNT_DISABLE_KEYCHAIN === "1") {
    return false;
  }
  try {
    getKeychainEntry().getPassword();
    return true;
  } catch {
    return false;
  }
}

// Module-level cache for passphrase-derived keys so we only prompt once per
// process. Cleared by init() and by the test hook below.
let cachedPassphraseKey: Buffer | null = null;
let passphrasePromptOverride: (() => string) | null = null;

// Test hook: lets tests inject a synchronous prompt without driving a real
// TTY. Exposing this as part of the module API is preferable to dependency
// injection through every call site, which would force callers (and existing
// tests) to thread a passphrase source argument through.
export function _setPassphrasePromptForTests(
  fn: (() => string) | null
): void {
  passphrasePromptOverride = fn;
  cachedPassphraseKey = null;
}

function readPassphrase(): string {
  const env = process.env.GRUNT_MASTER_KEY;
  if (env !== undefined) {
    if (env.length === 0) {
      throw new Error("GRUNT_MASTER_KEY is set but empty.");
    }
    return env;
  }
  if (passphrasePromptOverride) {
    const v = passphrasePromptOverride();
    if (!v) {
      throw new Error("Interactive passphrase prompt returned an empty value.");
    }
    return v;
  }
  return promptInteractively("Enter grunt master passphrase: ");
}

// Synchronous TTY passphrase prompt with echo suppressed. Runs at startup,
// so a blocking read is acceptable (and far simpler than threading async
// through init/get/set/unset).
function promptInteractively(prompt: string): string {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Keychain unavailable and stdin is not a TTY — set GRUNT_MASTER_KEY to provide a passphrase."
    );
  }
  const stdin = process.stdin as NodeJS.ReadStream;
  const fd = (stdin as unknown as { fd?: number }).fd ?? 0;
  process.stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  try {
    stdin.setRawMode(true);
    const buf = Buffer.alloc(1);
    let result = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf[0];
      if (ch === 3) {
        // Ctrl-C
        process.stdout.write("\n");
        throw new Error("Passphrase entry aborted.");
      }
      if (ch === 13 || ch === 10) break; // CR / LF
      if (ch === 127 || ch === 8) {
        // Backspace / DEL
        result = result.slice(0, -1);
        continue;
      }
      result += String.fromCharCode(ch);
    }
    if (result.length === 0) {
      throw new Error("Empty passphrase rejected.");
    }
    return result;
  } finally {
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* not all environments allow toggling raw mode back */
    }
    process.stdout.write("\n");
  }
}

function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

function loadPassphraseKey(): Buffer {
  if (cachedPassphraseKey) return cachedPassphraseKey;
  const salt = fs.readFileSync(getSaltFilePath());
  const passphrase = readPassphrase();
  const key = deriveKeyFromPassphrase(passphrase, salt);
  cachedPassphraseKey = key;
  return key;
}

function loadKeychainKey(): Buffer {
  const stored = getKeychainEntry().getPassword();
  if (!stored) {
    throw new Error(
      "Secrets store not initialized — call init() before get/set/unset."
    );
  }
  const key = Buffer.from(stored, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Invalid encryption key length in keychain: expected ${KEY_BYTES} bytes, got ${key.length}.`
    );
  }
  return key;
}

function loadEncryptionKey(): Buffer {
  // Salt file is the marker for passphrase mode — its presence pins the store
  // to the passphrase path even if the keychain becomes available later.
  if (fs.existsSync(getSaltFilePath())) {
    return loadPassphraseKey();
  }
  let keychainEntryExists = false;
  try {
    keychainEntryExists = getKeychainEntry().getPassword() !== null;
  } catch {
    keychainEntryExists = false;
  }
  if (!keychainEntryExists) {
    throw new Error(
      "Secrets store not initialized — call init() before get/set/unset."
    );
  }
  return loadKeychainKey();
}

function readSecretsBlob(key: Buffer): Record<string, string> {
  const filePath = getSecretsFilePath();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const blob = fs.readFileSync(filePath);
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Secrets file is corrupt or truncated.");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Secrets file does not contain a JSON object.");
  }
  return parsed as Record<string, string>;
}

function writeSecretsBlob(key: Buffer, data: Record<string, string>): void {
  const filePath = getSecretsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [12-byte IV][16-byte GCM tag][ciphertext]. Storing IV+tag inline
  // means each write is self-contained; nothing else needs to know the layout.
  const blob = Buffer.concat([iv, tag, ciphertext]);
  fs.writeFileSync(filePath, blob, { mode: 0o600 });
}

// Bootstraps the secrets store. On first call: if the OS keychain is usable,
// generates a 32-byte random key and stores it there; otherwise falls back to
// deriving a key from a passphrase (GRUNT_MASTER_KEY env var or interactive
// prompt) plus a freshly generated salt persisted to disk. Subsequent calls
// detect the existing setup (salt file ⇒ passphrase mode, keychain entry ⇒
// keychain mode) and return without re-initializing, so callers can invoke
// init() unconditionally on app startup.
export function init(): InitResult {
  cachedPassphraseKey = null;
  const saltPath = getSaltFilePath();
  if (fs.existsSync(saltPath)) {
    return { generated: false, source: "passphrase" };
  }
  if (isKeychainAvailable()) {
    const entry = getKeychainEntry();
    const existing = entry.getPassword();
    if (existing) {
      return { generated: false, source: "keychain" };
    }
    const key = crypto.randomBytes(KEY_BYTES);
    entry.setPassword(key.toString("base64"));
    writeSecretsBlob(key, {});
    return { generated: true, source: "keychain" };
  }
  // Passphrase fallback path.
  const passphrase = readPassphrase();
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  fs.mkdirSync(path.dirname(saltPath), { recursive: true });
  fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  writeSecretsBlob(key, {});
  cachedPassphraseKey = key;
  return { generated: true, source: "passphrase" };
}

export function get(key: string): string | undefined {
  const encKey = loadEncryptionKey();
  const data = readSecretsBlob(encKey);
  return data[key];
}

export function set(key: string, value: string): void {
  const encKey = loadEncryptionKey();
  const data = readSecretsBlob(encKey);
  data[key] = value;
  writeSecretsBlob(encKey, data);
}

export function unset(key: string): void {
  const encKey = loadEncryptionKey();
  const data = readSecretsBlob(encKey);
  delete data[key];
  writeSecretsBlob(encKey, data);
}
