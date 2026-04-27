import { materializeTaskTree } from "../src/services/taskTreeMaterializer";

jest.mock("../src/db/tasks");
jest.mock("../src/db/acceptanceCriteria");

import { createTask } from "../src/db/tasks";
import { createCriterion } from "../src/db/acceptanceCriteria";

// The trx handed to the callback is the same knex mock so call sites can
// invoke createTask(trx, ...) / createCriterion(trx, ...) freely.
function createMockKnex() {
  const knex = jest.fn() as unknown as {
    transaction: jest.Mock;
  };
  (knex as unknown as { transaction: jest.Mock }).transaction = jest.fn(
    async (cb: (trx: unknown) => unknown) => cb(knex)
  );
  return knex;
}

describe("materializeTaskTree", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a single root task with no children or acceptance criteria", async () => {
    const knex = createMockKnex();
    (createTask as jest.Mock).mockResolvedValueOnce({ id: 1, title: "Root" });

    const result = await materializeTaskTree(knex as never, 7, {
      parents: [{ title: "Root" }],
    });

    expect((knex as unknown as { transaction: jest.Mock }).transaction).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: null,
        title: "Root",
        order_position: 0,
        description: "",
      })
    );
    expect(createCriterion).not.toHaveBeenCalled();
    expect(result.parents).toHaveLength(1);
    expect(result.parents[0].id).toBe(1);
    expect(result.parents[0].acceptance_criteria_ids).toEqual([]);
    expect(result.parents[0].children).toEqual([]);
  });

  it("inserts the entire tree inside a single transaction", async () => {
    const knex = createMockKnex();
    let nextId = 100;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));

    await materializeTaskTree(knex as never, 7, {
      parents: [
        { title: "P1", children: [{ title: "C1" }, { title: "C2" }] },
        { title: "P2" },
      ],
    });

    expect((knex as unknown as { transaction: jest.Mock }).transaction).toHaveBeenCalledTimes(1);
    // Every createTask call must receive the same trx object so they all
    // participate in the same transaction.
    const trxArgs = (createTask as jest.Mock).mock.calls.map((c) => c[0]);
    for (const arg of trxArgs) {
      expect(arg).toBe(knex);
    }
  });

  it("creates a nested tree and wires parent_id / order_position correctly", async () => {
    const knex = createMockKnex();
    let nextId = 100;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));

    const result = await materializeTaskTree(knex as never, 7, {
      parents: [
        {
          title: "Phase 1",
          description: "Foundation",
          children: [
            { title: "Schema", children: [{ title: "users table" }] },
            { title: "Routes" },
          ],
        },
        { title: "Phase 2" },
      ],
    });

    // 5 tasks total: Phase 1, Schema, users table, Routes, Phase 2.
    expect(createTask).toHaveBeenCalledTimes(5);

    // Phase 1 inserted first (id 100), its parent_id is null.
    expect(createTask).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: null,
        title: "Phase 1",
        order_position: 0,
        description: "Foundation",
      })
    );
    // Schema inserted second (id 101) under Phase 1 (id 100).
    expect(createTask).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: 100,
        title: "Schema",
        order_position: 0,
      })
    );
    // users table inserted third (id 102) under Schema (id 101).
    expect(createTask).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: 101,
        title: "users table",
        order_position: 0,
      })
    );
    // Routes inserted fourth (id 103) under Phase 1 (id 100), order=1.
    expect(createTask).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: 100,
        title: "Routes",
        order_position: 1,
      })
    );
    // Phase 2 inserted last (id 104), root, order=1.
    expect(createTask).toHaveBeenNthCalledWith(
      5,
      expect.anything(),
      expect.objectContaining({
        repo_id: 7,
        parent_id: null,
        title: "Phase 2",
        order_position: 1,
      })
    );

    // The returned tree must surface the new ids so the GUI can navigate.
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0].id).toBe(100);
    expect(result.parents[0].children).toHaveLength(2);
    expect(result.parents[0].children[0].id).toBe(101);
    expect(result.parents[0].children[0].parent_id).toBe(100);
    expect(result.parents[0].children[0].children[0].id).toBe(102);
    expect(result.parents[0].children[0].children[0].parent_id).toBe(101);
    expect(result.parents[0].children[1].id).toBe(103);
    expect(result.parents[1].id).toBe(104);
  });

  it("creates acceptance criteria for each task with the correct task_id and order", async () => {
    const knex = createMockKnex();
    (createTask as jest.Mock).mockResolvedValueOnce({ id: 42, title: "T" });
    (createCriterion as jest.Mock)
      .mockResolvedValueOnce({ id: 901 })
      .mockResolvedValueOnce({ id: 902 });

    const result = await materializeTaskTree(knex as never, 7, {
      parents: [
        {
          title: "T",
          acceptance_criteria: ["first crit", "second crit"],
        },
      ],
    });

    expect(createCriterion).toHaveBeenNthCalledWith(1, expect.anything(), {
      task_id: 42,
      description: "first crit",
      order_position: 0,
    });
    expect(createCriterion).toHaveBeenNthCalledWith(2, expect.anything(), {
      task_id: 42,
      description: "second crit",
      order_position: 1,
    });
    expect(result.parents[0].acceptance_criteria_ids).toEqual([901, 902]);
  });

  it("rolls back the transaction when a downstream insert fails (all-or-nothing)", async () => {
    const knex = createMockKnex();
    // Parent insert succeeds, child insert fails — the transaction callback
    // must reject so the surrounding trx is rolled back.
    (createTask as jest.Mock)
      .mockResolvedValueOnce({ id: 100, title: "Parent" })
      .mockRejectedValueOnce(new Error("insert failed"));

    await expect(
      materializeTaskTree(knex as never, 7, {
        parents: [
          { title: "Parent", children: [{ title: "Child fails" }] },
        ],
      })
    ).rejects.toThrow("insert failed");

    // The transaction was opened exactly once. The error inside the callback
    // is what propagates out; knex itself is responsible for the rollback,
    // and our contract is simply that we re-throw rather than swallow.
    expect((knex as unknown as { transaction: jest.Mock }).transaction).toHaveBeenCalledTimes(1);
    // No acceptance criteria were created on the half-built tree.
    expect(createCriterion).not.toHaveBeenCalled();
  });

  it("rolls back when an acceptance criterion insert fails after tasks were created", async () => {
    const knex = createMockKnex();
    (createTask as jest.Mock).mockResolvedValueOnce({ id: 1, title: "T" });
    (createCriterion as jest.Mock).mockRejectedValueOnce(
      new Error("ac insert failed")
    );

    await expect(
      materializeTaskTree(knex as never, 7, {
        parents: [{ title: "T", acceptance_criteria: ["bad"] }],
      })
    ).rejects.toThrow("ac insert failed");

    expect((knex as unknown as { transaction: jest.Mock }).transaction).toHaveBeenCalledTimes(1);
  });

  // ---- task #304: per-parent repo_id ----
  it("AC #1098 — writes each top-level subtree against its own repo_id when supplied", async () => {
    const knex = createMockKnex();
    let nextId = 200;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));

    await materializeTaskTree(knex as never, 7, {
      parents: [
        // Inherits the default (7).
        { title: "Backend", children: [{ title: "BE-1" }] },
        // Overrides the default — this whole subtree belongs to repo 8.
        { title: "Frontend", repo_id: 8, children: [{ title: "FE-1" }] },
      ],
    });

    // 4 tasks total: Backend, BE-1, Frontend, FE-1.
    expect(createTask).toHaveBeenCalledTimes(4);

    // Backend (default repo)
    expect(createTask).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ repo_id: 7, title: "Backend", parent_id: null })
    );
    // BE-1 (inherits its parent's repo)
    expect(createTask).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ repo_id: 7, title: "BE-1" })
    );
    // Frontend (override applied)
    expect(createTask).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ repo_id: 8, title: "Frontend", parent_id: null })
    );
    // FE-1 (inherits its parent's overridden repo)
    expect(createTask).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({ repo_id: 8, title: "FE-1" })
    );
  });

  it("AC #1098 — every descendant of an overridden parent uses the parent's repo_id, not the default", async () => {
    const knex = createMockKnex();
    let nextId = 300;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));

    await materializeTaskTree(knex as never, 7, {
      parents: [
        {
          title: "Cross-repo",
          repo_id: 11,
          children: [
            { title: "C1", children: [{ title: "C1.1" }] },
            { title: "C2" },
          ],
        },
      ],
    });

    expect(createTask).toHaveBeenCalledTimes(4);
    for (const call of (createTask as jest.Mock).mock.calls) {
      expect(call[1].repo_id).toBe(11);
    }
  });

  it("AC #1098 — the returned MaterializedTaskTree surfaces each subtree's repo_id", async () => {
    const knex = createMockKnex();
    let nextId = 400;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));

    const result = await materializeTaskTree(knex as never, 7, {
      parents: [
        { title: "BE" },
        { title: "FE", repo_id: 8 },
      ],
    });

    expect(result.parents[0].repo_id).toBe(7);
    expect(result.parents[1].repo_id).toBe(8);
  });
});
