import request from "supertest";
import app from "../src/app";

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

describe("healthRouter", () => {
  it("GET /api/health returns 200 and ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      error: false,
    });
  });

  it("GET /api/health?verbose=true includes db health details", async () => {
    const res = await request(app).get("/api/health?verbose=true");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("db");
    expect(res.body.db.connected).toBe(true);
  });
});
