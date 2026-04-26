import {
  up,
  down,
} from "../src/db/migrations/20260425000001_alter_tasks_add_lease";

function createTableBuilderMock() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    text: jest.fn((...args: unknown[]) => {
      calls.push({ method: "text", args });
      return { nullable: jest.fn().mockReturnThis() };
    }),
    timestamp: jest.fn((...args: unknown[]) => {
      calls.push({ method: "timestamp", args });
      return { nullable: jest.fn().mockReturnThis() };
    }),
    index: jest.fn((...args: unknown[]) => {
      calls.push({ method: "index", args });
    }),
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args });
    }),
    dropIndex: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropIndex", args });
    }),
  };
  return { builder, calls };
}

function createKnexMock() {
  let captured: { table: string; cb: (b: any) => void } | null = null;
  const knex = {
    schema: {
      alterTable: jest.fn(async (table: string, cb: (b: any) => void) => {
        captured = { table, cb };
        const { builder } = createTableBuilderMock();
        cb(builder);
        return undefined;
      }),
    },
  };
  return {
    knex,
    getCaptured: () => captured,
  };
}

describe("migration 20260425000001_alter_tasks_add_lease", () => {
  describe("up()", () => {
    it("alters the tasks table", async () => {
      const { knex } = createKnexMock();
      await up(knex as any);
      expect(knex.schema.alterTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.alterTable as jest.Mock).mock.calls[0][0]).toBe(
        "tasks"
      );
    });

    it("adds worker_id (text, nullable), leased_until (timestamptz, nullable), and the index", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      // worker_id text NULL
      expect(builder.text).toHaveBeenCalledWith("worker_id");
      const textResult = (builder.text as jest.Mock).mock.results[0]
        .value as { nullable: jest.Mock };
      expect(textResult.nullable).toHaveBeenCalled();

      // leased_until timestamp NULL (SQLite-compatible — no useTz options arg)
      expect(builder.timestamp).toHaveBeenCalledWith("leased_until");
      const tsResult = (builder.timestamp as jest.Mock).mock.results[0]
        .value as { nullable: jest.Mock };
      expect(tsResult.nullable).toHaveBeenCalled();

      // composite index named idx_tasks_status_leased_until
      expect(builder.index).toHaveBeenCalledWith(
        ["status", "leased_until"],
        "idx_tasks_status_leased_until"
      );

      // sanity: at least these three calls happened
      expect(calls.map((c) => c.method)).toEqual(
        expect.arrayContaining(["text", "timestamp", "index"])
      );
    });
  });

  describe("down()", () => {
    it("drops the index and both columns", async () => {
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
      expect(builder.dropIndex).toHaveBeenCalledWith(
        ["status", "leased_until"],
        "idx_tasks_status_leased_until"
      );
      expect(builder.dropColumn).toHaveBeenCalledWith("worker_id");
      expect(builder.dropColumn).toHaveBeenCalledWith("leased_until");
    });
  });
});
