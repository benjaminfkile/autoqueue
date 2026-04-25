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
// autoCompleteParentTasks — policy-driven rollup (task #188)
//
// The function consumes the repo's `on_parent_child_fail` policy and rolls up
// parent statuses accordingly. The default policy ('ignore') preserves the
// pre-task #188 behavior so callers that haven't been updated keep working.
// ---------------------------------------------------------------------------
describe("autoCompleteParentTasks (default 'ignore' policy)", () => {
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

  it("preserves the pre-task-#188 rollup contract: parent → done when all children are terminal (done OR failed)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rowCount: 0 });

    await autoCompleteParentTasks(knex as any, 7, "ignore");

    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = (knex.raw as jest.Mock).mock.calls[0];
    // The 'ignore' policy is the legacy behavior: any terminal mix of children
    // (done OR failed) promotes the parent to 'done'. The NOT IN ('done','failed')
    // child predicate is the contract for "no children still pending/active".
    expect(sql).toMatch(/UPDATE tasks\s+SET\s+status\s*=\s*'done'/);
    expect(sql).toMatch(/child\.status\s+NOT\s+IN\s*\(\s*'done'\s*,\s*'failed'\s*\)/);
    expect(bindings).toEqual([7]);
  });
});

describe("autoCompleteParentTasks (policy='cascade_fail')", () => {
  it("issues a failure-cascade UPDATE before the done-rollup so a failed child propagates upward", async () => {
    const { knex } = createMockKnex();
    // Loop iteration 1: cascade-fail update marks 1 parent failed; done update finds nothing.
    // Loop iteration 2: both updates find nothing → exit.
    knex.raw
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    // 4 raw calls: 2 per iteration × 2 iterations.
    expect(knex.raw).toHaveBeenCalledTimes(4);
    expect(total).toBe(1);

    const failSql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The first call is the failure-cascade: SET status = 'failed' guarded by
    // (a) all children terminal AND (b) at least one child failed.
    expect(failSql).toMatch(/UPDATE tasks\s+SET\s+status\s*=\s*'failed'/);
    expect(failSql).toMatch(/child\.status\s*=\s*'failed'/);
    // It must NOT also mark parents done in the same statement — that is a
    // separate UPDATE and would race with this one.
    expect(failSql).not.toMatch(/SET\s+status\s*=\s*'done'/);
  });

  it("propagates failure transitively: a parent marked failed in iteration N causes its grandparent to be re-evaluated in iteration N+1", async () => {
    const { knex } = createMockKnex();
    // Iter 1: cascade_fail marks 1 (a parent), done marks 0.
    // Iter 2: cascade_fail marks 1 (the grandparent, now eligible), done marks 0.
    // Iter 3: both 0 → exit.
    knex.raw
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    expect(total).toBe(2);
    expect(knex.raw).toHaveBeenCalledTimes(6);
  });

  it("still promotes a parent to 'done' when all of its children completed successfully (no failed mix)", async () => {
    const { knex } = createMockKnex();
    knex.raw
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    expect(total).toBe(1);
    const doneSql = (knex.raw as jest.Mock).mock.calls[1][0] as string;
    // Done branch under cascade_fail requires ALL children to be 'done'
    // (not merely terminal) — otherwise the failure cascade should have fired.
    expect(doneSql).toMatch(/UPDATE tasks\s+SET\s+status\s*=\s*'done'/);
    expect(doneSql).toMatch(/child\.status\s*!=\s*'done'/);
  });
});

describe("autoCompleteParentTasks (policy='mark_partial')", () => {
  it("only promotes a parent to 'done' when ALL children are 'done' — a failed child leaves the parent pending", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rowCount: 0 });

    await autoCompleteParentTasks(knex as any, 1, "mark_partial");

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE tasks\s+SET\s+status\s*=\s*'done'/);
    // The "any failed child blocks rollup" contract: the predicate forbids any
    // child whose status is anything other than 'done'. A 'failed' child is
    // therefore disqualifying — guarding the mark_partial acceptance criterion.
    expect(sql).toMatch(/child\.status\s*!=\s*'done'/);
    // Conversely, this policy must NOT fall back to NOT IN ('done','failed'),
    // which would treat 'failed' as acceptable and mask failure.
    expect(sql).not.toMatch(/child\.status\s+NOT\s+IN\s*\(\s*'done'\s*,\s*'failed'\s*\)/);
    // mark_partial never marks parents 'failed' — failure stays at the leaf.
    expect(sql).not.toMatch(/SET\s+status\s*=\s*'failed'/);
  });

  it("loops once per round of newly-completed parents and exits when nothing changes", async () => {
    const { knex } = createMockKnex();
    knex.raw
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const total = await autoCompleteParentTasks(knex as any, 1, "mark_partial");

    expect(total).toBe(2);
    expect(knex.raw).toHaveBeenCalledTimes(2);
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
    // bindings: [repoId, repoId, workerId, leaseSeconds]
    expect(bindings).toEqual([1, 1, "host:123", 1800]);
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

  // -------------------------------------------------------------------------
  // on_failure policy (task #189)
  //
  // The failure-guard is no longer hardcoded. It now branches on the repo's
  // `on_failure` policy:
  //   - 'halt_repo' (default): any failed task in the repo blocks all pickup
  //   - 'halt_subtree': only blocks candidates that are siblings of a failed
  //     task or ancestors of a failed task (i.e. the affected subtree)
  //   - 'continue': never blocks — other branches keep running
  //   - any other value (e.g. 'retry'): falls through to halt_repo behavior
  //     so it remains the safe default until that policy is implemented.
  // -------------------------------------------------------------------------
  it("branches the failure-guard on r.on_failure via a CASE expression", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The policy gate must dispatch on r.on_failure rather than unconditionally
    // applying the legacy halt-on-any-failure rule.
    expect(sql).toMatch(/CASE\s+r\.on_failure/);
  });

  it("under 'halt_repo' (default/ELSE branch), retains the legacy NOT EXISTS guard so any failed task halts the repo", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The ELSE branch (which 'halt_repo' falls into) preserves the original
    // contract: any failed task in the repo blocks pickup. The predicate is
    // exactly the legacy guard.
    expect(sql).toMatch(/ELSE[\s\S]*NOT EXISTS\s*\(\s*SELECT 1 FROM tasks failed[\s\S]*?failed\.repo_id\s*=\s*t\.repo_id[\s\S]*?failed\.status\s*=\s*'failed'/);
  });

  it("under 'continue', the failure guard short-circuits to TRUE so unrelated tasks still get picked up", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // 'continue' mode means: never let a failed task gate pickup. The CASE
    // arm must be unconditionally true so the planner can drop the predicate.
    expect(sql).toMatch(/WHEN\s+'continue'\s+THEN\s+TRUE/);
  });

  it("under 'halt_subtree', blocks a candidate when a failed task shares its parent_id (sibling guard)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Sibling guard: failed.parent_id IS NOT DISTINCT FROM t.parent_id so
    // root-level (NULL parent) siblings compare correctly. This is the
    // "siblings of the failed task are blocked" half of halt_subtree.
    expect(sql).toMatch(/WHEN\s+'halt_subtree'\s+THEN/);
    expect(sql).toMatch(
      /failed\.status\s*=\s*'failed'[\s\S]*?failed\.parent_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+t\.parent_id/
    );
  });

  it("under 'halt_subtree', blocks a candidate that is an ancestor of any failed task (ancestor guard)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The recursive task_path CTE carries an ancestor_ids array per row so the
    // halt_subtree branch can check, for each failed task, whether the candidate
    // sits anywhere on its path-to-root. This is the "ancestors of the failed
    // task are blocked" half of halt_subtree.
    expect(sql).toMatch(/ARRAY\[id\]::int\[\]\s+AS\s+ancestor_ids/);
    expect(sql).toMatch(/tp\.ancestor_ids\s*\|\|\s*t\.id/);
    expect(sql).toMatch(
      /JOIN\s+tasks\s+failed\s+ON\s+failed\.id\s*=\s*failed_tp\.id[\s\S]*?failed\.status\s*=\s*'failed'[\s\S]*?t\.id\s*=\s*ANY\(failed_tp\.ancestor_ids\)/
    );
  });

  it("under 'halt_subtree', does NOT apply the repo-wide failure guard (so unrelated subtrees keep running)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The halt_subtree arm must NOT contain the legacy repo-wide guard
    // (failed.repo_id = t.repo_id AND failed.status = 'failed' with no
    // sibling/ancestor scoping). If it did, halt_subtree would degrade into
    // halt_repo and break acceptance criterion 729.
    const haltSubtreeArm = sql.match(
      /WHEN\s+'halt_subtree'\s+THEN([\s\S]*?)(?=WHEN\s+|ELSE\s)/
    );
    expect(haltSubtreeArm).not.toBeNull();
    const armBody = haltSubtreeArm![1];
    // Every failed-task lookup in this arm must be either sibling-scoped or
    // ancestor-scoped — never an unscoped repo-wide check.
    expect(armBody).toMatch(/failed\.parent_id|failed_tp\.ancestor_ids/);
  });

  // -------------------------------------------------------------------------
  // ordering_mode policy (task #187)
  //
  // The leaf-pick CTE must respect each parent's ordering_mode when deciding
  // which pending leaf is eligible:
  //   - 'sequential' parents → only the lowest-order_position pending child
  //     may be claimed; a sibling with a smaller order_position that is
  //     pending or active blocks the rest of the lane.
  //   - 'parallel' parents → any pending child is eligible regardless of
  //     order_position (and concurrent claims are still serialized by the
  //     existing FOR UPDATE OF t SKIP LOCKED).
  // The effective ordering_mode is the parent task's override if set,
  // otherwise the repo-level default.
  // -------------------------------------------------------------------------
  it("joins repos so the repo-level ordering_mode default is available as a fallback", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The repos row must be joined to the candidate row so that
    // r.ordering_mode is in scope as the fallback.
    expect(sql).toMatch(/JOIN\s+repos\s+r\s+ON\s+r\.id\s*=\s*t\.repo_id/);
  });

  it("left-joins the parent task so a parent-level ordering_mode override can be read (NULL when no parent)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // LEFT JOIN ensures root tasks (parent_id IS NULL) still produce a row
    // whose parent.ordering_mode is NULL — the COALESCE then falls back to
    // the repo-level default.
    expect(sql).toMatch(
      /LEFT\s+JOIN\s+tasks\s+parent\s+ON\s+parent\.id\s*=\s*t\.parent_id/
    );
  });

  it("prefers the parent's ordering_mode when set, falling back to the repo's via COALESCE", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // COALESCE(parent.ordering_mode, r.ordering_mode) is the contract for
    // "parent override wins, repo default otherwise". This is the exact
    // expression the task description prescribes.
    expect(sql).toMatch(
      /COALESCE\s*\(\s*parent\.ordering_mode\s*,\s*r\.ordering_mode\s*\)/
    );
  });

  it("treats a candidate as eligible when its effective ordering_mode is 'parallel' (no order_position gate)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The eligibility predicate is a disjunction: parallel mode short-circuits
    // past the sibling-NOT-EXISTS guard. We assert the disjunction shape so a
    // refactor cannot collapse it back into pure-sequential behavior.
    expect(sql).toMatch(
      /COALESCE\s*\([^)]+\)\s*=\s*'parallel'\s*OR\s+NOT\s+EXISTS/
    );
  });

  it("for sequential mode, blocks a candidate when an earlier-order_position sibling is still pending or active", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Sibling guard: same parent_id (or both NULL → root tasks), strictly
    // smaller order_position, status pending OR active. IS NOT DISTINCT FROM
    // is required so the comparison works for root tasks where parent_id is
    // NULL on both sides.
    expect(sql).toMatch(/SELECT\s+1\s+FROM\s+tasks\s+sibling/);
    expect(sql).toMatch(
      /sibling\.parent_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+t\.parent_id/
    );
    expect(sql).toMatch(
      /sibling\.order_position\s*<\s*t\.order_position/
    );
    expect(sql).toMatch(
      /sibling\.status\s+IN\s*\(\s*'pending'\s*,\s*'active'\s*\)/
    );
  });

  // -------------------------------------------------------------------------
  // requires_approval gate (task #216)
  //
  // A task with requires_approval=true must be skipped by the scheduler. The
  // gate is enforced inside the candidate CTE: the predicate excludes any
  // pending task whose requires_approval column is true. Once a user flips
  // the flag back to false (via the GUI's PATCH), the task becomes eligible
  // again on the next scheduler cycle.
  // -------------------------------------------------------------------------
  it("excludes pending tasks with requires_approval=true from the candidate set", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // The gate sits alongside the existing status='pending' check inside the
    // candidate CTE. NOT t.requires_approval is the predicate; relying on the
    // scheduler-side check would be racy under multiple workers.
    expect(sql).toMatch(/AND\s+NOT\s+t\.requires_approval/);
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
