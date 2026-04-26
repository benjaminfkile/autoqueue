import {
  up,
  down,
} from "../src/db/migrations/20260425000010_create_repo_webhooks";

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
    boolean: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "boolean", args, chain });
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

describe("migration 20260425000010_create_repo_webhooks", () => {
  describe("up()", () => {
    it("creates the repo_webhooks table", async () => {
      const { knex } = runUpAndCapture();
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "repo_webhooks"
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

    it("defines repo_id as a NOT NULL FK to repos(id) with cascading delete (so repo deletion cleans webhooks)", async () => {
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

    it("defines url as NOT NULL text (URLs may exceed varchar(255), e.g. signed Slack tokens)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const urlCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "url"
      );
      expect(urlCall).toBeDefined();
      expect(urlCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines events as NOT NULL text (JSON-encoded array of subscribed event names for SQLite)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const eventsCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "events"
      );
      expect(eventsCall).toBeDefined();
      expect(eventsCall!.chain.notNullable).toHaveBeenCalled();
    });

    it("defines active as NOT NULL boolean default true (new webhooks are live by default)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const activeCall = calls.find(
        (c) => c.method === "boolean" && c.args[0] === "active"
      );
      expect(activeCall).toBeDefined();
      expect(activeCall!.chain.notNullable).toHaveBeenCalled();
      expect(activeCall!.chain.defaultTo).toHaveBeenCalledWith(true);
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

    it("creates an index on repo_id (per-repo lookup hot path during task state changes)", async () => {
      const { knex, calls } = runUpAndCapture();
      await up(knex as any);
      const indexCall = calls.find(
        (c) =>
          c.method === "index" &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[]).includes("repo_id")
      );
      expect(indexCall).toBeDefined();
    });
  });

  describe("down()", () => {
    it("drops the repo_webhooks table", async () => {
      const knex = {
        schema: {
          dropTableIfExists: jest.fn().mockResolvedValue(undefined),
        },
      };
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith(
        "repo_webhooks"
      );
    });
  });
});
