import {
  PULL_WORKER_PAUSED_KEY,
  getSetting,
  isPullWorkerPaused,
  setPullWorkerPaused,
  setSetting,
} from "../src/db/appSettings";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["where", "insert", "update", "first"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock;
  // db.fn.now() shows up as part of the update call; the helper just uses it
  // verbatim, so a sentinel is enough to assert the contract.
  (knex as any).fn = { now: jest.fn(() => "now()") };
  return { knex, chain };
}

describe("getSetting", () => {
  it("returns the stored value when the key is present", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({ key: "k", value: "v" });

    const result = await getSetting(knex as any, "k");

    expect(knex).toHaveBeenCalledWith("app_settings");
    expect(chain.where).toHaveBeenCalledWith({ key: "k" });
    expect(result).toBe("v");
  });

  it("returns undefined when the key is missing (no row in app_settings)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const result = await getSetting(knex as any, "missing");

    expect(result).toBeUndefined();
  });
});

describe("setSetting", () => {
  it("inserts a new row when the key does not yet exist", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    await setSetting(knex as any, "k", "v");

    expect(chain.insert).toHaveBeenCalledWith({ key: "k", value: "v" });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("updates the existing row when the key is already present", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({ key: "k", value: "old" });

    await setSetting(knex as any, "k", "new");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ value: "new" })
    );
    expect(chain.insert).not.toHaveBeenCalled();
  });
});

describe("isPullWorkerPaused", () => {
  it("returns false by default when no setting row exists", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const result = await isPullWorkerPaused(knex as any);

    expect(result).toBe(false);
  });

  it("returns true when the stored value is the string 'true'", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      key: PULL_WORKER_PAUSED_KEY,
      value: "true",
    });

    const result = await isPullWorkerPaused(knex as any);

    expect(result).toBe(true);
  });

  it("returns false when the stored value is the string 'false'", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      key: PULL_WORKER_PAUSED_KEY,
      value: "false",
    });

    const result = await isPullWorkerPaused(knex as any);

    expect(result).toBe(false);
  });
});

describe("setPullWorkerPaused", () => {
  it("persists the boolean as the string 'true' when paused=true", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    await setPullWorkerPaused(knex as any, true);

    expect(chain.insert).toHaveBeenCalledWith({
      key: PULL_WORKER_PAUSED_KEY,
      value: "true",
    });
  });

  it("persists the boolean as the string 'false' when paused=false", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    await setPullWorkerPaused(knex as any, false);

    expect(chain.insert).toHaveBeenCalledWith({
      key: PULL_WORKER_PAUSED_KEY,
      value: "false",
    });
  });
});
