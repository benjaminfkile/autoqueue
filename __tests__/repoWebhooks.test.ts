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

describe("getWebhooksByRepoId", () => {
  it("returns webhooks scoped to a repo, ordered by id ascending so the GUI list is stable", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [{ id: 1 }, { id: 2 }];
    chain.orderBy.mockResolvedValueOnce(rows);

    const result = await getWebhooksByRepoId(knex as any, 7);

    expect(knex).toHaveBeenCalledWith("repo_webhooks");
    expect(chain.where).toHaveBeenCalledWith({ repo_id: 7 });
    expect(chain.orderBy).toHaveBeenCalledWith("id", "asc");
    expect(result).toBe(rows);
  });
});

describe("getWebhookById", () => {
  it("returns the row matching the id, or undefined", async () => {
    const { knex, chain } = createMockKnex();
    const row = { id: 1 };
    chain.first.mockResolvedValueOnce(row);

    const result = await getWebhookById(knex as any, 1);

    expect(knex).toHaveBeenCalledWith("repo_webhooks");
    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(result).toBe(row);
  });
});

describe("createWebhook", () => {
  it("inserts the webhook with events JSON-stringified (jsonb storage convention)", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = { id: 1 };
    chain.returning.mockResolvedValueOnce([inserted]);

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
    expect(result).toBe(inserted);
  });

  it("defaults active to true when not specified (new webhooks are live by default)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 2 }]);

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
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await updateWebhook(knex as any, 1, { active: false });

    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.update).toHaveBeenCalledWith({ active: false });
  });

  it("re-stringifies events when patching the events array", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await updateWebhook(knex as any, 1, { events: ["failed"] });

    expect(chain.update).toHaveBeenCalledWith({
      events: JSON.stringify(["failed"]),
    });
  });

  it("supports patching url, events, and active in a single call", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

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
