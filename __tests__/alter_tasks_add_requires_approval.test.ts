import {
  up,
  down,
} from "../src/db/migrations/20260425000007_alter_tasks_add_requires_approval";

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
    boolean: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "boolean", args, chain });
      return chain;
    }),
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args, chain: null });
    }),
  };
  return { builder, calls };
}

describe("migration 20260425000007_alter_tasks_add_requires_approval", () => {
  describe("up()", () => {
    it("alters the tasks table", async () => {
      const { builder } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      expect(knex.schema.alterTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.alterTable as jest.Mock).mock.calls[0][0]).toBe(
        "tasks"
      );
    });

    it("adds requires_approval as a not-null boolean defaulting to false", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const col = calls.find(
        (c) => c.method === "boolean" && c.args[0] === "requires_approval"
      );
      expect(col).toBeDefined();
      expect(col!.chain.notNullable).toHaveBeenCalled();
      expect(col!.chain.defaultTo).toHaveBeenCalledWith(false);
    });
  });

  describe("down()", () => {
    it("drops the requires_approval column", async () => {
      const { builder } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await down(knex as any);

      expect(knex.schema.alterTable).toHaveBeenCalledWith(
        "tasks",
        expect.any(Function)
      );
      expect(builder.dropColumn).toHaveBeenCalledWith("requires_approval");
    });
  });
});
