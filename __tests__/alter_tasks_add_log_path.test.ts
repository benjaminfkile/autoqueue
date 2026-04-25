import {
  up,
  down,
} from "../src/db/migrations/20260425000005_alter_tasks_add_log_path";

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
    text: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "text", args, chain });
      return chain;
    }),
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args, chain: null });
    }),
  };
  return { builder, calls };
}

describe("migration 20260425000005_alter_tasks_add_log_path", () => {
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

    it("adds log_path as text nullable", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const logPathCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "log_path"
      );
      expect(logPathCall).toBeDefined();
      expect(logPathCall!.chain.nullable).toHaveBeenCalled();
      expect(logPathCall!.chain.notNullable).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("drops the log_path column", async () => {
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
      expect(builder.dropColumn).toHaveBeenCalledWith("log_path");
    });
  });
});
