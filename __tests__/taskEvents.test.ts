import { recordEvent, getEventsByTaskId } from "../src/db/taskEvents";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "where",
    "insert",
    "returning",
    "orderBy",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock;
  return { knex, chain };
}

describe("recordEvent", () => {
  it("inserts a row into task_events with task_id, event, and data, returning the inserted row", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = {
      id: 1,
      task_id: 42,
      ts: new Date(),
      event: "claude_started",
      data: { attempt: 1 },
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await recordEvent(knex as any, 42, "claude_started", {
      attempt: 1,
    });

    expect(knex).toHaveBeenCalledWith("task_events");
    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      event: "claude_started",
      data: { attempt: 1 },
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result).toBe(inserted);
  });

  it("inserts data as null when no data is provided", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 2 }]);

    await recordEvent(knex as any, 42, "claimed");

    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      event: "claimed",
      data: null,
    });
  });

  it("normalizes an explicit undefined data argument to null", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 3 }]);

    await recordEvent(knex as any, 42, "retry", undefined);

    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      event: "retry",
      data: null,
    });
  });
});

describe("getEventsByTaskId", () => {
  it("filters by task_id and orders chronologically by ts ascending", async () => {
    const events = [
      { id: 1, task_id: 7, ts: new Date(), event: "claimed", data: null },
      { id: 2, task_id: 7, ts: new Date(), event: "claude_started", data: null },
    ];
    const { knex, chain } = createMockKnex();
    // The second orderBy call is the terminal in the chain — its return value
    // is awaited.
    chain.orderBy
      .mockReturnValueOnce(chain)
      .mockResolvedValueOnce(events);

    const result = await getEventsByTaskId(knex as any, 7);

    expect(knex).toHaveBeenCalledWith("task_events");
    expect(chain.where).toHaveBeenCalledWith({ task_id: 7 });
    // First sort key is ts ascending — this is the chronological contract.
    expect(chain.orderBy).toHaveBeenNthCalledWith(1, "ts", "asc");
    expect(result).toBe(events);
  });

  it("uses id as a tiebreaker so events that share a ts retain insertion order", async () => {
    const { knex, chain } = createMockKnex();
    chain.orderBy
      .mockReturnValueOnce(chain)
      .mockResolvedValueOnce([]);

    await getEventsByTaskId(knex as any, 7);

    // The id ascending tiebreaker keeps two events with identical ts values
    // (sub-ms inserts share now() in PG) in stable insertion order.
    expect(chain.orderBy).toHaveBeenNthCalledWith(2, "id", "asc");
  });
});
