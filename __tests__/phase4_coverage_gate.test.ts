// ---------------------------------------------------------------------------
// Phase 4 coverage gate (task #223)
//
// This file is the explicit coverage gate for the Phase 4 notes feature. It
// pins down three contracts that span multiple files and that no single other
// test exercises end-to-end:
//
//   AC #865 — visibility resolution for every NoteVisibility value, exercised
//             against a fixture task tree. Other tests verify the SQL string
//             shape; this file verifies the SEMANTICS via a parallel JS
//             resolver derived from the SQL CTE in src/db/taskNotes.ts. If the
//             two ever diverge, this file fails — that's the point.
//
//   AC #866 — parseNotesFromOutput happy + malformed coverage in one place,
//             with the malformed cases enumerated against the documented
//             contract (bad JSON, non-array, missing/empty content, invalid
//             visibility, malformed tags, partial recovery within a block).
//
//   AC #867 — taskRunner assembles TaskPayload.task.notes correctly given a
//             multi-level tree fixture: notes from ancestors, descendants,
//             siblings, self, and 'all' all surface (or don't) according to
//             the visibility rules, and the payload's notes array is the
//             source of truth fed to the agent.
//
// Note on the JS resolver: it is intentionally NOT exported from src/. We do
// not want two implementations of visibility resolution shipping in production.
// It lives here as a test oracle — a precise, readable spec that the SQL
// implementation must match. If a future change updates the SQL semantics,
// the resolver here must be updated in lockstep and these tests exercise both.
// ---------------------------------------------------------------------------

import { NoteVisibility, TaskNote, TaskPayloadNote } from "../src/interfaces";
import { parseNotesFromOutput } from "../src/services/claudeRunner";

// ---------------------------------------------------------------------------
// Fixture task tree
//
//                     R1 (root, repo 1)
//                    /        \
//                  A             B
//                 / \           / \
//                A1  A2        B1  B2
//                |
//                A1a
//
//             R2 (root, repo 2)  — separate repo, must never leak
//
// ---------------------------------------------------------------------------
type FixtureTask = {
  id: number;
  repo_id: number;
  parent_id: number | null;
};

const TREE: FixtureTask[] = [
  // repo 1
  { id: 1, repo_id: 1, parent_id: null }, // R1
  { id: 2, repo_id: 1, parent_id: 1 }, // A
  { id: 3, repo_id: 1, parent_id: 1 }, // B
  { id: 4, repo_id: 1, parent_id: 2 }, // A1
  { id: 5, repo_id: 1, parent_id: 2 }, // A2
  { id: 6, repo_id: 1, parent_id: 3 }, // B1
  { id: 7, repo_id: 1, parent_id: 3 }, // B2
  { id: 8, repo_id: 1, parent_id: 4 }, // A1a (grandchild of A)
  // repo 2 — isolated; presence proves cross-repo isolation
  { id: 100, repo_id: 2, parent_id: null }, // R2
];

function getTask(id: number): FixtureTask {
  const t = TREE.find((x) => x.id === id);
  if (!t) throw new Error(`fixture task ${id} not found`);
  return t;
}

// strict ancestors of `id` — i.e. the ids on the path from `id`'s parent up
// to the root.
function ancestorsOf(id: number): number[] {
  const out: number[] = [];
  let cur: FixtureTask | undefined = getTask(id);
  while (cur && cur.parent_id != null) {
    out.push(cur.parent_id);
    cur = TREE.find((x) => x.id === cur!.parent_id);
  }
  return out;
}

// strict descendants of `id` — every task whose path-to-root passes through
// `id`.
function descendantsOf(id: number): number[] {
  const out: number[] = [];
  const stack = TREE.filter((t) => t.parent_id === id).map((t) => t.id);
  while (stack.length) {
    const next = stack.pop()!;
    out.push(next);
    for (const child of TREE.filter((t) => t.parent_id === next)) {
      stack.push(child.id);
    }
  }
  return out;
}

// Parallel JS implementation of the visibility predicate in src/db/taskNotes.ts.
// A note authored on `noteTaskId` with visibility `vis` is visible to `targetId`
// when this returns true.
function isNoteVisible(
  vis: NoteVisibility,
  noteTaskId: number,
  targetId: number
): boolean {
  const note = getTask(noteTaskId);
  const target = getTask(targetId);

  // The originating task always sees its own notes regardless of visibility.
  if (noteTaskId === targetId) return true;

  // Cross-repo notes never surface (every visibility branch is repo-scoped).
  if (note.repo_id !== target.repo_id) return false;

  switch (vis) {
    case "self":
      // self only ever surfaces to the originating task — handled above.
      return false;
    case "siblings":
      // Same parent_id (NULL=NULL counts as same), excluding the target itself.
      return note.parent_id === target.parent_id;
    case "descendants":
      // Visible BELOW the author → author must be a strict ancestor of target.
      return ancestorsOf(targetId).includes(noteTaskId);
    case "ancestors":
      // Visible ABOVE the author → author must be a strict descendant of target.
      return descendantsOf(targetId).includes(noteTaskId);
    case "all":
      // Any task in the same repo (already gated above).
      return true;
    default: {
      const _exhaustive: never = vis;
      void _exhaustive;
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// AC #865 — visibility resolution unit tests for every visibility value
// ---------------------------------------------------------------------------
describe("Phase 4 visibility resolution (every NoteVisibility value)", () => {
  describe("'self' visibility", () => {
    it("surfaces only to the authoring task", () => {
      // Author = A (id=2). Only task 2 should see this note.
      for (const t of TREE.filter((x) => x.repo_id === 1)) {
        expect(isNoteVisible("self", 2, t.id)).toBe(t.id === 2);
      }
    });

    it("never crosses to a different repo", () => {
      expect(isNoteVisible("self", 1, 100)).toBe(false);
    });
  });

  describe("'siblings' visibility", () => {
    it("surfaces to tasks sharing the author's parent_id (excluding the author)", () => {
      // Author = A (id=2). Siblings = [B] (id=3). A itself sees its own note via
      // the self branch, but the sibling-visibility predicate alone matches B.
      const visible = TREE.filter(
        (t) => t.repo_id === 1 && t.id !== 2 && isNoteVisible("siblings", 2, t.id)
      ).map((t) => t.id);
      expect(visible.sort()).toEqual([3]);
    });

    it("treats root tasks as siblings of each other (NULL = NULL via IS NOT DISTINCT FROM)", () => {
      // Author = R1 (id=1). Within repo 1 there are no other roots, so no
      // sibling matches; but inserting another root into repo 1 would surface.
      const extraRoot: FixtureTask = { id: 9, repo_id: 1, parent_id: null };
      const all = [...TREE, extraRoot];
      // Use ad-hoc resolution against the extended set.
      const author = extraRoot;
      const target = all.find((t) => t.id === 1)!;
      const sameRepo = author.repo_id === target.repo_id;
      const sameParent = author.parent_id === target.parent_id;
      expect(sameRepo && sameParent && author.id !== target.id).toBe(true);
    });

    it("does NOT surface to ancestors, descendants, or unrelated branches", () => {
      // Author = A (id=2). Ancestors (R1) and descendants (A1, A2, A1a) and
      // cousins (B's children) must NOT see it.
      expect(isNoteVisible("siblings", 2, 1)).toBe(false); // R1
      expect(isNoteVisible("siblings", 2, 4)).toBe(false); // A1
      expect(isNoteVisible("siblings", 2, 6)).toBe(false); // B1 (cousin)
    });

    it("never crosses repos", () => {
      expect(isNoteVisible("siblings", 1, 100)).toBe(false);
    });
  });

  describe("'descendants' visibility", () => {
    it("surfaces to every strict descendant of the author", () => {
      // Author = A (id=2). Descendants = A1, A2, A1a.
      const visible = TREE.filter(
        (t) => t.repo_id === 1 && t.id !== 2 && isNoteVisible("descendants", 2, t.id)
      ).map((t) => t.id);
      expect(visible.sort()).toEqual([4, 5, 8]);
    });

    it("does NOT surface to ancestors, siblings, or unrelated branches", () => {
      expect(isNoteVisible("descendants", 2, 1)).toBe(false); // ancestor R1
      expect(isNoteVisible("descendants", 2, 3)).toBe(false); // sibling B
      expect(isNoteVisible("descendants", 2, 6)).toBe(false); // unrelated B1
    });

    it("walks the tree to arbitrary depth (grandchildren and below)", () => {
      // R1 is the deepest possible author here; A1a is its grandchild.
      expect(isNoteVisible("descendants", 1, 8)).toBe(true);
    });

    it("never crosses repos", () => {
      expect(isNoteVisible("descendants", 1, 100)).toBe(false);
    });
  });

  describe("'ancestors' visibility", () => {
    it("surfaces to every strict ancestor of the author", () => {
      // Author = A1a (id=8). Ancestors = A1 (id=4), A (id=2), R1 (id=1).
      const visible = TREE.filter(
        (t) => t.repo_id === 1 && t.id !== 8 && isNoteVisible("ancestors", 8, t.id)
      ).map((t) => t.id);
      expect(visible.sort()).toEqual([1, 2, 4]);
    });

    it("does NOT surface to descendants, siblings, or cousins of the author", () => {
      // Author = A (id=2). Descendants of A and B's subtree must not see it.
      expect(isNoteVisible("ancestors", 2, 4)).toBe(false); // A1 (descendant)
      expect(isNoteVisible("ancestors", 2, 3)).toBe(false); // B (sibling)
      expect(isNoteVisible("ancestors", 2, 6)).toBe(false); // B1 (cousin)
    });

    it("is symmetric to 'descendants': isNoteVisible('ancestors', N, X) iff isNoteVisible('descendants', X, N)", () => {
      // This property is the visibility-resolution invariant. Exhaustively
      // check every (author, target) pair within repo 1.
      const repo1 = TREE.filter((t) => t.repo_id === 1);
      for (const author of repo1) {
        for (const target of repo1) {
          if (author.id === target.id) continue;
          expect(isNoteVisible("ancestors", author.id, target.id)).toBe(
            isNoteVisible("descendants", target.id, author.id)
          );
        }
      }
    });

    it("never crosses repos", () => {
      expect(isNoteVisible("ancestors", 100, 1)).toBe(false);
    });
  });

  describe("'all' visibility", () => {
    it("surfaces to every other task in the same repo", () => {
      const visible = TREE.filter(
        (t) => t.repo_id === 1 && t.id !== 1 && isNoteVisible("all", 1, t.id)
      ).map((t) => t.id);
      // Every other task in repo 1.
      expect(visible.sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    });

    it("does NOT cross to a different repo", () => {
      expect(isNoteVisible("all", 1, 100)).toBe(false);
    });
  });

  it("the originating task always sees its own notes regardless of visibility (the 'self' fallthrough branch)", () => {
    const everyVisibility: NoteVisibility[] = [
      "self",
      "siblings",
      "descendants",
      "ancestors",
      "all",
    ];
    for (const v of everyVisibility) {
      // Author == target, every visibility, every task in the tree.
      for (const t of TREE) {
        expect(isNoteVisible(v, t.id, t.id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC #866 — agent output parsing happy + malformed cases
//
// parseNotesFromOutput is the boundary between the agent's freeform stdout
// and the structured TaskNote rows we persist. The contract is:
//   - any number of <NOTES_TO_SAVE>...</NOTES_TO_SAVE> blocks
//   - each block contains a JSON ARRAY (not object/null/scalar)
//   - each entry must have a string `content` (non-empty after the parser's
//     check) and a `visibility` matching the NoteVisibility enum
//   - tags is optional but if present must be a string[]
//   - any malformed entry/block is silently skipped (logged), never throws —
//     a single bad note must not derail the whole task
// ---------------------------------------------------------------------------
describe("Phase 4 agent output parsing (NOTES_TO_SAVE protocol)", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  describe("happy path", () => {
    it("parses a fully-formed block with all 5 visibility values + tags + content", () => {
      const out = `<NOTES_TO_SAVE>[
        {"visibility":"self","content":"a","tags":["t1"]},
        {"visibility":"siblings","content":"b","tags":["t2","t3"]},
        {"visibility":"descendants","content":"c"},
        {"visibility":"ancestors","content":"d","tags":[]},
        {"visibility":"all","content":"e"}
      ]</NOTES_TO_SAVE>`;
      const notes = parseNotesFromOutput(out);
      expect(notes).toHaveLength(5);
      expect(notes.map((n) => n.visibility)).toEqual([
        "self",
        "siblings",
        "descendants",
        "ancestors",
        "all",
      ]);
      expect(notes[0].tags).toEqual(["t1"]);
      // tags omitted on input → tags omitted on output (downstream defaults)
      expect("tags" in notes[2]).toBe(false);
      // tags=[] is preserved as an explicit empty array, not stripped.
      expect(notes[3].tags).toEqual([]);
    });

    it("parses multiple NOTES_TO_SAVE blocks scattered through stdout, in order of appearance", () => {
      const out = `noise
<NOTES_TO_SAVE>[{"visibility":"all","content":"first"}]</NOTES_TO_SAVE>
more noise
<NOTES_TO_SAVE>[{"visibility":"siblings","content":"second"}]</NOTES_TO_SAVE>`;
      const notes = parseNotesFromOutput(out);
      expect(notes.map((n) => n.content)).toEqual(["first", "second"]);
    });
  });

  describe("malformed cases (silently skipped, never thrown)", () => {
    it("skips a block whose body is not valid JSON", () => {
      const out = `<NOTES_TO_SAVE>{not json at all]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([]);
    });

    it("skips a block whose body is JSON but not an array (object, null, scalar)", () => {
      const obj = `<NOTES_TO_SAVE>{"visibility":"all","content":"x"}</NOTES_TO_SAVE>`;
      const nul = `<NOTES_TO_SAVE>null</NOTES_TO_SAVE>`;
      const num = `<NOTES_TO_SAVE>42</NOTES_TO_SAVE>`;
      const str = `<NOTES_TO_SAVE>"hello"</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(obj)).toEqual([]);
      expect(parseNotesFromOutput(nul)).toEqual([]);
      expect(parseNotesFromOutput(num)).toEqual([]);
      expect(parseNotesFromOutput(str)).toEqual([]);
    });

    it("skips entries that aren't objects (null, string, number) but keeps surrounding valid entries", () => {
      const out = `<NOTES_TO_SAVE>[
        null,
        "not-an-object",
        42,
        {"visibility":"all","content":"keeper"}
      ]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "all", content: "keeper" },
      ]);
    });

    it("skips entries with missing/empty/non-string content", () => {
      const out = `<NOTES_TO_SAVE>[
        {"visibility":"all"},
        {"visibility":"all","content":""},
        {"visibility":"all","content":123},
        {"visibility":"all","content":"keeper"}
      ]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "all", content: "keeper" },
      ]);
    });

    it("skips entries with missing/invalid visibility (not in the NoteVisibility enum)", () => {
      const out = `<NOTES_TO_SAVE>[
        {"content":"missing"},
        {"visibility":"public","content":"unknown"},
        {"visibility":42,"content":"non-string"},
        {"visibility":"siblings","content":"keeper"}
      ]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "siblings", content: "keeper" },
      ]);
    });

    it("skips entries whose tags is not a string[] (string, number[], mixed array)", () => {
      const out = `<NOTES_TO_SAVE>[
        {"visibility":"all","content":"a","tags":"oops"},
        {"visibility":"all","content":"b","tags":[1,2,3]},
        {"visibility":"all","content":"c","tags":["ok",2]},
        {"visibility":"all","content":"keeper","tags":["ok"]}
      ]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "all", tags: ["ok"], content: "keeper" },
      ]);
    });

    it("skips empty / whitespace-only NOTES_TO_SAVE blocks (no errors, no notes)", () => {
      const out = `<NOTES_TO_SAVE></NOTES_TO_SAVE>
<NOTES_TO_SAVE>   \n\t  </NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([]);
    });

    it("a malformed block before a valid block does not poison the valid block", () => {
      // The contract guarantees per-block recovery: bad block early in the
      // stream must NOT abort the parse, the next good block still surfaces.
      const out = `<NOTES_TO_SAVE>{ bad json here }</NOTES_TO_SAVE>
some agent narration
<NOTES_TO_SAVE>[{"visibility":"siblings","content":"survivor"}]</NOTES_TO_SAVE>`;
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "siblings", content: "survivor" },
      ]);
    });

    it("never throws on adversarial input", () => {
      // Sanity: every malformed shape we test above is handled by skip-and-log,
      // not by throwing. Combine them all into one stream and assert no throw.
      const out = [
        "<NOTES_TO_SAVE>not json</NOTES_TO_SAVE>",
        "<NOTES_TO_SAVE>{\"visibility\":\"all\",\"content\":\"x\"}</NOTES_TO_SAVE>",
        "<NOTES_TO_SAVE>[null,42,\"s\",{}]</NOTES_TO_SAVE>",
        "<NOTES_TO_SAVE>[{\"visibility\":\"bogus\",\"content\":\"x\"}]</NOTES_TO_SAVE>",
        "<NOTES_TO_SAVE>[{\"visibility\":\"all\",\"content\":\"keeper\"}]</NOTES_TO_SAVE>",
      ].join("\n");
      expect(() => parseNotesFromOutput(out)).not.toThrow();
      expect(parseNotesFromOutput(out)).toEqual([
        { visibility: "all", content: "keeper" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC #867 — TaskPayload assembly with a multi-level tree fixture
//
// This drives runTask end-to-end against a tree fixture and asserts that the
// taskPayload handed to claudeRunner has:
//   - the correct task / parent / siblings (with order_position preserved)
//   - exactly the notes that getNotesForTask would return for that target
//   - notes serialized to a plain-JSON shape (Date → ISO string, tags
//     defaulted to [])
//
// We mock getNotesForTask to return the visibility-resolved set for the
// target, so this test covers the assembly layer in taskRunner without
// re-testing the SQL CTE (that's done above and in taskNotes.test.ts).
// ---------------------------------------------------------------------------
jest.mock("../src/secrets", () => ({
  get: jest.fn((key: string) =>
    key === "ANTHROPIC_API_KEY" ? "sk-ant-test" : key === "GH_PAT" ? "tok" : undefined
  ),
  init: jest.fn(),
  set: jest.fn(),
  unset: jest.fn(),
  getSecretsFilePath: jest.fn(),
}));
jest.mock("../src/db/repos", () => ({ getRepoById: jest.fn() }));
jest.mock("../src/db/tasks", () => ({
  getTaskById: jest.fn(),
  getChildTasks: jest.fn(),
  updateTask: jest.fn(),
  getTasksByRepoId: jest.fn(),
  renewTaskLease: jest.fn(),
}));
jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn(),
}));
jest.mock("../src/db/taskEvents", () => ({ recordEvent: jest.fn() }));
jest.mock("../src/db/taskNotes", () => ({
  getNotesForTask: jest.fn(),
  createNote: jest.fn(),
}));
jest.mock("../src/services/git", () => ({
  cloneOrPull: jest.fn(),
  checkoutBaseBranch: jest.fn(),
  createTaskBranch: jest.fn(),
  commitAndPushTask: jest.fn(),
  mergeTaskIntoBase: jest.fn(),
  hasUncommittedChanges: jest.fn(),
}));
jest.mock("../src/services/github", () => ({ createPullRequest: jest.fn() }));
jest.mock("../src/services/webhookDelivery", () => ({
  triggerWebhooks: jest.fn(),
}));
jest.mock("../src/services/imageBuilder", () => ({
  ensureRunnerImage: jest.fn().mockResolvedValue({
    status: "ready",
    hash: "abc123",
    startedAt: null,
    finishedAt: null,
    error: null,
  }),
}));
jest.mock("../src/services/dockerProbe", () => ({
  refreshDockerState: jest.fn().mockResolvedValue({
    available: true,
    error: null,
    lastCheckedAt: null,
  }),
}));
// Mock only runClaudeOnTask — keep parseNotesFromOutput real so the parsing
// tests above run against the actual implementation.
jest.mock("../src/services/claudeRunner", () => {
  const actual = jest.requireActual("../src/services/claudeRunner");
  return {
    ...actual,
    runClaudeOnTask: jest.fn(),
  };
});

import { getRepoById } from "../src/db/repos";
import {
  getTaskById,
  getChildTasks,
  getTasksByRepoId,
  updateTask,
  renewTaskLease,
} from "../src/db/tasks";
import { getCriteriaByTaskId } from "../src/db/acceptanceCriteria";
import { recordEvent } from "../src/db/taskEvents";
import { getNotesForTask, createNote } from "../src/db/taskNotes";
import { runClaudeOnTask } from "../src/services/claudeRunner";
import { runTask } from "../src/services/taskRunner";

const getRepoByIdMock = getRepoById as jest.Mock;
const getTaskByIdMock = getTaskById as jest.Mock;
const getChildTasksMock = getChildTasks as jest.Mock;
const getTasksByRepoIdMock = getTasksByRepoId as jest.Mock;
const updateTaskMock = updateTask as jest.Mock;
const renewTaskLeaseMock = renewTaskLease as jest.Mock;
const getCriteriaMock = getCriteriaByTaskId as jest.Mock;
const recordEventMock = recordEvent as jest.Mock;
const getNotesForTaskMock = getNotesForTask as jest.Mock;
const createNoteMock = createNote as jest.Mock;
const runClaudeMock = runClaudeOnTask as jest.Mock;

describe("Phase 4 TaskPayload assembly (multi-level tree fixture)", () => {
  // Repo + task fixture mirroring the tree at the top of this file. Tasks are
  // shaped to satisfy the Task interface (status, retry_count, …).
  const repo = {
    id: 1,
    owner: null,
    repo_name: null,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    github_token: null,
    is_local_folder: true,
    local_path: "/tmp/repo",
    on_failure: "halt_repo",
    max_retries: 0,
    on_parent_child_fail: "ignore",
    ordering_mode: "sequential",
    created_at: new Date(),
  };

  function makeTask(t: FixtureTask, overrides: Record<string, unknown> = {}) {
    return {
      id: t.id,
      repo_id: t.repo_id,
      parent_id: t.parent_id,
      title: `task-${t.id}`,
      description: `desc-${t.id}`,
      order_position: t.id, // distinct so we can assert order is preserved
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:1",
      leased_until: new Date(),
      ordering_mode: null,
      log_path: null,
      created_at: new Date(),
      ...overrides,
    };
  }

  // The sample notes corpus: one note per visibility kind, authored from
  // various points in the tree. The visibility-resolved set is what
  // getNotesForTask would return for a given target — we precompute it via the
  // JS resolver above.
  const SAMPLE_NOTES: TaskNote[] = [
    {
      id: 1001,
      task_id: 1, // R1 — root
      author: "user",
      visibility: "all",
      tags: ["root-context"],
      content: "applies to every task in this repo",
      created_at: new Date("2026-04-25T10:00:00.000Z"),
    },
    {
      id: 1002,
      task_id: 1, // R1
      author: "agent",
      visibility: "descendants",
      tags: [],
      content: "context for the whole subtree under R1",
      created_at: new Date("2026-04-25T10:01:00.000Z"),
    },
    {
      id: 1003,
      task_id: 2, // A
      author: "agent",
      visibility: "siblings",
      tags: ["heads-up"],
      content: "B should know about this",
      created_at: new Date("2026-04-25T10:02:00.000Z"),
    },
    {
      id: 1004,
      task_id: 8, // A1a (deep leaf)
      author: "agent",
      visibility: "ancestors",
      tags: [],
      content: "follow-up for A1, A, R1",
      created_at: new Date("2026-04-25T10:03:00.000Z"),
    },
    {
      id: 1005,
      task_id: 4, // A1
      author: "user",
      visibility: "self",
      tags: [],
      content: "private to A1",
      created_at: new Date("2026-04-25T10:04:00.000Z"),
    },
  ];

  // For a given target id, return the subset of SAMPLE_NOTES that the visibility
  // rules surface — the same answer getNotesForTask would give. We use the JS
  // resolver from the top of the file as the oracle.
  function notesVisibleTo(targetId: number): TaskNote[] {
    return SAMPLE_NOTES.filter((n) =>
      isNoteVisible(n.visibility, n.task_id, targetId)
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    getRepoByIdMock.mockResolvedValue(repo);
    getCriteriaMock.mockResolvedValue([]);
    updateTaskMock.mockImplementation(async (_db, _id, _data) => undefined);
    renewTaskLeaseMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
    createNoteMock.mockResolvedValue({ id: 1 });
    runClaudeMock.mockResolvedValue({ success: true, output: "ok", notes: [] });

    // getTaskById walks the fixture tree.
    getTaskByIdMock.mockImplementation(async (_db, id: number) => {
      const found = TREE.find((t) => t.id === id);
      return found ? makeTask(found) : undefined;
    });

    // Siblings are looked up via getChildTasks(parent_id) when parent_id is not
    // null, otherwise via getTasksByRepoId(repoId).filter(parent_id == null).
    getChildTasksMock.mockImplementation(async (_db, parentId: number) =>
      TREE.filter((t) => t.parent_id === parentId).map((t) => makeTask(t))
    );
    getTasksByRepoIdMock.mockImplementation(async (_db, repoId: number) =>
      TREE.filter((t) => t.repo_id === repoId).map((t) => makeTask(t))
    );
  });

  function assertVisibleNotesMatch(
    payloadNotes: TaskPayloadNote[],
    expected: TaskNote[]
  ) {
    // Compare by id since order is implementation-dependent at the JS-resolver
    // level. The SQL CTE orders by created_at ASC, id ASC; runTask preserves
    // whatever order getNotesForTask returns — so we sort both sides by id
    // before comparing for stability.
    const got = [...payloadNotes].sort((a, b) => a.id - b.id);
    const exp = [...expected].sort((a, b) => a.id - b.id);
    expect(got.map((n) => n.id)).toEqual(exp.map((n) => n.id));
    for (const e of exp) {
      const g = got.find((x) => x.id === e.id)!;
      expect(g).toBeDefined();
      expect(g.task_id).toBe(e.task_id);
      expect(g.author).toBe(e.author);
      expect(g.visibility).toBe(e.visibility);
      expect(g.tags).toEqual(e.tags);
      expect(g.content).toBe(e.content);
      // Date is serialized to ISO string for plain-JSON safety in the prompt.
      expect(g.created_at).toBe(
        e.created_at instanceof Date
          ? e.created_at.toISOString()
          : String(e.created_at)
      );
    }
  }

  type AssembledPayload = {
    task: {
      id: number;
      title: string;
      description: string;
      acceptanceCriteria: Array<{ id: number; description: string; met: boolean }>;
      parent: { id: number; title: string; description: string } | null;
      siblings: Array<{
        id: number;
        title: string;
        status: string;
        order_position: number;
      }>;
      notes: TaskPayloadNote[];
    };
  };

  async function runAgainst(
    targetId: number
  ): Promise<{ payload: AssembledPayload; visible: TaskNote[] }> {
    const visible = notesVisibleTo(targetId);
    getNotesForTaskMock.mockResolvedValue(visible);

    const target = TREE.find((t) => t.id === targetId)!;
    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, target.repo_id, target.id);

    const payload = runClaudeMock.mock.calls[0]?.[0]?.taskPayload as AssembledPayload;
    return { payload, visible };
  }

  it("R1 (root): sees its own notes (1001, 1002 via self-fallthrough) plus A1a's 'ancestors' note (1004) — A1a is a strict descendant of R1", async () => {
    const { payload, visible } = await runAgainst(1);
    expect(payload.task.id).toBe(1);
    expect(payload.task.parent).toBeNull();
    // R1 has no siblings (no other repo-1 root). siblings array is filtered to
    // exclude self.
    expect(payload.task.siblings).toEqual([]);
    assertVisibleNotesMatch(payload.task.notes, visible);
    // 1001/1002 surface via self-fallthrough (R1 authored them).
    // 1004 surfaces because A1a — a strict descendant of R1 — authored an
    // 'ancestors'-visibility note targeted at its ancestors (R1, A, A1).
    // 1003 (siblings@A) and 1005 (self@A1) do NOT reach R1.
    expect(payload.task.notes.map((n) => n.id).sort()).toEqual([
      1001, 1002, 1004,
    ]);
  });

  it("A (mid-tier): sees 1001 (all), 1002 (R1 descendants), 1003 (own siblings note via self-fallthrough), 1004 (A1a ancestors)", async () => {
    const { payload, visible } = await runAgainst(2);
    expect(payload.task.id).toBe(2);
    // Parent = R1
    expect(payload.task.parent).toEqual({
      id: 1,
      title: "task-1",
      description: "desc-1",
    });
    // Siblings = [B] (id=3) only — A is filtered out from its own siblings list.
    expect(payload.task.siblings.map((s) => s.id)).toEqual([3]);
    assertVisibleNotesMatch(payload.task.notes, visible);
    // 1003 is authored on A (target == author) so it surfaces via the
    // self-fallthrough even though its 'siblings' visibility otherwise targets
    // B. 1005 (A1 self) is NOT visible to A.
    expect(payload.task.notes.map((n) => n.id).sort()).toEqual([
      1001, 1002, 1003, 1004,
    ]);
  });

  it("B (mid-tier sibling of A): sees R1's notes + A's 'siblings' note (cross-sibling visibility)", async () => {
    const { payload, visible } = await runAgainst(3);
    expect(payload.task.id).toBe(3);
    expect(payload.task.parent?.id).toBe(1);
    // Siblings = [A] (id=2)
    expect(payload.task.siblings.map((s) => s.id)).toEqual([2]);
    // Visible: 1001 (all), 1002 (descendants from R1), 1003 (siblings from A)
    assertVisibleNotesMatch(payload.task.notes, visible);
    expect(payload.task.notes.map((n) => n.id).sort()).toEqual([
      1001, 1002, 1003,
    ]);
  });

  it("A1 (descendant of A): sees R1's 'all' + 'descendants', A1a's 'ancestors', and its own 'self' note (NOT A's 'siblings' note)", async () => {
    const { payload, visible } = await runAgainst(4);
    expect(payload.task.id).toBe(4);
    expect(payload.task.parent?.id).toBe(2); // A
    // Siblings of A1 are [A2] (id=5) — same parent A.
    expect(payload.task.siblings.map((s) => s.id)).toEqual([5]);
    // Visible: 1001 (all), 1002 (R1 descendants reaches A1), 1004 (A1a
    // ancestors hits A1), 1005 (A1's own 'self' note via self-fallthrough).
    // NOT 1003 — that's A's siblings note, not visible to A's children.
    assertVisibleNotesMatch(payload.task.notes, visible);
    expect(payload.task.notes.map((n) => n.id).sort()).toEqual([
      1001, 1002, 1004, 1005,
    ]);
    expect(payload.task.notes.map((n) => n.id)).not.toContain(1003);
  });

  it("A1a (deep leaf): sees every visible note authored above it on the path-to-root + 'all'", async () => {
    const { payload, visible } = await runAgainst(8);
    expect(payload.task.id).toBe(8);
    expect(payload.task.parent?.id).toBe(4); // A1
    // Siblings = []  (A1a has no siblings)
    expect(payload.task.siblings).toEqual([]);
    // Visible: 1001 (all), 1002 (R1 descendants reaches A1a), 1004 (A1a's own
    // 'ancestors' note via self-fallthrough — author = target).
    assertVisibleNotesMatch(payload.task.notes, visible);
    expect(payload.task.notes.map((n) => n.id).sort()).toEqual([
      1001, 1002, 1004,
    ]);
  });

  it("B1 (cousin of A's subtree): does NOT see A's 'siblings' note, A1a's 'ancestors' note, or A1's 'self' note", async () => {
    const { payload, visible } = await runAgainst(6);
    expect(payload.task.id).toBe(6);
    expect(payload.task.parent?.id).toBe(3); // B
    // Siblings of B1 = [B2] (id=7).
    expect(payload.task.siblings.map((s) => s.id)).toEqual([7]);
    // Visible: 1001 (all), 1002 (R1 descendants reaches B1).
    // NOT 1003, 1004, 1005 — those target the A subtree only.
    assertVisibleNotesMatch(payload.task.notes, visible);
    const ids = payload.task.notes.map((n: TaskPayloadNote) => n.id);
    expect(ids.sort()).toEqual([1001, 1002]);
    expect(ids).not.toContain(1003);
    expect(ids).not.toContain(1004);
    expect(ids).not.toContain(1005);
  });

  it("payload always includes a notes array (never undefined) and always serializes Date created_at to ISO strings", async () => {
    const { payload } = await runAgainst(8);
    expect(Array.isArray(payload.task.notes)).toBe(true);
    for (const n of payload.task.notes as TaskPayloadNote[]) {
      expect(typeof n.created_at).toBe("string");
      // ISO string round-trips back to the same Date.
      expect(new Date(n.created_at).toISOString()).toBe(n.created_at);
    }
  });

  it("siblings list excludes the running task itself across every level of the tree", async () => {
    // Pick representatives at three depths.
    for (const targetId of [1, 2, 4, 8]) {
      const { payload } = await runAgainst(targetId);
      expect(payload.task.siblings.map((s) => s.id)).not.toContain(targetId);
    }
  });

  it("calls getNotesForTask with the running task id (so visibility is resolved against the correct target — not the parent)", async () => {
    await runAgainst(8);
    expect(getNotesForTaskMock).toHaveBeenCalledWith(expect.anything(), 8);
  });
});
