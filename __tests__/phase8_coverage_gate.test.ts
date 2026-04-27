// ---------------------------------------------------------------------------
// Phase 8 coverage gate (task #298)
//
// Pins down the three contracts that ship the Phase 7 ("Read-only repo tools
// in planning chat") work and that no single other test exercises end-to-end:
//
//   AC #1082 — Path traversal attempts are blocked. Sibling unit tests
//              (repoPath.test.ts, repoTools.test.ts) prove the resolver and
//              the tool layer each reject traversal in isolation. This gate
//              proves the FULL chain rejects: a model-issued tool_use through
//              chatService → real repoTools dispatch → real repoPath →
//              real fs lands as an `is_error: true` tool_result that the
//              model can read. A regression that bypasses repoPath in any
//              one of the three tools (list_files, read_file, search) would
//              surface here.
//
//   AC #1083 — Byte cap is enforced. read_file's READ_FILE_BYTE_CAP must
//              hold both for the "no range, big file" fast path and for the
//              "range that itself is too large" slow path, AND it must hold
//              when the call comes through chatService's tool-use loop (so
//              the cap is not accidentally lifted by some serialization step
//              upstream of the handler).
//
//   AC #1084 — A simulated multi-tool turn round-trips. A scripted Anthropic
//              client emits a tool_use turn, the loop dispatches into the
//              REAL repoTools handlers against a real on-disk fixture, the
//              tool_results are threaded back into the next API call, and a
//              final assistant text turn closes the loop. This is the full
//              "model → tool → fs → tool_result → model" round-trip; sibling
//              tests in chatService.test.ts mock at the repoTools boundary
//              and so cannot prove the wire-up actually works.
//
// Note on layering: this file deliberately avoids mocking repoTools or
// repoPath. It mocks only `getRepoById` (so we don't need a live DB) and the
// Anthropic streaming client (so we don't need a live API). Everything else
// — listFiles / readFile / search / resolveSafePath / fs — runs for real.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  AnthropicLike,
  AnthropicStreamEvent,
  ChatStreamEvent,
  streamChatEvents,
} from "../src/services/chatService";
import { READ_FILE_BYTE_CAP } from "../src/services/repoTools";
import { Repo } from "../src/interfaces";

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));
import { getRepoById } from "../src/db/repos";

const baseRepo: Repo = {
  id: 1,
  owner: "acme",
  repo_name: "widgets",
  active: true,
  base_branch: "main",
  base_branch_parent: "main",
  require_pr: false,
  github_token: null,
  is_local_folder: true,
  local_path: "",
  on_failure: "halt_subtree",
  max_retries: 0,
  on_parent_child_fail: "ignore",
  ordering_mode: "sequential",
  clone_status: "ready",
  clone_error: null,
  created_at: new Date(),
};

// ---------------------------------------------------------------------------
// Anthropic stream helpers
//
// Mirrors the helper in chatService.test.ts but kept local so this gate file
// stays self-contained — a future move/rename of chatService.test.ts must not
// silently drop this file's contracts on the floor.
// ---------------------------------------------------------------------------
async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

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

function fakeClient(turns: AnthropicStreamEvent[][]): {
  client: AnthropicLike;
  create: jest.Mock;
  snapshots: Array<{ messages: unknown[] }>;
} {
  // chatService keeps a single `conversation` array across the loop and
  // pushes onto it after every API call. Jest captures call arguments by
  // reference, so `create.mock.calls[i][0].messages` reflects the FINAL
  // conversation state, not the state at call time. We snapshot the
  // messages at each call so multi-turn tests can inspect the conversation
  // shape that was actually sent to the model on round n.
  const snapshots: Array<{ messages: unknown[] }> = [];
  const create = jest.fn().mockImplementation(async (body: { messages: unknown[] }) => {
    snapshots.push({
      messages: JSON.parse(JSON.stringify(body.messages)),
    });
    const idx = create.mock.calls.length - 1;
    if (idx < turns.length) return toAsyncIterable(turns[idx]);
    // After every scripted turn is consumed, return an empty stream so the
    // loop interprets the next call (if any) as "no tool_use → done"
    // instead of hanging on an undefined mock return.
    return toAsyncIterable([]);
  });
  return { client: { messages: { create } }, create, snapshots };
}

// Helper to drain a streamChatEvents generator into an array.
async function drain(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// AC #1082 — Path traversal attempts are blocked end-to-end
// ---------------------------------------------------------------------------

describe("Phase 8 — path traversal is blocked through the full tool-dispatch chain (AC #1082)", () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-phase8-traversal-"));
    (getRepoById as jest.Mock).mockResolvedValue({
      ...baseRepo,
      local_path: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // We script the model to call each of the three read-only tools with a
  // payload that tries to escape the repo root, then assert the tool_result
  // the loop threads back into the second API call carries is_error=true and
  // the path-traversal error message. The second turn returns a final text
  // segment so the loop terminates naturally.
  //
  // Doing this for ALL THREE tools (list_files, read_file, search) is the
  // point: a regression that hardens one tool but forgets another would
  // pass the tool's own unit test and fail this gate.
  it.each([
    {
      name: "list_files",
      input: { repo_id: 1, path: "../escape" },
    },
    {
      name: "read_file",
      input: { repo_id: 1, path: "../escape/secret.txt" },
    },
    {
      name: "search",
      input: { repo_id: 1, pattern: "x", path: "../escape" },
    },
  ])(
    "%s rejects a `..`-traversal payload as an is_error tool_result",
    async ({ name, input }) => {
      const { client, create, snapshots } = fakeClient([
        buildStream([
          { kind: "tool_use", id: "tu_trv", name, input },
        ]),
        buildStream([{ kind: "text", text: "ok" }]),
      ]);

      const events = await drain(
        streamChatEvents({
          apiKey: "x",
          model: "claude-test-model",
          system: "sys",
          messages: [{ role: "user", content: "go" }],
          client,
          repoToolsContext: { db: {} as never, reposPath: "/unused" },
        })
      );

      // Loop made it to the second turn (so the tool_result was actually
      // routed back to the model) and the assistant's final text reached us.
      expect(events).toEqual([{ type: "text", text: "ok" }]);
      expect(create).toHaveBeenCalledTimes(2);

      const userTurn = (snapshots[1].messages as Array<{ role: string; content: unknown }>)[2];
      expect(userTurn.role).toBe("user");
      const toolResult = (userTurn.content as Array<{
        type: string;
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }>)[0];
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.tool_use_id).toBe("tu_trv");
      expect(toolResult.is_error).toBe(true);
      // The error string the model sees must mention the traversal — that is
      // the cue it uses to retry with a sane path instead of giving up.
      expect(toolResult.content).toMatch(/\.\./);
    }
  );

  it("absolute-path payloads are rejected with the same is_error treatment", async () => {
    // Absolute paths are a separate vector from `..` (different branch in
    // resolveSafePath) and must not slip through any of the three tools.
    const { client, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_abs",
          name: "read_file",
          input: { repo_id: 1, path: "/etc/passwd" },
        },
      ]),
      buildStream([{ kind: "text", text: "ok" }]),
    ]);

    await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "go" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    const toolResult = ((snapshots[1].messages as Array<{
      content: Array<{ content: string; is_error?: boolean }>;
    }>)[2].content)[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/relative|escape|absolute/);
  });

  it("symlink escapes (file inside the repo points outside) are rejected by read_file", async () => {
    // The literal path looks safe — `leak` is a name inside the repo. The
    // resolver must follow the symlink and notice the target is outside the
    // realpath'd root. This is a defense-in-depth check that proves the
    // symlink-resolution branch is wired into the chat dispatch path, not
    // just exercised in repoPath unit tests.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-phase8-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "shh");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmpDir, "leak"));

      const { client, snapshots } = fakeClient([
        buildStream([
          {
            kind: "tool_use",
            id: "tu_lnk",
            name: "read_file",
            input: { repo_id: 1, path: "leak" },
          },
        ]),
        buildStream([{ kind: "text", text: "ok" }]),
      ]);

      await drain(
        streamChatEvents({
          apiKey: "x",
          model: "claude-test-model",
          system: "sys",
          messages: [{ role: "user", content: "go" }],
          client,
          repoToolsContext: { db: {} as never, reposPath: "/unused" },
        })
      );

      const toolResult = ((snapshots[1].messages as Array<{
        content: Array<{ content: string; is_error?: boolean }>;
      }>)[2].content)[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toMatch(/symlink|outside|escape/);
      // Crucially, the symlink target's contents must NOT have leaked into
      // the tool_result. If we ever shipped the bytes back, we'd see "shh".
      expect(toolResult.content).not.toMatch(/shh/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC #1083 — Byte cap is enforced through the full tool-dispatch chain
// ---------------------------------------------------------------------------

describe("Phase 8 — read_file byte cap is enforced through the full tool-dispatch chain (AC #1083)", () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-phase8-bytecap-"));
    (getRepoById as jest.Mock).mockResolvedValue({
      ...baseRepo,
      local_path: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a model-issued read_file with no range refuses an over-cap file and tells the model to retry with a slice", async () => {
    // One byte over the cap — the simplest possible "too big" file. The
    // tool's contract is to surface a structured error string the model can
    // read; the loop must thread that error back as is_error=true so the
    // model re-issues read_file with start_line/end_line.
    fs.writeFileSync(
      path.join(tmpDir, "big.txt"),
      "a".repeat(READ_FILE_BYTE_CAP + 1)
    );

    const { client, create, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_big",
          name: "read_file",
          input: { repo_id: 1, path: "big.txt" },
        },
      ]),
      buildStream([{ kind: "text", text: "ok" }]),
    ]);

    await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "read it" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    expect(create).toHaveBeenCalledTimes(2);
    const toolResult = ((snapshots[1].messages as Array<{
      content: Array<{ content: string; is_error?: boolean }>;
    }>)[2].content)[0];
    expect(toolResult.is_error).toBe(true);
    // Three properties the model relies on:
    //   1. it knows the file is too big ("larger than"),
    //   2. it sees the exact cap (so it can plan a slice that fits),
    //   3. it sees the names of the args it should retry with.
    expect(toolResult.content).toMatch(/larger than/);
    expect(toolResult.content).toContain(String(READ_FILE_BYTE_CAP));
    expect(toolResult.content).toMatch(/start_line/);
    expect(toolResult.content).toMatch(/end_line/);
  });

  it("a small slice of an oversized file succeeds and the bytes the model sees are exactly the requested lines", async () => {
    // The "huge file but small slice" branch. Must produce real content (not
    // an error) and the content must be the requested lines, byte-for-byte.
    const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
    const body = lines.join("\n") + "\n";
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(READ_FILE_BYTE_CAP);
    fs.writeFileSync(path.join(tmpDir, "big.txt"), body);

    const { client, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_slice",
          name: "read_file",
          input: { repo_id: 1, path: "big.txt", start_line: 100, end_line: 102 },
        },
      ]),
      buildStream([{ kind: "text", text: "ok" }]),
    ]);

    await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "slice it" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    const toolResult = ((snapshots[1].messages as Array<{
      content: Array<{ content: string; is_error?: boolean }>;
    }>)[2].content)[0];
    expect(toolResult.is_error).toBeUndefined();
    expect(toolResult.content).toBe("line 100\nline 101\nline 102");
  });

  it("a slice that is itself over the cap is also rejected (the cap is final, not just a `read whole file` shortcut)", async () => {
    // Pathological case: a single-line file that exceeds the cap. Asking
    // for line 1..1 produces a slice == whole file, which still exceeds the
    // cap. The slow-path check must catch it. A regression where the cap was
    // checked only on full-file reads would let arbitrarily large content
    // through here.
    fs.writeFileSync(
      path.join(tmpDir, "wide.txt"),
      "a".repeat(READ_FILE_BYTE_CAP * 2)
    );

    const { client, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_oversliced",
          name: "read_file",
          input: { repo_id: 1, path: "wide.txt", start_line: 1, end_line: 1 },
        },
      ]),
      buildStream([{ kind: "text", text: "ok" }]),
    ]);

    await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "read it" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    const toolResult = ((snapshots[1].messages as Array<{
      content: Array<{ content: string; is_error?: boolean }>;
    }>)[2].content)[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/larger than/);
    expect(toolResult.content).toContain(String(READ_FILE_BYTE_CAP));
    // The error must steer the model toward narrowing the slice — not the
    // start_line/end_line wording (which would be confusing since it already
    // passed those), but a "narrower" hint.
    expect(toolResult.content).toMatch(/narrower/);
  });
});

// ---------------------------------------------------------------------------
// AC #1084 — A simulated multi-tool turn round-trips through real handlers
// ---------------------------------------------------------------------------

describe("Phase 8 — simulated multi-tool turn round-trips through the real tool layer (AC #1084)", () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-phase8-multitool-"));
    (getRepoById as jest.Mock).mockResolvedValue({
      ...baseRepo,
      local_path: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("model issues list_files + search + read_file across two turns; each tool_result reflects real fs state and the loop terminates with a final text turn", async () => {
    // -------------------------------------------------------------------
    // Fixture: a tiny but realistic repo. Nested file (so list_files has
    // something to recurse into), a needle to find (so search has work),
    // and a file to read in the second turn (so read_file gets exercised).
    // -------------------------------------------------------------------
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# project\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "main.ts"),
      ["import x from 'y'", "const NEEDLE = 1", "export {}"].join("\n") + "\n"
    );
    // Drop a .gitignore so we also prove the dispatch chain honours it
    // through the real handler — not just at the unit boundary.
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "vendored.js"),
      "const NEEDLE = 999\n"
    );

    // Turn 1: model parallelises list_files + search to orient itself.
    // Turn 2: model has the search hit, so it reads the file at the hit's
    //         line range to inspect.
    // Turn 3: model emits final text — the loop exits.
    const { client, create, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_ls",
          name: "list_files",
          input: { repo_id: 1, depth: 2 },
        },
        {
          kind: "tool_use",
          id: "tu_sr",
          name: "search",
          input: { repo_id: 1, pattern: "NEEDLE", literal: true },
        },
      ]),
      buildStream([
        { kind: "text", text: "Found NEEDLE in src/main.ts. " },
        {
          kind: "tool_use",
          id: "tu_rd",
          name: "read_file",
          input: { repo_id: 1, path: "src/main.ts", start_line: 2, end_line: 2 },
        },
      ]),
      buildStream([{ kind: "text", text: "It's a constant declaration." }]),
    ]);

    const events = await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "what's in here?" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    // -------------------------------------------------------------------
    // Event ordering. The mid-turn text must surface BEFORE the final text;
    // both must surface in the order they were streamed. A regression where
    // text was buffered until the loop exited would fail here.
    // -------------------------------------------------------------------
    expect(events).toEqual([
      { type: "text", text: "Found NEEDLE in src/main.ts. " },
      { type: "text", text: "It's a constant declaration." },
    ]);

    // Three Anthropic round trips: turn 1 emits tools, turn 2 emits a tool
    // and text, turn 3 emits final text and stops. A regression that bailed
    // early or kept looping would change this number.
    expect(create).toHaveBeenCalledTimes(3);

    // -------------------------------------------------------------------
    // Conversation shape after turn 1: assistant turn carries both tool_use
    // blocks; the follow-up user turn carries both tool_result blocks
    // bundled in ONE message (not two), in the same id order.
    // -------------------------------------------------------------------
    const turn2Messages = snapshots[1].messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(turn2Messages).toHaveLength(3);
    expect(turn2Messages[1].role).toBe("assistant");
    expect((turn2Messages[1].content as Array<{ id: string }>).map((b) => b.id)).toEqual([
      "tu_ls",
      "tu_sr",
    ]);
    expect(turn2Messages[2].role).toBe("user");
    const turn1Results = turn2Messages[2].content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
    expect(turn1Results).toHaveLength(2);
    expect(turn1Results.map((r) => r.tool_use_id)).toEqual(["tu_ls", "tu_sr"]);
    for (const r of turn1Results) {
      expect(r.type).toBe("tool_result");
      expect(r.is_error).toBeUndefined();
    }

    // The list_files result must be JSON with `entries` and `truncated`.
    const lsPayload = JSON.parse(turn1Results[0].content) as {
      entries: Array<{ path: string; type: string }>;
      truncated: boolean;
    };
    expect(lsPayload.truncated).toBe(false);
    const lsPaths = lsPayload.entries.map((e) => e.path).sort();
    // .gitignore must show up (it's at the root and not ignored), src/ and
    // its child must show up at depth=2, and node_modules MUST NOT — proving
    // the .gitignore was applied through the real walker.
    expect(lsPaths).toEqual(
      [".gitignore", "README.md", "src", "src/main.ts"].sort()
    );
    expect(lsPaths.some((p) => p.startsWith("node_modules"))).toBe(false);

    // The search result must be JSON with `matches` and `truncated`. The
    // hit in node_modules must NOT appear — same .gitignore argument.
    const srPayload = JSON.parse(turn1Results[1].content) as {
      matches: Array<{ path: string; line: number; text: string }>;
      truncated: boolean;
    };
    expect(srPayload.truncated).toBe(false);
    expect(srPayload.matches).toEqual([
      { path: "src/main.ts", line: 2, text: "const NEEDLE = 1" },
    ]);

    // -------------------------------------------------------------------
    // Conversation shape after turn 2: assistant turn carries text + the
    // read_file tool_use; the follow-up user turn carries the read_file
    // tool_result with the EXACT line slice from disk. This proves the
    // bytes the model sees on round n+1 are the bytes the handler computed
    // on round n — no transformation, no re-encoding.
    // -------------------------------------------------------------------
    const turn3Messages = snapshots[2].messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(turn3Messages).toHaveLength(5);
    expect(turn3Messages[3].role).toBe("assistant");
    const turn2AssistantBlocks = turn3Messages[3].content as Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
    }>;
    // Order: text segment first, then tool_use — matches the stream order.
    expect(turn2AssistantBlocks[0].type).toBe("text");
    expect(turn2AssistantBlocks[0].text).toBe(
      "Found NEEDLE in src/main.ts. "
    );
    expect(turn2AssistantBlocks[1].type).toBe("tool_use");
    expect(turn2AssistantBlocks[1].id).toBe("tu_rd");
    expect(turn2AssistantBlocks[1].name).toBe("read_file");

    const turn2Results = turn3Messages[4].content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
    expect(turn2Results).toHaveLength(1);
    expect(turn2Results[0].tool_use_id).toBe("tu_rd");
    expect(turn2Results[0].is_error).toBeUndefined();
    expect(turn2Results[0].content).toBe("const NEEDLE = 1");
  });

  it("a failing tool_use does not poison the rest of the turn — the model still sees results for sibling tools and the loop continues", async () => {
    // Mixed-fortune turn: list_files succeeds, read_file fails (file not
    // found). The loop must surface BOTH tool_results in the same user
    // message — not abort after the first failure — so the model has the
    // context to recover (e.g. by re-listing to find the right path).
    fs.writeFileSync(path.join(tmpDir, "real.txt"), "hello\n");

    const { client, create, snapshots } = fakeClient([
      buildStream([
        {
          kind: "tool_use",
          id: "tu_ls_ok",
          name: "list_files",
          input: { repo_id: 1 },
        },
        {
          kind: "tool_use",
          id: "tu_rd_bad",
          name: "read_file",
          input: { repo_id: 1, path: "does-not-exist.ts" },
        },
      ]),
      buildStream([{ kind: "text", text: "noted." }]),
    ]);

    await drain(
      streamChatEvents({
        apiKey: "x",
        model: "claude-test-model",
        system: "sys",
        messages: [{ role: "user", content: "look around" }],
        client,
        repoToolsContext: { db: {} as never, reposPath: "/unused" },
      })
    );

    expect(create).toHaveBeenCalledTimes(2);
    const results = ((snapshots[1].messages as Array<{
      content: Array<{
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }>;
    }>)[2].content);
    expect(results).toHaveLength(2);
    // Both tool_use ids present, in the order the model emitted them.
    expect(results.map((r) => r.tool_use_id)).toEqual([
      "tu_ls_ok",
      "tu_rd_bad",
    ]);
    // First result is success (no is_error flag).
    expect(results[0].is_error).toBeUndefined();
    expect(JSON.parse(results[0].content).entries.map((e: { path: string }) => e.path)).toContain(
      "real.txt"
    );
    // Second result is failure with a useful message.
    expect(results[1].is_error).toBe(true);
    expect(results[1].content).toMatch(/not found/);
  });
});
