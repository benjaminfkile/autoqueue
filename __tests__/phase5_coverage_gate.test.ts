// ---------------------------------------------------------------------------
// Phase 5 coverage gate (task #224)
//
// Pins down the four contracts that ship Phase 5 (in-app planning chat) and
// that no single other test exercises end-to-end:
//
//   AC #868 — A stubbed Anthropic client drives the SSE chat endpoint
//             deterministically. We construct the same `AnthropicLike` shape
//             the SDK exposes, return canned stream events, and assert the
//             SSE bytes the router writes back. No real network, no flaky
//             timing.
//
//   AC #869 — POST /api/repos/:id/materialize-tree is atomic. The route runs
//             the materializer inside `db.transaction(...)`; if any insert
//             rejects mid-way, the callback rejects, knex rolls back the
//             transaction, and the route surfaces a 500 — never a half-built
//             tree.
//
//   AC #870 — `validateTaskTreeProposal` (and the streaming tool-call parser
//             that wraps it) reject every documented malformed shape. This
//             includes both the static validator and the streaming protocol:
//             partial-JSON assembly, unknown tool names, malformed JSON, and
//             schema failures all surface as `proposal_error` rather than
//             throwing.
//
// Plus (mentioned in the task body but not as a numbered AC): the system
// prompt assembled by `buildSystemPrompt` is deterministic for a given repo +
// context. We assert byte-for-byte identical output across repeated calls so
// future changes that introduce nondeterminism (timestamps, random ordering,
// Map iteration order) fail loudly here.
// ---------------------------------------------------------------------------

import request from "supertest";

// ---------------------------------------------------------------------------
// Module mocks. Set up BEFORE importing the modules under test so jest can
// hoist correctly.
// ---------------------------------------------------------------------------

jest.mock("../src/secrets", () => ({
  get: jest.fn((key: string) =>
    key === "ANTHROPIC_API_KEY" ? "sk-ant-test" : undefined
  ),
  init: jest.fn(),
  set: jest.fn(),
  unset: jest.fn(),
  getSecretsFilePath: jest.fn(),
}));

jest.mock("../src/db/db", () => ({
  getDb: jest.fn(),
}));

jest.mock("../src/db/health", () => ({
  __esModule: true,
  default: {
    getDBConnectionHealth: jest.fn().mockResolvedValue({
      connected: true,
      connectionUsesProxy: false,
    }),
  },
}));

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
  getAllRepos: jest.fn(),
  getRepoByOwnerAndName: jest.fn(),
  createRepo: jest.fn(),
  updateRepo: jest.fn(),
  deleteRepo: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  getTasksByRepoId: jest.fn().mockResolvedValue([]),
  createTask: jest.fn(),
  getTaskById: jest.fn(),
  getChildTasks: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
}));

jest.mock("../src/db/acceptanceCriteria", () => ({
  createCriterion: jest.fn(),
  getCriteriaByTaskId: jest.fn(),
}));

// Phase 8 (task #304) wires the repo-link scope into materialize-tree's
// proposal validation. The route now calls listLinksForRepo to assemble the
// allowed repo_id set; default it to "no links" so the Phase 5 atomicity
// tests, which predate that scoping, keep behaving as a single-repo flow.
jest.mock("../src/db/repoLinks", () => ({
  listLinksForRepo: jest.fn().mockResolvedValue([]),
}));

// Task #322 — chatRouter now reads settings.default_model on each /api/chat
// call. The Phase 5 SSE chat tests stub the Anthropic SDK at the import
// boundary, so the router runs end-to-end through real chatService — which
// means we need a mocked default-model resolver too. Keep it deterministic
// here so the SSE assertions don't depend on a settings row.
jest.mock("../src/db/settings", () => ({
  getDefaultModel: jest.fn().mockResolvedValue("claude-test-model"),
}));

// Stub the Anthropic SDK at the import boundary so the chat router exercises
// real `streamChatEvents` against a fully scripted stream. This is the AC #868
// boundary — keep one canonical stub here so we don't drift between tests.
const anthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: anthropicCreate },
    })),
  };
});

import app from "../src/app";
import { getDb } from "../src/db/db";
import { getRepoById } from "../src/db/repos";
import { createTask } from "../src/db/tasks";
import { createCriterion } from "../src/db/acceptanceCriteria";
import {
  AnthropicLike,
  AnthropicStreamEvent,
  buildSystemPrompt,
  ChatStreamEvent,
  GRUNT_SCHEMA,
  PROPOSE_TASK_TREE_TOOL,
  PROPOSE_TASK_TREE_TOOL_NAME,
  streamChatEvents,
  validateTaskTreeProposal,
} from "../src/services/chatService";
import { Repo, Task } from "../src/interfaces";

const repoFixture: Repo = {
  id: 7,
  owner: "acme",
  repo_name: "widgets",
  active: true,
  base_branch: "main",
  base_branch_parent: "main",
  require_pr: false,
  github_token: null,
  is_local_folder: false,
  local_path: null,
  on_failure: "halt_subtree",
  max_retries: 0,
  on_parent_child_fail: "ignore",
  ordering_mode: "sequential",
  clone_status: "ready",
  clone_error: null,
  created_at: new Date("2026-04-01T00:00:00Z"),
};

const taskFixture: Task = {
  id: 99,
  repo_id: 7,
  parent_id: null,
  title: "Migrate widgets",
  description: "old → new",
  order_position: 0,
  status: "done",
  retry_count: 0,
  pr_url: null,
  worker_id: null,
  leased_until: null,
  ordering_mode: null,
  log_path: null,
  requires_approval: false,
  model: null,
  created_at: new Date("2026-04-20T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
});

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// AC #870 — Tool-call schema validation tested with invalid inputs
//
// Two layers: the pure validator (validateTaskTreeProposal) and the streaming
// tool-call parser (streamChatEvents) that calls into it. Both must reject /
// surface every malformed shape we document, and neither may throw.
// ---------------------------------------------------------------------------
describe("Phase 5 — tool-call schema validation (AC #870)", () => {
  describe("validateTaskTreeProposal — invalid root shapes", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["string", "nope"],
      ["number", 42],
      ["boolean", true],
      ["array", [{ title: "X" }]],
    ])("rejects %s as the proposal root", (_label, input) => {
      const result = validateTaskTreeProposal(input as unknown);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/object|parents/);
    });

    it("rejects missing parents", () => {
      const r = validateTaskTreeProposal({});
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/parents/);
    });

    it("rejects empty parents array", () => {
      const r = validateTaskTreeProposal({ parents: [] });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/non-empty/);
    });

    it("rejects non-array parents (string, number, object)", () => {
      for (const bad of ["nope", 5, { not: "array" }]) {
        const r = validateTaskTreeProposal({ parents: bad as unknown });
        expect(r.valid).toBe(false);
      }
    });
  });

  describe("validateTaskTreeProposal — invalid node shapes", () => {
    it("rejects non-object parent entries (null, string, number, array)", () => {
      for (const bad of [null, "x", 1, []]) {
        const r = validateTaskTreeProposal({ parents: [bad as unknown] });
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.error).toMatch(/parents\[0\]/);
      }
    });

    it("rejects missing title", () => {
      const r = validateTaskTreeProposal({ parents: [{}] });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/title/);
    });

    it("rejects non-string title (number, null, object)", () => {
      for (const bad of [5, null, { foo: "bar" }]) {
        const r = validateTaskTreeProposal({ parents: [{ title: bad as unknown }] });
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.error).toMatch(/title/);
      }
    });

    it("rejects whitespace-only title (after trim)", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "   \t\n  " }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/title/);
    });

    it("rejects non-string description", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "T", description: 123 }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/description/);
    });
  });

  describe("validateTaskTreeProposal — invalid acceptance_criteria", () => {
    it("rejects non-array acceptance_criteria", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "T", acceptance_criteria: "single string" }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/acceptance_criteria/);
    });

    it("rejects non-string items inside acceptance_criteria with a useful path", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "T", acceptance_criteria: ["ok", 5, "ok2"] }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/acceptance_criteria\[1\]/);
    });

    it("rejects empty/whitespace-only acceptance_criteria entries", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "T", acceptance_criteria: ["ok", "   "] }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/acceptance_criteria\[1\]/);
    });
  });

  describe("validateTaskTreeProposal — invalid children", () => {
    it("rejects non-array children", () => {
      const r = validateTaskTreeProposal({
        parents: [{ title: "T", children: "nope" }],
      });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toMatch(/children/);
    });

    it("reports the full path for a malformed deeply nested node", () => {
      const r = validateTaskTreeProposal({
        parents: [
          {
            title: "Root",
            children: [
              { title: "ok" },
              {
                title: "branch",
                children: [{ title: "" }],
              },
            ],
          },
        ],
      });
      expect(r.valid).toBe(false);
      if (!r.valid)
        expect(r.error).toMatch(/parents\[0\].children\[1\].children\[0\]/);
    });

    it("never throws on hostile input — every malformed shape returns {valid:false}", () => {
      const adversarial: unknown[] = [
        null,
        undefined,
        42,
        "string",
        true,
        [],
        {},
        { parents: null },
        { parents: [null] },
        { parents: [{ title: 1 }] },
        { parents: [{ title: "T", children: [{ title: "T", children: [{}] }] }] },
        { parents: [{ title: "T", acceptance_criteria: [1, 2, 3] }] },
        // deeply nested malformed leaf
        {
          parents: Array(5).fill({
            title: "T",
            children: [{ title: "" }],
          }),
        },
      ];
      for (const input of adversarial) {
        expect(() => validateTaskTreeProposal(input)).not.toThrow();
        const r = validateTaskTreeProposal(input);
        expect(r.valid).toBe(false);
      }
    });
  });

  describe("streaming tool-call parser surfaces invalid inputs as proposal_error", () => {
    it("treats malformed partial_json as proposal_error (never throws)", async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: PROPOSE_TASK_TREE_TOOL_NAME,
            id: "x",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"parents": [' },
        },
        { type: "content_block_stop", index: 0 },
      ];
      const fakeClient: AnthropicLike = {
        messages: {
          create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
        },
      };

      const out: ChatStreamEvent[] = [];
      for await (const e of streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "s",
        messages: [{ role: "user", content: "go" }],
        client: fakeClient,
        tools: [PROPOSE_TASK_TREE_TOOL],
      })) {
        out.push(e);
      }
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe("proposal_error");
      if (out[0].type === "proposal_error") {
        expect(out[0].error).toMatch(/JSON/i);
      }
    });

    it("surfaces schema-validation failures (well-formed JSON, broken shape) as proposal_error", async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: PROPOSE_TASK_TREE_TOOL_NAME,
            id: "x",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ parents: [{ description: "no title" }] }),
          },
        },
        { type: "content_block_stop", index: 0 },
      ];
      const fakeClient: AnthropicLike = {
        messages: {
          create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
        },
      };

      const out: ChatStreamEvent[] = [];
      for await (const e of streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "s",
        messages: [{ role: "user", content: "go" }],
        client: fakeClient,
        tools: [PROPOSE_TASK_TREE_TOOL],
      })) {
        out.push(e);
      }
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe("proposal_error");
      if (out[0].type === "proposal_error") {
        expect(out[0].error).toMatch(/title/);
      }
    });

    it("ignores tool_use blocks for unknown tool names (does not surface a proposal_error)", async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", name: "rogue_tool", id: "x" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"hostile": true}' },
        },
        { type: "content_block_stop", index: 0 },
      ];
      const fakeClient: AnthropicLike = {
        messages: {
          create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
        },
      };
      const out: ChatStreamEvent[] = [];
      for await (const e of streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "s",
        messages: [{ role: "user", content: "go" }],
        client: fakeClient,
      })) {
        out.push(e);
      }
      expect(out).toEqual([]);
    });

    it("treats an empty tool_use block (zero deltas) as an empty object → proposal_error from validator", async () => {
      // The model can emit a tool_use with no input deltas. The parser treats
      // that as the literal empty object, which then fails schema validation
      // with a parents-related error.
      const events: AnthropicStreamEvent[] = [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: PROPOSE_TASK_TREE_TOOL_NAME,
            id: "x",
          },
        },
        { type: "content_block_stop", index: 0 },
      ];
      const fakeClient: AnthropicLike = {
        messages: {
          create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
        },
      };
      const out: ChatStreamEvent[] = [];
      for await (const e of streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "s",
        messages: [{ role: "user", content: "go" }],
        client: fakeClient,
      })) {
        out.push(e);
      }
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe("proposal_error");
      if (out[0].type === "proposal_error") {
        expect(out[0].error).toMatch(/parents/);
      }
    });

    it("recovers across multiple tool_use blocks — a malformed block does not abort the stream", async () => {
      const valid = { parents: [{ title: "Recovered" }] };
      const events: AnthropicStreamEvent[] = [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: PROPOSE_TASK_TREE_TOOL_NAME,
            id: "a",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{not json" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            name: PROPOSE_TASK_TREE_TOOL_NAME,
            id: "b",
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(valid) },
        },
        { type: "content_block_stop", index: 1 },
      ];
      const fakeClient: AnthropicLike = {
        messages: {
          create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
        },
      };
      const out: ChatStreamEvent[] = [];
      for await (const e of streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "s",
        messages: [{ role: "user", content: "go" }],
        client: fakeClient,
      })) {
        out.push(e);
      }
      expect(out).toHaveLength(2);
      expect(out[0].type).toBe("proposal_error");
      expect(out[1]).toEqual({ type: "proposal", proposal: valid });
    });
  });
});

// ---------------------------------------------------------------------------
// AC #869 — Materialize endpoint atomicity (failure mid-insert rolls back)
//
// We drive POST /api/repos/:id/materialize-tree against:
//   - a getDb() that returns a knex-shaped object with a real `transaction`
//     method that runs the callback with the same trx,
//   - the underlying createTask / createCriterion fns mocked so we can fail at
//     a chosen step,
//   - the actual materializeTaskTree implementation (NOT mocked here — that's
//     the difference from reposRouter.test.ts which mocks the materializer).
//
// Atomicity contract:
//   - On any insert rejection, the transaction callback rejects so knex rolls
//     back. The route must return 500, never 201, and the response body must
//     not contain a half-built tree.
//   - Any inserts that succeeded before the failure are inside the same trx,
//     so they're rolled back by knex too — the test asserts this by
//     verifying the trx callback rejected (transaction promise rejected).
// ---------------------------------------------------------------------------
describe("Phase 5 — materialize endpoint atomicity (AC #869)", () => {
  // A knex-shaped mock whose .transaction(cb) runs cb with itself as the trx.
  // We capture whether the trx callback rejected so the test can assert
  // rollback semantics independently of the insert mocks.
  function makeKnexMock(): {
    knex: unknown;
    transactionCalls: number;
    lastTransactionRejected: () => boolean;
  } {
    let transactionCalls = 0;
    let lastRejected = false;
    const knex: unknown = {
      transaction: jest.fn(async (cb: (trx: unknown) => unknown) => {
        transactionCalls++;
        lastRejected = false;
        try {
          return await cb(knex);
        } catch (err) {
          lastRejected = true;
          throw err;
        }
      }),
    };
    return {
      knex,
      get transactionCalls() {
        return transactionCalls;
      },
      lastTransactionRejected: () => lastRejected,
    };
  }

  beforeEach(() => {
    (getRepoById as jest.Mock).mockResolvedValue({ ...repoFixture, id: 7 });
  });

  it("happy path: returns 201 with the full materialized tree (sanity baseline)", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);

    let nextId = 100;
    (createTask as jest.Mock).mockImplementation(async (_db, data) => ({
      id: nextId++,
      ...data,
    }));
    (createCriterion as jest.Mock).mockImplementation(
      async (_db, data) => ({ id: 500 + (data.order_position ?? 0), ...data })
    );

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({
        parents: [
          {
            title: "Phase 1",
            acceptance_criteria: ["bootstrapped"],
            children: [{ title: "Schema" }],
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(dbMock.transactionCalls).toBe(1);
    expect(dbMock.lastTransactionRejected()).toBe(false);
    expect(res.body.parents).toHaveLength(1);
    expect(res.body.parents[0].id).toBe(100);
    expect(res.body.parents[0].children[0].id).toBe(101);
    expect(res.body.parents[0].acceptance_criteria_ids).toEqual([500]);
  });

  it("returns 500 and rolls back when a child task insert fails mid-tree", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);

    // Parent succeeds, second child throws.
    (createTask as jest.Mock)
      .mockResolvedValueOnce({ id: 100, title: "Parent" })
      .mockResolvedValueOnce({ id: 101, title: "Child A" })
      .mockRejectedValueOnce(new Error("child insert failed"));

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({
        parents: [
          {
            title: "Parent",
            children: [{ title: "Child A" }, { title: "Child B" }],
          },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/child insert failed/);
    // The transaction was opened exactly once and its callback rejected, so
    // knex would roll the trx back. We do NOT see a 201 with a half-built
    // tree.
    expect(dbMock.transactionCalls).toBe(1);
    expect(dbMock.lastTransactionRejected()).toBe(true);
    expect(res.body.parents).toBeUndefined();
  });

  it("returns 500 and rolls back when an acceptance_criteria insert fails", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);

    (createTask as jest.Mock).mockResolvedValueOnce({ id: 100, title: "T" });
    (createCriterion as jest.Mock).mockRejectedValueOnce(
      new Error("ac insert failed")
    );

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({
        parents: [{ title: "T", acceptance_criteria: ["bad"] }],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ac insert failed/);
    expect(dbMock.transactionCalls).toBe(1);
    expect(dbMock.lastTransactionRejected()).toBe(true);
  });

  it("returns 500 and rolls back when the FIRST top-level parent insert fails (no work done)", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);
    (createTask as jest.Mock).mockRejectedValueOnce(new Error("first insert failed"));

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({ parents: [{ title: "T1" }, { title: "T2" }] });

    expect(res.status).toBe(500);
    expect(dbMock.transactionCalls).toBe(1);
    expect(dbMock.lastTransactionRejected()).toBe(true);
    // Nothing further was attempted after the first failure.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createCriterion).not.toHaveBeenCalled();
  });

  it("returns 500 and rolls back when a SECOND top-level parent fails (first parent's inserts must roll back too)", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);

    (createTask as jest.Mock)
      .mockResolvedValueOnce({ id: 100, title: "P1" })
      .mockResolvedValueOnce({ id: 101, title: "P1.child" })
      .mockRejectedValueOnce(new Error("p2 failed"));
    (createCriterion as jest.Mock).mockResolvedValueOnce({ id: 500 });

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({
        parents: [
          {
            title: "P1",
            acceptance_criteria: ["c1"],
            children: [{ title: "P1.child" }],
          },
          { title: "P2" },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/p2 failed/);
    expect(dbMock.transactionCalls).toBe(1);
    // Critically: even though P1 + its child + its AC all "succeeded" inside
    // the trx, the trx callback rejected, so knex rolls all of them back.
    expect(dbMock.lastTransactionRejected()).toBe(true);
  });

  it("rejects malformed proposals before opening the transaction (no DB work, no rollback)", async () => {
    const dbMock = makeKnexMock();
    (getDb as jest.Mock).mockReturnValue(dbMock.knex);

    const res = await request(app)
      .post("/api/repos/7/materialize-tree")
      .send({ parents: [{ description: "no title" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
    expect(dbMock.transactionCalls).toBe(0);
    expect(createTask).not.toHaveBeenCalled();
    expect(createCriterion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SSE chat endpoint streams correctly (AC #868)
//
// The SDK is stubbed at the import boundary so the real chatService and
// chatRouter run end-to-end against fully scripted Anthropic stream events.
// This is what AC #868 ("stubbed Anthropic client used to keep tests
// deterministic") refers to.
// ---------------------------------------------------------------------------
describe("Phase 5 — SSE chat endpoint with stubbed Anthropic client (AC #868)", () => {
  beforeEach(() => {
    // Default empty repo + no tasks; specific tests override via getRepoById.
    (getRepoById as jest.Mock).mockResolvedValue(undefined);
  });

  function scriptStream(events: AnthropicStreamEvent[]) {
    anthropicCreate.mockResolvedValueOnce(toAsyncIterable(events));
  }

  it("streams text deltas as `event: delta` SSE frames and ends with `event: done`", async () => {
    scriptStream([
      { type: "message_start" },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain('data: {"text":"Hello"}');
    expect(res.text).toContain('data: {"text":" world"}');
    expect(res.text).toContain("event: done");

    // Stub was given the right payload: stream:true, tools:[propose_task_tree],
    // system contains the schema, and the user message is forwarded verbatim.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const body = anthropicCreate.mock.calls[0][0];
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: PROPOSE_TASK_TREE_TOOL_NAME }),
      ])
    );
    expect(body.system).toContain("repos(");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("emits a `proposal` SSE event when the stub yields a valid propose_task_tree call", async () => {
    const proposal = {
      parents: [
        {
          title: "Login flow",
          children: [{ title: "POST /login" }],
        },
      ],
    };
    const json = JSON.stringify(proposal);
    const half = Math.floor(json.length / 2);
    scriptStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          name: PROPOSE_TASK_TREE_TOOL_NAME,
          id: "tool_1",
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: json.slice(0, half) },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: json.slice(half) },
      },
      { type: "content_block_stop", index: 0 },
    ]);

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "go" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: proposal");
    expect(res.text).toContain(JSON.stringify({ proposal }));
    expect(res.text).toContain("event: done");
  });

  it("emits a `proposal_error` SSE event when the stub yields a malformed tool-use block", async () => {
    scriptStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          name: PROPOSE_TASK_TREE_TOOL_NAME,
          id: "tool_2",
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not json" },
      },
      { type: "content_block_stop", index: 0 },
    ]);

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "go" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: proposal_error");
    expect(res.text).toMatch(/JSON/i);
    expect(res.text).toContain("event: done");
  });

  it("emits an `event: error` SSE frame when the stubbed stream throws", async () => {
    anthropicCreate.mockRejectedValueOnce(new Error("upstream blew up"));

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: error");
    expect(res.text).toContain("upstream blew up");
  });

  it("interleaves text deltas, proposal, and done events in stream order", async () => {
    const proposal = { parents: [{ title: "T" }] };
    scriptStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "preamble " },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          name: PROPOSE_TASK_TREE_TOOL_NAME,
          id: "t2",
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(proposal) },
      },
      { type: "content_block_stop", index: 1 },
    ]);

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    const deltaIdx = res.text.indexOf("event: delta");
    const proposalIdx = res.text.indexOf("event: proposal");
    const doneIdx = res.text.indexOf("event: done");
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(proposalIdx).toBeGreaterThan(deltaIdx);
    expect(doneIdx).toBeGreaterThan(proposalIdx);
  });

  it("forwards multi-turn message history verbatim to the stubbed client", async () => {
    scriptStream([]);

    await request(app)
      .post("/api/chat")
      .send({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second" },
        ],
      });

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreate.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "second" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deterministic system-prompt assembly for a given repo + context
//
// Not numbered as an AC, but called out in the task description: "system-
// prompt assembly produces deterministic output for a given repo+context". We
// pin this here so a future change that introduces nondeterminism (a Date.now
// in the prompt, randomized section ordering, JSON.stringify of a Map, etc.)
// fails immediately.
// ---------------------------------------------------------------------------
describe("Phase 5 — buildSystemPrompt determinism", () => {
  const fullCtx = {
    repo: repoFixture,
    recentTasks: [
      taskFixture,
      { ...taskFixture, id: 100, title: "B", parent_id: 99, status: "pending" as const },
    ],
  };

  it("returns byte-for-byte identical output across repeated calls (no context)", () => {
    const a = buildSystemPrompt();
    const b = buildSystemPrompt();
    expect(a).toBe(b);
    expect(a).toContain(GRUNT_SCHEMA);
    expect(a).toContain(PROPOSE_TASK_TREE_TOOL_NAME);
  });

  it("returns byte-for-byte identical output across repeated calls (full context)", () => {
    const a = buildSystemPrompt(fullCtx);
    const b = buildSystemPrompt(fullCtx);
    expect(a).toBe(b);
    expect(a).toContain("Current repo");
    expect(a).toContain("acme/widgets");
    expect(a).toContain("Recent task history");
    expect(a).toContain("#99 [done]");
    expect(a).toContain("#100 [pending] parent=99 B");
  });

  it("output is independent of object identity — equivalent contexts produce identical prompts", () => {
    const ctx1 = {
      repo: { ...repoFixture },
      recentTasks: [{ ...taskFixture }],
    };
    const ctx2 = {
      repo: { ...repoFixture },
      recentTasks: [{ ...taskFixture }],
    };
    expect(buildSystemPrompt(ctx1)).toBe(buildSystemPrompt(ctx2));
  });

  it("different contexts produce DIFFERENT prompts (so identity above is meaningful)", () => {
    const a = buildSystemPrompt(fullCtx);
    const b = buildSystemPrompt({ repo: repoFixture });
    expect(a).not.toBe(b);
    expect(b).not.toContain("Recent task history");
  });
});
