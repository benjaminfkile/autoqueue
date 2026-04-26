import {
  createLink,
  deleteLink,
  getLinkById,
  listLinksForRepo,
  updateLinkPermission,
} from "../src/db/repoLinks";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "where",
    "orWhere",
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
    repo_a_id: 1,
    repo_b_id: 2,
    role: null,
    permission: "read",
    created_at: new Date(),
    ...overrides,
  };
}

describe("listLinksForRepo", () => {
  it("returns links where the repo appears on either side, ordered by id", async () => {
    const { knex, chain } = createMockKnex();
    const rows = [
      rowFixture({ id: 1, repo_a_id: 1, repo_b_id: 2 }),
      rowFixture({ id: 2, repo_a_id: 3, repo_b_id: 1 }),
    ];
    chain.orderBy.mockResolvedValueOnce(rows);

    const result = await listLinksForRepo(knex as any, 1);

    expect(knex).toHaveBeenCalledWith("repo_links");
    // Symmetric lookup: a repo can be in either column, so the helper must
    // OR-match on both. Using only `where({ repo_a_id })` would silently miss
    // half the links for any given repo.
    expect(chain.where).toHaveBeenCalledWith({ repo_a_id: 1 });
    expect(chain.orWhere).toHaveBeenCalledWith({ repo_b_id: 1 });
    expect(chain.orderBy).toHaveBeenCalledWith("id", "asc");
    expect(result).toEqual(rows);
  });
});

describe("getLinkById", () => {
  it("looks up a link by id and returns the first row", async () => {
    const { knex, chain } = createMockKnex();
    const row = rowFixture({ id: 7, repo_a_id: 1, repo_b_id: 2 });
    chain.first.mockResolvedValueOnce(row);

    const result = await getLinkById(knex as any, 7);

    expect(knex).toHaveBeenCalledWith("repo_links");
    expect(chain.where).toHaveBeenCalledWith({ id: 7 });
    expect(chain.first).toHaveBeenCalled();
    expect(result).toEqual(row);
  });

  it("returns undefined when no link matches", async () => {
    const { knex, chain } = createMockKnex();
    chain.first.mockResolvedValueOnce(undefined);

    const result = await getLinkById(knex as any, 999);

    expect(result).toBeUndefined();
  });
});

describe("createLink", () => {
  it("normalizes the pair to (min,max) before insert so symmetric inserts collapse to one row", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 1, repo_a_id: 2, repo_b_id: 5 }),
    ]);

    // Caller passes the larger id first. The helper must canonicalize so the
    // unique expression index on (MIN(a,b), MAX(a,b)) sees the same key as a
    // matching call with (2, 5).
    await createLink(knex as any, 5, 2);

    expect(knex).toHaveBeenCalledWith("repo_links");
    expect(chain.insert).toHaveBeenCalledWith({
      repo_a_id: 2,
      repo_b_id: 5,
      role: null,
      permission: "read",
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
  });

  it("preserves an already-ordered pair (the min/max is idempotent for sorted input)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([rowFixture()]);

    await createLink(knex as any, 1, 9);

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ repo_a_id: 1, repo_b_id: 9 })
    );
  });

  it("defaults role to null and permission to 'read' when not supplied", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([rowFixture()]);

    await createLink(knex as any, 1, 2);

    expect(chain.insert).toHaveBeenCalledWith({
      repo_a_id: 1,
      repo_b_id: 2,
      role: null,
      permission: "read",
    });
  });

  it("passes through an explicit role and permission", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ role: "shared-types", permission: "write" }),
    ]);

    const result = await createLink(knex as any, 1, 2, "shared-types", "write");

    expect(chain.insert).toHaveBeenCalledWith({
      repo_a_id: 1,
      repo_b_id: 2,
      role: "shared-types",
      permission: "write",
    });
    expect(result.role).toBe("shared-types");
    expect(result.permission).toBe("write");
  });

  it("returns the inserted row from the returning() result", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = rowFixture({ id: 42, repo_a_id: 1, repo_b_id: 2 });
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createLink(knex as any, 2, 1);

    expect(result).toEqual(inserted);
  });
});

describe("updateLinkPermission", () => {
  it("patches only the permission column for the given id", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([
      rowFixture({ id: 1, permission: "write" }),
    ]);

    const result = await updateLinkPermission(knex as any, 1, "write");

    expect(knex).toHaveBeenCalledWith("repo_links");
    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.update).toHaveBeenCalledWith({ permission: "write" });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result.permission).toBe("write");
  });
});

describe("deleteLink", () => {
  it("deletes by id and returns the affected row count", async () => {
    const { knex, chain } = createMockKnex();
    chain.delete.mockResolvedValueOnce(1);

    const result = await deleteLink(knex as any, 1);

    expect(knex).toHaveBeenCalledWith("repo_links");
    expect(chain.where).toHaveBeenCalledWith({ id: 1 });
    expect(chain.delete).toHaveBeenCalled();
    expect(result).toBe(1);
  });
});
