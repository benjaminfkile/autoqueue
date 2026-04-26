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
    const tree = { parents: [{ title: "Reproduce" }] };
    chain.returning.mockResolvedValueOnce([
      {
        id: 1,
        name: "Bug fix template",
        description: "Standard bug fix layout",
        tree: JSON.stringify(tree),
        created_at: new Date(),
      },
    ]);

    const result = await createTemplate(knex as any, {
      name: "Bug fix template",
      description: "Standard bug fix layout",
      tree,
    });

    expect(knex).toHaveBeenCalledWith("task_templates");
    expect(chain.insert).toHaveBeenCalledWith({
      name: "Bug fix template",
      description: "Standard bug fix layout",
      // SQLite stores `tree` as text; the helper JSON-encodes on insert and
      // JSON-decodes on read so callers always see the structured shape.
      tree: JSON.stringify(tree),
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result.tree).toEqual(tree);
  });

  it("defaults description to empty string when omitted (so a NULL is never inserted into the NOT NULL text column)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      { id: 2, tree: JSON.stringify({ parents: [] }) },
    ]);

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
  it("returns templates ordered by created_at desc (most recent first), with each tree JSON-decoded", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [
      { id: 2, tree: JSON.stringify({ parents: [{ title: "B" }] }) },
      { id: 1, tree: JSON.stringify({ parents: [{ title: "A" }] }) },
    ];
    chain.orderBy.mockResolvedValueOnce(rows);

    const result = await getAllTemplates(knex as any);

    expect(knex).toHaveBeenCalledWith("task_templates");
    expect(chain.orderBy).toHaveBeenCalledWith("created_at", "desc");
    expect(result).toHaveLength(2);
    expect(result[0].tree).toEqual({ parents: [{ title: "B" }] });
    expect(result[1].tree).toEqual({ parents: [{ title: "A" }] });
  });
});

describe("getTemplateById", () => {
  it("returns the matching row with tree JSON-decoded when one exists", async () => {
    const { knex, chain } = createMockKnex();
    const tree = { parents: [{ title: "Step 1" }] };
    chain.first.mockResolvedValueOnce({
      id: 7,
      name: "T",
      tree: JSON.stringify(tree),
    });

    const result = await getTemplateById(knex as any, 7);

    expect(chain.where).toHaveBeenCalledWith({ id: 7 });
    expect(chain.first).toHaveBeenCalledTimes(1);
    expect(result?.tree).toEqual(tree);
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
