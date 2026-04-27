import {
  getSettings,
  updateSettings,
  getDefaultModel,
  setDefaultModel,
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
});

describe("updateSettings", () => {
  it("patches default_model on the singleton row and refreshes updated_at, then returns the fresh row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-opus-4-7",
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
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    await updateSettings(knex as any, { default_model: "claude-haiku-4-5" });

    expect((chain as any).insert).not.toHaveBeenCalled();
  });
});

describe("getDefaultModel / setDefaultModel", () => {
  it("getDefaultModel returns the default_model field from the singleton row", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      id: 1,
      default_model: "claude-haiku-4-5",
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
      updated_at: "2026-04-26T00:00:00.000Z",
    });

    const result = await setDefaultModel(knex as any, "claude-opus-4-7");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ default_model: "claude-opus-4-7" })
    );
    expect(result.default_model).toBe("claude-opus-4-7");
  });
});
