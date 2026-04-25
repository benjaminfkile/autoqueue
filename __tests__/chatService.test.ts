import {
  buildSystemPrompt,
  GRUNT_SCHEMA,
  loadChatContext,
  streamChatTextDeltas,
  streamChatEvents,
  AnthropicLike,
  AnthropicStreamEvent,
  PROPOSE_TASK_TREE_TOOL,
  PROPOSE_TASK_TREE_TOOL_NAME,
  validateTaskTreeProposal,
  ChatStreamEvent,
} from "../src/services/chatService";
import { Repo, Task } from "../src/interfaces";

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));
jest.mock("../src/db/tasks", () => ({
  getTasksByRepoId: jest.fn(),
}));
import { getRepoById } from "../src/db/repos";
import { getTasksByRepoId } from "../src/db/tasks";

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
  created_at: new Date("2026-04-01T00:00:00Z"),
};

const makeTask = (overrides: Partial<Task>): Task => ({
  id: 1,
  repo_id: 7,
  parent_id: null,
  title: "T",
  description: "",
  order_position: 0,
  status: "pending",
  retry_count: 0,
  pr_url: null,
  worker_id: null,
  leased_until: null,
  ordering_mode: null,
  log_path: null,
  created_at: new Date("2026-04-10T00:00:00Z"),
  ...overrides,
});

describe("buildSystemPrompt", () => {
  it("always includes the grunt schema block", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(GRUNT_SCHEMA);
  });

  it("identifies the assistant as Grunt's planning assistant", () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("planning");
  });

  it("does not include repo or task sections when no context is provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Current repo");
    expect(prompt).not.toContain("Recent task history");
  });

  it("includes the current repo block when a repo is in context", () => {
    const prompt = buildSystemPrompt({ repo: repoFixture });
    expect(prompt).toContain("Current repo");
    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("base_branch: main");
    expect(prompt).toContain("ordering_mode: sequential");
  });

  it("falls back to local_path for repos with no owner/repo_name", () => {
    const prompt = buildSystemPrompt({
      repo: { ...repoFixture, owner: null, repo_name: null, is_local_folder: true, local_path: "C:/work/proj" },
    });
    expect(prompt).toContain("C:/work/proj");
    expect(prompt).toContain("local_folder: C:/work/proj");
  });

  it("includes recent task history when tasks are provided", () => {
    const prompt = buildSystemPrompt({
      repo: repoFixture,
      recentTasks: [
        makeTask({ id: 11, title: "A", status: "done" }),
        makeTask({ id: 12, title: "B", status: "pending", parent_id: 11 }),
      ],
    });
    expect(prompt).toContain("Recent task history");
    expect(prompt).toContain("#11 [done]");
    expect(prompt).toContain("A");
    expect(prompt).toContain("#12 [pending] parent=11 B");
  });

  it("omits the recent-tasks section when the array is empty", () => {
    const prompt = buildSystemPrompt({ repo: repoFixture, recentTasks: [] });
    expect(prompt).not.toContain("Recent task history");
  });
});

describe("loadChatContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns an empty context when repoId is null/undefined", async () => {
    const ctx = await loadChatContext({} as never, null);
    expect(ctx).toEqual({});
    expect(getRepoById).not.toHaveBeenCalled();
  });

  it("returns an empty context when the repo does not exist", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(undefined);
    const ctx = await loadChatContext({} as never, 999);
    expect(ctx).toEqual({});
  });

  it("loads repo and recent tasks (sorted newest-first, capped at 10)", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(repoFixture);
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: i + 1, created_at: new Date(2026, 3, i + 1) })
    );
    (getTasksByRepoId as jest.Mock).mockResolvedValue(tasks);

    const ctx = await loadChatContext({} as never, 7);
    expect(ctx.repo).toEqual(repoFixture);
    expect(ctx.recentTasks).toHaveLength(10);
    // Newest first: id 15 then id 14 ... id 6
    expect(ctx.recentTasks?.[0].id).toBe(15);
    expect(ctx.recentTasks?.[9].id).toBe(6);
  });
});

describe("streamChatTextDeltas", () => {
  it("yields only text deltas from content_block_delta events", async () => {
    const events: AnthropicStreamEvent[] = [
      { type: "message_start" },
      { type: "content_block_start" },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } as never },
      { type: "content_block_stop" },
      { type: "message_stop" },
    ];

    const fakeClient: AnthropicLike = {
      messages: {
        create: jest.fn().mockResolvedValue(toAsyncIterable(events)),
      },
    };

    const out: string[] = [];
    for await (const chunk of streamChatTextDeltas({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      client: fakeClient,
    })) {
      out.push(chunk);
    }
    expect(out).toEqual(["Hel", "lo"]);
    expect(fakeClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      })
    );
  });

  it("propagates errors from the underlying client", async () => {
    const fakeClient: AnthropicLike = {
      messages: {
        create: jest.fn().mockRejectedValue(new Error("boom")),
      },
    };
    await expect(async () => {
      for await (const _ of streamChatTextDeltas({
        apiKey: "x",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        client: fakeClient,
      })) {
        // drain
        void _;
      }
    }).rejects.toThrow("boom");
  });
});

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe("buildSystemPrompt — propose_task_tree guidance", () => {
  it("instructs the model to call the propose_task_tree tool", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(PROPOSE_TASK_TREE_TOOL_NAME);
    expect(prompt.toLowerCase()).toContain("propose");
  });
});

describe("PROPOSE_TASK_TREE_TOOL definition", () => {
  it("uses the canonical tool name", () => {
    expect(PROPOSE_TASK_TREE_TOOL.name).toBe("propose_task_tree");
    expect(PROPOSE_TASK_TREE_TOOL_NAME).toBe("propose_task_tree");
  });

  it("declares an input_schema requiring a `parents` array", () => {
    expect(PROPOSE_TASK_TREE_TOOL.input_schema.type).toBe("object");
    const schema = PROPOSE_TASK_TREE_TOOL.input_schema as {
      required?: string[];
      properties?: { parents?: { type?: string } };
    };
    expect(schema.required).toEqual(expect.arrayContaining(["parents"]));
    expect(schema.properties?.parents?.type).toBe("array");
  });

  it("has a description so the model knows when to invoke it", () => {
    expect(PROPOSE_TASK_TREE_TOOL.description).toBeTruthy();
    expect((PROPOSE_TASK_TREE_TOOL.description ?? "").length).toBeGreaterThan(20);
  });
});

describe("validateTaskTreeProposal", () => {
  it("accepts a minimal valid proposal", () => {
    const result = validateTaskTreeProposal({
      parents: [{ title: "Build login" }],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.proposal.parents).toHaveLength(1);
      expect(result.proposal.parents[0].title).toBe("Build login");
    }
  });

  it("accepts a deeply nested tree with descriptions and acceptance_criteria", () => {
    const result = validateTaskTreeProposal({
      parents: [
        {
          title: "Phase 1",
          description: "Foundations",
          acceptance_criteria: ["repo bootstrapped"],
          children: [
            {
              title: "Schema",
              children: [{ title: "users table" }],
            },
            { title: "Routes" },
          ],
        },
      ],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.proposal.parents[0].children?.[0].children?.[0].title).toBe(
        "users table"
      );
      expect(result.proposal.parents[0].acceptance_criteria).toEqual([
        "repo bootstrapped",
      ]);
    }
  });

  it("strips unknown extra fields by ignoring them", () => {
    const result = validateTaskTreeProposal({
      parents: [{ title: "X", weird_extra: "ignored" }],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.proposal.parents[0]).toEqual({ title: "X" });
    }
  });

  it("rejects non-object root inputs (null/undefined/string/array)", () => {
    for (const input of [null, undefined, "string", [] as never]) {
      const result = validateTaskTreeProposal(input as unknown);
      expect(result.valid).toBe(false);
    }
  });

  it("rejects when parents is missing or empty", () => {
    expect(validateTaskTreeProposal({}).valid).toBe(false);
    expect(validateTaskTreeProposal({ parents: [] }).valid).toBe(false);
    expect(validateTaskTreeProposal({ parents: "nope" }).valid).toBe(false);
  });

  it("rejects nodes without a title", () => {
    const r = validateTaskTreeProposal({ parents: [{}] });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/title/);
  });

  it("rejects empty-string titles", () => {
    const r = validateTaskTreeProposal({ parents: [{ title: "   " }] });
    expect(r.valid).toBe(false);
  });

  it("rejects non-string acceptance_criteria items with a useful path", () => {
    const r = validateTaskTreeProposal({
      parents: [
        { title: "T", acceptance_criteria: ["ok", 5] },
      ],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/acceptance_criteria\[1\]/);
  });

  it("rejects a malformed nested child node and reports its path", () => {
    const r = validateTaskTreeProposal({
      parents: [
        { title: "Root", children: [{ title: "ok" }, { title: "" }] },
      ],
    });
    expect(r.valid).toBe(false);
    if (!r.valid)
      expect(r.error).toMatch(/parents\[0\].children\[1\]/);
  });
});

describe("streamChatEvents", () => {
  it("yields text events for text deltas", async () => {
    const events: AnthropicStreamEvent[] = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      client: fakeClient,
    })) {
      out.push(e);
    }

    expect(out).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("forwards tools to the client when provided", async () => {
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable([])) },
    };
    for await (const _ of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      client: fakeClient,
      tools: [PROPOSE_TASK_TREE_TOOL],
    })) {
      void _;
    }
    expect(fakeClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [PROPOSE_TASK_TREE_TOOL],
      })
    );
  });

  it("emits a `proposal` event when the model calls propose_task_tree with valid input", async () => {
    const proposal = {
      parents: [
        {
          title: "Login feature",
          children: [{ title: "Add /login route" }],
        },
      ],
    };
    const json = JSON.stringify(proposal);
    // Split the JSON across two partial deltas to mimic streaming behavior.
    const half = Math.floor(json.length / 2);
    const events: AnthropicStreamEvent[] = [
      { type: "message_start" },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          name: "propose_task_tree",
          id: "toolu_1",
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
      { type: "message_stop" },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      client: fakeClient,
      tools: [PROPOSE_TASK_TREE_TOOL],
    })) {
      out.push(e);
    }

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "proposal", proposal });
  });

  it("emits a `proposal_error` event when the model's input is not valid JSON", async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "propose_task_tree", id: "x" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{ not json" },
      },
      { type: "content_block_stop", index: 0 },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
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

  it("emits a `proposal_error` event when the input fails schema validation", async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "propose_task_tree", id: "x" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ parents: [] }) },
      },
      { type: "content_block_stop", index: 0 },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
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

  it("ignores tool_use blocks for tool names other than propose_task_tree", async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "some_other_tool", id: "x" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"foo":1}' },
      },
      { type: "content_block_stop", index: 0 },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      client: fakeClient,
    })) {
      out.push(e);
    }

    expect(out).toEqual([]);
  });

  it("interleaves text and proposal events in stream order", async () => {
    const proposal = { parents: [{ title: "T" }] };
    const events: AnthropicStreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "preamble " } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", name: "propose_task_tree", id: "y" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(proposal) },
      },
      { type: "content_block_stop", index: 1 },
    ];
    const fakeClient: AnthropicLike = {
      messages: { create: jest.fn().mockResolvedValue(toAsyncIterable(events)) },
    };

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      client: fakeClient,
    })) {
      out.push(e);
    }
    expect(out).toEqual([
      { type: "text", text: "preamble " },
      { type: "proposal", proposal },
    ]);
  });
});
