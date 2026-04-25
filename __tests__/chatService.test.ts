import {
  buildSystemPrompt,
  GRUNT_SCHEMA,
  loadChatContext,
  streamChatTextDeltas,
  AnthropicLike,
  AnthropicStreamEvent,
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
