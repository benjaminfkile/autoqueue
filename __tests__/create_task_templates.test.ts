import {
  up,
  down,
} from "../src/db/migrations/20260425000008_create_task_templates";

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
    string: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "string", args, chain });
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

describe("migration 20260425000008_create_task_templates", () => {
  describe("up()", () => {
    it("creates the task_templates table", async () => {
      const { builder } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "task_templates"
      );
    });

    it("defines an auto-increment id primary key", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const idCall = calls.find(
        (c) => c.method === "increments" && c.args[0] === "id"
      );
      expect(idCall).toBeDefined();
      expect(idCall!.chain.primary).toHaveBeenCalled();
    });

    it("defines name as a NOT NULL string", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const nameCall = calls.find(
        (c) => c.method === "string" && c.args[0] === "name"
      );
      expect(nameCall).toBeDefined();
      expect(nameCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines description as text NOT NULL with default ''", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const descCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "description"
      );
      expect(descCall).toBeDefined();
      expect(descCall!.chain.notNullable).toHaveBeenCalled();
      expect(descCall!.chain.defaultTo).toHaveBeenCalledWith("");
    });

    it("defines tree as text NOT NULL (JSON-encoded at the helper boundary for SQLite)", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const treeCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "tree"
      );
      expect(treeCall).toBeDefined();
      expect(treeCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines created_at as a NOT NULL timestamp defaulting to now() (SQLite-compatible, no useTz)", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const tsCall = calls.find(
        (c) => c.method === "timestamp" && c.args[0] === "created_at"
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.args.length).toBe(1);
      expect(tsCall!.chain.notNullable).toHaveBeenCalled();
      expect(tsCall!.chain.defaultTo).toHaveBeenCalled();
    });

    it("creates an index on name", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_t: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      const indexCall = calls.find((c) => c.method === "index");
      expect(indexCall).toBeDefined();
      expect(indexCall!.args[0]).toEqual(["name"]);
    });
  });

  describe("down()", () => {
    it("drops the task_templates table", async () => {
      const knex = {
        schema: {
          dropTableIfExists: jest.fn().mockResolvedValue(undefined),
        },
      };
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith(
        "task_templates"
      );
    });
  });
});
