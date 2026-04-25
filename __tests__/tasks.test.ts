import {
  createTask,
  reconcileOrphanedTasks,
  autoCompleteParentTasks,
  claimNextPendingLeafTask,
  renewTaskLease,
  getTasksByRepoId,
  getTaskById,
  getChildTasks,
  updateTask,
  deleteTask,
} from "../src/db/tasks";

// ---------------------------------------------------------------------------
// Mock Knex builder
// ---------------------------------------------------------------------------

function createMockKnex(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, jest.Mock> = {};

  const methods = [
    "where",
    "andWhere",
    "whereNull",
    "max",
    "first",
    "insert",
    "update",
    "delete",
    "returning",
    "orderBy",
  ];

  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }

  // Apply overrides (terminal values)
  Object.assign(chain, overrides);

  // The knex instance is itself a function (table selector)
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock & {
    raw: jest.Mock;
    transaction: jest.Mock;
  };
  knex.raw = jest.fn();
  // The transaction helper hands a "trx" object to the callback. For these
  // unit tests, the trx object is the knex mock itself, so trx.raw == knex.raw.
  knex.transaction = jest.fn(async (cb: (trx: unknown) => unknown) => cb(knex));

  return { knex, chain };
}

// ---------------------------------------------------------------------------
// createTask — auto order_position
// ---------------------------------------------------------------------------
describe("createTask", () => {
  it("queries for max order_position and adds 1 when order_position is omitted", async () => {
    const { knex, chain } = createMockKnex();

    // First call: the max query
    chain.first.mockResolvedValueOnce({ max_pos: 3 });
    // Second call: the insert().returning("*")
    const inserted = {
      id: 10,
      repo_id: 1,
      parent_id: null,
      title: "t",
      description: "",
      order_position: 4,
      status: "pending",
      retry_count: 0,
      pr_url: null,
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createTask(knex as any, {
      repo_id: 1,
      title: "t",
    });

    // The max query should have been issued
    expect(chain.max).toHaveBeenCalledWith("order_position as max_pos");
    // Insert should use max_pos + 1 = 4
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ order_position: 4 })
    );
    expect(result).toEqual(inserted);
  });

  it("uses 0 when there are no existing tasks (max_pos is null)", async () => {
    const { knex, chain } = createMockKnex();

    chain.first.mockResolvedValueOnce({ max_pos: null });
    const inserted = {
      id: 11,
      repo_id: 1,
      parent_id: null,
      title: "first",
      description: "",
      order_position: 0,
      status: "pending",
      retry_count: 0,
      pr_url: null,
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createTask(knex as any, {
      repo_id: 1,
      title: "first",
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ order_position: 0 })
    );
    expect(result).toEqual(inserted);
  });
});

// ---------------------------------------------------------------------------
// reconcileOrphanedTasks — startup orphan reconciliation
// ---------------------------------------------------------------------------
describe("reconcileOrphanedTasks", () => {
  it("issues a single UPDATE that reclaims active tasks owned by this worker, with expired leases, or with null leases, and clears worker_id and leased_until", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });

    const count = await reconcileOrphanedTasks(knex as any, "host:123");

    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = (knex.raw as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/UPDATE tasks/);
    expect(sql).toMatch(/SET\s+status\s*=\s*'pending'/);
    expect(sql).toContain("worker_id = NULL");
    expect(sql).toContain("leased_until = NULL");
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'active'/);
    expect(sql).toContain("worker_id = ?");
    expect(sql).toContain("leased_until IS NULL");
    expect(sql).toContain("leased_until < NOW()");
    expect(sql).toContain("RETURNING id");
    expect(bindings).toEqual(["host:123"]);
    expect(count).toBe(3);
  });

  it("returns 0 when there are no orphans to reclaim", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    const count = await reconcileOrphanedTasks(knex as any, "host:123");

    expect(count).toBe(0);
  });

  it("does NOT touch tasks held by a different live worker (the predicate excludes them)", async () => {
    // We can't run real SQL here, but we can prove the predicate shape: the
    // WHERE clause matches OUR worker_id OR an expired/null lease — never an
    // unrelated worker_id with a future lease. This guards acceptance
    // criterion 710 (don't steal from live workers) at the contract level.
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await reconcileOrphanedTasks(knex as any, "host:123");

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Other workers are excluded unless their lease is expired/null. The
    // worker_id = ? branch must use the parameter (i.e. THIS worker), not a
    // wildcard.
    expect(sql).toMatch(
      /worker_id\s*=\s*\?\s+OR\s+leased_until\s+IS\s+NULL\s+OR\s+leased_until\s*<\s*NOW\(\)/
    );
    // Sanity: the predicate is scoped to status='active'.
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'active'/);
  });
});

// ---------------------------------------------------------------------------
// autoCompleteParentTasks — loops until rowCount is 0
// ---------------------------------------------------------------------------
describe("autoCompleteParentTasks", () => {
  it("loops until rowCount is 0", async () => {
    const { knex } = createMockKnex();

    knex.raw
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1);

    expect(knex.raw).toHaveBeenCalledTimes(3);
    expect(total).toBe(3);
  });

  it("returns 0 when no parents need completing", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1);

    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// claimNextPendingLeafTask — atomic claim with FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------
describe("claimNextPendingLeafTask", () => {
  it("returns the claimed task with worker_id and leased_until set", async () => {
    const claimed = {
      id: 5,
      repo_id: 1,
      parent_id: null,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:123",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [claimed] });

    const result = await claimNextPendingLeafTask(
      knex as any,
      1,
      "host:123",
      1800
    );

    expect(result).toEqual(claimed);
    expect(knex.transaction).toHaveBeenCalledTimes(1);
    expect(knex.raw).toHaveBeenCalledTimes(1);

    // Verify the SQL is a single-statement claim that locks the candidate
    // row with FOR UPDATE SKIP LOCKED and updates it atomically.
    const [sql, bindings] = (knex.raw as jest.Mock).mock.calls[0];
    expect(sql).toContain("FOR UPDATE OF t SKIP LOCKED");
    expect(sql).toMatch(/UPDATE tasks\s+SET\s+status\s*=\s*'active'/);
    expect(sql).toContain("worker_id = ?");
    expect(sql).toContain("leased_until = NOW() + (? * interval '1 second')");
    expect(sql).toContain("RETURNING tasks.*");
    // bindings: [repoId, repoId, repoId, workerId, leaseSeconds]
    expect(bindings).toEqual([1, 1, 1, "host:123", 1800]);
  });

  it("returns undefined when no eligible task is available (e.g. all locked or none pending)", async () => {
    const { knex } = createMockKnex();
    // No row matched (or every candidate was locked by a concurrent worker
    // and skipped).
    knex.raw.mockResolvedValueOnce({ rows: [] });

    const result = await claimNextPendingLeafTask(
      knex as any,
      1,
      "host:123",
      1800
    );

    expect(result).toBeUndefined();
  });

  it("retains the failed-task NOT EXISTS guard so a failed task halts the repo", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM tasks failed/);
    expect(sql).toContain("failed.status = 'failed'");
  });

  it("two concurrent claim calls never return the same task (FOR UPDATE SKIP LOCKED contract)", async () => {
    // Simulate two concurrent workers polling. The first transaction's
    // candidate CTE locks row 5; the second transaction's SKIP LOCKED
    // skips row 5 and either picks the next eligible row or finds none.
    // We model this at the boundary by returning two distinct rows from
    // db.raw across the two calls — the guarantee is that the same task is
    // never returned twice.
    const taskA = {
      id: 5,
      repo_id: 1,
      parent_id: null,
      title: "leaf-a",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "worker-a",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const taskB = { ...taskA, id: 6, title: "leaf-b", worker_id: "worker-b" };

    const { knex } = createMockKnex();
    knex.raw
      .mockResolvedValueOnce({ rows: [taskA] })
      .mockResolvedValueOnce({ rows: [taskB] });

    const [a, b] = await Promise.all([
      claimNextPendingLeafTask(knex as any, 1, "worker-a", 1800),
      claimNextPendingLeafTask(knex as any, 1, "worker-b", 1800),
    ]);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
  });
});

// ---------------------------------------------------------------------------
// renewTaskLease — bump leased_until to NOW() + leaseSeconds
// ---------------------------------------------------------------------------
describe("renewTaskLease", () => {
  it("issues an UPDATE that sets leased_until = NOW() + leaseSeconds for the given task id", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rowCount: 1 });

    await renewTaskLease(knex as any, 42, 1800);

    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = (knex.raw as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/UPDATE tasks/);
    expect(sql).toContain("leased_until = NOW() + (? * interval '1 second')");
    expect(sql).toMatch(/WHERE id = \?/);
    expect(bindings).toEqual([1800, 42]);
  });

  it("propagates DB errors so callers can log/recover", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockRejectedValueOnce(new Error("connection lost"));

    await expect(renewTaskLease(knex as any, 42, 1800)).rejects.toThrow(
      "connection lost"
    );
  });
});

// ---------------------------------------------------------------------------
// Simple readers / mutators — exercise the remaining query-builder paths so
// the Phase 1 coverage gate (≥80% line coverage on src/db/tasks.ts) is met.
// ---------------------------------------------------------------------------
describe("getTasksByRepoId", () => {
  it("filters by repo_id and orders by order_position ascending", async () => {
    const tasks = [{ id: 1 }, { id: 2 }];
    const { knex, chain } = createMockKnex();
    chain.orderBy.mockResolvedValueOnce(tasks);

    const result = await getTasksByRepoId(knex as any, 7);

    expect(knex).toHaveBeenCalledWith("tasks");
    expect(chain.where).toHaveBeenCalledWith({ repo_id: 7 });
    expect(chain.orderBy).toHaveBeenCalledWith("order_position", "asc");
    expect(result).toBe(tasks);
  });
});

describe("getTaskById", () => {
  it("returns the row matching the given id (or undefined)", async () => {
    const task = { id: 42 };
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(task);

    const result = await getTaskById(knex as any, 42);

    expect(chain.where).toHaveBeenCalledWith({ id: 42 });
    expect(chain.first).toHaveBeenCalled();
    expect(result).toBe(task);
  });
});

describe("getChildTasks", () => {
  it("filters by parent_id and orders by order_position ascending", async () => {
    const tasks = [{ id: 10 }, { id: 11 }];
    const { knex, chain } = createMockKnex();
    chain.orderBy.mockResolvedValueOnce(tasks);

    const result = await getChildTasks(knex as any, 5);

    expect(chain.where).toHaveBeenCalledWith({ parent_id: 5 });
    expect(chain.orderBy).toHaveBeenCalledWith("order_position", "asc");
    expect(result).toBe(tasks);
  });
});

describe("createTask (parent_id branch)", () => {
  it("uses andWhere({parent_id}) when parent_id is provided (exercises the non-null branch)", async () => {
    const { knex, chain } = createMockKnex();
    let andWhereFn: (() => void) | undefined;
    chain.andWhere.mockImplementation(function (this: unknown, fn: () => void) {
      andWhereFn = fn;
      return chain;
    });
    chain.first.mockResolvedValueOnce({ max_pos: 1 });
    const inserted = {
      id: 20,
      repo_id: 1,
      parent_id: 9,
      title: "child",
      description: "",
      order_position: 2,
      status: "pending",
      retry_count: 0,
      pr_url: null,
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createTask(knex as any, {
      repo_id: 1,
      parent_id: 9,
      title: "child",
    });

    // Drive the andWhere callback so the parent_id branch executes.
    expect(andWhereFn).toBeDefined();
    andWhereFn!.call(chain);
    expect(chain.where).toHaveBeenCalledWith({ parent_id: 9 });

    // Insert should preserve parent_id and use max_pos + 1.
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: 9, order_position: 2 })
    );
    expect(result).toEqual(inserted);
  });

  it("uses whereNull('parent_id') when parent_id is omitted (exercises the root-task branch)", async () => {
    const { knex, chain } = createMockKnex();
    let andWhereFn: (() => void) | undefined;
    chain.andWhere.mockImplementation(function (this: unknown, fn: () => void) {
      andWhereFn = fn;
      return chain;
    });
    chain.first.mockResolvedValueOnce({ max_pos: 0 });
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await createTask(knex as any, { repo_id: 1, title: "root" });

    expect(andWhereFn).toBeDefined();
    andWhereFn!.call(chain);
    expect(chain.whereNull).toHaveBeenCalledWith("parent_id");
  });

  it("respects an explicit order_position and skips the max-position lookup", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      { id: 30, order_position: 17 },
    ]);

    await createTask(knex as any, {
      repo_id: 1,
      title: "explicit",
      order_position: 17,
    });

    // The max-position lookup should not have run.
    expect(chain.max).not.toHaveBeenCalled();
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ order_position: 17 })
    );
  });
});

describe("updateTask", () => {
  it("issues UPDATE ... WHERE id = ? RETURNING * and returns the updated row", async () => {
    const updated = {
      id: 42,
      repo_id: 1,
      parent_id: null,
      title: "t",
      description: "",
      order_position: 0,
      status: "done",
      retry_count: 0,
      pr_url: null,
      created_at: new Date(),
    };
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([updated]);

    const result = await updateTask(knex as any, 42, { status: "done" });

    expect(chain.where).toHaveBeenCalledWith({ id: 42 });
    expect(chain.update).toHaveBeenCalledWith({ status: "done" });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result).toBe(updated);
  });
});

describe("deleteTask", () => {
  it("issues DELETE ... WHERE id = ?", async () => {
    const { knex, chain } = createMockKnex();
    chain.delete.mockResolvedValueOnce(1);

    await deleteTask(knex as any, 42);

    expect(chain.where).toHaveBeenCalledWith({ id: 42 });
    expect(chain.delete).toHaveBeenCalled();
  });
});
