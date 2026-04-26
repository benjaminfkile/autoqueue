import fs from "fs";
import os from "os";
import path from "path";

// In-memory keychain mock — the real @napi-rs/keyring talks to macOS Keychain
// / Windows Credential Manager / libsecret, which we never want test runs to
// touch. The mock implements just enough of the Entry API for the secrets
// module (get/set/delete password). The backing store hangs off globalThis so
// it survives jest.resetModules() — the mock factory is re-run on reload, but
// the store reference it captures is the same one.
const KEYCHAIN_STORE_KEY = Symbol.for("__grunt_test_keychain_store__");
(globalThis as any)[KEYCHAIN_STORE_KEY] =
  (globalThis as any)[KEYCHAIN_STORE_KEY] || new Map<string, string>();

jest.mock("@napi-rs/keyring", () => {
  const store: Map<string, string> = (globalThis as any)[KEYCHAIN_STORE_KEY];
  class MockEntry {
    private readonly _key: string;
    constructor(service: string, username: string) {
      this._key = `${service}::${username}`;
    }
    setPassword(password: string): void {
      store.set(this._key, password);
    }
    getPassword(): string | null {
      return store.has(this._key) ? (store.get(this._key) as string) : null;
    }
    deleteCredential(): boolean {
      return store.delete(this._key);
    }
    deletePassword(): boolean {
      return store.delete(this._key);
    }
  }
  return {
    Entry: MockEntry,
    AsyncEntry: MockEntry,
    findCredentials: () => [],
  };
});

function resetMockKeychain(): void {
  ((globalThis as any)[KEYCHAIN_STORE_KEY] as Map<string, string>).clear();
}

describe("secrets module", () => {
  let tmpDir: string;
  let secrets: typeof import("../src/secrets");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-secrets-test-"));
    process.env.GRUNT_SECRETS_DIR = tmpDir;
    jest.resetModules();
    resetMockKeychain();
    secrets = require("../src/secrets");
  });

  afterEach(() => {
    delete process.env.GRUNT_SECRETS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exposes init / get / set / unset", () => {
    expect(typeof secrets.init).toBe("function");
    expect(typeof secrets.get).toBe("function");
    expect(typeof secrets.set).toBe("function");
    expect(typeof secrets.unset).toBe("function");
  });

  test("init() generates a key and creates the encrypted file", () => {
    const result = secrets.init();
    expect(result.generated).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "secrets.enc"))).toBe(true);
  });

  test("init() is idempotent", () => {
    expect(secrets.init().generated).toBe(true);
    secrets.set("k", "v");
    expect(secrets.init().generated).toBe(false);
    expect(secrets.get("k")).toBe("v");
  });

  test("round-trip: set then get returns the same value", () => {
    secrets.init();
    secrets.set("ANTHROPIC_API_KEY", "sk-ant-abc-123");
    expect(secrets.get("ANTHROPIC_API_KEY")).toBe("sk-ant-abc-123");
  });

  test("set() persists across module reloads (uses the file, not memory)", () => {
    secrets.init();
    secrets.set("GH_PAT", "ghp_xyz");

    jest.resetModules();
    const reloaded = require("../src/secrets") as typeof import("../src/secrets");
    expect(reloaded.get("GH_PAT")).toBe("ghp_xyz");
  });

  test("unset() removes the value", () => {
    secrets.init();
    secrets.set("foo", "bar");
    secrets.unset("foo");
    expect(secrets.get("foo")).toBeUndefined();
  });

  test("get() returns undefined for unknown keys", () => {
    secrets.init();
    expect(secrets.get("nope")).toBeUndefined();
  });

  test("file on disk is encrypted (no plaintext key or value)", () => {
    secrets.init();
    const sentinelKey = "PLAINTEXT_KEY_SENTINEL";
    const sentinelVal = "PLAINTEXT_VALUE_SENTINEL_xyz123";
    secrets.set(sentinelKey, sentinelVal);

    const blob = fs.readFileSync(path.join(tmpDir, "secrets.enc"));
    const asUtf8 = blob.toString("utf8");
    const asLatin1 = blob.toString("latin1");
    expect(asUtf8).not.toContain(sentinelKey);
    expect(asUtf8).not.toContain(sentinelVal);
    expect(asLatin1).not.toContain(sentinelKey);
    expect(asLatin1).not.toContain(sentinelVal);
  });

  test("get/set/unset throw when init() has not been called", () => {
    expect(() => secrets.get("x")).toThrow(/not initialized/);
    expect(() => secrets.set("x", "y")).toThrow(/not initialized/);
    expect(() => secrets.unset("x")).toThrow(/not initialized/);
  });

  test("encryption key stored under the grunt service name", () => {
    secrets.init();
    const { Entry } = require("@napi-rs/keyring");
    const entry = new Entry(secrets.SERVICE_NAME, secrets.KEY_USERNAME);
    const stored = entry.getPassword();
    expect(stored).toBeTruthy();
    expect(Buffer.from(stored, "base64").length).toBe(32);
  });

  test("getSecretsFilePath() lives inside the OS-appropriate user data dir", () => {
    delete process.env.GRUNT_SECRETS_DIR;
    jest.resetModules();
    const reloaded = require("../src/secrets") as typeof import("../src/secrets");
    const filePath = reloaded.getSecretsFilePath();
    expect(path.basename(filePath)).toBe("secrets.enc");
    if (process.platform === "darwin") {
      expect(filePath).toContain(
        path.join("Library", "Application Support", "grunt")
      );
    } else if (process.platform === "win32") {
      expect(filePath.toLowerCase()).toContain(`${path.sep}grunt${path.sep}`.toLowerCase());
    } else {
      expect(filePath).toMatch(
        new RegExp(`${path.sep}grunt${path.sep}secrets\\.enc$`)
      );
    }
  });

  test("tampering with the ciphertext is detected (GCM auth tag)", () => {
    secrets.init();
    secrets.set("k", "v");
    const filePath = path.join(tmpDir, "secrets.enc");
    const blob = fs.readFileSync(filePath);
    // Flip a byte inside the ciphertext region.
    blob[blob.length - 1] ^= 0xff;
    fs.writeFileSync(filePath, blob);
    expect(() => secrets.get("k")).toThrow();
  });
});
