import {
  getSettings,
  updateSettings,
  getDefaultModel,
  setDefaultModel,
  getWeeklyTokenCap,
  setWeeklyTokenCap,
  getSessionTokenCap,
  setSessionTokenCap,
} from "../src/db/settings";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["where", "update", "first"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock;
  (knex as any).fn = { now: jest.fn(() => "now()") };
  return { knex, chain };
}

describe("getSettings", () => {
  it("reads the singleton row by id=1", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const settings = await getSettings(knex as any);

    expect(knex).toHaveBeenCalledWith("settings");
    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(settings.default_model).toBe("claude-sonnet-4-6");
  });

  it("throws when the singleton row is missing (the migration is supposed to seed it; absence is a bug, not a fallback case)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    await expect(getSettings(knex as any)).rejects.toThrow(/settings row missing/);
  });

  it("returns null caps when columns are NULL (NULL is the unlimited signal — must not collapse to 0 or Infinity)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const settings = await getSettings(knex as any);

    expect(settings.weekly_token_cap).toBeNull();
    expect(settings.session_token_cap).toBeNull();
  });

  it("normalizes string-encoded bigints from SQLite into numbers (driver may return BIGINT as string for large values)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: "1000000",
      session_token_cap: 50000,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const settings = await getSettings(knex as any);

    expect(settings.weekly_token_cap).toBe(1000000);
    expect(settings.session_token_cap).toBe(50000);
  });
});

describe("updateSettings", () => {
  it("patches default_model on the singleton row and refreshes updated_at, then returns the fresh row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-opus-4-7",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await updateSettings(knex as any, {
      default_model: "claude-opus-4-7",
    });

    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        default_model: "claude-opus-4-7",
        updated_at: "now()",
      })
    );
    expect(result.default_model).toBe("claude-opus-4-7");
  });

  it("does not insert a new row when patching (the table is single-row; insert paths are forbidden by the singleton trigger)", async () => {
    const { knex, chain } = createMockKnex();
    (chain as any).insert = jest.fn().mockReturnThis();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    await updateSettings(knex as any, { default_model: "claude-haiku-4-5" });

    expect((chain as any).insert).not.toHaveBeenCalled();
  });

  it("can patch token caps alongside or independently of default_model", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: 5000,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    await updateSettings(knex as any, { weekly_token_cap: 5000 });

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        weekly_token_cap: 5000,
        updated_at: "now()",
      })
    );
  });
});

describe("getDefaultModel / setDefaultModel", () => {
  it("getDefaultModel returns the default_model field from the singleton row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-haiku-4-5",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const model = await getDefaultModel(knex as any);

    expect(model).toBe("claude-haiku-4-5");
  });

  it("setDefaultModel writes the new model and returns the refreshed row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-opus-4-7",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setDefaultModel(knex as any, "claude-opus-4-7");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ default_model: "claude-opus-4-7" })
    );
    expect(result.default_model).toBe("claude-opus-4-7");
  });
});

describe("getWeeklyTokenCap / setWeeklyTokenCap", () => {
  it("getWeeklyTokenCap returns null when the cap is unlimited", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const cap = await getWeeklyTokenCap(knex as any);
    expect(cap).toBeNull();
  });

  it("getWeeklyTokenCap returns the configured number when a cap is set", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: 250000,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const cap = await getWeeklyTokenCap(knex as any);
    expect(cap).toBe(250000);
  });

  it("setWeeklyTokenCap writes the number and returns the refreshed row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: 100000,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setWeeklyTokenCap(knex as any, 100000);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ weekly_token_cap: 100000 })
    );
    expect(result.weekly_token_cap).toBe(100000);
  });

  it("setWeeklyTokenCap accepts null to clear the cap (NULL = unlimited)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setWeeklyTokenCap(knex as any, null);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ weekly_token_cap: null })
    );
    expect(result.weekly_token_cap).toBeNull();
  });

  it("setWeeklyTokenCap rejects negative or non-integer values (no meaningful interpretation as a token budget)", async () => {
    const { knex } = createMockKnex();

    await expect(setWeeklyTokenCap(knex as any, -1)).rejects.toThrow(
      /weekly_token_cap/
    );
    await expect(setWeeklyTokenCap(knex as any, 1.5)).rejects.toThrow(
      /weekly_token_cap/
    );
  });
});

describe("getSessionTokenCap / setSessionTokenCap", () => {
  it("getSessionTokenCap returns null when the cap is unlimited", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const cap = await getSessionTokenCap(knex as any);
    expect(cap).toBeNull();
  });

  it("getSessionTokenCap returns the configured number when a cap is set", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: 8000,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const cap = await getSessionTokenCap(knex as any);
    expect(cap).toBe(8000);
  });

  it("setSessionTokenCap writes the number and returns the refreshed row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: 8000,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setSessionTokenCap(knex as any, 8000);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ session_token_cap: 8000 })
    );
    expect(result.session_token_cap).toBe(8000);
  });

  it("setSessionTokenCap accepts null to clear the cap (NULL = unlimited)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setSessionTokenCap(knex as any, null);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ session_token_cap: null })
    );
    expect(result.session_token_cap).toBeNull();
  });

  it("setSessionTokenCap rejects negative values", async () => {
    const { knex } = createMockKnex();

    await expect(setSessionTokenCap(knex as any, -100)).rejects.toThrow(
      /session_token_cap/
    );
  });
});
