import {
  up,
  down,
} from "../src/db/migrations/20260425000004_create_task_events";

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
    text: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "text", args, chain });
      return chain;
    }),
    jsonb: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "jsonb", args, chain });
      return chain;
    }),
    index: jest.fn((...args: unknown[]) => {
      calls.push({ method: "index", args, chain: null });
    }),
  };
  return { builder, calls };
}

describe("migration 20260425000004_create_task_events", () => {
  describe("up()", () => {
    it("creates the task_events table", async () => {
      const { builder } = createTableBuilderMock();
      const knex = {
        fn: { now: jest.fn(() => "now()") },
        schema: {
          createTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "task_events"
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

    it("defines task_id as a NOT NULL FK to tasks.id with ON DELETE CASCADE", async () => {
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
      const taskIdCall = calls.find(
        (c) => c.method === "integer" && c.args[0] === "task_id"
      );
      expect(taskIdCall).toBeDefined();
      expect(taskIdCall!.chain.notNullable).toHaveBeenCalled();
      expect(taskIdCall!.chain.references).toHaveBeenCalledWith("id");
      expect(taskIdCall!.chain.inTable).toHaveBeenCalledWith("tasks");
      expect(taskIdCall!.chain.onDelete).toHaveBeenCalledWith("CASCADE");
    });

    it("defines ts as timestamptz NOT NULL default now()", async () => {
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
        (c) => c.method === "timestamp" && c.args[0] === "ts"
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.args[1]).toEqual(expect.objectContaining({ useTz: true }));
      expect(tsCall!.chain.notNullable).toHaveBeenCalled();
      expect(tsCall!.chain.defaultTo).toHaveBeenCalled();
    });

    it("defines event as text NOT NULL", async () => {
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
      const eventCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "event"
      );
      expect(eventCall).toBeDefined();
      expect(eventCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines data as jsonb NULL", async () => {
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
      const dataCall = calls.find(
        (c) => c.method === "jsonb" && c.args[0] === "data"
      );
      expect(dataCall).toBeDefined();
      expect(dataCall!.chain.nullable).toHaveBeenCalled();
    });

    it("creates a composite index on (task_id, ts)", async () => {
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
      expect(indexCall!.args[0]).toEqual(["task_id", "ts"]);
    });
  });

  describe("down()", () => {
    it("drops the task_events table", async () => {
      const knex = {
        schema: {
          dropTableIfExists: jest.fn().mockResolvedValue(undefined),
        },
      };
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith("task_events");
    });
  });
});
