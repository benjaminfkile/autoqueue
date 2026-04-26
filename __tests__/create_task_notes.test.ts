import {
  up,
  down,
} from "../src/db/migrations/20260425000006_create_task_notes";

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
    index: jest.fn((...args: unknown[]) => {
      calls.push({ method: "index", args, chain: null });
    }),
  };
  return { builder, calls };
}

function makeKnex() {
  const { builder, calls } = createTableBuilderMock();
  const knex = {
    fn: { now: jest.fn(() => "now()") },
    schema: {
      createTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
        cb(builder);
      }),
      dropTableIfExists: jest.fn().mockResolvedValue(undefined),
    },
  };
  return { knex, builder, calls };
}

describe("migration 20260425000006_create_task_notes", () => {
  describe("up()", () => {
    it("creates the task_notes table", async () => {
      const { knex } = makeKnex();
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "task_notes"
      );
    });

    it("defines an auto-increment id primary key", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const idCall = calls.find(
        (c) => c.method === "increments" && c.args[0] === "id"
      );
      expect(idCall).toBeDefined();
      expect(idCall!.chain.primary).toHaveBeenCalled();
    });

    it("defines task_id as a NOT NULL FK to tasks.id with ON DELETE CASCADE", async () => {
      const { knex, calls } = makeKnex();
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

    it("defines author as text NOT NULL", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "text" && x.args[0] === "author"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines visibility as text NOT NULL", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "text" && x.args[0] === "visibility"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines tags as text NOT NULL with an empty-array default (JSON-encoded for SQLite)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find((x) => x.method === "text" && x.args[0] === "tags");
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      // Empty-array default lets agents omit tags without producing a NULL
      // column that callers would have to coalesce on read.
      expect(c!.chain.defaultTo).toHaveBeenCalledWith("[]");
    });

    it("defines content as text NOT NULL", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "text" && x.args[0] === "content"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines created_at as a NOT NULL timestamp defaulting to now() (SQLite-compatible, no useTz)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "timestamp" && x.args[0] === "created_at"
      );
      expect(c).toBeDefined();
      expect(c!.args.length).toBe(1);
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.defaultTo).toHaveBeenCalled();
    });

    it("creates a (task_id, created_at) index for the per-task chronological reader", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const idx = calls.find(
        (c) =>
          c.method === "index" &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[]).includes("task_id") &&
          (c.args[0] as string[]).includes("created_at")
      );
      expect(idx).toBeDefined();
    });
  });

  describe("down()", () => {
    it("drops the task_notes table cleanly", async () => {
      const { knex } = makeKnex();
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith("task_notes");
    });
  });
});
