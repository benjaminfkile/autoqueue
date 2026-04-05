import request from "supertest";
import app from "../src/app";

// Mock the DB so the health router doesn't require a real connection
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

describe("app basic routes", () => {
  it("GET / returns service name with -dev suffix when NODE_ENV is not production", async () => {
    app.set("secrets", { NODE_ENV: "development" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("gateway-downstream-node-starter-dev");
  });

  it("GET / returns service name without suffix when NODE_ENV is production", async () => {
    app.set("secrets", { NODE_ENV: "production" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("gateway-downstream-node-starter");
  });

  it("GET /api/health returns 200 with ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.error).toBe(false);
  });
});
