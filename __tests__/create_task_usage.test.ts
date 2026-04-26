import {
  up,
  down,
} from "../src/db/migrations/20260425000009_create_task_usage";

function createColumnBuilderMock() {
  const chain = {
    primary: jest.fn().mockReturnThis(),
    notNullable: jest.fn().mockReturnThis(),
    nullable: jest.fn().mockReturnThis(),
    defaultTo: jest.fn().mockReturnThis(),
    references: jest.fn().mockReturnThis(),
    inTable: jest.fn().mockReturnThis(),
    onDelete: jest.fn().mockReturnThis(),
  };
  return chain;
}

function createTableBuilderMock() {
  const calls: Array<{ method: string; args: unknown[]; chain: any }> = [];
  const builder = {
    increments: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "increments", args, chain });
      return chain;
    }),
    integer: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "integer", args, chain });
      return chain;
    }),
    timestamp: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "timestamp", args, chain });
      return chain;
    }),
    index: jest.fn((...args: unknown[]) => {
      calls.push({ method: "index", args, chain: null });
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

describe("migration 20260425000009_create_task_usage", () => {
  describe("up()", () => {
    it("creates the task_usage table", async () => {
      const { knex } = runUpAndCapture();
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "task_usage"
      );
    });

    it("defines an auto-increment id primary key", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const idCall = calls.find(
        (c) => c.method === "increments" && c.args[0] === "id"
      );
      expect(idCall).toBeDefined();
      expect(idCall!.chain.primary).toHaveBeenCalled();
    });

    it("defines task_id as a NOT NULL FK to tasks(id) with cascading delete", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const taskIdCall = calls.find(
        (c) => c.method === "integer" && c.args[0] === "task_id"
      );
      expect(taskIdCall).toBeDefined();
      expect(taskIdCall!.chain.notNullable).toHaveBeenCalled();
      expect(taskIdCall!.chain.references).toHaveBeenCalledWith("id");
      expect(taskIdCall!.chain.inTable).toHaveBeenCalledWith("tasks");
      expect(taskIdCall!.chain.onDelete).toHaveBeenCalledWith("CASCADE");
    });

    it("defines repo_id as a NOT NULL FK to repos(id) with cascading delete (so repo deletion cleans usage rows)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const repoIdCall = calls.find(
        (c) => c.method === "integer" && c.args[0] === "repo_id"
      );
      expect(repoIdCall).toBeDefined();
      expect(repoIdCall!.chain.notNullable).toHaveBeenCalled();
      expect(repoIdCall!.chain.references).toHaveBeenCalledWith("id");
      expect(repoIdCall!.chain.inTable).toHaveBeenCalledWith("repos");
      expect(repoIdCall!.chain.onDelete).toHaveBeenCalledWith("CASCADE");
    });

    it.each([
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ])("defines %s as NOT NULL int default 0", async (col) => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const c = calls.find(
        (call) => call.method === "integer" && call.args[0] === col
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.defaultTo).toHaveBeenCalledWith(0);
    });

    it("defines created_at as a NOT NULL timestamp defaulting to now() (SQLite-compatible, no useTz)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const tsCall = calls.find(
        (c) => c.method === "timestamp" && c.args[0] === "created_at"
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.args.length).toBe(1);
      expect(tsCall!.chain.notNullable).toHaveBeenCalled();
      expect(tsCall!.chain.defaultTo).toHaveBeenCalled();
    });

    it("creates an index on task_id (per-task aggregation hot path)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const indexCall = calls.find(
        (c) => c.method === "index" && Array.isArray(c.args[0]) && (c.args[0] as string[]).includes("task_id")
      );
      expect(indexCall).toBeDefined();
    });

    it("creates an index on repo_id (per-repo aggregation hot path)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const indexCall = calls.find(
        (c) => c.method === "index" && Array.isArray(c.args[0]) && (c.args[0] as string[]).includes("repo_id")
      );
      expect(indexCall).toBeDefined();
    });
  });

  describe("down()", () => {
    it("drops the task_usage table", async () => {
      const knex = {
        schema: {
          dropTableIfExists: jest.fn().mockResolvedValue(undefined),
        },
      };
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith("task_usage");
    });
  });
});
