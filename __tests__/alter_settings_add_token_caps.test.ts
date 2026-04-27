import {
  up,
  down,
} from "../src/db/migrations/20260426000005_alter_settings_add_token_caps";

function createColumnBuilderMock() {
  const chain = {
    nullable: jest.fn().mockReturnThis(),
    notNullable: jest.fn().mockReturnThis(),
    defaultTo: jest.fn().mockReturnThis(),
  };
  return chain;
}

function createTableBuilderMock() {
  const calls: Array<{ method: string; args: unknown[]; chain: any }> = [];
  const builder = {
    bigInteger: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "bigInteger", args, chain });
      return chain;
    }),
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args, chain: null });
    }),
  };
  return { builder, calls };
}

function makeKnex() {
  const { builder, calls } = createTableBuilderMock();
  const knex = {
    schema: {
      alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
        cb(builder);
      }),
    },
  };
  return { knex, builder, calls };
}

describe("migration 20260426000005_alter_settings_add_token_caps", () => {
  describe("up()", () => {
    it("alters the settings table", async () => {
      const { knex } = makeKnex();
      await up(knex as any);
      expect(knex.schema.alterTable).toHaveBeenCalledTimes(1);
      expect(knex.schema.alterTable.mock.calls[0][0]).toBe("settings");
    });

    it("adds weekly_token_cap as a nullable bigint (NULL means unlimited; bigInteger because weekly token totals can exceed 32-bit range)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);

      const c = calls.find(
        (x) => x.method === "bigInteger" && x.args[0] === "weekly_token_cap"
      );
      expect(c).toBeDefined();
      expect(c!.chain.nullable).toHaveBeenCalled();
      expect(c!.chain.notNullable).not.toHaveBeenCalled();
      expect(c!.chain.defaultTo).not.toHaveBeenCalled();
    });

    it("adds session_token_cap as a nullable bigint (NULL means unlimited)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);

      const c = calls.find(
        (x) => x.method === "bigInteger" && x.args[0] === "session_token_cap"
      );
      expect(c).toBeDefined();
      expect(c!.chain.nullable).toHaveBeenCalled();
      expect(c!.chain.notNullable).not.toHaveBeenCalled();
      expect(c!.chain.defaultTo).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("drops both cap columns", async () => {
      const { knex, builder } = makeKnex();
      await down(knex as any);

      expect(knex.schema.alterTable).toHaveBeenCalledWith(
        "settings",
        expect.any(Function)
      );
      expect(builder.dropColumn).toHaveBeenCalledWith("weekly_token_cap");
      expect(builder.dropColumn).toHaveBeenCalledWith("session_token_cap");
    });
  });
});
