import {
  up,
  down,
} from "../src/db/migrations/20260425000003_add_ordering_mode";

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
    dropColumn: jest.fn((...args: unknown[]) => {
      calls.push({ method: "dropColumn", args, chain: null });
    }),
  };
  return { builder, calls };
}

function createKnexMock() {
  const tableCalls: Array<{ table: string; builder: any; calls: any[] }> = [];
  const knex = {
    schema: {
      alterTable: jest.fn(async (table: string, cb: (b: any) => void) => {
        const { builder, calls } = createTableBuilderMock();
        tableCalls.push({ table, builder, calls });
        cb(builder);
      }),
    },
  };
  return { knex, tableCalls };
}

describe("migration 20260425000003_add_ordering_mode", () => {
  describe("up()", () => {
    it("alters both repos and tasks tables", async () => {
      const { knex, tableCalls } = createKnexMock();
      await up(knex as any);

      expect(knex.schema.alterTable).toHaveBeenCalledTimes(2);
      const tables = tableCalls.map((t) => t.table);
      expect(tables).toContain("repos");
      expect(tables).toContain("tasks");
    });

    it("adds ordering_mode (text NOT NULL default 'sequential') to repos", async () => {
      const { knex, tableCalls } = createKnexMock();
      await up(knex as any);

      const reposCall = tableCalls.find((t) => t.table === "repos");
      expect(reposCall).toBeDefined();
      const orderingCall = reposCall!.calls.find(
        (c) => c.method === "text" && c.args[0] === "ordering_mode"
      );
      expect(orderingCall).toBeDefined();
      expect(orderingCall!.chain.notNullable).toHaveBeenCalled();
      expect(orderingCall!.chain.defaultTo).toHaveBeenCalledWith("sequential");
    });

    it("adds ordering_mode (text, nullable) to tasks", async () => {
      const { knex, tableCalls } = createKnexMock();
      await up(knex as any);

      const tasksCall = tableCalls.find((t) => t.table === "tasks");
      expect(tasksCall).toBeDefined();
      const orderingCall = tasksCall!.calls.find(
        (c) => c.method === "text" && c.args[0] === "ordering_mode"
      );
      expect(orderingCall).toBeDefined();
      expect(orderingCall!.chain.nullable).toHaveBeenCalled();
      expect(orderingCall!.chain.notNullable).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("drops ordering_mode from both repos and tasks", async () => {
      const { knex, tableCalls } = createKnexMock();
      await down(knex as any);

      expect(knex.schema.alterTable).toHaveBeenCalledTimes(2);
      const tables = tableCalls.map((t) => t.table);
      expect(tables).toContain("repos");
      expect(tables).toContain("tasks");

      for (const tc of tableCalls) {
        expect(tc.builder.dropColumn).toHaveBeenCalledWith("ordering_mode");
      }
    });
  });
});
