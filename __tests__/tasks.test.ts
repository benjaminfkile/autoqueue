import {
  createTask,
  reconcileOrphanedTasks,
  autoCompleteParentTasks,
  claimNextPendingLeafTask,
  renewTaskLease,
  reclaimExpiredLeaseTasks,
  hasActiveLeasedTask,
  getTasksByRepoId,
  getTaskById,
  getChildTasks,
  updateTask,
  deleteTask,
  resolveTaskModel,
  resolveTaskModelWithSource,
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
    "orWhereNull",
    "orWhere",
    "whereNotIn",
    "whereIn",
    "max",
    "first",
    "insert",
    "update",
    "delete",
    "returning",
    "orderBy",
    "select",
    "pluck",
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
    const { knex, chain } = createMockKnex();
    chain.update.mockResolvedValueOnce(3);

    const count = await reconcileOrphanedTasks(knex as any, "host:123");

    expect(knex).toHaveBeenCalledWith("tasks");
    expect(chain.where).toHaveBeenCalledWith("status", "active");
    expect(chain.andWhere).toHaveBeenCalledWith(expect.any(Function));
    expect(chain.update).toHaveBeenCalledWith({
      status: "pending",
      worker_id: null,
      leased_until: null,
    });
    expect(count).toBe(3);
  });

  it("returns 0 when there are no orphans to reclaim", async () => {
    const { knex, chain } = createMockKnex();
    chain.update.mockResolvedValueOnce(0);

    const count = await reconcileOrphanedTasks(knex as any, "host:123");

    expect(count).toBe(0);
  });

  it("does NOT touch tasks held by a different live worker (the predicate excludes them)", async () => {
    const { knex, chain } = createMockKnex();
    chain.update.mockResolvedValueOnce(0);

    await reconcileOrphanedTasks(knex as any, "host:123");

    // The andWhere callback must use: this worker's ID, OR expired lease, OR null lease
    const cb = (chain.andWhere as jest.Mock).mock.calls[0][0] as (b: any) => void;
    const sub = {
      where: jest.fn().mockReturnThis(),
      orWhereNull: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    };
    cb(sub);
    // Only reclaims this specific worker's tasks — not any worker_id (no wildcard)
    expect(sub.where).toHaveBeenCalledWith("worker_id", "host:123");
    expect(sub.orWhereNull).toHaveBeenCalledWith("leased_until");
    expect(sub.orWhere).toHaveBeenCalledWith("leased_until", "<", expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// reclaimExpiredLeaseTasks — lease-expiry recovery
// ---------------------------------------------------------------------------
describe("reclaimExpiredLeaseTasks", () => {
  it("resets a stale-active task to pending and bumps retry_count", async () => {
    const { knex, chain } = createMockKnex();

    const staleTask = makeTask(1, null, 0, "active", {
      retry_count: 0,
      worker_id: "worker-1",
      leased_until: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    });
    const mockEvent = {
      id: 1,
      task_id: 1,
      event: "lease_expired_reclaimed",
      data: null,
      ts: new Date(),
    };

    chain.andWhere.mockResolvedValueOnce([staleTask]);
    chain.update.mockResolvedValueOnce(1);
    chain.returning.mockResolvedValueOnce([mockEvent]);

    const result = await reclaimExpiredLeaseTasks(knex as any, 1, 3);

    expect(result.resetToPending).toBe(1);
    expect(result.markedFailed).toBe(0);
    expect(chain.update).toHaveBeenCalledWith({
      status: "pending",
      worker_id: null,
      leased_until: null,
      retry_count: 1,
    });
  });

  it("does not reclaim any task when all active tasks have a valid lease", async () => {
    const { knex, chain } = createMockKnex();

    // andWhere returns empty array — no stale tasks
    chain.andWhere.mockResolvedValueOnce([]);

    const result = await reclaimExpiredLeaseTasks(knex as any, 1, 3);

    expect(result.resetToPending).toBe(0);
    expect(result.markedFailed).toBe(0);
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("marks a stale-active task as failed when retries are exhausted (retry_count + 1 >= maxAttempts)", async () => {
    const { knex, chain } = createMockKnex();

    const exhaustedTask = makeTask(1, null, 0, "active", {
      retry_count: 2,  // 2 + 1 = 3 >= maxAttempts (3) → exhausted
      worker_id: "worker-1",
      leased_until: new Date(Date.now() - 10 * 60 * 1000),
    });
    const mockEvent = {
      id: 1,
      task_id: 1,
      event: "lease_expired_reclaimed",
      data: null,
      ts: new Date(),
    };

    chain.andWhere.mockResolvedValueOnce([exhaustedTask]);
    chain.update.mockResolvedValueOnce(1);
    chain.returning.mockResolvedValueOnce([mockEvent]);

    const result = await reclaimExpiredLeaseTasks(knex as any, 1, 3);

    expect(result.markedFailed).toBe(1);
    expect(result.resetToPending).toBe(0);
    expect(chain.update).toHaveBeenCalledWith({
      status: "failed",
      worker_id: null,
      leased_until: null,
      retry_count: 3,
    });
  });

  it("handles multiple stale tasks in one sweep — some reset, some failed", async () => {
    const { knex, chain } = createMockKnex();

    const freshTask = makeTask(1, null, 0, "active", {
      retry_count: 0,
      worker_id: "w1",
      leased_until: new Date(Date.now() - 5 * 60 * 1000),
    });
    const exhaustedTask = makeTask(2, null, 1, "active", {
      retry_count: 2,
      worker_id: "w2",
      leased_until: new Date(Date.now() - 40 * 60 * 1000),
    });
    const mockEvent = { id: 1, task_id: 1, event: "lease_expired_reclaimed", data: null, ts: new Date() };

    chain.andWhere.mockResolvedValueOnce([freshTask, exhaustedTask]);
    // update + event for freshTask
    chain.update.mockResolvedValueOnce(1);
    chain.returning.mockResolvedValueOnce([mockEvent]);
    // update + event for exhaustedTask
    chain.update.mockResolvedValueOnce(1);
    chain.returning.mockResolvedValueOnce([{ ...mockEvent, task_id: 2 }]);

    const result = await reclaimExpiredLeaseTasks(knex as any, 1, 3);

    expect(result.resetToPending).toBe(1);
    expect(result.markedFailed).toBe(1);
    // First update: reset freshTask to pending
    expect(chain.update).toHaveBeenNthCalledWith(1, {
      status: "pending",
      worker_id: null,
      leased_until: null,
      retry_count: 1,
    });
    // Second update: mark exhaustedTask failed
    expect(chain.update).toHaveBeenNthCalledWith(2, {
      status: "failed",
      worker_id: null,
      leased_until: null,
      retry_count: 3,
    });
  });

  it("returns {0, 0} when there are no active tasks at all (repo is idle)", async () => {
    const { knex, chain } = createMockKnex();
    chain.andWhere.mockResolvedValueOnce([]);

    const result = await reclaimExpiredLeaseTasks(knex as any, 99, 3);

    expect(result).toEqual({ resetToPending: 0, markedFailed: 0 });
    expect(chain.update).not.toHaveBeenCalled();
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
  it("loops until no rows are updated", async () => {
    const { knex, chain } = createMockKnex();

    // Iter 1: 2 parent candidates, each has children, all terminal → update 2
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 10 }, { id: 20 }])
      .mockResolvedValueOnce([]);
    chain.first
      .mockResolvedValueOnce({ id: 100 })  // hasChildren(10) = true
      .mockResolvedValueOnce({ id: 200 }); // hasChildren(20) = true
    chain.pluck
      .mockResolvedValueOnce(["done"])           // childStatuses(10)
      .mockResolvedValueOnce(["done", "failed"]); // childStatuses(20)
    chain.update.mockResolvedValueOnce(2);

    const total = await autoCompleteParentTasks(knex as any, 1);

    expect(total).toBe(2);
  });

  it("returns 0 when no parents need completing", async () => {
    const { knex, chain } = createMockKnex();
    chain.whereNotIn.mockResolvedValueOnce([]);

    const total = await autoCompleteParentTasks(knex as any, 1);

    expect(total).toBe(0);
  });

  it("preserves the pre-task-#188 rollup contract: parent → done when all children are terminal (done OR failed)", async () => {
    const { knex, chain } = createMockKnex();

    // One candidate parent whose children are a mix of done and failed (all terminal)
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([]);
    chain.first.mockResolvedValueOnce({ id: 10 });           // hasChildren(7) = true
    chain.pluck.mockResolvedValueOnce(["done", "failed"]);   // childStatuses(7)
    chain.update.mockResolvedValueOnce(1);

    const total = await autoCompleteParentTasks(knex as any, 7, "ignore");

    // Parent is promoted to 'done' when all children are terminal (done OR failed)
    expect(chain.update).toHaveBeenCalledWith({ status: "done" });
    expect(total).toBe(1);
  });
});

describe("autoCompleteParentTasks (policy='cascade_fail')", () => {
  it("issues a failure-cascade UPDATE before the done-rollup so a failed child propagates upward", async () => {
    const { knex, chain } = createMockKnex();
    // Iter 1: fail-sweep finds 1 parent with a failed child → marks it failed
    //         done-sweep finds no candidates
    // Iter 2: both sweeps find nothing → exit
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 1 }])  // iter1 fail-sweep candidates
      .mockResolvedValueOnce([])            // iter1 done-sweep candidates
      .mockResolvedValueOnce([])            // iter2 fail-sweep candidates
      .mockResolvedValueOnce([]);           // iter2 done-sweep candidates
    chain.first.mockResolvedValueOnce({ id: 10 }); // hasChildren(1) = true
    chain.pluck.mockResolvedValueOnce(["done", "failed"]); // childStatuses(1)
    chain.update.mockResolvedValueOnce(1);

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    expect(total).toBe(1);
    // The first (and only) update call must mark the parent 'failed', not 'done'
    expect(chain.update).toHaveBeenNthCalledWith(1, { status: "failed" });
  });

  it("propagates failure transitively: a parent marked failed in iteration N causes its grandparent to be re-evaluated in iteration N+1", async () => {
    const { knex, chain } = createMockKnex();
    // Iter 1: fail-sweep marks 1 parent failed; done-sweep: nothing
    // Iter 2: fail-sweep marks 1 grandparent failed; done-sweep: nothing
    // Iter 3: both sweeps: nothing → exit
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 2 }])  // iter1 fail candidates
      .mockResolvedValueOnce([])            // iter1 done candidates
      .mockResolvedValueOnce([{ id: 3 }])  // iter2 fail candidates (grandparent)
      .mockResolvedValueOnce([])            // iter2 done candidates
      .mockResolvedValueOnce([])            // iter3 fail candidates
      .mockResolvedValueOnce([]);           // iter3 done candidates
    chain.first
      .mockResolvedValueOnce({ id: 10 })  // hasChildren(2)
      .mockResolvedValueOnce({ id: 20 }); // hasChildren(3)
    chain.pluck
      .mockResolvedValueOnce(["done", "failed"])  // childStatuses(2) iter1
      .mockResolvedValueOnce(["done", "failed"]); // childStatuses(3) iter2
    chain.update
      .mockResolvedValueOnce(1)  // iter1 fail update
      .mockResolvedValueOnce(1); // iter2 fail update

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    expect(total).toBe(2);
  });

  it("still promotes a parent to 'done' when all of its children completed successfully (no failed mix)", async () => {
    const { knex, chain } = createMockKnex();
    // Iter 1: fail-sweep: candidate found but all-done predicate fails (no failed child) → ids=[] → 0
    //         done-sweep: same candidate, all-done predicate passes → update 1
    // Iter 2: both sweeps find nothing → exit
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 1 }])  // iter1 fail-sweep
      .mockResolvedValueOnce([{ id: 1 }])  // iter1 done-sweep
      .mockResolvedValueOnce([])            // iter2 fail-sweep
      .mockResolvedValueOnce([]);           // iter2 done-sweep
    chain.first
      .mockResolvedValueOnce({ id: 10 })  // hasChildren(1) for fail-sweep
      .mockResolvedValueOnce({ id: 10 }); // hasChildren(1) for done-sweep
    chain.pluck
      .mockResolvedValueOnce(["done"])   // childStatuses(1) for fail-sweep
      .mockResolvedValueOnce(["done"]); // childStatuses(1) for done-sweep
    chain.update.mockResolvedValueOnce(1);

    const total = await autoCompleteParentTasks(knex as any, 1, "cascade_fail");

    expect(total).toBe(1);
    // Done branch under cascade_fail requires ALL children to be 'done'
    expect(chain.update).toHaveBeenCalledWith({ status: "done" });
  });
});

describe("autoCompleteParentTasks (policy='mark_partial')", () => {
  it("only promotes a parent to 'done' when ALL children are 'done' — a failed child leaves the parent pending", async () => {
    const { knex, chain } = createMockKnex();
    // Candidate has a mix of done + failed children → predicate fails (not all done)
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);
    chain.first.mockResolvedValueOnce({ id: 10 });
    chain.pluck.mockResolvedValueOnce(["done", "failed"]); // fails all-done predicate

    const total = await autoCompleteParentTasks(knex as any, 1, "mark_partial");

    // mark_partial never promotes parents when any child is failed
    expect(chain.update).not.toHaveBeenCalled();
    expect(total).toBe(0);
  });

  it("loops once per round of newly-completed parents and exits when nothing changes", async () => {
    const { knex, chain } = createMockKnex();
    // Iter 1: 2 candidates, all children done → update 2
    // Iter 2: no candidates → exit
    chain.whereNotIn
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([]);
    chain.first
      .mockResolvedValueOnce({ id: 10 })  // hasChildren(1)
      .mockResolvedValueOnce({ id: 20 }); // hasChildren(2)
    chain.pluck
      .mockResolvedValueOnce(["done"])  // childStatuses(1)
      .mockResolvedValueOnce(["done"]); // childStatuses(2)
    chain.update.mockResolvedValueOnce(2);

    const total = await autoCompleteParentTasks(knex as any, 1, "mark_partial");

    expect(total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Helper factories for claimNextPendingLeafTask tests
// ---------------------------------------------------------------------------
function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    owner: null,
    repo_name: null,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    git_pat: null, git_provider: "github", ado_project: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_repo",
    max_retries: 0,
    on_parent_child_fail: "ignore",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeTask(
  id: number,
  parentId: number | null,
  orderPos: number,
  status = "pending",
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    repo_id: 1,
    parent_id: parentId,
    title: `task-${id}`,
    description: "",
    order_position: orderPos,
    status,
    retry_count: 0,
    pr_url: null,
    worker_id: null,
    leased_until: null,
    ordering_mode: null,
    log_path: null,
    requires_approval: false,
    model: null,
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// claimNextPendingLeafTask — in-memory tree walk claim
// ---------------------------------------------------------------------------
describe("claimNextPendingLeafTask", () => {
  it("returns the claimed task with worker_id and leased_until set", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const tasks = [makeTask(5, null, 0)];
    const claimed = {
      ...tasks[0],
      status: "active",
      worker_id: "host:123",
      leased_until: new Date(),
    };

    chain.where
      .mockReturnValueOnce(chain)
      .mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(
      knex as any,
      1,
      "host:123",
      1800
    );

    expect(result).toEqual(claimed);
    expect(knex.transaction).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no eligible task is available (e.g. all locked or none pending)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    // All tasks are done or active — no pending tasks
    const tasks = [makeTask(1, null, 0, "active"), makeTask(2, null, 1, "done")];

    chain.where
      .mockReturnValueOnce(chain)
      .mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(
      knex as any,
      1,
      "host:123",
      1800
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined when the repo row does not exist", async () => {
    const { knex, chain } = createMockKnex();

    chain.where.mockReturnValueOnce(chain);
    chain.first.mockResolvedValueOnce(undefined);

    const result = await claimNextPendingLeafTask(
      knex as any,
      99,
      "host:123",
      1800
    );

    expect(result).toBeUndefined();
  });

  it("branches the failure-guard on r.on_failure: halt_repo blocks while continue does not", async () => {
    // halt_repo: any failed task in the repo blocks all pickup
    const { knex: knex1, chain: chain1 } = createMockKnex();
    const repoHalt = makeRepo({ on_failure: "halt_repo", ordering_mode: "parallel" });
    const tasksWithFailed = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "failed")];
    chain1.where.mockReturnValueOnce(chain1).mockResolvedValueOnce(tasksWithFailed);
    chain1.first.mockResolvedValueOnce(repoHalt);
    expect(await claimNextPendingLeafTask(knex1 as any, 1, "h", 60)).toBeUndefined();

    // continue: same task set, pending task is still claimed
    const { knex: knex2, chain: chain2 } = createMockKnex();
    const repoContinue = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const claimedTask = { ...tasksWithFailed[0], status: "active", worker_id: "h" };
    chain2.where.mockReturnValueOnce(chain2).mockResolvedValueOnce(tasksWithFailed);
    chain2.first.mockResolvedValueOnce(repoContinue);
    chain2.returning.mockResolvedValueOnce([claimedTask]);
    expect(await claimNextPendingLeafTask(knex2 as any, 1, "h", 60)).toEqual(claimedTask);
  });

  it("under 'halt_repo' (default/ELSE branch), any failed task in the repo halts all pickup", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "halt_repo", ordering_mode: "parallel" });
    const tasks = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "failed")];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  it("under 'continue', the failure guard is skipped so unrelated tasks still get picked up", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const tasks = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "failed")];
    const claimed = { ...tasks[0], status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toEqual(claimed);
  });

  it("under 'halt_subtree', blocks a candidate when a failed task shares its parent_id (sibling guard)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "halt_subtree", ordering_mode: "parallel" });
    // task3 is pending but its sibling task2 is failed → task3 blocked
    const tasks = [
      makeTask(1, null, 0, "active"),  // parent (not pending)
      makeTask(2, 1, 0, "failed"),     // failed child
      makeTask(3, 1, 1, "pending"),    // pending sibling of failed → blocked
    ];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  it("under 'halt_subtree', blocks a candidate that is an ancestor of any failed task (ancestor guard)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "halt_subtree", ordering_mode: "parallel" });
    // task1 is pending, its descendant task2 is failed → task1 blocked
    const tasks = [
      makeTask(1, null, 0, "pending"),  // pending parent
      makeTask(2, 1, 0, "failed"),      // failed child → blocks ancestor task1
    ];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  it("under 'halt_subtree', does NOT apply the repo-wide failure guard (so unrelated subtrees keep running)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "halt_subtree", ordering_mode: "parallel" });
    // Subtree A: has a failure. Subtree B: completely clean, should still be claimable.
    const tasks = [
      makeTask(1, null, 0, "active"),   // root A (not pending)
      makeTask(2, 1, 0, "failed"),      // failed in subtree A
      makeTask(3, 1, 1, "pending"),     // pending sibling of failed → blocked in A
      makeTask(4, null, 1, "pending"),  // root B — no relationship to A's failure
    ];
    const claimed = { ...tasks[3], status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // task4 (root B) is unrelated to the failure in subtree A → should be claimed
    expect(result).toEqual(claimed);
  });

  it("joins repos so the repo-level ordering_mode default is available as a fallback", async () => {
    // The repo row is fetched inside the transaction (trx("repos").where.first())
    // and its ordering_mode field is used when the task's parent has no override.
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // Two root-level pending tasks: sequential ordering → only pos=0 is eligible
    const tasks = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "pending")];
    const claimed = { ...tasks[0], status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // Only task1 (pos=0) is eligible under sequential; task2 is blocked
    expect(result).toEqual(claimed);
    // Verify the update targeted task1 (the final where({id}) call)
    const whereCalls = (chain.where as jest.Mock).mock.calls;
    expect(whereCalls[whereCalls.length - 1][0]).toEqual({ id: 1 });
  });

  it("left-joins the parent task so a parent-level ordering_mode override can be read (NULL when no parent)", async () => {
    // A parent task's ordering_mode field is read during the in-memory walk and
    // used as the effective ordering for its children, falling back to the repo
    // ordering_mode when the parent has no override (null).
    const { knex, chain } = createMockKnex();
    // Repo default = sequential. Parent overrides to parallel.
    // Under sequential: task2 (pos=1) would be blocked by task3 (pos=0, active sibling).
    // Under parent's parallel override: task2 is eligible despite active sibling.
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    const parent = makeTask(10, null, 0, "active", { ordering_mode: "parallel" });
    const task3 = makeTask(3, 10, 0, "active");   // active sibling (would block in sequential)
    const task2 = makeTask(2, 10, 1, "pending");  // pending — blocked under sequential, free under parallel
    const tasks = [parent, task3, task2];
    const claimed = { ...task2, status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // task2 is claimed because parent's parallel override takes precedence over repo's sequential
    expect(result).toEqual(claimed);
  });

  it("prefers the parent's ordering_mode when set, falling back to the repo's via COALESCE", async () => {
    // When a parent has ordering_mode=null, the repo's default is used.
    // A parent with ordering_mode='parallel' overrides the repo's 'sequential'.
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // Parent with explicit parallel override
    const parent = makeTask(10, null, 0, "active", { ordering_mode: "parallel" });
    // Two children — under sequential they'd be ordered; under parallel both eligible
    const child1 = makeTask(1, 10, 0, "pending");
    const child2 = makeTask(2, 10, 1, "pending");
    const tasks = [parent, child1, child2];
    const claimed = { ...child1, status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // Both children are eligible (parent=parallel); DFS picks child1 first
    expect(result).toEqual(claimed);
  });

  it("treats a candidate as eligible when its effective ordering_mode is 'parallel' (no order_position gate)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    // Two pending tasks at root — both eligible under parallel, DFS picks pos=0 first
    const tasks = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "pending")];
    const claimed = { ...tasks[0], status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // task1 (pos=0) claimed; task2 (pos=1) was also eligible — no order_position gate
    expect(result).toEqual(claimed);
    expect(result!.id).toBe(1);
  });

  it("for sequential mode, blocks a candidate when an earlier-order_position sibling is still pending or active", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // task1 (pos=0) is pending; task2 (pos=1) is pending but blocked by task1
    const tasks = [makeTask(1, null, 0, "pending"), makeTask(2, null, 1, "pending")];
    const claimed = { ...tasks[0], status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // task1 (pos=0) claimed; task2 was skipped because task1 (earlier sibling) was pending
    expect(result).toEqual(claimed);
    const whereCalls = (chain.where as jest.Mock).mock.calls;
    // The final where call targets the update for task1, not task2
    expect(whereCalls[whereCalls.length - 1][0]).toEqual({ id: 1 });
  });

  it("blocks a candidate whose strict-ancestor lane has earlier work pending/active in another subtree", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // Sequential root children: subtreeA (pos=0) and subtreeB (pos=1).
    // grandchildA (under subtreeA) is eligible; grandchildB (under subtreeB) is
    // blocked because subtreeA still has pending work.
    const subtreeA = makeTask(10, null, 0, "active"); // still active — blocks subtreeB
    const grandchildA = makeTask(1, 10, 0, "pending");
    const subtreeB = makeTask(20, null, 1, "pending"); // pos=1, itself pending
    const grandchildB = makeTask(2, 20, 0, "pending");
    const tasks = [subtreeA, grandchildA, subtreeB, grandchildB];
    const claimed = { ...grandchildA, status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // grandchildA is eligible; grandchildB is blocked because subtreeA (its ancestor-level
    // earlier sibling) still has pending/active work in its subtree
    expect(result).toEqual(claimed);
    const whereCalls = (chain.where as jest.Mock).mock.calls;
    expect(whereCalls[whereCalls.length - 1][0]).toEqual({ id: 1 });
  });

  it("excludes pending tasks with requires_approval=true from the candidate set", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    // Only task has requires_approval=true → skipped → no eligible task
    const tasks = [makeTask(1, null, 0, "pending", { requires_approval: true })];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Leaf guard: tasks with children (phase parents) must never be claimed
  // ---------------------------------------------------------------------------
  it("never claims a parent task whose children are ALL done (leaf guard)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    // parent has two done children — all terminal, but parent is NOT a leaf
    const parent = makeTask(1, null, 0, "pending");
    const child1 = makeTask(2, 1, 0, "done");
    const child2 = makeTask(3, 1, 1, "done");
    const tasks = [parent, child1, child2];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // The parent must not be claimed — autoCompleteParentTasks handles it
    expect(result).toBeUndefined();
  });

  it("never claims a parent task whose children are ALL failed (leaf guard)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const parent = makeTask(1, null, 0, "pending");
    const child1 = makeTask(2, 1, 0, "failed");
    const child2 = makeTask(3, 1, 1, "failed");
    const tasks = [parent, child1, child2];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  it("never claims a parent task with a mix of done and failed children (leaf guard)", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const parent = makeTask(1, null, 0, "pending");
    const child1 = makeTask(2, 1, 0, "done");
    const child2 = makeTask(3, 1, 1, "failed");
    const tasks = [parent, child1, child2];

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    expect(result).toBeUndefined();
  });

  it("single-task phase: claims the one child leaf, never the parent", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // Phase parent (id=1) has exactly one child (id=2). Both pending.
    const parent = makeTask(1, null, 0, "pending");
    const child = makeTask(2, 1, 0, "pending");
    const tasks = [parent, child];
    const claimed = { ...child, status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // The leaf child is claimed, not the parent
    expect(result).toEqual(claimed);
    expect(result!.id).toBe(2);
    // The update targeted the child (id=2), not the parent (id=1)
    const whereCalls = (chain.where as jest.Mock).mock.calls;
    expect(whereCalls[whereCalls.length - 1][0]).toEqual({ id: 2 });
  });

  it("last-task-of-phase: claims the final pending child leaf, never the parent", async () => {
    const { knex, chain } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "sequential" });
    // Phase parent (id=1), two children: first is done, second is still pending
    const parent = makeTask(1, null, 0, "pending");
    const child1 = makeTask(2, 1, 0, "done");
    const child2 = makeTask(3, 1, 1, "pending");
    const tasks = [parent, child1, child2];
    const claimed = { ...child2, status: "active", worker_id: "host:123" };

    chain.where.mockReturnValueOnce(chain).mockResolvedValueOnce(tasks);
    chain.first.mockResolvedValueOnce(repo);
    chain.returning.mockResolvedValueOnce([claimed]);

    const result = await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    // The last pending child is claimed, not the parent
    expect(result).toEqual(claimed);
    expect(result!.id).toBe(3);
    const whereCalls = (chain.where as jest.Mock).mock.calls;
    expect(whereCalls[whereCalls.length - 1][0]).toEqual({ id: 3 });
  });

  it("two concurrent claim calls never return the same task (FOR UPDATE SKIP LOCKED contract)", async () => {
    // Each worker gets its own mock knex so they pick different tasks.
    const { knex: knexA, chain: chainA } = createMockKnex();
    const { knex: knexB, chain: chainB } = createMockKnex();
    const repo = makeRepo({ on_failure: "continue", ordering_mode: "parallel" });
    const taskA = makeTask(5, null, 0, "pending");
    const taskB = makeTask(6, null, 1, "pending");

    const claimedA = { ...taskA, status: "active", worker_id: "worker-a" };
    const claimedB = { ...taskB, status: "active", worker_id: "worker-b" };

    chainA.where.mockReturnValueOnce(chainA).mockResolvedValueOnce([taskA, taskB]);
    chainA.first.mockResolvedValueOnce(repo);
    chainA.returning.mockResolvedValueOnce([claimedA]);

    chainB.where.mockReturnValueOnce(chainB).mockResolvedValueOnce([taskA, taskB]);
    chainB.first.mockResolvedValueOnce(repo);
    chainB.returning.mockResolvedValueOnce([claimedB]);

    const [a, b] = await Promise.all([
      claimNextPendingLeafTask(knexA as any, 1, "worker-a", 1800),
      claimNextPendingLeafTask(knexB as any, 1, "worker-b", 1800),
    ]);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
  });
});

// ---------------------------------------------------------------------------
// hasActiveLeasedTask — strict single-task guard used by the scheduler.
// Task #29 hinges on this: buildWorkQueue claims nothing when it returns
// true, so the query shape and the truthy/falsy mapping are contractual.
// ---------------------------------------------------------------------------
describe("hasActiveLeasedTask", () => {
  it("returns true when a task exists with status='active' and leased_until >= now", async () => {
    const { knex, chain } = createMockKnex();
    // A row is returned → there's an in-flight active task.
    chain.first.mockResolvedValueOnce({
      id: 42,
      status: "active",
      leased_until: new Date(Date.now() + 60_000),
    });

    const result = await hasActiveLeasedTask(knex as any);

    expect(knex).toHaveBeenCalledWith("tasks");
    expect(chain.where).toHaveBeenCalledWith({ status: "active" });
    // The lease-freshness predicate must be leased_until >= now, so a lease
    // that is exactly at the current instant still counts as valid.
    expect(chain.andWhere).toHaveBeenCalledWith(
      "leased_until",
      ">=",
      expect.any(String)
    );
    expect(result).toBe(true);
  });

  it("returns false when no row matches (every active task's lease has expired, or nothing is active at all)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const result = await hasActiveLeasedTask(knex as any);

    expect(result).toBe(false);
  });

  it("uses the supplied `now` when checking freshness so tests can pin the instant deterministically", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const fixed = new Date("2026-08-12T12:00:00.000Z");
    await hasActiveLeasedTask(knex as any, fixed);

    expect(chain.andWhere).toHaveBeenCalledWith(
      "leased_until",
      ">=",
      fixed.toISOString()
    );
  });
});

// ---------------------------------------------------------------------------
// renewTaskLease — bump leased_until to NOW() + leaseSeconds
// ---------------------------------------------------------------------------
describe("renewTaskLease", () => {
  it("issues an UPDATE that sets leased_until for the given task id", async () => {
    const { knex, chain } = createMockKnex();
    chain.update.mockResolvedValueOnce(1);

    await renewTaskLease(knex as any, 42, 1800);

    expect(knex).toHaveBeenCalledWith("tasks");
    expect(chain.where).toHaveBeenCalledWith({ id: 42 });
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ leased_until: expect.any(Date) })
    );
  });

  it("propagates DB errors so callers can log/recover", async () => {
    const { knex, chain } = createMockKnex();
    chain.update.mockRejectedValueOnce(new Error("connection lost"));

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

// ---------------------------------------------------------------------------
// createTask — model field flows through to the insert payload (Phase 11)
// ---------------------------------------------------------------------------
describe("createTask (model field)", () => {
  it("forwards an explicit model string into the insert payload", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({ max_pos: null });
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await createTask(knex as any, {
      repo_id: 1,
      title: "t",
      model: "claude-haiku-4-5",
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" })
    );
  });

  it("inserts model: null when the caller omits it (NULL signals 'inherit' per the resolution rule)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({ max_pos: null });
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await createTask(knex as any, { repo_id: 1, title: "t" });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ model: null })
    );
  });
});

// ---------------------------------------------------------------------------
// resolveTaskModel — task → parent → settings.default_model resolution
//
// Documented rule (see src/db/tasks.ts): the effective Claude model for a
// task is the first non-null value in this lookup chain:
//   1. task.model
//   2. nearest ancestor's model (walk parent_id; first hit wins)
//   3. settings.default_model
// The walk keeps inheritance live — clearing or changing an ancestor
// re-routes descendants without a backfill.
// ---------------------------------------------------------------------------
describe("resolveTaskModel", () => {
  it("returns the task's own model when it is set (rule #1: per-task override wins)", async () => {
    const { knex, chain } = createMockKnex();
    // The first lookup is the task itself; .first() resolves with a row that
    // has a non-null model, so the walk short-circuits and never consults the
    // ancestors or the settings table.
    chain.first.mockResolvedValueOnce({
      model: "claude-opus-4-7",
      parent_id: null,
    });

    const result = await resolveTaskModel(knex as any, 42);

    expect(result).toBe("claude-opus-4-7");
    // Only one tasks lookup; the settings table is never queried.
    expect(knex).toHaveBeenCalledTimes(1);
    expect(knex).toHaveBeenCalledWith("tasks");
  });

  it("walks up parent_id and returns the nearest ancestor's model (rule #2)", async () => {
    const { knex, chain } = createMockKnex();
    // task 30 → null model, parent 20
    // task 20 → model='claude-sonnet-4-6' (the win)
    chain.first
      .mockResolvedValueOnce({ model: null, parent_id: 20 })
      .mockResolvedValueOnce({ model: "claude-sonnet-4-6", parent_id: 10 });

    const result = await resolveTaskModel(knex as any, 30);

    expect(result).toBe("claude-sonnet-4-6");
    // Two tasks lookups, no settings lookup (the ancestor satisfied the rule).
    expect(knex).toHaveBeenCalledTimes(2);
    for (const call of (knex as unknown as jest.Mock).mock.calls) {
      expect(call[0]).toBe("tasks");
    }
  });

  it("falls back to settings.default_model when no task in the chain has a model set (rule #3)", async () => {
    const { knex, chain } = createMockKnex();
    // task 30 → null, parent 20
    // task 20 → null, parent 10
    // task 10 → null, no parent (root)
    // → settings.default_model
    chain.first
      .mockResolvedValueOnce({ model: null, parent_id: 20 })
      .mockResolvedValueOnce({ model: null, parent_id: 10 })
      .mockResolvedValueOnce({ model: null, parent_id: null })
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModel(knex as any, 30);

    expect(result).toBe("claude-sonnet-4-6");
    // 3 tasks lookups + 1 settings lookup.
    const tableCalls = (knex as unknown as jest.Mock).mock.calls.map(
      (c) => c[0]
    );
    expect(tableCalls).toEqual(["tasks", "tasks", "tasks", "settings"]);
  });

  it("treats an empty-string model as 'not set' so legacy/empty values don't poison resolution", async () => {
    const { knex, chain } = createMockKnex();
    chain.first
      .mockResolvedValueOnce({ model: "", parent_id: null })
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModel(knex as any, 1);

    expect(result).toBe("claude-sonnet-4-6");
  });

  it("falls back to settings.default_model when the task id does not exist (defensive: no row to read)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModel(knex as any, 999);

    expect(result).toBe("claude-sonnet-4-6");
  });

  it("does not loop forever if parent_id ever points at an already-visited id (defense against cycles in legacy data)", async () => {
    const { knex, chain } = createMockKnex();
    // task 1 → null, parent 2
    // task 2 → null, parent 1   (cycle)
    // → must terminate and fall back to settings.default_model
    chain.first
      .mockResolvedValueOnce({ model: null, parent_id: 2 })
      .mockResolvedValueOnce({ model: null, parent_id: 1 })
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModel(knex as any, 1);

    expect(result).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskModelWithSource — same chain as resolveTaskModel but reports
// where the resolved model came from so the GUI can render an
// "override / parent / default" badge without re-walking the tree.
// ---------------------------------------------------------------------------
describe("resolveTaskModelWithSource", () => {
  it("reports source='override' when the task itself has a model set", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce({
      model: "claude-opus-4-7",
      parent_id: null,
    });

    const result = await resolveTaskModelWithSource(knex as any, 42);

    expect(result).toEqual({ model: "claude-opus-4-7", source: "override" });
  });

  it("reports source='parent' when an ancestor's model wins the walk", async () => {
    const { knex, chain } = createMockKnex();
    // task 30 → null model, parent 20
    // task 20 → model='claude-sonnet-4-6', parent 10 (the win)
    chain.first
      .mockResolvedValueOnce({ model: null, parent_id: 20 })
      .mockResolvedValueOnce({ model: "claude-sonnet-4-6", parent_id: 10 });

    const result = await resolveTaskModelWithSource(knex as any, 30);

    expect(result).toEqual({ model: "claude-sonnet-4-6", source: "parent" });
  });

  it("reports source='default' when the chain has no overrides and falls back to settings", async () => {
    const { knex, chain } = createMockKnex();
    chain.first
      .mockResolvedValueOnce({ model: null, parent_id: 20 })
      .mockResolvedValueOnce({ model: null, parent_id: null })
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModelWithSource(knex as any, 30);

    expect(result).toEqual({ model: "claude-sonnet-4-6", source: "default" });
  });

  it("treats an empty-string model on the origin task as 'not set' (so source is default, not override)", async () => {
    const { knex, chain } = createMockKnex();
    chain.first
      .mockResolvedValueOnce({ model: "", parent_id: null })
      .mockResolvedValueOnce({
        id: 1,
        default_model: "claude-sonnet-4-6",
        updated_at: "2026-04-26T00:00:00.000Z",
      });

    const result = await resolveTaskModelWithSource(knex as any, 1);

    expect(result).toEqual({ model: "claude-sonnet-4-6", source: "default" });
  });
});
