import {
  up,
  down,
} from "../src/db/migrations/20260426000004_alter_tasks_add_model";

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

describe("migration 20260426000004_alter_tasks_add_model", () => {
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

    it("adds model as text nullable (NULL means inherit from ancestor → settings.default_model)", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const modelCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "model"
      );
      expect(modelCall).toBeDefined();
      expect(modelCall!.chain.nullable).toHaveBeenCalled();
      expect(modelCall!.chain.notNullable).not.toHaveBeenCalled();
      // No default — NULL is the inheritance signal; defaulting to a string
      // would silently break the resolution rule.
      expect(modelCall!.chain.defaultTo).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("drops the model column", async () => {
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
      expect(builder.dropColumn).toHaveBeenCalledWith("model");
    });
  });
});
