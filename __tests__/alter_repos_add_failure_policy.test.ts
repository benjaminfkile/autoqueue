import {
  up,
  down,
} from "../src/db/migrations/20260425000002_alter_repos_add_failure_policy";

function createColumnBuilderMock() {
  const chain = {
    notNullable: jest.fn().mockReturnThis(),
    defaultTo: jest.fn().mockReturnThis(),
    nullable: jest.fn().mockReturnThis(),
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
    integer: jest.fn((...args: unknown[]) => {
      const chain = createColumnBuilderMock();
      calls.push({ method: "integer", args, chain });
      return chain;
    }),
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args, chain: null });
    }),
  };
  return { builder, calls };
}

describe("migration 20260425000002_alter_repos_add_failure_policy", () => {
  describe("up()", () => {
    it("alters the repos table", async () => {
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
        "repos"
      );
    });

    it("adds on_failure (text NOT NULL default 'halt_repo')", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const onFailureCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "on_failure"
      );
      expect(onFailureCall).toBeDefined();
      expect(onFailureCall!.chain.notNullable).toHaveBeenCalled();
      expect(onFailureCall!.chain.defaultTo).toHaveBeenCalledWith("halt_repo");
    });

    it("adds max_retries (integer NOT NULL default 3)", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const maxRetriesCall = calls.find(
        (c) => c.method === "integer" && c.args[0] === "max_retries"
      );
      expect(maxRetriesCall).toBeDefined();
      expect(maxRetriesCall!.chain.notNullable).toHaveBeenCalled();
      expect(maxRetriesCall!.chain.defaultTo).toHaveBeenCalledWith(3);
    });

    it("adds on_parent_child_fail (text NOT NULL default 'mark_partial')", async () => {
      const { builder, calls } = createTableBuilderMock();
      const knex = {
        schema: {
          alterTable: jest.fn(async (_table: string, cb: (b: any) => void) => {
            cb(builder);
          }),
        },
      };

      await up(knex as any);

      const onParentChildFailCall = calls.find(
        (c) => c.method === "text" && c.args[0] === "on_parent_child_fail"
      );
      expect(onParentChildFailCall).toBeDefined();
      expect(onParentChildFailCall!.chain.notNullable).toHaveBeenCalled();
      expect(onParentChildFailCall!.chain.defaultTo).toHaveBeenCalledWith(
        "mark_partial"
      );
    });
  });

  describe("down()", () => {
    it("drops all three columns", async () => {
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
        "repos",
        expect.any(Function)
      );
      expect(builder.dropColumn).toHaveBeenCalledWith("on_failure");
      expect(builder.dropColumn).toHaveBeenCalledWith("max_retries");
      expect(builder.dropColumn).toHaveBeenCalledWith("on_parent_child_fail");
    });
  });
});
