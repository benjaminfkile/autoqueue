import {
  createTask,
  resetActiveTasks,
  autoCompleteParentTasks,
  getNextPendingLeafTask,
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
  };
  knex.raw = jest.fn();

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
// resetActiveTasks
// ---------------------------------------------------------------------------
describe("resetActiveTasks", () => {
  it("updates active tasks to pending and returns count", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const count = await resetActiveTasks(knex as any);

    expect(chain.where).toHaveBeenCalledWith({ status: "active" });
    expect(chain.update).toHaveBeenCalledWith({ status: "pending" });
    expect(count).toBe(2);
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
// getNextPendingLeafTask — NOT EXISTS (failed tasks) guard
// ---------------------------------------------------------------------------
describe("getNextPendingLeafTask", () => {
  it("returns the first pending leaf task", async () => {
    const task = {
      id: 5,
      repo_id: 1,
      parent_id: null,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "pending",
      retry_count: 0,
      pr_url: null,
      created_at: new Date(),
    };
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [task] });

    const result = await getNextPendingLeafTask(knex as any, 1);

    expect(result).toEqual(task);
    expect(knex.raw).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when a failed task exists for the repo (NOT EXISTS guard)", async () => {
    const { knex } = createMockKnex();
    // The query returns no rows because the NOT EXISTS (failed tasks) clause
    // filters everything out when a failed task exists
    knex.raw.mockResolvedValueOnce({ rows: [] });

    const result = await getNextPendingLeafTask(knex as any, 1);

    expect(result).toBeUndefined();

    // Verify the SQL contains the NOT EXISTS guard for failed tasks
    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("failed");
    // Specifically verify the failed-task guard is a separate NOT EXISTS clause
    // that checks for any failed task in the repo
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM tasks failed/);
    expect(sql).toContain("failed.status = 'failed'");
  });
});
