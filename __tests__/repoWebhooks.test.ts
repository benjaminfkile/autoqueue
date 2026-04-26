import {
  createWebhook,
  deleteWebhook,
  getWebhookById,
  getWebhooksByRepoId,
  updateWebhook,
} from "../src/db/repoWebhooks";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "where",
    "insert",
    "update",
    "delete",
    "returning",
    "first",
    "orderBy",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock;
  return { knex, chain };
}

function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    repo_id: 7,
    url: "https://hooks.slack.com/services/X",
    events: JSON.stringify(["done"]),
    active: 1,
    created_at: new Date(),
    ...overrides,
  };
}

describe("getWebhooksByRepoId", () => {
  it("returns webhooks scoped to a repo with events JSON-decoded and active coerced to a boolean", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [
      rowFixture({ id: 1, events: JSON.stringify(["done"]), active: 1 }),
      rowFixture({ id: 2, events: JSON.stringify(["failed"]), active: 0 }),
    ];
    chain.orderBy.mockResolvedValueOnce(rows);

    const result = await getWebhooksByRepoId(knex as any, 7);

    expect(knex).toHaveBeenCalledWith("repo_webhooks");
    expect(chain.where).toHaveBeenCalledWith({ repo_id: 7 });
    expect(chain.orderBy).toHaveBeenCalledWith("id", "asc");
    expect(result).toHaveLength(2);
    expect(result[0].events).toEqual(["done"]);
    expect(result[0].active).toBe(true);
    expect(result[1].events).toEqual(["failed"]);
    // SQLite returns booleans as 0/1 integers; the helper coerces these so
    // callers can rely on real booleans.
    expect(result[1].active).toBe(false);
  });
});

describe("getWebhookById", () => {
  it("returns the row matching the id with events parsed, or undefined", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(
      rowFixture({ id: 1, events: JSON.stringify(["halted"]), active: 1 })
    );

    const result = await getWebhookById(knex as any, 1);

    expect(knex).toHaveBeenCalledWith("repo_webhooks");
    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(result?.events).toEqual(["halted"]);
    expect(result?.active).toBe(true);
  });
});

describe("createWebhook", () => {
  it("inserts the webhook with events JSON-stringified (text storage convention for SQLite)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 1, events: JSON.stringify(["done", "halted"]), active: 1 }),
    ]);

    const result = await createWebhook(knex as any, {
      repo_id: 7,
      url: "https://hooks.slack.com/services/X",
      events: ["done", "halted"],
      active: true,
    });

    expect(knex).toHaveBeenCalledWith("repo_webhooks");
    expect(chain.insert).toHaveBeenCalledWith({
      repo_id: 7,
      url: "https://hooks.slack.com/services/X",
      events: JSON.stringify(["done", "halted"]),
      active: true,
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result.events).toEqual(["done", "halted"]);
    expect(result.active).toBe(true);
  });

  it("defaults active to true when not specified (new webhooks are live by default)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 2, events: JSON.stringify(["done"]), active: 1 }),
    ]);

    await createWebhook(knex as any, {
      repo_id: 1,
      url: "https://x.example.com/h",
      events: ["done"],
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ active: true })
    );
  });
});

describe("updateWebhook", () => {
  it("only patches the columns the caller passed in (omits undefined fields)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 1, active: 0 }),
    ]);

    await updateWebhook(knex as any, 1, { active: false });

    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.update).toHaveBeenCalledWith({ active: false });
  });

  it("re-stringifies events when patching the events array", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 1, events: JSON.stringify(["failed"]) }),
    ]);

    await updateWebhook(knex as any, 1, { events: ["failed"] });

    expect(chain.update).toHaveBeenCalledWith({
      events: JSON.stringify(["failed"]),
    });
  });

  it("supports patching url, events, and active in a single call", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({
        id: 1,
        url: "https://new.example.com/h",
        events: JSON.stringify(["done", "failed"]),
        active: 0,
      }),
    ]);

    await updateWebhook(knex as any, 1, {
      url: "https://new.example.com/h",
      events: ["done", "failed"],
      active: false,
    });

    expect(chain.update).toHaveBeenCalledWith({
      url: "https://new.example.com/h",
      events: JSON.stringify(["done", "failed"]),
      active: false,
    });
  });
});

describe("deleteWebhook", () => {
  it("deletes by id and returns the affected row count", async () => {
    const { knex, chain } = createMockKnex();
    chain.delete.mockResolvedValueOnce(1);

    const result = await deleteWebhook(knex as any, 1);

    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.delete).toHaveBeenCalled();
    expect(result).toBe(1);
  });
});
