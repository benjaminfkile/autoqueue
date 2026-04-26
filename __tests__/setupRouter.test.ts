import request from "supertest";

jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock("../src/db/health", () => ({
  __esModule: true,
  default: {
    getDBConnectionHealth: jest.fn().mockResolvedValue({
      connected: true,
      connectionUsesProxy: false,
    }),
  },
}));

jest.mock("../src/secrets", () => ({
  get: jest.fn(),
  set: jest.fn(),
  unset: jest.fn(),
  init: jest.fn(),
  getSecretsFilePath: jest.fn(),
}));

import app from "../src/app";
import * as secrets from "../src/secrets";

const getMock = secrets.get as jest.Mock;
const setMock = secrets.set as jest.Mock;
const unsetMock = secrets.unset as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("setupRouter GET /api/setup", () => {
  it("reports ready=false when neither secret is configured", async () => {
    getMock.mockReturnValue(undefined);

    const res = await request(app).get("/api/setup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: false,
      configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
    });
  });

  it("reports ready=true when every required secret is non-empty", async () => {
    getMock.mockImplementation((key: string) => {
      if (key === "ANTHROPIC_API_KEY") return "sk-test";
      if (key === "GH_PAT") return "ghp_test";
      return undefined;
    });

    const res = await request(app).get("/api/setup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: true,
      configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
    });
  });

  it("treats empty strings as not configured", async () => {
    getMock.mockImplementation((key: string) =>
      key === "ANTHROPIC_API_KEY" ? "" : "ghp_test"
    );

    const res = await request(app).get("/api/setup");

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.configured.ANTHROPIC_API_KEY).toBe(false);
    expect(res.body.configured.GH_PAT).toBe(true);
  });

  it("returns 500 when secrets.get throws", async () => {
    getMock.mockImplementation(() => {
      throw new Error("keychain locked");
    });

    const res = await request(app).get("/api/setup");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/keychain locked/);
  });
});

describe("setupRouter POST /api/setup", () => {
  it("rejects payloads missing ANTHROPIC_API_KEY", async () => {
    const res = await request(app)
      .post("/api/setup")
      .send({ GH_PAT: "ghp_test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects payloads missing GH_PAT", async () => {
    const res = await request(app)
      .post("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GH_PAT/);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects empty/whitespace values", async () => {
    const res = await request(app)
      .post("/api/setup")
      .send({ ANTHROPIC_API_KEY: "   ", GH_PAT: "ghp_test" });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects non-string values", async () => {
    const res = await request(app)
      .post("/api/setup")
      .send({ ANTHROPIC_API_KEY: 42, GH_PAT: "ghp_test" });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("stores both secrets and returns ready status on success", async () => {
    getMock.mockImplementation((key: string) => {
      if (key === "ANTHROPIC_API_KEY") return "sk-test";
      if (key === "GH_PAT") return "ghp_test";
      return undefined;
    });

    const res = await request(app)
      .post("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-test", GH_PAT: "ghp_test" });

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(setMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-test");
    expect(setMock).toHaveBeenCalledWith("GH_PAT", "ghp_test");
  });

  it("trims whitespace before storing", async () => {
    getMock.mockReturnValue("ok");

    await request(app)
      .post("/api/setup")
      .send({
        ANTHROPIC_API_KEY: "  sk-test  ",
        GH_PAT: "\tghp_test\n",
      });

    expect(setMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-test");
    expect(setMock).toHaveBeenCalledWith("GH_PAT", "ghp_test");
  });

  it("returns 500 with the error message when secrets.set throws", async () => {
    setMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await request(app)
      .post("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-test", GH_PAT: "ghp_test" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disk full/);
  });
});

describe("setupRouter PATCH /api/setup", () => {
  it("updates a single secret without requiring the others", async () => {
    getMock.mockImplementation((key: string) => {
      if (key === "ANTHROPIC_API_KEY") return "sk-new";
      if (key === "GH_PAT") return "ghp_existing";
      return undefined;
    });

    const res = await request(app)
      .patch("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-new" });

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-new");
  });

  it("updates both secrets when both are provided", async () => {
    getMock.mockReturnValue("ok");

    const res = await request(app)
      .patch("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-new", GH_PAT: "ghp_new" });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-new");
    expect(setMock).toHaveBeenCalledWith("GH_PAT", "ghp_new");
  });

  it("trims whitespace before storing", async () => {
    getMock.mockReturnValue("ok");

    await request(app)
      .patch("/api/setup")
      .send({ GH_PAT: "  ghp_new  " });

    expect(setMock).toHaveBeenCalledWith("GH_PAT", "ghp_new");
  });

  it("rejects empty strings on provided keys", async () => {
    const res = await request(app)
      .patch("/api/setup")
      .send({ ANTHROPIC_API_KEY: "   " });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects non-string values on provided keys", async () => {
    const res = await request(app)
      .patch("/api/setup")
      .send({ GH_PAT: 42 });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects empty payloads", async () => {
    const res = await request(app).patch("/api/setup").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one secret/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("ignores unknown keys", async () => {
    getMock.mockReturnValue("ok");

    const res = await request(app)
      .patch("/api/setup")
      .send({ UNKNOWN_KEY: "x", ANTHROPIC_API_KEY: "sk-new" });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-new");
  });

  it("returns 500 when secrets.set throws", async () => {
    setMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await request(app)
      .patch("/api/setup")
      .send({ ANTHROPIC_API_KEY: "sk-new" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disk full/);
  });
});

describe("setupRouter DELETE /api/setup/:key", () => {
  it("clears a single required secret", async () => {
    getMock.mockImplementation((key: string) =>
      key === "ANTHROPIC_API_KEY" ? undefined : "ghp_existing"
    );

    const res = await request(app).delete("/api/setup/ANTHROPIC_API_KEY");

    expect(res.status).toBe(200);
    expect(res.body.configured.ANTHROPIC_API_KEY).toBe(false);
    expect(res.body.configured.GH_PAT).toBe(true);
    expect(unsetMock).toHaveBeenCalledTimes(1);
    expect(unsetMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("rejects unknown keys", async () => {
    const res = await request(app).delete("/api/setup/SOMETHING_ELSE");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown secret key/i);
    expect(unsetMock).not.toHaveBeenCalled();
  });

  it("returns 500 when secrets.unset throws", async () => {
    unsetMock.mockImplementation(() => {
      throw new Error("write failed");
    });

    const res = await request(app).delete("/api/setup/GH_PAT");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/write failed/);
  });
});

describe("setupRouter DELETE /api/setup", () => {
  it("unsets each required secret and reports ready=false", async () => {
    getMock.mockReturnValue(undefined);

    const res = await request(app).delete("/api/setup");

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(unsetMock).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
    expect(unsetMock).toHaveBeenCalledWith("GH_PAT");
  });

  it("returns 500 with the error message when secrets.unset throws", async () => {
    unsetMock.mockImplementation(() => {
      throw new Error("write failed");
    });

    const res = await request(app).delete("/api/setup");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/write failed/);
  });
});
