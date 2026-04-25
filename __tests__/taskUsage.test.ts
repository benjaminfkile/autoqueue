import {
  getUsageRowsForTask,
  getUsageTotalsForRepo,
  getUsageTotalsForTask,
  recordTaskUsage,
} from "../src/db/taskUsage";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "where",
    "insert",
    "returning",
    "orderBy",
    "select",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock & {
    raw: jest.Mock;
  };
  knex.raw = jest.fn((sql: string) => sql);
  return { knex, chain };
}

const sampleUsage = {
  input_tokens: 100,
  output_tokens: 200,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 1000,
};

describe("recordTaskUsage", () => {
  it("inserts a row into task_usage with task_id, repo_id, and the four token fields", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = {
      id: 1,
      task_id: 42,
      repo_id: 7,
      ...sampleUsage,
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await recordTaskUsage(knex as any, {
      task_id: 42,
      repo_id: 7,
      usage: sampleUsage,
    });

    expect(knex).toHaveBeenCalledWith("task_usage");
    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      repo_id: 7,
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 1000,
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result).toBe(inserted);
  });

  it("accepts zero-valued fields without coercion (so a zero-token attempt still produces a row)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 2 }]);

    await recordTaskUsage(knex as any, {
      task_id: 1,
      repo_id: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 0,
        output_tokens: 0,
      })
    );
  });
});

describe("getUsageRowsForTask", () => {
  it("returns rows for a task ordered chronologically (oldest first) so the audit timeline reads naturally", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [{ id: 1 }, { id: 2 }];
    // The final orderBy resolves with the rows.
    chain.orderBy.mockReturnValueOnce(chain).mockResolvedValueOnce(rows);

    const result = await getUsageRowsForTask(knex as any, 42);

    expect(knex).toHaveBeenCalledWith("task_usage");
    expect(chain.where).toHaveBeenCalledWith({ task_id: 42 });
    // First orderBy on created_at asc, then a tie-breaker on id asc.
    expect(chain.orderBy).toHaveBeenNthCalledWith(1, "created_at", "asc");
    expect(chain.orderBy).toHaveBeenNthCalledWith(2, "id", "asc");
    expect(result).toBe(rows);
  });
});

describe("getUsageTotalsForTask", () => {
  it("sums all four token columns scoped by task_id and returns the totals plus run_count", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([
      {
        input_tokens: "300",
        output_tokens: "600",
        cache_creation_input_tokens: "75",
        cache_read_input_tokens: "1500",
        run_count: "3",
      },
    ]);

    const result = await getUsageTotalsForTask(knex as any, 42);

    expect(knex).toHaveBeenCalledWith("task_usage");
    expect(chain.where).toHaveBeenCalledWith({ task_id: 42 });
    expect(result).toEqual({
      input_tokens: 300,
      output_tokens: 600,
      cache_creation_input_tokens: 75,
      cache_read_input_tokens: 1500,
      run_count: 3,
    });
  });

  it("returns zeroed totals (and run_count: 0) when no rows match — callers can render without null-checks", async () => {
    const { knex, chain } = createMockKnex();
    // Postgres COALESCE returns 0 when SUM has no rows, but the COUNT(*) is 0
    // and the entire row may legitimately have all-zero values.
    chain.select.mockResolvedValueOnce([
      {
        input_tokens: "0",
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
        run_count: "0",
      },
    ]);

    const result = await getUsageTotalsForTask(knex as any, 999);

    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      run_count: 0,
    });
  });

  it("survives an empty result set (no rows from the aggregate query at all)", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([]);

    const result = await getUsageTotalsForTask(knex as any, 999);

    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      run_count: 0,
    });
  });
});

describe("getUsageTotalsForRepo", () => {
  it("sums all four token columns scoped by repo_id (mirrors the per-task helper)", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([
      {
        input_tokens: "1000",
        output_tokens: "2000",
        cache_creation_input_tokens: "500",
        cache_read_input_tokens: "5000",
        run_count: "10",
      },
    ]);

    const result = await getUsageTotalsForRepo(knex as any, 7);

    expect(chain.where).toHaveBeenCalledWith({ repo_id: 7 });
    expect(result).toEqual({
      input_tokens: 1000,
      output_tokens: 2000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 5000,
      run_count: 10,
    });
  });
});
