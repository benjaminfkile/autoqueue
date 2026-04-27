import request from "supertest";
import app from "../src/app";

jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock("../src/db/settings", () => ({
  getSettings: jest.fn(),
}));
import { getSettings } from "../src/db/settings";

jest.mock("../src/db/usageAggregations", () => ({
  getWeeklyTokens: jest.fn(),
  getDailyTokens: jest.fn(),
}));
import {
  getDailyTokens,
  getWeeklyTokens,
} from "../src/db/usageAggregations";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("usageRouter GET /api/usage/weekly", () => {
  it("returns weekly_total, weekly_cap, breakdown, and the trailing-30-day daily array — the SPA dashboard's single read for cap-vs-usage and the chart", async () => {
    (getSettings as jest.Mock).mockResolvedValue({
      id: 1,
      default_model: "claude",
      weekly_token_cap: 1_000_000,
      session_token_cap: null,
      updated_at: "2026-04-26",
    });
    (getWeeklyTokens as jest.Mock).mockResolvedValue({
      input: 100,
      output: 200,
      cache_creation: 50,
      cache_read: 1000,
      total: 1350,
    });
    (getDailyTokens as jest.Mock).mockResolvedValue([
      { date: "2026-04-25", total: 1000 },
      { date: "2026-04-26", total: 350 },
    ]);

    const res = await request(app).get("/api/usage/weekly");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      weekly_total: 1350,
      weekly_cap: 1_000_000,
      weekly_breakdown: {
        input: 100,
        output: 200,
        cache_creation: 50,
        cache_read: 1000,
      },
      daily: [
        { date: "2026-04-25", total: 1000 },
        { date: "2026-04-26", total: 350 },
      ],
    });
  });

  it("preserves weekly_cap=null (unlimited) end-to-end so the SPA can render 'Unlimited' instead of an arbitrary ceiling", async () => {
    (getSettings as jest.Mock).mockResolvedValue({
      id: 1,
      default_model: "claude",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26",
    });
    (getWeeklyTokens as jest.Mock).mockResolvedValue({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
    (getDailyTokens as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get("/api/usage/weekly");

    expect(res.status).toBe(200);
    expect(res.body.weekly_cap).toBeNull();
    expect(res.body.weekly_total).toBe(0);
  });

  it("requests a 30-day daily window so the chart length matches the dashboard contract", async () => {
    (getSettings as jest.Mock).mockResolvedValue({
      id: 1,
      default_model: "claude",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26",
    });
    (getWeeklyTokens as jest.Mock).mockResolvedValue({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
    (getDailyTokens as jest.Mock).mockResolvedValue([]);

    await request(app).get("/api/usage/weekly");

    expect(getDailyTokens).toHaveBeenCalledTimes(1);
    const args = (getDailyTokens as jest.Mock).mock.calls[0];
    // Third arg is the days window. Pinning the value catches a future
    // refactor that "tunes" the chart length and silently breaks the SPA's
    // expected 30-bar layout.
    expect(args[2]).toBe(30);
    // Same `now` instance must flow into both helpers so the 7-day total and
    // the 30-day chart line up at midnight rollovers.
    expect((getWeeklyTokens as jest.Mock).mock.calls[0][1]).toBe(args[1]);
  });

  it("returns 500 with the error message when the settings read throws so the SPA can surface a banner instead of a stuck spinner", async () => {
    (getSettings as jest.Mock).mockRejectedValue(new Error("db down"));
    (getWeeklyTokens as jest.Mock).mockResolvedValue({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
    (getDailyTokens as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get("/api/usage/weekly");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });
});
