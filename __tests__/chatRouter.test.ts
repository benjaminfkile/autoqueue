import request from "supertest";

jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
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

jest.mock("../src/services/chatService", () => {
  const actual = jest.requireActual("../src/services/chatService");
  return {
    ...actual,
    loadChatContext: jest.fn(),
    streamChatEvents: jest.fn(),
    buildSystemPrompt: jest.fn().mockImplementation(actual.buildSystemPrompt),
  };
});

jest.mock("../src/secrets", () => ({
  get: jest.fn(),
  init: jest.fn(),
  set: jest.fn(),
  unset: jest.fn(),
  getSecretsFilePath: jest.fn(),
}));

jest.mock("../src/db/settings", () => ({
  getDefaultModel: jest.fn(),
}));

import app from "../src/app";
import * as secrets from "../src/secrets";
import { getDefaultModel } from "../src/db/settings";
import {
  loadChatContext,
  streamChatEvents,
  buildSystemPrompt,
  PROPOSE_TASK_TREE_TOOL,
} from "../src/services/chatService";

const repoFixture = {
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
  created_at: new Date("2026-04-01T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  (secrets.get as jest.Mock).mockImplementation((key: string) =>
    key === "ANTHROPIC_API_KEY" ? "sk-ant-test" : undefined
  );
  (loadChatContext as jest.Mock).mockResolvedValue({});
  (getDefaultModel as jest.Mock).mockResolvedValue("claude-default-from-settings");
  (streamChatEvents as jest.Mock).mockImplementation(() =>
    asyncIterable([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ])
  );
});

async function* asyncIterable<T>(items: T[]) {
  for (const i of items) yield i;
}

describe("POST /api/chat", () => {
  it("returns 400 when messages is missing or empty", async () => {
    const res1 = await request(app).post("/api/chat").send({});
    expect(res1.status).toBe(400);

    const res2 = await request(app).post("/api/chat").send({ messages: [] });
    expect(res2.status).toBe(400);
  });

  it("returns 400 when a message has an invalid role", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "system", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role/);
  });

  it("returns 400 when a message has missing/empty content", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "" }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when repo_id is provided but not numeric", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        repo_id: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repo_id/);
  });

  it("returns 500 when ANTHROPIC_API_KEY is not configured", async () => {
    (secrets.get as jest.Mock).mockReturnValue(undefined);
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("streams Claude text deltas back as SSE events", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain('data: {"text":"Hello"}');
    expect(res.text).toContain('data: {"text":" world"}');
    expect(res.text).toContain("event: done");
  });

  it("emits an SSE error event when the model stream throws", async () => {
    (streamChatEvents as jest.Mock).mockImplementation(
      async function* failingStream() {
        // Trigger an error mid-iteration.
        throw new Error("upstream blew up");
        // eslint-disable-next-line no-unreachable
        yield { type: "text", text: "x" };
      }
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: error");
    expect(res.text).toContain("upstream blew up");
  });

  it("loads repo + recent task history into the system prompt when repo_id is provided", async () => {
    (loadChatContext as jest.Mock).mockResolvedValue({
      repo: repoFixture,
      recentTasks: [
        {
          id: 99,
          repo_id: 7,
          parent_id: null,
          title: "Migrate widgets",
          description: "",
          order_position: 0,
          status: "done",
          retry_count: 0,
          pr_url: null,
          worker_id: null,
          leased_until: null,
          ordering_mode: null,
          log_path: null,
          created_at: new Date("2026-04-20T00:00:00Z"),
        },
      ],
    });

    const res = await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "plan a feature" }],
        repo_id: 7,
      });

    expect(res.status).toBe(200);
    expect(loadChatContext).toHaveBeenCalledWith(expect.anything(), 7);

    expect(streamChatEvents).toHaveBeenCalledTimes(1);
    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.messages).toEqual([
      { role: "user", content: "plan a feature" },
    ]);
    expect(args.system).toContain("Current repo");
    expect(args.system).toContain("acme/widgets");
    expect(args.system).toContain("Recent task history");
    expect(args.system).toContain("#99");
    // Schema is always embedded.
    expect(args.system).toContain("repos(");
    expect(args.system).toContain("tasks(");
  });

  it("does not include repo/history sections when no repo_id is provided", async () => {
    (loadChatContext as jest.Mock).mockResolvedValue({});

    await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.system).not.toContain("Current repo");
    expect(args.system).not.toContain("Recent task history");
    expect(args.system).toContain("repos(");
  });

  it("uses the user's last assistant turn as part of the message history (multi-turn)", async () => {
    await request(app)
      .post("/api/chat")
      .send({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second" },
        ],
      });

    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "second" },
    ]);
  });

  it("calls buildSystemPrompt with the loaded context (so future context fields flow through)", async () => {
    const ctx = { repo: repoFixture, recentTasks: [] as never[] };
    (loadChatContext as jest.Mock).mockResolvedValue(ctx);

    await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        repo_id: 7,
      });

    expect(buildSystemPrompt).toHaveBeenCalledWith(ctx);
  });

  it("registers the propose_task_tree tool with each model call", async () => {
    await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.tools).toBeDefined();
    expect(args.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: PROPOSE_TASK_TREE_TOOL.name }),
      ])
    );
  });

  it("emits a structured `proposal` SSE event when the model calls propose_task_tree", async () => {
    const proposal = {
      parents: [
        {
          title: "Add login flow",
          description: "User can sign in with email/password.",
          acceptance_criteria: ["GET /login renders form"],
          children: [
            { title: "Wire DB schema for users" },
            { title: "POST /login route with bcrypt check" },
          ],
        },
      ],
    };
    (streamChatEvents as jest.Mock).mockImplementation(() =>
      asyncIterable([
        { type: "text", text: "Here's a plan:" },
        { type: "proposal", proposal },
      ])
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "build login" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: proposal");
    expect(res.text).toContain(JSON.stringify({ proposal }));
    // Done event still fires after the proposal.
    expect(res.text).toContain("event: done");
  });

  it("emits a `proposal_error` SSE event when the tool input is malformed", async () => {
    (streamChatEvents as jest.Mock).mockImplementation(() =>
      asyncIterable([
        {
          type: "proposal_error",
          error: "parents must be a non-empty array",
          raw: {},
        },
      ])
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "build login" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: proposal_error");
    expect(res.text).toContain("parents must be a non-empty array");
  });

  // ---- task #322 — model resolution (settings.default_model + per-request override) ----
  it("AC #1144 — reads settings.default_model on each chat call and forwards it to streamChatEvents", async () => {
    await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(getDefaultModel).toHaveBeenCalledTimes(1);
    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.model).toBe("claude-default-from-settings");
  });

  it("AC #1144 — re-reads settings.default_model on every chat call (no caching)", async () => {
    (getDefaultModel as jest.Mock)
      .mockResolvedValueOnce("first-call-model")
      .mockResolvedValueOnce("second-call-model");

    await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi again" }] });

    expect(getDefaultModel).toHaveBeenCalledTimes(2);
    const firstArgs = (streamChatEvents as jest.Mock).mock.calls[0][0];
    const secondArgs = (streamChatEvents as jest.Mock).mock.calls[1][0];
    expect(firstArgs.model).toBe("first-call-model");
    expect(secondArgs.model).toBe("second-call-model");
  });

  it("AC #1145 — per-request `model` overrides settings.default_model and skips the settings read", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-7",
      });

    expect(res.status).toBe(200);
    // Override is honored verbatim …
    const args = (streamChatEvents as jest.Mock).mock.calls[0][0];
    expect(args.model).toBe("claude-opus-4-7");
    // … and we do not bother reading settings when the caller already pinned
    // the model for this session.
    expect(getDefaultModel).not.toHaveBeenCalled();
  });

  it("AC #1145 — rejects a non-string `model` field with 400", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        model: 42,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/);
    expect(streamChatEvents).not.toHaveBeenCalled();
  });

  it("AC #1145 — rejects an empty/whitespace-only `model` with 400", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        model: "   ",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/);
  });
});
