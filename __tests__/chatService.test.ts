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
jest.mock("../src/services/repoTools", () => ({
  __esModule: true,
  listFiles: jest.fn(),
  readFile: jest.fn(),
  search: jest.fn(),
}));
import { getRepoById } from "../src/db/repos";
import { getTasksByRepoId } from "../src/db/tasks";
import {
  listFiles as listFilesMock,
  readFile as readFileMock,
  search as searchMock,
} from "../src/services/repoTools";

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
  requires_approval: false,
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

describe("streamChatEvents — multi-tool turn loop", () => {
  // Mock the repo-tool implementations the loop dispatches into. Keeping the
  // mocks at the chatService boundary (not the underlying fs/db) means each
  // assertion can spell out exactly what the model would receive on the next
  // turn without simulating a real repo on disk.
  const repoTools = {
    listFiles: listFilesMock as jest.Mock,
    readFile: readFileMock as jest.Mock,
    search: searchMock as jest.Mock,
  };

  beforeEach(() => {
    repoTools.listFiles.mockReset();
    repoTools.readFile.mockReset();
    repoTools.search.mockReset();
  });

  // Build an Anthropic-shaped stream representing a single assistant message.
  // Each `block` is either a text segment (string) or a tool_use spec.
  type Block =
    | { kind: "text"; text: string }
    | { kind: "tool_use"; id: string; name: string; input: unknown };
  function buildStream(blocks: Block[]): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = [{ type: "message_start" }];
    blocks.forEach((b, i) => {
      if (b.kind === "text") {
        out.push({
          type: "content_block_start",
          index: i,
          content_block: { type: "text" },
        });
        out.push({
          type: "content_block_delta",
          index: i,
          delta: { type: "text_delta", text: b.text },
        });
        out.push({ type: "content_block_stop", index: i });
      } else {
        out.push({
          type: "content_block_start",
          index: i,
          content_block: { type: "tool_use", id: b.id, name: b.name },
        });
        out.push({
          type: "content_block_delta",
          index: i,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(b.input),
          },
        });
        out.push({ type: "content_block_stop", index: i });
      }
    });
    out.push({ type: "message_stop" });
    return out;
  }

  // A fake AnthropicLike whose `create` returns a fresh async iterable for
  // each call, drawn in order from `turns`. After all turns are consumed,
  // further calls return an empty iterable (which the loop interprets as
  // "no tool calls — done").
  function fakeClient(turns: AnthropicStreamEvent[][]): {
    client: AnthropicLike;
    create: jest.Mock;
  } {
    const create = jest.fn();
    for (const events of turns) {
      create.mockResolvedValueOnce(toAsyncIterable(events));
    }
    create.mockResolvedValue(toAsyncIterable([]));
    return { client: { messages: { create } }, create };
  }

  it("AC #1079 — completes a multi-turn loop: tool_use → tool_result → text → end", async () => {
    repoTools.readFile.mockResolvedValueOnce({
      ok: true,
      content: "console.log('hi')\n",
    });

    // Turn 1: model asks to read_file
    // Turn 2: model emits a final text response
    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_1", name: "read_file", input: { repo_id: 7, path: "x.ts" } },
      ]),
      buildStream([{ kind: "text", text: "Looks good." }]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "review" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(out).toEqual([{ type: "text", text: "Looks good." }]);
    expect(create).toHaveBeenCalledTimes(2);

    // The second API call must include the assistant's tool_use turn AND the
    // user turn carrying the tool_result, threaded through in order.
    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages).toHaveLength(3);
    expect(secondCall.messages[0]).toEqual({
      role: "user",
      content: "review",
    });
    expect(secondCall.messages[1].role).toBe("assistant");
    expect(secondCall.messages[1].content).toEqual([
      {
        type: "tool_use",
        id: "tu_1",
        name: "read_file",
        input: { repo_id: 7, path: "x.ts" },
      },
    ]);
    expect(secondCall.messages[2].role).toBe("user");
    expect(secondCall.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "console.log('hi')\n",
      },
    ]);
  });

  it("AC #1079 — dispatches every tool_use in a single turn and bundles tool_results in one user message", async () => {
    repoTools.search.mockResolvedValueOnce({
      ok: true,
      matches: [{ path: "a.ts", line: 1, text: "foo" }],
      truncated: false,
    });
    repoTools.listFiles.mockResolvedValueOnce({
      ok: true,
      entries: [{ path: "a.ts", type: "file", size: 10 }],
      truncated: false,
    });

    // Single turn with two tool_uses, then a final text turn.
    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_a", name: "search", input: { repo_id: 7, pattern: "foo" } },
        { kind: "tool_use", id: "tu_b", name: "list_files", input: { repo_id: 7 } },
      ]),
      buildStream([{ kind: "text", text: "ok" }]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(repoTools.search).toHaveBeenCalledTimes(1);
    expect(repoTools.listFiles).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);

    // Both tool_uses appear on the assistant turn, both tool_results on the
    // single follow-up user turn — never two separate user turns.
    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages[1].content).toHaveLength(2);
    expect(secondCall.messages[2].content).toHaveLength(2);
    expect(
      (secondCall.messages[2].content as Array<{ tool_use_id: string }>).map(
        (b) => b.tool_use_id
      )
    ).toEqual(["tu_a", "tu_b"]);
  });

  it("AC #1080 — surfaces a failed tool as a tool_result with is_error=true", async () => {
    repoTools.readFile.mockResolvedValueOnce({
      ok: false,
      error: "file not found: missing.ts",
    });

    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_x", name: "read_file", input: { repo_id: 7, path: "missing.ts" } },
      ]),
      buildStream([{ kind: "text", text: "Sorry." }]),
    ]);

    for await (const _ of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "read missing" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      void _;
    }

    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_x",
        content: "file not found: missing.ts",
        is_error: true,
      },
    ]);
  });

  it("AC #1080 — a thrown handler error becomes is_error=true rather than crashing the loop", async () => {
    repoTools.search.mockRejectedValueOnce(new Error("db connection lost"));

    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_y", name: "search", input: { repo_id: 7, pattern: "x" } },
      ]),
      buildStream([{ kind: "text", text: "Couldn't search." }]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "search x" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(out).toEqual([{ type: "text", text: "Couldn't search." }]);
    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_y",
        content: "db connection lost",
        is_error: true,
      },
    ]);
  });

  it("AC #1080 — repo tool calls without a repoToolsContext are surfaced as is_error=true tool_results", async () => {
    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_z", name: "read_file", input: { repo_id: 7, path: "x" } },
      ]),
      buildStream([{ kind: "text", text: "skipped" }]),
    ]);

    for await (const _ of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "read x" }],
      client,
      // Deliberately no repoToolsContext.
    })) {
      void _;
    }

    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_z",
      is_error: true,
    });
  });

  it("AC #1081 — text deltas continue to stream while tools are being dispatched", async () => {
    repoTools.search.mockResolvedValueOnce({
      ok: true,
      matches: [],
      truncated: false,
    });

    // First turn: text "Looking..." then a tool_use.
    // Second turn: more text deltas in two chunks, no tool_use → end.
    const { client } = fakeClient([
      buildStream([
        { kind: "text", text: "Looking… " },
        { kind: "tool_use", id: "tu_t", name: "search", input: { repo_id: 7, pattern: "x" } },
      ]),
      buildStream([
        { kind: "text", text: "No " },
        { kind: "text", text: "matches." },
      ]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "any matches?" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(out).toEqual([
      { type: "text", text: "Looking… " },
      { type: "text", text: "No " },
      { type: "text", text: "matches." },
    ]);
  });

  it("treats propose_task_tree as terminal: emits the proposal and stops without a follow-up API call", async () => {
    const proposal = { parents: [{ title: "Build auth" }] };
    const { client, create } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_p",
          name: "propose_task_tree",
          input: proposal,
        },
      ]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "plan" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(out).toEqual([{ type: "proposal", proposal }]);
    // Once the proposal lands, the user owns the next move — no point
    // round-tripping to the model again.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("propose_task_tree alongside read-only tools still terminates after the proposal (other tool_results are not sent)", async () => {
    repoTools.search.mockResolvedValueOnce({
      ok: true,
      matches: [],
      truncated: false,
    });
    const proposal = { parents: [{ title: "Refactor auth" }] };
    const { client, create } = fakeClient([
      buildStream([
        { kind: "tool_use", id: "tu_s", name: "search", input: { repo_id: 7, pattern: "x" } },
        { kind: "tool_use", id: "tu_p", name: "propose_task_tree", input: proposal },
      ]),
    ]);

    const out: ChatStreamEvent[] = [];
    for await (const e of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "plan" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
    })) {
      out.push(e);
    }

    expect(out).toEqual([{ type: "proposal", proposal }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("aborts the loop after maxToolTurns rather than spinning forever", async () => {
    repoTools.listFiles.mockResolvedValue({
      ok: true,
      entries: [],
      truncated: false,
    });

    // The model keeps calling list_files on every turn — the loop should
    // bail after `maxToolTurns` API calls and return without throwing.
    const create = jest.fn().mockImplementation(async () =>
      toAsyncIterable(
        buildStream([
          {
            kind: "tool_use",
            id: "tu_loop",
            name: "list_files",
            input: { repo_id: 7 },
          },
        ])
      )
    );
    const client: AnthropicLike = { messages: { create } };

    for await (const _ of streamChatEvents({
      apiKey: "x",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      client,
      repoToolsContext: { db: {} as never, reposPath: "/r" },
      maxToolTurns: 3,
    })) {
      void _;
    }

    expect(create).toHaveBeenCalledTimes(3);
  });
});
