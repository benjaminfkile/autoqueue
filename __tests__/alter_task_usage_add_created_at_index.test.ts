import {
  up,
  down,
} from "../src/db/migrations/20260426000006_alter_task_usage_add_created_at_index";

function createTableBuilderMock() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    index: jest.fn((...args: unknown[]) => {
      calls.push({ method: "index", args });
    }),
    dropIndex: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropIndex", args });
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

describe("migration 20260426000006_alter_task_usage_add_created_at_index", () => {
  describe("up()", () => {
    it("alters the task_usage table", async () => {
      const { knex } = makeKnex();
      await up(knex as any);
      expect(knex.schema.alterTable).toHaveBeenCalledTimes(1);
      expect(knex.schema.alterTable.mock.calls[0][0]).toBe("task_usage");
    });

    it("creates an index on created_at named idx_task_usage_created_at (weekly cap aggregation hot path)", async () => {
      const { knex, builder } = makeKnex();
      await up(knex as any);
      expect(builder.index).toHaveBeenCalledWith(
        ["created_at"],
        "idx_task_usage_created_at"
      );
    });
  });

  describe("down()", () => {
    it("drops the created_at index", async () => {
      const { knex, builder } = makeKnex();
      await down(knex as any);
      expect(knex.schema.alterTable).toHaveBeenCalledWith(
        "task_usage",
        expect.any(Function)
      );
      expect(builder.dropIndex).toHaveBeenCalledWith(
        ["created_at"],
        "idx_task_usage_created_at"
      );
    });
  });
});
