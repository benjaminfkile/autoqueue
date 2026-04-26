import fs from "fs";
import os from "os";
import path from "path";

// In-memory keychain mock — the real @napi-rs/keyring talks to macOS Keychain
// / Windows Credential Manager / libsecret, which we never want test runs to
// touch. The mock implements just enough of the Entry API for the secrets
// module (get/set/delete password). The backing store hangs off globalThis so
// it survives jest.resetModules() — the mock factory is re-run on reload, but
// the store reference it captures is the same one. The flags object lets
// tests simulate a missing/broken backend (Linux without libsecret, headless
// CI, etc.) by flipping `unavailable` true; every Entry method then throws.
const KEYCHAIN_STORE_KEY = Symbol.for("__grunt_test_keychain_store__");
const KEYCHAIN_FLAGS_KEY = Symbol.for("__grunt_test_keychain_flags__");
(globalThis as any)[KEYCHAIN_STORE_KEY] =
  (globalThis as any)[KEYCHAIN_STORE_KEY] || new Map<string, string>();
(globalThis as any)[KEYCHAIN_FLAGS_KEY] =
  (globalThis as any)[KEYCHAIN_FLAGS_KEY] || { unavailable: false };

jest.mock("@napi-rs/keyring", () => {
  const store: Map<string, string> = (globalThis as any)[KEYCHAIN_STORE_KEY];
  const flags: { unavailable: boolean } = (globalThis as any)[
    KEYCHAIN_FLAGS_KEY
  ];
  function ensureAvailable(): void {
    if (flags.unavailable) {
      throw new Error("Mock keychain backend is unavailable");
    }
  }
  class MockEntry {
    private readonly _key: string;
    constructor(service: string, username: string) {
      this._key = `${service}::${username}`;
    }
    setPassword(password: string): void {
      ensureAvailable();
      store.set(this._key, password);
    }
    getPassword(): string | null {
      ensureAvailable();
      return store.has(this._key) ? (store.get(this._key) as string) : null;
    }
    deleteCredential(): boolean {
      ensureAvailable();
      return store.delete(this._key);
    }
    deletePassword(): boolean {
      ensureAvailable();
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
  ((globalThis as any)[KEYCHAIN_FLAGS_KEY] as {
    unavailable: boolean;
  }).unavailable = false;
}

function setKeychainUnavailable(unavailable: boolean): void {
  ((globalThis as any)[KEYCHAIN_FLAGS_KEY] as {
    unavailable: boolean;
  }).unavailable = unavailable;
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

  test("init() reports keychain as the key source on a healthy backend", () => {
    const result = secrets.init();
    expect(result.source).toBe("keychain");
  });
});

describe("secrets module — passphrase fallback", () => {
  let tmpDir: string;
  let secrets: typeof import("../src/secrets");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-secrets-pw-test-"));
    process.env.GRUNT_SECRETS_DIR = tmpDir;
    process.env.GRUNT_DISABLE_KEYCHAIN = "1";
    delete process.env.GRUNT_MASTER_KEY;
    jest.resetModules();
    resetMockKeychain();
    secrets = require("../src/secrets");
  });

  afterEach(() => {
    delete process.env.GRUNT_SECRETS_DIR;
    delete process.env.GRUNT_DISABLE_KEYCHAIN;
    delete process.env.GRUNT_MASTER_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("init() falls back to passphrase mode when GRUNT_DISABLE_KEYCHAIN is set", () => {
    process.env.GRUNT_MASTER_KEY = "correct horse battery staple";
    const result = secrets.init();
    expect(result.generated).toBe(true);
    expect(result.source).toBe("passphrase");
    expect(fs.existsSync(path.join(tmpDir, "secrets.salt"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "secrets.enc"))).toBe(true);
    // Salt is the actual random bytes — sanity check on length.
    expect(fs.readFileSync(path.join(tmpDir, "secrets.salt")).length).toBe(16);
  });

  test("init() detects a thrown keychain error and falls back cleanly", () => {
    delete process.env.GRUNT_DISABLE_KEYCHAIN;
    setKeychainUnavailable(true);
    process.env.GRUNT_MASTER_KEY = "headless-fallback-pw";
    const result = secrets.init();
    expect(result.source).toBe("passphrase");
    expect(fs.existsSync(path.join(tmpDir, "secrets.salt"))).toBe(true);
  });

  test("GRUNT_MASTER_KEY env var path works end-to-end without interaction", () => {
    process.env.GRUNT_MASTER_KEY = "non-interactive-key";
    const promptSpy = jest.fn(() => "should-not-be-called");
    secrets._setPassphrasePromptForTests(promptSpy);

    secrets.init();
    secrets.set("ANTHROPIC_API_KEY", "sk-ant-via-env");
    expect(secrets.get("ANTHROPIC_API_KEY")).toBe("sk-ant-via-env");
    expect(promptSpy).not.toHaveBeenCalled();
  });

  test("interactive prompt is called only when no env var and keychain is unavailable", () => {
    delete process.env.GRUNT_MASTER_KEY;
    const promptSpy = jest.fn(() => "interactive-pw");
    secrets._setPassphrasePromptForTests(promptSpy);

    secrets.init();
    expect(promptSpy).toHaveBeenCalledTimes(1);
    secrets.set("k", "v");
    expect(secrets.get("k")).toBe("v");
  });

  test("interactive prompt is NOT called when keychain is available", () => {
    delete process.env.GRUNT_DISABLE_KEYCHAIN;
    setKeychainUnavailable(false);
    delete process.env.GRUNT_MASTER_KEY;
    jest.resetModules();
    const fresh = require("../src/secrets") as typeof import("../src/secrets");

    const promptSpy = jest.fn(() => "should-not-be-called");
    fresh._setPassphrasePromptForTests(promptSpy);

    const result = fresh.init();
    expect(result.source).toBe("keychain");
    expect(promptSpy).not.toHaveBeenCalled();
  });

  test("interactive prompt is NOT called when GRUNT_MASTER_KEY is set", () => {
    process.env.GRUNT_MASTER_KEY = "env-wins";
    const promptSpy = jest.fn(() => "should-not-be-called");
    secrets._setPassphrasePromptForTests(promptSpy);

    secrets.init();
    secrets.set("k", "v");
    expect(secrets.get("k")).toBe("v");
    expect(promptSpy).not.toHaveBeenCalled();
  });

  test("passphrase mode round-trip: set then get returns the same value", () => {
    process.env.GRUNT_MASTER_KEY = "round-trip-key";
    secrets.init();
    secrets.set("ANTHROPIC_API_KEY", "sk-ant-pw-mode");
    expect(secrets.get("ANTHROPIC_API_KEY")).toBe("sk-ant-pw-mode");
  });

  test("passphrase mode persists across module reloads (uses salt+pw, not memory)", () => {
    process.env.GRUNT_MASTER_KEY = "persist-across-reload";
    secrets.init();
    secrets.set("GH_PAT", "ghp_pw_xyz");

    jest.resetModules();
    const reloaded = require("../src/secrets") as typeof import("../src/secrets");
    expect(reloaded.get("GH_PAT")).toBe("ghp_pw_xyz");
  });

  test("init() is idempotent in passphrase mode (salt file pins the mode)", () => {
    process.env.GRUNT_MASTER_KEY = "idempotent-pw";
    expect(secrets.init().generated).toBe(true);
    secrets.set("k", "v");
    const second = secrets.init();
    expect(second.generated).toBe(false);
    expect(second.source).toBe("passphrase");
    expect(secrets.get("k")).toBe("v");
  });

  test("wrong passphrase fails decryption (GCM auth tag rejects derived key)", () => {
    process.env.GRUNT_MASTER_KEY = "right-pw";
    secrets.init();
    secrets.set("k", "v");

    process.env.GRUNT_MASTER_KEY = "wrong-pw";
    jest.resetModules();
    const reloaded = require("../src/secrets") as typeof import("../src/secrets");
    expect(() => reloaded.get("k")).toThrow();
  });

  test("file on disk is encrypted in passphrase mode (no plaintext key or value)", () => {
    process.env.GRUNT_MASTER_KEY = "encrypts-on-disk";
    secrets.init();
    const sentinelKey = "PLAINTEXT_KEY_SENTINEL";
    const sentinelVal = "PLAINTEXT_VALUE_SENTINEL_xyz123";
    secrets.set(sentinelKey, sentinelVal);

    const blob = fs.readFileSync(path.join(tmpDir, "secrets.enc"));
    expect(blob.toString("utf8")).not.toContain(sentinelKey);
    expect(blob.toString("utf8")).not.toContain(sentinelVal);
    expect(blob.toString("latin1")).not.toContain(sentinelKey);
    expect(blob.toString("latin1")).not.toContain(sentinelVal);
  });

  test("get/set/unset throw when init() has not been called in passphrase mode", () => {
    process.env.GRUNT_MASTER_KEY = "no-init";
    expect(() => secrets.get("x")).toThrow(/not initialized/);
    expect(() => secrets.set("x", "y")).toThrow(/not initialized/);
    expect(() => secrets.unset("x")).toThrow(/not initialized/);
  });

  test("empty GRUNT_MASTER_KEY is rejected", () => {
    process.env.GRUNT_MASTER_KEY = "";
    expect(() => secrets.init()).toThrow(/GRUNT_MASTER_KEY/);
  });

  test("no env var, no prompt override, no TTY → throws a helpful error", () => {
    delete process.env.GRUNT_MASTER_KEY;
    // No prompt override, and jest's stdin is not a TTY in normal test runs.
    if (process.stdin.isTTY) {
      // Skip when the suite is somehow attached to a TTY (e.g. local debug).
      return;
    }
    expect(() => secrets.init()).toThrow(/TTY|GRUNT_MASTER_KEY/);
  });
});
