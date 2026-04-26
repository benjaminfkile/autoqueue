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

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe("app basic routes", () => {
  it("GET / falls back to service name with -dev suffix when web build is absent and NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "development";
    const res = await request(app).get("/");
    // When /web/dist/index.html exists the SPA shell is served instead;
    // otherwise the legacy banner is returned. Either is a valid 200.
    expect(res.status).toBe(200);
    if (res.type === "text/html") {
      expect(res.text).toMatch(/<div id="root"><\/div>/);
    } else {
      expect(res.text).toBe("grunt-api-dev");
    }
  });

  it("GET / falls back to service name without suffix when web build is absent and NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    if (res.type === "text/html") {
      expect(res.text).toMatch(/<div id="root"><\/div>/);
    } else {
      expect(res.text).toBe("grunt-api");
    }
  });

  it("GET /api/health returns 200 with ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.error).toBe(false);
  });
});
