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

jest.mock("../src/db/settings", () => ({
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
}));

import app from "../src/app";
import { getSettings, updateSettings } from "../src/db/settings";

const getSettingsMock = getSettings as jest.Mock;
const updateSettingsMock = updateSettings as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("settingsRouter GET /api/settings", () => {
  it("returns the singleton settings row including token caps", async () => {
    getSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: 8000,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const res = await request(app).get("/api/settings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: 8000,
      updated_at: "2026-04-26T00:00:00.000Z",
    });
  });

  it("returns 500 when the db call throws", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await request(app).get("/api/settings");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db unavailable/);
  });
});

describe("settingsRouter PATCH /api/settings", () => {
  it("updates default_model and returns the refreshed row", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-opus-4-7",
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ default_model: "claude-opus-4-7" });

    expect(res.status).toBe(200);
    expect(res.body.default_model).toBe("claude-opus-4-7");
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      default_model: "claude-opus-4-7",
    });
  });

  it("trims whitespace before persisting", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-haiku-4-5",
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    await request(app)
      .patch("/api/settings")
      .send({ default_model: "  claude-haiku-4-5  " });

    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      default_model: "claude-haiku-4-5",
    });
  });

  it("rejects empty/whitespace default_model", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ default_model: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default_model/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects non-string default_model", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ default_model: 42 });

    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects empty payloads", async () => {
    const res = await request(app).patch("/api/settings").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one settings field/i);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("ignores unknown keys but still requires a recognized field", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ some_future_field: "x" });

    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("returns 500 when updateSettings throws", async () => {
    updateSettingsMock.mockRejectedValueOnce(new Error("disk full"));

    const res = await request(app)
      .patch("/api/settings")
      .send({ default_model: "claude-opus-4-7" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disk full/);
  });

  it("accepts a numeric weekly_token_cap and forwards it as-is", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: 250000,
      session_token_cap: null,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: 250000 });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      weekly_token_cap: 250000,
    });
    expect(res.body.weekly_token_cap).toBe(250000);
  });

  it("accepts a very large integer weekly_token_cap (BIGINT column)", async () => {
    const big = 9_000_000_000;
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: big,
      session_token_cap: null,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: big });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      weekly_token_cap: big,
    });
  });

  it("treats null weekly_token_cap as a clear-to-NULL signal (unlimited)", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: null });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      weekly_token_cap: null,
    });
    expect(res.body.weekly_token_cap).toBeNull();
  });

  it("accepts a numeric session_token_cap", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: 8000,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ session_token_cap: 8000 });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      session_token_cap: 8000,
    });
  });

  it("treats null session_token_cap as unlimited", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ session_token_cap: null });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      session_token_cap: null,
    });
  });

  it("can patch caps and default_model in the same request", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-opus-4-7",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: "2026-04-26T01:00:00.000Z",
    });

    const res = await request(app).patch("/api/settings").send({
      default_model: "claude-opus-4-7",
      weekly_token_cap: 1000,
      session_token_cap: null,
    });

    expect(res.status).toBe(200);
    expect(updateSettingsMock.mock.calls[0][1]).toEqual({
      default_model: "claude-opus-4-7",
      weekly_token_cap: 1000,
      session_token_cap: null,
    });
  });

  it("rejects negative weekly_token_cap", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekly_token_cap/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer weekly_token_cap", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekly_token_cap/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects string-encoded weekly_token_cap (caller must send a JSON number)", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ weekly_token_cap: "1000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekly_token_cap/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects negative session_token_cap", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ session_token_cap: -10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_token_cap/);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
