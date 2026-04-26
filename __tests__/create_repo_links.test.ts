import {
  up,
  down,
} from "../src/db/migrations/20260426000002_create_repo_links";

function createColumnBuilderMock() {
  const chain = {
    primary: jest.fn().mockReturnThis(),
    notNullable: jest.fn().mockReturnThis(),
    nullable: jest.fn().mockReturnThis(),
    defaultTo: jest.fn().mockReturnThis(),
    references: jest.fn().mockReturnThis(),
    inTable: jest.fn().mockReturnThis(),
    onDelete: jest.fn().mockReturnThis(),
    checkIn: jest.fn().mockReturnThis(),
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
      raw: jest.fn().mockResolvedValue(undefined),
      dropTableIfExists: jest.fn().mockResolvedValue(undefined),
    },
  };
  return { knex, builder, calls };
}

describe("migration 20260426000002_create_repo_links", () => {
  describe("up()", () => {
    it("creates the repo_links table", async () => {
      const { knex } = makeKnex();
      await up(knex as any);
      expect(knex.schema.createTable).toHaveBeenCalledTimes(1);
      expect((knex.schema.createTable as jest.Mock).mock.calls[0][0]).toBe(
        "repo_links"
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

    it("defines repo_a_id as a NOT NULL FK to repos(id) with ON DELETE CASCADE (so repo deletion cleans its links)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "integer" && x.args[0] === "repo_a_id"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.references).toHaveBeenCalledWith("id");
      expect(c!.chain.inTable).toHaveBeenCalledWith("repos");
      expect(c!.chain.onDelete).toHaveBeenCalledWith("CASCADE");
    });

    it("defines repo_b_id as a NOT NULL FK to repos(id) with ON DELETE CASCADE (the other half of the symmetric pair)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "integer" && x.args[0] === "repo_b_id"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.references).toHaveBeenCalledWith("id");
      expect(c!.chain.inTable).toHaveBeenCalledWith("repos");
      expect(c!.chain.onDelete).toHaveBeenCalledWith("CASCADE");
    });

    it("defines role as nullable text (free-form label, optional per spec)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find((x) => x.method === "text" && x.args[0] === "role");
      expect(c).toBeDefined();
      expect(c!.chain.nullable).toHaveBeenCalled();
      expect(c!.chain.notNullable).not.toHaveBeenCalled();
    });

    it("defines permission as NOT NULL text defaulting to 'read' and constrained to 'read'|'write' (Phase 10 will use 'write' to authorize cross-repo edits)", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const c = calls.find(
        (x) => x.method === "text" && x.args[0] === "permission"
      );
      expect(c).toBeDefined();
      expect(c!.chain.notNullable).toHaveBeenCalled();
      expect(c!.chain.defaultTo).toHaveBeenCalledWith("read");
      expect(c!.chain.checkIn).toHaveBeenCalledWith(["read", "write"]);
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

    it("indexes both repo_a_id and repo_b_id (the chat tool will look up links from either side without knowing which id was inserted as 'a')", async () => {
      const { knex, calls } = makeKnex();
      await up(knex as any);
      const aIdx = calls.find(
        (c) =>
          c.method === "index" &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[]).includes("repo_a_id")
      );
      const bIdx = calls.find(
        (c) =>
          c.method === "index" &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[]).includes("repo_b_id")
      );
      expect(aIdx).toBeDefined();
      expect(bIdx).toBeDefined();
    });

    it("creates a unique expression index keyed on (MIN(a,b), MAX(a,b)) so that a link {a:1,b:2} and {a:2,b:1} collide as duplicates", async () => {
      // The acceptance criterion is "Unique constraint prevents duplicate
      // links regardless of order". A naive UNIQUE(repo_a_id, repo_b_id)
      // would let the model insert (1,2) and (2,1) as two distinct rows.
      // We canonicalize the pair inside an expression index instead, so
      // SQLite stores both orderings under the same key.
      const { knex } = makeKnex();
      await up(knex as any);
      expect(knex.schema.raw).toHaveBeenCalledTimes(1);
      const sql = (knex.schema.raw as jest.Mock).mock.calls[0][0] as string;
      expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
      expect(sql).toMatch(/repo_links/);
      expect(sql).toMatch(/MIN\s*\(\s*repo_a_id\s*,\s*repo_b_id\s*\)/i);
      expect(sql).toMatch(/MAX\s*\(\s*repo_a_id\s*,\s*repo_b_id\s*\)/i);
    });
  });

  describe("down()", () => {
    it("drops the repo_links table cleanly (the unique expression index goes with it)", async () => {
      const { knex } = makeKnex();
      await down(knex as any);
      expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith("repo_links");
    });
  });
});
