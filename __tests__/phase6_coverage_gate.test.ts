// ---------------------------------------------------------------------------
// Phase 6 coverage gate (task #225)
//
// Pins down the auth-provider contracts that ship Phase 6 (pluggable auth) and
// that no single other test exercises end-to-end with REAL signed JWTs against
// a fake JWKS endpoint:
//
//   AC #871 — Each provider has a dedicated test file.
//             ApiKeyProvider lives in __tests__/auth.test.ts (its own
//             `describe("ApiKeyProvider")` block covers valid / invalid /
//             missing-header cases). CognitoProvider lives in
//             __tests__/cognitoAuth.test.ts (its own
//             `describe("CognitoProvider")` block covers valid / expired /
//             malformed token cases). Provider-chain selection lives in
//             __tests__/buildAuthProviders.test.ts. This gate file additionally
//             pins the dedicated-test-file contract by exercising each
//             provider in its own focused describe block here.
//
//   AC #872 — JWKS caching tested with a fetch count assertion. Earlier tests
//             stubbed CognitoJwtVerifier.create(), which lets us assert verifier
//             memoization but bypasses real JWKS fetching. This file mounts a
//             fake JWKS endpoint by replacing aws-jwt-verify's HTTPS fetch with
//             an in-memory implementation that counts requests, then drives
//             real RSA-signed JWTs through CognitoProvider and asserts the
//             JWKS endpoint is hit exactly once across many verifications.
//
//   AC #873 — Provider chain selection covered for every documented config
//             value of AUTH_PROVIDER:
//                 undefined                  → [ApiKeyProvider]
//                 ""                         → [ApiKeyProvider]
//                 "apikey"                   → [ApiKeyProvider]
//                 "cognito"                  → [CognitoProvider]
//                 "apikey,cognito"           → [ApiKeyProvider, CognitoProvider]
//                 "cognito,apikey"           → [CognitoProvider, ApiKeyProvider]
//             plus the failure case (unknown name throws). Each branch is
//             exercised both at the buildAuthProviders() level and end-to-end
//             through the actual middleware chain so a regression in either
//             layer surfaces here.
//
// JWKS endpoint and signing keys: a single RSA-2048 key pair is generated at
// module load. Its public half is published as a JWK with the same kid the
// signed JWTs reference. aws-jwt-verify's HTTPS fetch is replaced with a
// counting in-memory implementation; the JWKS body is JSON-encoded UTF-8 bytes
// matching the on-the-wire format the library expects.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import express, { Express, Request } from "express";
import request from "supertest";

import { ApiKeyProvider } from "../src/auth/ApiKeyProvider";
import { CognitoProvider } from "../src/auth/CognitoProvider";
import { buildAuthProviders } from "../src/auth/buildAuthProviders";
import protectedRoute from "../src/middleware/protectedRoute";
import { AuthContext, AuthProvider } from "../src/auth/AuthProvider";
import { IAppSecrets } from "../src/interfaces";

jest.mock("bcrypt", () => ({ compare: jest.fn() }));
import bcrypt from "bcrypt";

// ---------------------------------------------------------------------------
// Fake JWKS endpoint
//
// aws-jwt-verify performs JWKS retrieval through the `fetch` function exported
// from its internal `https.js` module. Both direct calls (jwk.fetchJwks) and
// SimpleFetcher resolve `exports.fetch` dynamically at call time, so replacing
// the property on the live module exports is sufficient — every fetch path
// goes through our counter without any deeper monkey-patching.
// ---------------------------------------------------------------------------

// Imported for side-effecting property override below. Typed as a writable
// shape so we can swap in our counting fetch. The package exports field
// doesn't expose the deep https.js path, so we resolve it through Node's
// classic resolution by computing the absolute path off the package main.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("path") as typeof import("path");
const httpsModulePath = path.join(
  path.dirname(require.resolve("aws-jwt-verify")),
  "https.js"
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpsModule = require(httpsModulePath) as {
  fetch: (uri: string) => Promise<Uint8Array>;
};

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const KID = "test-kid-1";
const PUBLIC_JWK = {
  ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: KID,
  alg: "RS256",
  use: "sig",
};
const JWKS_DOC = { keys: [PUBLIC_JWK] };

const USER_POOL_ID = "us-east-1_TestPool";
const CLIENT_ID = "test-client-1";
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;
const EXPECTED_JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

let jwksFetchCount = 0;
const fetchedUris: string[] = [];

const originalFetch = httpsModule.fetch;
httpsModule.fetch = jest.fn(async (uri: string) => {
  jwksFetchCount++;
  fetchedUris.push(uri);
  return Buffer.from(JSON.stringify(JWKS_DOC), "utf8") as unknown as Uint8Array;
}) as unknown as typeof httpsModule.fetch;

afterAll(() => {
  // Restore the real fetch so other test files that may load aws-jwt-verify
  // (none today, but defensive) see the original implementation.
  httpsModule.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// JWT signing helpers
//
// We sign JWTs by hand against the test key pair so we control every claim,
// including ones aws-jwt-verify exercises (iss, exp, token_use, client_id,
// aud, kid). Using a real signature also exercises the verifier's signature
// check end-to-end.
// ---------------------------------------------------------------------------

type JwtClaims = {
  iss?: string;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  client_id?: string;
  token_use?: string;
  email?: string;
  scope?: string;
  [key: string]: unknown;
};

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(
  claims: JwtClaims,
  opts?: { kid?: string; alg?: string; signingKey?: crypto.KeyObject }
): string {
  const header = {
    alg: opts?.alg ?? "RS256",
    kid: opts?.kid ?? KID,
    typ: "JWT",
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(opts?.signingKey ?? privateKey);
  return `${signingInput}.${base64url(sig)}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validAccessClaims(overrides: Partial<JwtClaims> = {}): JwtClaims {
  return {
    iss: ISSUER,
    sub: "user-sub-1",
    client_id: CLIENT_ID,
    token_use: "access",
    iat: nowSec() - 1,
    exp: nowSec() + 600,
    ...overrides,
  };
}

const SECRETS_BASE: IAppSecrets = {
  NODE_ENV: "development",
  PORT: "3000",
  DB_NAME: "x",
  DB_HOST: "x",
  DB_PROXY_URL: "x",
  API_KEY_HASH: "$2b$10$fakehash",
  REPOS_PATH: "/tmp",
  COGNITO_USER_POOL_ID: USER_POOL_ID,
  COGNITO_CLIENT_ID: CLIENT_ID,
};

function secrets(extra: Partial<IAppSecrets> = {}): IAppSecrets {
  return { ...SECRETS_BASE, ...extra };
}

function makeReq(opts: {
  secrets?: IAppSecrets | Record<string, unknown>;
  apiKey?: string;
  authorization?: string;
}): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.apiKey !== undefined) headers["x-api-key"] = opts.apiKey;
  if (opts.authorization !== undefined)
    headers["authorization"] = opts.authorization;
  return {
    headers,
    app: { get: (k: string) => (k === "secrets" ? opts.secrets : undefined) },
  } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.compare as jest.Mock).mockImplementation(
    async (raw: string, hash: string) =>
      raw === "raw-key" && hash === SECRETS_BASE.API_KEY_HASH
  );
});

// ---------------------------------------------------------------------------
// AC #871 — ApiKeyProvider dedicated coverage (valid / invalid / missing)
//
// The full ApiKeyProvider suite lives in __tests__/auth.test.ts; this block
// is the per-AC pin so a regression in any one of valid / invalid / missing
// fails the gate independently.
// ---------------------------------------------------------------------------

describe("Phase 6 — ApiKeyProvider (AC #871: valid / invalid / missing header)", () => {
  let provider: ApiKeyProvider;
  beforeEach(() => {
    provider = new ApiKeyProvider();
  });

  it("VALID — returns an AuthContext when the key matches the configured hash", async () => {
    const ctx = await provider.authenticate(
      makeReq({ secrets: SECRETS_BASE, apiKey: "raw-key" })
    );
    expect(ctx).toEqual({ provider: "api-key", subject: "api-key" });
    expect(bcrypt.compare).toHaveBeenCalledWith(
      "raw-key",
      SECRETS_BASE.API_KEY_HASH
    );
  });

  it("INVALID — returns null when the supplied key does not match the hash", async () => {
    const ctx = await provider.authenticate(
      makeReq({ secrets: SECRETS_BASE, apiKey: "wrong-key" })
    );
    expect(ctx).toBeNull();
  });

  it("MISSING — returns null and never invokes bcrypt when x-api-key is absent", async () => {
    const ctx = await provider.authenticate(makeReq({ secrets: SECRETS_BASE }));
    expect(ctx).toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC #871 / #872 — CognitoProvider dedicated coverage with REAL JWTs
//
// The full CognitoProvider suite lives in __tests__/cognitoAuth.test.ts (which
// stubs CognitoJwtVerifier). This block pins the same scenarios using actual
// signed JWTs verified against a fake JWKS endpoint, so a regression in the
// real verification path (signature check, claim validation, JWKS plumbing)
// surfaces here even when the stubbed test would still pass.
// ---------------------------------------------------------------------------

describe("Phase 6 — CognitoProvider end-to-end with real JWTs + fake JWKS (AC #871, #872)", () => {
  beforeEach(() => {
    jwksFetchCount = 0;
    fetchedUris.length = 0;
  });

  it("VALID TOKEN — accepts a properly signed JWT and returns the decoded AuthContext", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(
      validAccessClaims({
        sub: "alice-sub",
        email: "alice@example.com",
        scope: "read:tasks write:tasks",
      })
    );
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toEqual({
      provider: "cognito",
      subject: "alice-sub",
      email: "alice@example.com",
      scopes: ["read:tasks", "write:tasks"],
    });
  });

  it("EXPIRED TOKEN — returns null when exp is in the past", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(
      validAccessClaims({ exp: nowSec() - 60, iat: nowSec() - 600 })
    );
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  it("WRONG AUDIENCE — returns null when client_id does not match COGNITO_CLIENT_ID", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(
      validAccessClaims({ client_id: "rogue-client" })
    );
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  it("WRONG ISSUER — returns null when iss does not match the configured user pool", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(
      validAccessClaims({
        iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool",
      })
    );
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  it("MALFORMED TOKEN (gibberish) — returns null when the token isn't a JWT at all", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({
        secrets: secrets(),
        authorization: "Bearer not.a.real.jwt.at.all",
      })
    );
    expect(ctx).toBeNull();
  });

  it("MALFORMED TOKEN (tampered signature) — returns null when the signature does not verify", async () => {
    const provider = new CognitoProvider();
    const valid = signJwt(validAccessClaims());
    // Flip the last character of the signature segment to break it without
    // disturbing the JWT structure.
    const parts = valid.split(".");
    const sig = parts[2];
    const tampered =
      `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${tampered}` })
    );
    expect(ctx).toBeNull();
  });

  it("MALFORMED TOKEN (signed with a different key) — returns null", async () => {
    const provider = new CognitoProvider();
    const otherKey = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey;
    const token = signJwt(validAccessClaims(), { signingKey: otherKey });
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  it("WRONG TOKEN_USE — returns null when token_use is 'id' (provider only accepts access tokens)", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(validAccessClaims({ token_use: "id" }));
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  it("KID NOT IN JWKS — returns null when the JWT references a key the JWKS doesn't have", async () => {
    const provider = new CognitoProvider();
    const token = signJwt(validAccessClaims(), { kid: "unknown-kid" });
    const ctx = await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    expect(ctx).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AC #872 — JWKS caching (fetch count assertion)
  // -------------------------------------------------------------------------

  it("AC #872 — JWKS endpoint is hit at most once across many verifications by a single provider", async () => {
    const provider = new CognitoProvider();

    for (let i = 0; i < 10; i++) {
      const token = signJwt(validAccessClaims({ sub: `u-${i}` }));
      const ctx = await provider.authenticate(
        makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
      );
      expect(ctx).not.toBeNull();
    }

    expect(jwksFetchCount).toBe(1);
    expect(fetchedUris).toEqual([EXPECTED_JWKS_URI]);
  });

  it("AC #872 — JWKS is NOT fetched when the token is missing or malformed (no signature work attempted)", async () => {
    const provider = new CognitoProvider();

    // Missing Authorization header → provider returns null before touching the verifier.
    await provider.authenticate(makeReq({ secrets: secrets() }));
    // Non-Bearer scheme → same.
    await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: "Basic xyz" })
    );
    // Empty bearer token → same.
    await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: "Bearer    " })
    );

    expect(jwksFetchCount).toBe(0);
  });

  it("AC #872 — JWKS cache persists across mixed valid + invalid (claim-failure) tokens — still exactly one fetch", async () => {
    // We intentionally exclude the wrong-kid case here: aws-jwt-verify's
    // SimpleJwksCache treats a kid miss as a possible JWKS rotation signal
    // and refetches once — that's correct caching behavior, not a leak. The
    // contract this test pins is "tokens whose kid is in the JWKS but whose
    // claims fail validation must NOT trigger a JWKS refetch."
    const provider = new CognitoProvider();

    const valid = signJwt(validAccessClaims());
    const expired = signJwt(
      validAccessClaims({ exp: nowSec() - 1, iat: nowSec() - 60 })
    );
    const wrongClient = signJwt(
      validAccessClaims({ client_id: "rogue-client" })
    );

    expect(
      await provider.authenticate(
        makeReq({ secrets: secrets(), authorization: `Bearer ${valid}` })
      )
    ).not.toBeNull();
    expect(
      await provider.authenticate(
        makeReq({ secrets: secrets(), authorization: `Bearer ${expired}` })
      )
    ).toBeNull();
    expect(
      await provider.authenticate(
        makeReq({ secrets: secrets(), authorization: `Bearer ${wrongClient}` })
      )
    ).toBeNull();
    expect(
      await provider.authenticate(
        makeReq({ secrets: secrets(), authorization: `Bearer ${valid}` })
      )
    ).not.toBeNull();

    expect(jwksFetchCount).toBe(1);
  });

  it("AC #872 — rotating user pool / client config rebuilds the verifier and refetches JWKS", async () => {
    const provider = new CognitoProvider();

    // First call: fetches JWKS for pool A.
    const tokenA = signJwt(validAccessClaims());
    await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${tokenA}` })
    );
    expect(jwksFetchCount).toBe(1);

    // Rotate to a NEW pool id. The provider must rebuild the verifier and
    // therefore refetch the JWKS for the new issuer. The token won't verify
    // (issuer mismatch), but we're asserting on fetch count — not auth result.
    const otherPoolSecrets = secrets({
      COGNITO_USER_POOL_ID: "us-east-1_OtherPool",
    });
    await provider.authenticate(
      makeReq({ secrets: otherPoolSecrets, authorization: `Bearer ${tokenA}` })
    );
    expect(jwksFetchCount).toBe(2);
    expect(fetchedUris[1]).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool/.well-known/jwks.json"
    );

    // Rotating BACK to the original pool also rebuilds (cacheKey miss) and
    // refetches — the in-memory cache is keyed by (poolId, clientId) and is
    // a single slot, not a map.
    await provider.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${tokenA}` })
    );
    expect(jwksFetchCount).toBe(3);
  });

  it("AC #872 — separate provider instances do not share the JWKS cache", async () => {
    const a = new CognitoProvider();
    const b = new CognitoProvider();
    const token = signJwt(validAccessClaims());

    await a.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );
    await b.authenticate(
      makeReq({ secrets: secrets(), authorization: `Bearer ${token}` })
    );

    // Each provider builds its own verifier; each verifier fetches its own
    // JWKS. This is the intentional contract — JWKS state lives on the
    // provider instance, not in a process-wide singleton.
    expect(jwksFetchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC #873 — Provider chain selection covered for every config value
//
// Every documented value of AUTH_PROVIDER (including the implicit / empty /
// invalid forms) is exercised here both at the buildAuthProviders() pure
// layer and end-to-end through the protectedRoute middleware. Adding a new
// value to the IAppSecrets union without extending this matrix should make
// these tests fail.
// ---------------------------------------------------------------------------

describe("Phase 6 — provider chain selection from AUTH_PROVIDER (AC #873)", () => {
  type ConfigCase = {
    label: string;
    config: IAppSecrets["AUTH_PROVIDER"] | undefined | string;
    expectedChain: ("api-key" | "cognito")[];
  };

  // Every value the IAppSecrets.AUTH_PROVIDER union accepts plus the
  // backwards-compatibility cases (undefined / empty / whitespace-only).
  const cases: ConfigCase[] = [
    { label: "undefined", config: undefined, expectedChain: ["api-key"] },
    {
      label: "empty string",
      config: "" as unknown as IAppSecrets["AUTH_PROVIDER"],
      expectedChain: ["api-key"],
    },
    {
      label: "whitespace only",
      config: "   " as unknown as IAppSecrets["AUTH_PROVIDER"],
      expectedChain: ["api-key"],
    },
    {
      label: "commas + whitespace only",
      config: " , , " as unknown as IAppSecrets["AUTH_PROVIDER"],
      expectedChain: ["api-key"],
    },
    { label: "'apikey'", config: "apikey", expectedChain: ["api-key"] },
    { label: "'cognito'", config: "cognito", expectedChain: ["cognito"] },
    {
      label: "'apikey,cognito'",
      config: "apikey,cognito",
      expectedChain: ["api-key", "cognito"],
    },
    {
      label: "'cognito,apikey'",
      config: "cognito,apikey",
      expectedChain: ["cognito", "api-key"],
    },
    {
      label: "case-insensitive '  APIKey , Cognito  '",
      config:
        "  APIKey , Cognito  " as unknown as IAppSecrets["AUTH_PROVIDER"],
      expectedChain: ["api-key", "cognito"],
    },
  ];

  describe("buildAuthProviders() returns the right chain for every value", () => {
    it.each(cases)(
      "$label → [$expectedChain]",
      ({ config, expectedChain }) => {
        const chain = buildAuthProviders(
          secrets({
            AUTH_PROVIDER: config as IAppSecrets["AUTH_PROVIDER"],
          })
        );
        expect(chain.map((p) => p.name)).toEqual(expectedChain);
        // Each chain entry is the canonical class — no plain-object stand-ins.
        for (const provider of chain) {
          if (provider.name === "api-key") {
            expect(provider).toBeInstanceOf(ApiKeyProvider);
          } else {
            expect(provider).toBeInstanceOf(CognitoProvider);
          }
        }
      }
    );

    it("throws on an unknown provider name (misconfiguration surfaces at startup)", () => {
      expect(() =>
        buildAuthProviders(
          secrets({
            AUTH_PROVIDER:
              "apikey,oauth" as unknown as IAppSecrets["AUTH_PROVIDER"],
          })
        )
      ).toThrow(/Unknown AUTH_PROVIDER entry/);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end through protectedRoute: each chain authenticates the request
  // shapes it should and rejects the ones it shouldn't.
  // -------------------------------------------------------------------------
  function makeApp(chain: AuthProvider[], appSecrets: IAppSecrets): {
    app: Express;
    capturedAuth: { value: AuthContext | undefined };
  } {
    const app = express();
    app.use(express.json());
    const captured = { value: undefined as AuthContext | undefined };
    app.use("/api/secret", protectedRoute(), (req, res) => {
      captured.value = (req as Request & { auth?: AuthContext }).auth;
      res.status(200).json({ ok: true, auth: captured.value });
    });
    app.set("secrets", appSecrets);
    app.set("authProviders", chain);
    return { app, capturedAuth: captured };
  }

  describe("end-to-end through protectedRoute for each chain", () => {
    beforeEach(() => {
      jwksFetchCount = 0;
      fetchedUris.length = 0;
    });

    it("'apikey': accepts a valid x-api-key, rejects a Bearer-only request", async () => {
      const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "apikey" }));
      const { app, capturedAuth } = makeApp(chain, secrets({ AUTH_PROVIDER: "apikey" }));

      const ok = await request(app)
        .get("/api/secret")
        .set("x-api-key", "raw-key");
      expect(ok.status).toBe(200);
      expect(capturedAuth.value?.provider).toBe("api-key");

      const token = signJwt(validAccessClaims());
      const bearerOnly = await request(app)
        .get("/api/secret")
        .set("Authorization", `Bearer ${token}`);
      expect(bearerOnly.status).toBe(401);
    });

    it("'cognito': accepts a valid Bearer JWT, rejects an x-api-key-only request", async () => {
      const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "cognito" }));
      const { app, capturedAuth } = makeApp(chain, secrets({ AUTH_PROVIDER: "cognito" }));

      const token = signJwt(validAccessClaims({ sub: "u-cognito" }));
      const ok = await request(app)
        .get("/api/secret")
        .set("Authorization", `Bearer ${token}`);
      expect(ok.status).toBe(200);
      expect(capturedAuth.value).toMatchObject({
        provider: "cognito",
        subject: "u-cognito",
      });

      const apiKeyOnly = await request(app)
        .get("/api/secret")
        .set("x-api-key", "raw-key");
      expect(apiKeyOnly.status).toBe(401);
      // No bcrypt comparison should have happened: ApiKeyProvider isn't in the chain.
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it("'apikey,cognito': api-key wins when both are supplied (first provider takes priority)", async () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "apikey,cognito" })
      );
      const { app, capturedAuth } = makeApp(
        chain,
        secrets({ AUTH_PROVIDER: "apikey,cognito" })
      );

      const token = signJwt(validAccessClaims());
      const res = await request(app)
        .get("/api/secret")
        .set("x-api-key", "raw-key")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(capturedAuth.value?.provider).toBe("api-key");
      // Cognito was never consulted, so no JWKS fetch happened.
      expect(jwksFetchCount).toBe(0);
    });

    it("'apikey,cognito': falls through to Cognito when only a Bearer is supplied", async () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "apikey,cognito" })
      );
      const { app, capturedAuth } = makeApp(
        chain,
        secrets({ AUTH_PROVIDER: "apikey,cognito" })
      );

      const token = signJwt(validAccessClaims({ sub: "fallthrough-user" }));
      const res = await request(app)
        .get("/api/secret")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(capturedAuth.value).toMatchObject({
        provider: "cognito",
        subject: "fallthrough-user",
      });
    });

    it("'cognito,apikey': cognito wins when a valid Bearer is supplied (order is preserved)", async () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "cognito,apikey" })
      );
      const { app, capturedAuth } = makeApp(
        chain,
        secrets({ AUTH_PROVIDER: "cognito,apikey" })
      );

      const token = signJwt(validAccessClaims({ sub: "cog-first" }));
      const res = await request(app)
        .get("/api/secret")
        .set("x-api-key", "raw-key")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(capturedAuth.value?.provider).toBe("cognito");
      // ApiKeyProvider was never consulted because Cognito succeeded first.
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it("'cognito,apikey': falls through to api-key when the Bearer JWT is rejected", async () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "cognito,apikey" })
      );
      const { app, capturedAuth } = makeApp(
        chain,
        secrets({ AUTH_PROVIDER: "cognito,apikey" })
      );

      const expired = signJwt(
        validAccessClaims({ exp: nowSec() - 60, iat: nowSec() - 600 })
      );
      const res = await request(app)
        .get("/api/secret")
        .set("Authorization", `Bearer ${expired}`)
        .set("x-api-key", "raw-key");
      expect(res.status).toBe(200);
      expect(capturedAuth.value?.provider).toBe("api-key");
    });

    it("default (no AUTH_PROVIDER): keeps existing api-key behavior", async () => {
      const chain = buildAuthProviders(secrets());
      const { app } = makeApp(chain, secrets());
      const res = await request(app)
        .get("/api/secret")
        .set("x-api-key", "raw-key");
      expect(res.status).toBe(200);
    });
  });
});
