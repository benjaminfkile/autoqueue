// ---------------------------------------------------------------------------
// Phase 7 coverage gate (task #226)
//
// Pins down the four contracts that ship Phase 7 (polish features) and that
// no single other test exercises end-to-end:
//
//   AC #874 — Approval-gate skip path covered. Tasks with requires_approval=true
//             must be silently skipped by the scheduler. The gate lives inside
//             the candidate-CTE in claimNextPendingLeafTask, so a refactor that
//             accidentally removes the predicate (or moves it to a non-atomic
//             scheduler-side check) would let the scheduler pick up tasks that
//             were explicitly held for human review. We exercise:
//               - the SQL predicate itself (AND NOT t.requires_approval)
//               - the scheduler integration: buildWorkQueue silently skips a
//                 repo whose only pending leaf is held for approval
//               - the unblock path: flipping the flag back to false makes the
//                 same task claimable on the next cycle
//
//   AC #875 — Template round-trip asserts equivalence after instantiate. A
//             template captured from a populated repo and immediately
//             re-materialized into a fresh repo must produce a structurally
//             identical task tree (titles, descriptions, acceptance criteria,
//             children) with runtime-only state stripped. This is the core
//             "save & reuse" promise of the templates feature.
//
//   AC #876 — Webhook retry logic covered. The contract has three branches:
//               1. success on the first attempt → ok=true, attempts=1
//               2. 5xx then 200 → retried, eventually ok=true
//               3. 5xx forever → eventual drop after MAX_DELIVERY_ATTEMPTS
//             Plus the orthogonal cases that complete the table: 4xx is not
//             retried (permanent client error), and network errors retry the
//             same as 5xx (transient by assumption).
//
// Plus (mentioned in the task description but not a numbered AC): task_usage
// rows are created from a stubbed Anthropic-shape usage object. The end-to-end
// shape is "Anthropic SDK -> claudeRunner.parseUsageFromOutput -> taskRunner
// -> recordTaskUsage", so this gate drives a stubbed usage object through the
// real parser and asserts the four-column row that lands in the DB layer.
// ---------------------------------------------------------------------------

import {
  claimNextPendingLeafTask,
} from "../src/db/tasks";
import {
  deliverWebhook,
  fireWebhooksForRepo,
  MAX_DELIVERY_ATTEMPTS,
  WebhookPayload,
} from "../src/services/webhookDelivery";
import { parseUsageFromOutput } from "../src/services/claudeRunner";
import { recordTaskUsage } from "../src/db/taskUsage";
import { buildTemplateFromRepo } from "../src/services/taskTemplateBuilder";
import { materializeTaskTree } from "../src/services/taskTreeMaterializer";
import {
  ProposedTaskNode,
  TaskTreeProposal,
} from "../src/services/chatService";
import { Repo, RepoWebhook, Task, TokenUsage } from "../src/interfaces";

// Mocks for the template round-trip path. The DB modules are mocked at the
// module boundary so the materializer's transaction wrapper still executes
// (it just gets a stubbed knex back), and the captured `createTask` /
// `createCriterion` arguments give us the equivalence comparison.
jest.mock("../src/db/tasks", () => {
  const real = jest.requireActual("../src/db/tasks");
  return {
    ...real,
    getTasksByRepoId: jest.fn(),
    createTask: jest.fn(),
  };
});
jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn(),
  createCriterion: jest.fn(),
}));
jest.mock("../src/db/repoWebhooks", () => ({
  getWebhooksByRepoId: jest.fn(),
}));

import {
  getTasksByRepoId,
  createTask,
} from "../src/db/tasks";
import {
  getCriteriaByTaskId,
  createCriterion,
} from "../src/db/acceptanceCriteria";
import { getWebhooksByRepoId } from "../src/db/repoWebhooks";

const getTasksByRepoIdMock = getTasksByRepoId as jest.Mock;
const getCriteriaByTaskIdMock = getCriteriaByTaskId as jest.Mock;
const createTaskMock = createTask as jest.Mock;
const createCriterionMock = createCriterion as jest.Mock;
const getWebhooksByRepoIdMock = getWebhooksByRepoId as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mock-Knex helpers
// ---------------------------------------------------------------------------
function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  for (const m of [
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
    "select",
  ]) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const knex = jest.fn().mockReturnValue(chain) as unknown as jest.Mock & {
    raw: jest.Mock;
    transaction: jest.Mock;
  };
  knex.raw = jest.fn();
  knex.transaction = jest.fn(async (cb: (trx: unknown) => unknown) => cb(knex));
  return { knex, chain };
}

// ---------------------------------------------------------------------------
// AC #874 — Approval gate skip path
// ---------------------------------------------------------------------------

describe("Phase 7 — approval gate skip in scheduler (AC #874)", () => {
  it("the candidate CTE in claimNextPendingLeafTask carries `AND NOT t.requires_approval` so approval-held tasks are excluded atomically", async () => {
    // The gate must live inside the SQL predicate, not in JS. A scheduler-side
    // check would race under multiple workers — one worker could read the row
    // before another flipped the flag.
    const { knex } = createMockKnex();
    knex.raw.mockResolvedValueOnce({ rows: [] });

    await claimNextPendingLeafTask(knex as any, 1, "host:123", 1800);

    const sql = (knex.raw as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/AND\s+NOT\s+t\.requires_approval/);
  });

  it("buildWorkQueue produces no entry for a repo whose only pending leaf is held for approval (DB returns undefined)", async () => {
    // Scheduler-side proof of AC #874: if claimNextPendingLeafTask returns
    // undefined (because the only pending leaf has requires_approval=true and
    // the SQL predicate filtered it out), buildWorkQueue must NOT add anything
    // for that repo and must not attempt to record a 'claimed' event.
    jest.resetModules();

    jest.doMock("../src/db/repos", () => ({
      getActiveRepos: jest
        .fn()
        .mockResolvedValue([{ id: 1, on_parent_child_fail: "ignore" }]),
    }));
    const claimMock = jest.fn().mockResolvedValue(undefined);
    jest.doMock("../src/db/tasks", () => ({
      claimNextPendingLeafTask: claimMock,
      autoCompleteParentTasks: jest.fn(),
    }));
    const recordEventMock = jest.fn();
    jest.doMock("../src/db/taskEvents", () => ({
      recordEvent: recordEventMock,
    }));
    jest.doMock("../src/services/taskRunner", () => ({
      runTask: jest.fn(),
    }));

    const { buildWorkQueue: scopedBuildWorkQueue } = await import(
      "../src/services/scheduler"
    );

    const queue = await scopedBuildWorkQueue({} as any, "worker-1", 1800);
    expect(queue).toEqual([]);
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).not.toHaveBeenCalled();

    jest.dontMock("../src/db/repos");
    jest.dontMock("../src/db/tasks");
    jest.dontMock("../src/db/taskEvents");
    jest.dontMock("../src/services/taskRunner");
  });

  it("flipping requires_approval back to false makes the same task claimable on the next cycle (unblock path)", async () => {
    // Two consecutive cycles: the first finds nothing (task is held), the
    // second finds the now-released task. This is the contract the GUI's
    // approve button relies on — there's no second flag, no separate 'released'
    // state, just requires_approval=false and the task is back in the queue.
    jest.resetModules();

    jest.doMock("../src/db/repos", () => ({
      getActiveRepos: jest
        .fn()
        .mockResolvedValue([{ id: 1, on_parent_child_fail: "ignore" }]),
    }));
    const releasedTask = {
      id: 42,
      repo_id: 1,
      parent_id: null,
      title: "needs review",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "worker-1",
      leased_until: new Date(),
      ordering_mode: null,
      log_path: null,
      requires_approval: false,
      created_at: new Date(),
    };
    const claimMock = jest
      .fn()
      .mockResolvedValueOnce(undefined) // cycle 1: held
      .mockResolvedValueOnce(releasedTask); // cycle 2: released
    jest.doMock("../src/db/tasks", () => ({
      claimNextPendingLeafTask: claimMock,
      autoCompleteParentTasks: jest.fn(),
    }));
    const recordEventMock = jest.fn();
    jest.doMock("../src/db/taskEvents", () => ({
      recordEvent: recordEventMock,
    }));
    jest.doMock("../src/services/taskRunner", () => ({
      runTask: jest.fn(),
    }));

    const { buildWorkQueue: scopedBuildWorkQueue } = await import(
      "../src/services/scheduler"
    );

    const cycle1 = await scopedBuildWorkQueue({} as any, "worker-1", 1800);
    expect(cycle1).toEqual([]);

    const cycle2 = await scopedBuildWorkQueue({} as any, "worker-1", 1800);
    expect(cycle2).toEqual([{ repoId: 1, taskId: 42 }]);
    expect(recordEventMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      {},
      42,
      "claimed",
      { worker_id: "worker-1" }
    );

    jest.dontMock("../src/db/repos");
    jest.dontMock("../src/db/tasks");
    jest.dontMock("../src/db/taskEvents");
    jest.dontMock("../src/services/taskRunner");
  });
});

// ---------------------------------------------------------------------------
// AC #875 — Template save & instantiate round-trip
//
// We model a populated repo whose tree contains the structural fields a
// template captures (title, description, acceptance criteria, parent/child
// relationships) plus runtime-only fields that MUST be stripped from the
// captured template. We then drive that captured TaskTreeProposal through the
// real materializer (with createTask / createCriterion stubbed to capture
// what the materializer would write) and assert the captured tree is
// structurally equivalent to the source.
// ---------------------------------------------------------------------------

type SourceTask = {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  description: string;
  order_position: number;
  // runtime-only state that should never reach the captured template
  status: Task["status"];
  retry_count: number;
  pr_url: string | null;
  worker_id: string | null;
  leased_until: Date | null;
  ordering_mode: Task["ordering_mode"];
  log_path: string | null;
  requires_approval: boolean;
  created_at: Date;
};

const SOURCE_REPO_ID = 7;

function makeSourceTask(over: Partial<SourceTask> & Pick<SourceTask, "id" | "title">): SourceTask {
  return {
    repo_id: SOURCE_REPO_ID,
    parent_id: null,
    description: "",
    order_position: 0,
    status: "done",
    retry_count: 0,
    pr_url: null,
    worker_id: null,
    leased_until: null,
    ordering_mode: null,
    log_path: null,
    requires_approval: false,
    created_at: new Date(),
    ...over,
  };
}

// A representative tree:
//
//                           Phase 1                Phase 2
//                          /       \                  |
//                       Setup    Migrate            Ship
//                      /     \
//                    DB     Routes
//
// Phase 1 has acceptance criteria; Setup has its own; Phase 2 / Ship have
// none. Mixing in / out keeps the equivalence check honest — every shape the
// builder might encounter (no children, no criteria, both, multiple levels)
// is exercised in one round trip.
const SOURCE_TASKS: SourceTask[] = [
  // Phase 1 root
  makeSourceTask({
    id: 1,
    title: "Phase 1",
    description: "Foundation work",
    order_position: 0,
    status: "done",
    retry_count: 2, // runtime state — must not leak
    pr_url: "https://github.com/x/y/pull/1", // runtime state — must not leak
  }),
  // Phase 1 children
  makeSourceTask({
    id: 2,
    title: "Setup",
    description: "Prep the repo",
    parent_id: 1,
    order_position: 0,
  }),
  makeSourceTask({
    id: 3,
    title: "Migrate",
    description: "",
    parent_id: 1,
    order_position: 1,
    log_path: "/tmp/migrate.log", // runtime state — must not leak
  }),
  // Setup children
  makeSourceTask({
    id: 4,
    title: "DB",
    description: "Bring up the schema",
    parent_id: 2,
    order_position: 0,
  }),
  makeSourceTask({
    id: 5,
    title: "Routes",
    parent_id: 2,
    order_position: 1,
  }),
  // Phase 2 root
  makeSourceTask({
    id: 10,
    title: "Phase 2",
    order_position: 1,
  }),
  // Phase 2 child
  makeSourceTask({
    id: 11,
    title: "Ship",
    description: "Cut the release",
    parent_id: 10,
    order_position: 0,
  }),
];

const SOURCE_CRITERIA: Record<number, Array<{ description: string; met: boolean; order_position: number }>> = {
  1: [
    { description: "all Phase 1 children are done", met: true, order_position: 0 },
    { description: "no schema regressions", met: false, order_position: 1 },
  ],
  2: [{ description: "repo is initialised", met: true, order_position: 0 }],
};

// Walk a TaskTreeProposal into a normalized comparable structure (titles,
// descriptions, acceptance criteria as ordered lists, children) so we can
// compare two trees with a single deep-equal. Fields the template format
// chooses to omit (e.g. description="" → undefined) survive the round trip
// because we apply the same normalization to both sides.
type NormalizedNode = {
  title: string;
  description: string;
  acceptance_criteria: string[];
  children: NormalizedNode[];
};

function normalizeProposalNode(node: ProposedTaskNode): NormalizedNode {
  return {
    title: node.title,
    description: node.description ?? "",
    acceptance_criteria: node.acceptance_criteria ?? [],
    children: (node.children ?? []).map(normalizeProposalNode),
  };
}

function normalizeProposal(proposal: TaskTreeProposal): NormalizedNode[] {
  return proposal.parents.map(normalizeProposalNode);
}

// Build an equivalent NormalizedNode[] directly from the SourceTask fixture so
// we have a ground-truth oracle independent of the builder.
function normalizeFromSource(): NormalizedNode[] {
  const byParent = new Map<number | null, SourceTask[]>();
  for (const t of SOURCE_TASKS) {
    const list = byParent.get(t.parent_id) ?? [];
    list.push(t);
    byParent.set(t.parent_id, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order_position - b.order_position);
  }
  function build(t: SourceTask): NormalizedNode {
    return {
      title: t.title,
      description: t.description,
      acceptance_criteria: (SOURCE_CRITERIA[t.id] ?? [])
        .slice()
        .sort((a, b) => a.order_position - b.order_position)
        .map((c) => c.description),
      children: (byParent.get(t.id) ?? []).map(build),
    };
  }
  return (byParent.get(null) ?? []).map(build);
}

describe("Phase 7 — task template round-trip equivalence (AC #875)", () => {
  it("a captured template re-materializes into a structurally equivalent tree (titles, descriptions, criteria, children all match)", async () => {
    // -------------------------------------------------------------------
    // Phase 1: capture. buildTemplateFromRepo reads the source tasks and
    // their criteria and emits a TaskTreeProposal stripped of runtime state.
    // -------------------------------------------------------------------
    getTasksByRepoIdMock.mockResolvedValueOnce(SOURCE_TASKS);
    getCriteriaByTaskIdMock.mockImplementation(async (_db: unknown, taskId: number) => {
      return (SOURCE_CRITERIA[taskId] ?? []).map((c, idx) => ({
        id: 1000 + taskId * 10 + idx,
        task_id: taskId,
        description: c.description,
        order_position: c.order_position,
        met: c.met,
        created_at: new Date(),
      }));
    });

    const captured = await buildTemplateFromRepo({} as any, SOURCE_REPO_ID);

    // The captured proposal must be structurally equivalent to the source.
    expect(normalizeProposal(captured)).toEqual(normalizeFromSource());

    // And it must have stripped runtime-only state — no node carries a status,
    // pr_url, retry_count, log_path, etc. We walk the entire tree and assert
    // the exact key set on every node.
    const allowed = new Set([
      "title",
      "description",
      "acceptance_criteria",
      "children",
    ]);
    function assertCleanNode(n: ProposedTaskNode): void {
      for (const k of Object.keys(n)) {
        expect(allowed.has(k)).toBe(true);
      }
      for (const c of n.children ?? []) assertCleanNode(c);
    }
    for (const p of captured.parents) assertCleanNode(p);

    // -------------------------------------------------------------------
    // Phase 2: round-trip through (serialize → deserialize) the way the DB
    // would. The taskTemplates table stores `tree` as a JSON string, so the
    // re-materialization must work on the string-then-parsed value too.
    // -------------------------------------------------------------------
    const serialized = JSON.stringify(captured);
    const reloaded: TaskTreeProposal = JSON.parse(serialized);
    expect(normalizeProposal(reloaded)).toEqual(normalizeFromSource());

    // -------------------------------------------------------------------
    // Phase 3: instantiate. Drive the reloaded proposal through the real
    // materializer with createTask / createCriterion stubbed to assign fresh
    // ids while remembering what was inserted.
    // -------------------------------------------------------------------
    let nextTaskId = 5000;
    const insertedTasks: Array<{
      id: number;
      repo_id: number;
      parent_id: number | null;
      title: string;
      description: string;
      order_position: number;
    }> = [];
    createTaskMock.mockImplementation(
      async (_db: unknown, data: {
        repo_id: number;
        parent_id: number | null;
        title: string;
        description: string;
        order_position: number;
      }) => {
        const id = nextTaskId++;
        const row = { ...data, id };
        insertedTasks.push(row);
        return row;
      }
    );
    let nextCriterionId = 9000;
    const insertedCriteria: Array<{
      id: number;
      task_id: number;
      description: string;
      order_position: number;
    }> = [];
    createCriterionMock.mockImplementation(
      async (_db: unknown, data: {
        task_id: number;
        description: string;
        order_position: number;
      }) => {
        const id = nextCriterionId++;
        const row = { ...data, id };
        insertedCriteria.push(row);
        return row;
      }
    );

    const targetRepoId = 999; // a fresh repo, distinct from the source
    const { knex: trxDb } = createMockKnex();
    const materialized = await materializeTaskTree(
      trxDb as any,
      targetRepoId,
      reloaded
    );

    // -------------------------------------------------------------------
    // Phase 4: equivalence. Reconstruct the materialized tree as a
    // NormalizedNode[] using the data the materializer actually wrote, then
    // assert deep equality with the source-tree oracle.
    // -------------------------------------------------------------------
    const tasksByParent = new Map<number | null, typeof insertedTasks>();
    for (const t of insertedTasks) {
      const list = tasksByParent.get(t.parent_id) ?? [];
      list.push(t);
      tasksByParent.set(t.parent_id, list);
    }
    for (const list of tasksByParent.values()) {
      list.sort((a, b) => a.order_position - b.order_position);
    }
    function buildMaterialized(parentId: number | null): NormalizedNode[] {
      return (tasksByParent.get(parentId) ?? []).map((t) => ({
        title: t.title,
        description: t.description,
        acceptance_criteria: insertedCriteria
          .filter((c) => c.task_id === t.id)
          .sort((a, b) => a.order_position - b.order_position)
          .map((c) => c.description),
        children: buildMaterialized(t.id),
      }));
    }
    expect(buildMaterialized(null)).toEqual(normalizeFromSource());

    // The returned MaterializedTaskTree mirrors the input shape and surfaces
    // the freshly-allocated ids back to the caller — this is the contract the
    // GUI uses to navigate to the new tasks.
    expect(materialized.parents).toHaveLength(2);
    expect(materialized.parents[0].title).toBe("Phase 1");
    expect(materialized.parents[0].children).toHaveLength(2);
    expect(
      materialized.parents[0].acceptance_criteria_ids.length
    ).toBeGreaterThan(0);

    // Every materialized task references the FRESH repo, not the source repo.
    for (const t of insertedTasks) {
      expect(t.repo_id).toBe(targetRepoId);
      expect(t.repo_id).not.toBe(SOURCE_REPO_ID);
    }
  });

  it("instantiating the same template twice produces two independent trees with disjoint ids — proving the round-trip is reusable", async () => {
    // The point of templates is repeated reuse. Two consecutive instantiations
    // of the same captured tree must each go through createTask end-to-end and
    // never share row ids. A regression where the materializer cached or
    // mutated the proposal would surface here.
    getTasksByRepoIdMock.mockResolvedValueOnce(SOURCE_TASKS);
    getCriteriaByTaskIdMock.mockImplementation(async () => []);

    const captured = await buildTemplateFromRepo({} as any, SOURCE_REPO_ID);
    const serialized = JSON.stringify(captured);

    let nextTaskId = 5000;
    const seenIds = new Set<number>();
    createTaskMock.mockImplementation(async (_db, data) => {
      const id = nextTaskId++;
      seenIds.add(id);
      return { ...data, id };
    });

    const { knex: dbA } = createMockKnex();
    const { knex: dbB } = createMockKnex();
    const a = await materializeTaskTree(
      dbA as any,
      100,
      JSON.parse(serialized)
    );
    const b = await materializeTaskTree(
      dbB as any,
      200,
      JSON.parse(serialized)
    );

    // Both materializations produced the same structure...
    expect(a.parents.map((p) => p.title)).toEqual(b.parents.map((p) => p.title));
    // ...with disjoint id sets.
    const aIds = new Set<number>();
    const bIds = new Set<number>();
    function collect(nodes: typeof a.parents, into: Set<number>): void {
      for (const n of nodes) {
        into.add(n.id);
        collect(n.children as typeof a.parents, into);
      }
    }
    collect(a.parents, aIds);
    collect(b.parents, bIds);
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
    expect(aIds.size).toBe(bIds.size);
    expect(aIds.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// task_usage rows from a stubbed Anthropic usage object (task body item)
// ---------------------------------------------------------------------------

describe("Phase 7 — task_usage rows from a stubbed Anthropic usage object", () => {
  // The end-to-end shape is "Anthropic SDK -> claudeRunner.parseUsageFromOutput
  // -> taskRunner -> recordTaskUsage". We drive a stubbed Anthropic-shape
  // usage object through the real parser (which is what taskRunner actually
  // calls) and then through the DB layer, and assert the four-column row that
  // lands in task_usage.

  it("a stream-json line with `message.usage` parses into a TokenUsage that recordTaskUsage writes verbatim", async () => {
    // Anthropic's stream-json events surface usage on `message.usage` for
    // assistant messages. This is the most common shape the CLI emits.
    const anthropicUsage = {
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 9000,
    };
    const streamJsonLine = JSON.stringify({
      type: "message_delta",
      message: { id: "msg_x", role: "assistant", usage: anthropicUsage },
    });
    const cliOutput = `garbage\n${streamJsonLine}\nmore garbage\n`;

    const parsed = parseUsageFromOutput(cliOutput);
    expect(parsed).toEqual(anthropicUsage);

    const { knex, chain } = createMockKnex();
    const inserted = {
      id: 1,
      task_id: 42,
      repo_id: 7,
      ...anthropicUsage,
      created_at: new Date(),
    };
    chain.returning.mockResolvedValueOnce([inserted]);

    const row = await recordTaskUsage(knex as any, {
      task_id: 42,
      repo_id: 7,
      usage: parsed as TokenUsage,
    });

    expect(knex).toHaveBeenCalledWith("task_usage");
    expect(chain.insert).toHaveBeenCalledWith({
      task_id: 42,
      repo_id: 7,
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 9000,
    });
    expect(row).toBe(inserted);
  });

  it("multiple stream-json events sum into a single aggregated usage (multi-turn run accounts for every Anthropic call)", async () => {
    // A real run emits a usage block per assistant turn plus a final result
    // envelope; the parser must aggregate so a single task_usage row reflects
    // the whole agent invocation.
    const lines = [
      JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 } } }),
      JSON.stringify({ usage: { input_tokens: 0, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 } }),
    ];
    const parsed = parseUsageFromOutput(lines.join("\n"));
    expect(parsed).toEqual({
      input_tokens: 30,
      output_tokens: 103,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 50,
    });
  });

  it("returns null when the agent output contains no recognisable usage block (so taskRunner does not write all-zero rows)", async () => {
    // The taskRunner contract: skip recordTaskUsage when parseUsageFromOutput
    // returns null. A regression that returned a zero-filled object instead
    // would write misleading rows for older CLI output formats.
    expect(parseUsageFromOutput("just text, nothing structured")).toBeNull();
    expect(parseUsageFromOutput("")).toBeNull();
    expect(
      parseUsageFromOutput(
        JSON.stringify({ message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #876 — Webhook retry logic (success / 5xx-with-retry / eventual drop)
// ---------------------------------------------------------------------------

describe("Phase 7 — webhook retry logic (AC #876)", () => {
  // Replace setTimeout so retry backoff doesn't add wallclock time. We still
  // want the retry control flow to run, just not the sleeps.
  let realSetTimeout: typeof setTimeout;
  beforeEach(() => {
    realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
  });
  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
  });

  const samplePayload: WebhookPayload = {
    text: "stub",
    event: "done",
    repo: { id: 1, owner: "o", repo_name: "r" },
    task: { id: 1, title: "t", status: "done", pr_url: null },
  };

  // --- BRANCH 1: success on first attempt --------------------------------
  it("SUCCESS — a single 2xx response settles the delivery on the first attempt with no retries", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Body and headers shape — the consumer can rely on this contract.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({
      event: "done",
      text: "stub",
    });
  });

  // --- BRANCH 2: 5xx then success ---------------------------------------
  it("5xx WITH RETRY — a 503/502 then a 200 settles ok=true on a later attempt (transient server errors are retried)", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 503 } as any)
      .mockResolvedValueOnce({ status: 502 } as any)
      .mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // --- BRANCH 3: eventual drop ------------------------------------------
  it("EVENTUAL DROP — every attempt returns 5xx, delivery is dropped after MAX_DELIVERY_ATTEMPTS with the last status surfaced", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 500 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(result.status).toBe(500);
    expect(result.error).toBe(`HTTP 500`);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
  });

  // --- Orthogonal cases that complete the table --------------------------
  it("4xx is NOT retried (permanent client error — extra requests just hammer the misconfigured target)", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ status: 404 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("network errors (TypeError/ECONNRESET) retry the same as 5xx — they're transient by assumption", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("network errors that never resolve — eventual drop with the last error string surfaced", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://example.com/h",
      samplePayload
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
  });

  // --- End-to-end through fireWebhooksForRepo ----------------------------
  // Closes the gap: deliverWebhook is the unit, fireWebhooksForRepo is the
  // call site. The latter must not couple the task pipeline to delivery
  // failure — a webhook that exhausts its retry budget logs the failure but
  // never throws.
  it("fireWebhooksForRepo invokes deliverWebhook for matching webhooks and survives an eventual drop without throwing", async () => {
    const baseRepo: Repo = {
      id: 7,
      owner: "octocat",
      repo_name: "widgets",
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: false,
      local_path: null,
      on_failure: "halt_repo",
      max_retries: 3,
      on_parent_child_fail: "mark_partial",
      ordering_mode: "sequential",
      clone_status: "ready",
      clone_error: null,
      created_at: new Date(),
    };
    const baseTask: Task = {
      id: 42,
      repo_id: 7,
      parent_id: null,
      title: "Add login",
      description: "",
      order_position: 0,
      status: "done",
      retry_count: 0,
      pr_url: null,
      worker_id: null,
      leased_until: null,
      ordering_mode: null,
      log_path: null,
      requires_approval: false,
      created_at: new Date(),
    };
    const subscribed: RepoWebhook = {
      id: 1,
      repo_id: 7,
      url: "https://hooks.example.com/permanently-broken",
      events: ["done"],
      active: true,
      created_at: new Date(),
    };

    getWebhooksByRepoIdMock.mockResolvedValueOnce([subscribed]);
    const fetchMock = jest.fn().mockResolvedValue({ status: 500 } as any);
    (global as any).fetch = fetchMock;
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        fireWebhooksForRepo({} as any, baseRepo, baseTask, "done")
      ).resolves.toBeUndefined();
      // Retry budget was used in full — exactly MAX_DELIVERY_ATTEMPTS.
      expect(fetchMock).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
      // The dropped-delivery log surfaces the URL and attempt count so an
      // operator can act on it.
      const errorLog = errSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorLog).toMatch(/permanently-broken/);
      expect(errorLog).toMatch(/3 attempt/);
    } finally {
      errSpy.mockRestore();
    }
  });
});
