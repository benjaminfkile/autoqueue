import {
  createTemplate,
  deleteTemplate,
  getAllTemplates,
  getTemplateById,
} from "../src/db/taskTemplates";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "where",
    "first",
    "insert",
    "returning",
    "orderBy",
    "delete",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock;
  return { knex, chain };
}

describe("createTemplate", () => {
  it("inserts a row into task_templates with name, description, and serialized tree", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = {
      id: 1,
      name: "Bug fix template",
      description: "Standard bug fix layout",
      tree: { parents: [{ title: "Reproduce" }] },
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createTemplate(knex as any, {
      name: "Bug fix template",
      description: "Standard bug fix layout",
      tree: { parents: [{ title: "Reproduce" }] },
    });

    expect(knex).toHaveBeenCalledWith("task_templates");
    expect(chain.insert).toHaveBeenCalledWith({
      name: "Bug fix template",
      description: "Standard bug fix layout",
      // The jsonb column receives a JSON string; this matches how task_notes
      // serializes its jsonb columns and avoids per-call type casting.
      tree: JSON.stringify({ parents: [{ title: "Reproduce" }] }),
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result).toBe(inserted);
  });

  it("defaults description to empty string when omitted (so a NULL is never inserted into the NOT NULL text column)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 2 }]);

    await createTemplate(knex as any, {
      name: "Minimal",
      tree: { parents: [{ title: "Step 1" }] },
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ description: "" })
    );
  });
});

describe("getAllTemplates", () => {
  it("returns templates ordered by created_at desc (most recent first)", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [{ id: 2 }, { id: 1 }];
    chain.orderBy.mockResolvedValueOnce(rows);

    const result = await getAllTemplates(knex as any);

    expect(knex).toHaveBeenCalledWith("task_templates");
    expect(chain.orderBy).toHaveBeenCalledWith("created_at", "desc");
    expect(result).toBe(rows);
  });
});

describe("getTemplateById", () => {
  it("returns the matching row when one exists", async () => {
    const { knex, chain } = createMockKnex();
    const row = { id: 7, name: "T", tree: {} };
    chain.first.mockResolvedValueOnce(row);

    const result = await getTemplateById(knex as any, 7);

    expect(chain.where).toHaveBeenCalledWith({ id: 7 });
    expect(chain.first).toHaveBeenCalledTimes(1);
    expect(result).toBe(row);
  });

  it("resolves to undefined when no row matches", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const result = await getTemplateById(knex as any, 999);

    expect(result).toBeUndefined();
  });
});

describe("deleteTemplate", () => {
  it("deletes the row in task_templates whose id matches and returns the affected count", async () => {
    const { knex, chain } = createMockKnex();
    chain.delete.mockResolvedValueOnce(1);

    const result = await deleteTemplate(knex as any, 4);

    expect(knex).toHaveBeenCalledWith("task_templates");
    expect(chain.where).toHaveBeenCalledWith({ id: 4 });
    expect(chain.delete).toHaveBeenCalledTimes(1);
    expect(result).toBe(1);
  });

  it("resolves to 0 when no row matches the supplied id (idempotent delete)", async () => {
    const { knex, chain } = createMockKnex();
    chain.delete.mockResolvedValueOnce(0);

    const result = await deleteTemplate(knex as any, 999);

    expect(result).toBe(0);
  });
});
