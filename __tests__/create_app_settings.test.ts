import {
  up,
  down,
} from "../src/db/migrations/20260426000001_create_app_settings";

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

function runUpAndCapture() {
  const { builder, calls } = createTableBuilderMock();
  const knex = {
    fn: { now: jest.fn(() => "now()") },
    schema: {
      createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
        cb(builder);
      }),
    },
  };
  return { knex, builder, calls };
}

describe("migration 20260426000001_create_app_settings", () => {
  describe("up()", () => {
    it("creates the app_settings table", async () => {
      const { knex } = runUpAndCapture();
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "app_settings"
      );
    });

    it("defines key as the primary key (text — settings are referenced by name, not auto-id)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const keyCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "key"
      );
      expect(keyCall).toBeDefined();
      expect(keyCall!.chain.primary).toHaveBeenCalled();
    });

    it("defines value as NOT NULL text", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const valueCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "value"
      );
      expect(valueCall).toBeDefined();
      expect(valueCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines updated_at as a NOT NULL timestamp defaulting to now()", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const tsCall = calls.find(
        (c) => c.method === "timestamp" && c.args[0] === "updated_at"
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.chain.notNullable).toHaveBeenCalled();
      expect(tsCall!.chain.defaultTo).toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("drops the app_settings table", async () => {
      const knex = {
        schema: {
          dropTableIfExists: jest.fn().mockResolvedValue(undefined),
        },
      };
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith(
        "app_settings"
      );
    });
  });
});
