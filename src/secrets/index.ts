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
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

export interface InitResult {
  generated: boolean;
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

function getKeychainEntry(): Entry {
  return new Entry(SERVICE_NAME, KEY_USERNAME);
}

function loadEncryptionKey(): Buffer {
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

// Bootstraps the secrets store. Generates a random 32-byte encryption key and
// writes it to the OS keychain on first call; subsequent calls are no-ops so
// callers can invoke init() unconditionally on app startup.
export function init(): InitResult {
  const entry = getKeychainEntry();
  const existing = entry.getPassword();
  if (existing) {
    return { generated: false };
  }
  const key = crypto.randomBytes(KEY_BYTES);
  entry.setPassword(key.toString("base64"));
  writeSecretsBlob(key, {});
  return { generated: true };
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
