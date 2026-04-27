import {
  up,
  down,
} from "../src/db/migrations/20260426000003_create_settings";

function createColumnBuilderMock() {
  const chain = {
    primary: jest.fn().mockReturnThis(),
    notNullable: jest.fn().mockReturnThis(),
    nullable: jest.fn().mockReturnThis(),
    defaultTo: jest.fn().mockReturnThis(),
  };
  return chain;
}

function createTableBuilderMock() {
  const calls: Array<{ method: string; args: unknown[]; chain: any }> = [];
  const builder = {
    integer: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "integer", args, chain });
      return chain;
    }),
    text: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "text", args, chain });
      return chain;
    }),
    timestamp: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "timestamp", args, chain });
      return chain;
    }),
  };
  return { builder, calls };
}

function makeKnex() {
  const { builder, calls } = createTableBuilderMock();
  // The migration also seeds the singleton row via knex("settings").insert(...).
  // We model the knex callable as a function that returns a chain with insert().
  const insert = jest.fn().mockResolvedValue(undefined);
  const tableChain = { insert };
  const knex: any = jest.fn().mockReturnValue(tableChain);
  knex.fn = { now: jest.fn(() => "now()") };
  knex.schema = {
    createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
      cb(builder);
    }),
    raw: jest.fn().mockResolvedValue(undefined),
    dropTableIfExists: jest.fn().mockResolvedValue(undefined),
  };
  return { knex, builder, calls, insert };
}

describe("migration 20260426000003_create_settings", () => {
  describe("up()", () => {
    it("creates the settings table", async () => {
      const { knex } = makeKnex();
      await up(knex);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect(knex.schema.createTable.mock.calls[0][0]).toBe("settings");
    });

    it("defines id as a non-auto-increment integer primary key (the row is pinned to id=1, not assigned by SQLite)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex);
      const idCall = calls.find(
        (c) => c.method === "integer" && c.args[0] === "id"
      );
      expect(idCall).toBeDefined();
      expect(idCall!.chain.primary).toHaveBeenCalled();
    });

    it("defines default_model as NOT NULL text defaulting to 'claude-sonnet-4-6' (Phase 11 default; opus was the legacy hardcoded value)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex);
      const c = calls.find(
        (x) => x.method === "text" && x.args[0] === "default_model"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.defaultTo).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("defines updated_at as a NOT NULL timestamp defaulting to now()", async () => {
      const { knex, calls } = makeKnex();
      await up(knex);
      const c = calls.find(
        (x) => x.method === "timestamp" && x.args[0] === "updated_at"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.defaultTo).toHaveBeenCalled();
    });

    it("installs a singleton trigger that rejects inserts with id != 1 (so callers can never accidentally create a second settings row)", async () => {
      const { knex } = makeKnex();
      await up(knex);
      const triggerCall = knex.schema.raw.mock.calls.find((c: any[]) =>
        /CREATE\s+TRIGGER/i.test(String(c[0]))
      );
      expect(triggerCall).toBeDefined();
      const sql = String(triggerCall![0]);
      expect(sql).toMatch(/BEFORE\s+INSERT\s+ON\s+settings/i);
      expect(sql).toMatch(/NEW\.id\s*<>\s*1/);
      expect(sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    });

    it("seeds the single row with id=1 and default_model='claude-sonnet-4-6' so getSettings() never sees an empty table", async () => {
      const { knex, insert } = makeKnex();
      await up(knex);
      expect(knex).toHaveBeenCalledWith("settings");
      expect(insert).toHaveBeenCalledWith({
        id: 1,
        default_model: "claude-sonnet-4-6",
      });
    });
  });

  describe("down()", () => {
    it("drops the singleton trigger before the table (SQLite would otherwise leave a dangling trigger)", async () => {
      const { knex } = makeKnex();
      await down(knex);
      const dropTriggerCall = knex.schema.raw.mock.calls.find((c: any[]) =>
        /DROP\s+TRIGGER/i.test(String(c[0]))
      );
      expect(dropTriggerCall).toBeDefined();
      expect(String(dropTriggerCall![0])).toMatch(
        /settings_singleton_insert/
      );
    });

    it("drops the settings table", async () => {
      const { knex } = makeKnex();
      await down(knex);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith("settings");
    });
  });
});
