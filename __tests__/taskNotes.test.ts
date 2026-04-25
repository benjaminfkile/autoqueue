import { createNote, getNotesForTask } from "../src/db/taskNotes";

function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["where", "insert", "returning", "orderBy"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock & {
    raw: jest.Mock;
  };
  knex.raw = jest.fn();
  return { knex, chain };
}

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------
describe("createNote", () => {
  it("inserts a row into task_notes with task_id, author, visibility, content, and serialized tags", async () => {
    const { knex, chain } = createMockKnex();
    const inserted = {
      id: 1,
      task_id: 42,
      author: "agent",
      visibility: "siblings",
      tags: ["context", "warning"],
      content: "watch out for the migration order",
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const result = await createNote(knex as any, {
      task_id: 42,
      author: "agent",
      visibility: "siblings",
      content: "watch out for the migration order",
      tags: ["context", "warning"],
    });

    expect(knex).toHaveBeenCalledWith("task_notes");
    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      author: "agent",
      visibility: "siblings",
      // tags is serialized so the pg driver receives a value the jsonb column
      // accepts without per-call type-casting.
      tags: JSON.stringify(["context", "warning"]),
      content: "watch out for the migration order",
    });
    expect(chain.returning).toHaveBeenCalledWith("*");
    expect(result).toBe(inserted);
  });

  it("defaults tags to an empty array when omitted (so a NULL is never inserted into the NOT NULL jsonb column)", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning.mockResolvedValueOnce([{ id: 2 }]);

    await createNote(knex as any, {
      task_id: 7,
      author: "user",
      visibility: "self",
      content: "private note",
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: JSON.stringify([]),
      })
    );
  });

  it("accepts both 'agent' and 'user' as authors", async () => {
    const { knex, chain } = createMockKnex();
    chain.returning
      .mockResolvedValueOnce([{ id: 10, author: "agent" }])
      .mockResolvedValueOnce([{ id: 11, author: "user" }]);

    await createNote(knex as any, {
      task_id: 1,
      author: "agent",
      visibility: "all",
      content: "a",
    });
    await createNote(knex as any, {
      task_id: 1,
      author: "user",
      visibility: "all",
      content: "b",
    });

    const calls = chain.insert.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual(expect.objectContaining({ author: "agent" }));
    expect(calls[1]).toEqual(expect.objectContaining({ author: "user" }));
  });
});

// ---------------------------------------------------------------------------
// getNotesForTask — visibility resolution against the task tree
//
// The function issues a single recursive-CTE SQL query that, for the supplied
// task X, returns notes visible to X under the visibility model:
//   - n.task_id == X            → always (the originating task sees its own)
//   - 'siblings'                → notes from tasks sharing X's parent_id
//   - 'descendants'             → notes from strict ancestors of X
//   - 'ancestors'               → notes from strict descendants of X
//   - 'all'                     → notes from any task in X's repo
// We can't run real SQL here, but we assert the predicate shape so a refactor
// can't silently break the visibility contract.
// ---------------------------------------------------------------------------
describe("getNotesForTask", () => {
  it("issues a single raw SQL query and returns the rows", async () => {
    const notes = [
      {
        id: 1,
        task_id: 5,
        author: "agent",
        visibility: "all",
        tags: [],
        content: "hi",
        created_at: new Date(),
      },
    ];
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: notes });

    const result = await getNotesForTask(knex as any, 5);

    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(result).toBe(notes);
  });

  it("binds the task id three times (one per CTE that needs the target)", async () => {
    // The query references the target task id in three places: the ancestors
    // CTE seed, the descendants CTE seed, and the target CTE. Three identical
    // bindings is the contract — fewer would mean a CTE is missing the seed.
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 42);

    const [, bindings] = (knex.raw as jest.Mock).mock.calls[0];
    expect(bindings).toEqual([42, 42, 42]);
  });

  it("uses recursive CTEs to walk both ancestor and descendant chains", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Recursive CTEs are required because the tree is unbounded depth — a
    // single self-join would only catch one generation up/down.
    expect(sql).toMatch(/WITH\s+RECURSIVE/);
    expect(sql).toMatch(/ancestors_of_target/);
    expect(sql).toMatch(/descendants_of_target/);
  });

  it("the ancestors CTE seeds with the target's parent_id (strict ancestors only)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Strict ancestors means we don't include the target itself in this CTE.
    // That's important because 'descendants' notes from N are visible to X
    // only when X is a STRICT descendant of N — including the target in the
    // ancestor set would make a 'descendants' note authored on X also surface
    // to X via this branch (it already surfaces via the n.task_id = target.id
    // branch, so the predicate would double-match). Seeding with parent_id
    // (and a NOT NULL guard) gives strict ancestors.
    expect(sql).toMatch(
      /SELECT\s+t\.parent_id\s+AS\s+id[\s\S]*?WHERE\s+t\.id\s*=\s*\?[\s\S]*?t\.parent_id\s+IS\s+NOT\s+NULL/
    );
  });

  it("the descendants CTE seeds with the target's children (strict descendants only)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Strict descendants means seed = direct children of target (parent_id = ?),
    // not the target itself. Symmetric to the ancestors CTE.
    expect(sql).toMatch(
      /descendants_of_target\s+AS\s*\([\s\S]*?WHERE\s+t\.parent_id\s*=\s*\?/
    );
  });

  it("always returns notes whose task_id == target.id (the originating task always sees its own notes regardless of visibility)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // This is the "self" branch in the visibility resolver: even a note with
    // visibility='self' should always surface to its own task. We assert the
    // catch-all predicate is present so that contract can't be lost in a
    // refactor that tries to fold this into the 'self' visibility check.
    expect(sql).toMatch(/n\.task_id\s*=\s*target\.id/);
  });

  it("'siblings' visibility matches notes whose authoring task shares parent_id with the target (within the same repo, excluding the target itself)", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // IS NOT DISTINCT FROM is required so that root-level tasks (parent_id
    // IS NULL on both sides) compare correctly — a plain "=" returns NULL for
    // NULL=NULL and excludes them.
    expect(sql).toMatch(
      /n\.visibility\s*=\s*'siblings'[\s\S]*?n\.task_id\s*!=\s*target\.id[\s\S]*?nt\.parent_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+target\.parent_id[\s\S]*?nt\.repo_id\s*=\s*target\.repo_id/
    );
  });

  it("'descendants' visibility matches notes whose authoring task is a strict ancestor of the target", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // A note authored on N with visibility='descendants' is meant for tasks
    // BELOW N. Resolved against target X, that means N must be an ancestor of
    // X — i.e. the note's task_id appears in the ancestors_of_target CTE.
    expect(sql).toMatch(
      /n\.visibility\s*=\s*'descendants'[\s\S]*?n\.task_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+ancestors_of_target/
    );
  });

  it("'ancestors' visibility matches notes whose authoring task is a strict descendant of the target", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // Symmetric to the 'descendants' branch: a note authored on N targeted at
    // ancestors is visible to X when N is below X (X is an ancestor of N), i.e.
    // N appears in descendants_of_target.
    expect(sql).toMatch(
      /n\.visibility\s*=\s*'ancestors'[\s\S]*?n\.task_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+descendants_of_target/
    );
  });

  it("'all' visibility matches notes from any task in the same repo as the target", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    // 'all' is repo-scoped — never cross-repo. A bug here would leak notes
    // across unrelated repos, so the repo_id equality is asserted explicitly.
    expect(sql).toMatch(
      /n\.visibility\s*=\s*'all'[\s\S]*?nt\.repo_id\s*=\s*target\.repo_id/
    );
  });

  it("orders results chronologically by created_at, with id as tiebreaker for stable ordering on identical timestamps", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await getNotesForTask(knex as any, 1);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(
      /ORDER\s+BY\s+n\.created_at\s+ASC\s*,\s*n\.id\s+ASC/
    );
  });

  it("returns an empty array when the target has no visible notes", async () => {
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    const result = await getNotesForTask(knex as any, 999);

    expect(result).toEqual([]);
  });
});
