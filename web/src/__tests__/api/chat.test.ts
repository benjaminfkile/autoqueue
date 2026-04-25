import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError, chatApi, parseSseChunk } from "../../api/client";
import type { ChatStreamEvent } from "../../api/types";

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("parseSseChunk", () => {
  it("parses delta events", () => {
    const events: ChatStreamEvent[] = [];
    const remainder = parseSseChunk(sse("delta", { text: "hi" }), (e) =>
      events.push(e)
    );
    expect(remainder).toBe("");
    expect(events).toEqual([{ type: "delta", text: "hi" }]);
  });

  it("parses proposal events", () => {
    const events: ChatStreamEvent[] = [];
    const proposal = { parents: [{ title: "T" }] };
    parseSseChunk(sse("proposal", { proposal }), (e) => events.push(e));
    expect(events).toEqual([{ type: "proposal", proposal }]);
  });

  it("parses proposal_error and error events", () => {
    const events: ChatStreamEvent[] = [];
    const buf = sse("proposal_error", { error: "bad json" }) +
      sse("error", { error: "boom" });
    parseSseChunk(buf, (e) => events.push(e));
    expect(events).toEqual([
      { type: "proposal_error", error: "bad json" },
      { type: "error", error: "boom" },
    ]);
  });

  it("emits done with no payload", () => {
    const events: ChatStreamEvent[] = [];
    parseSseChunk("event: done\ndata: {}\n\n", (e) => events.push(e));
    expect(events).toEqual([{ type: "done" }]);
  });

  it("returns the trailing partial frame as buffer remainder", () => {
    const events: ChatStreamEvent[] = [];
    const partial = sse("delta", { text: "hello" }) +
      "event: delta\ndata: {\"text\":\"part";
    const remainder = parseSseChunk(partial, (e) => events.push(e));
    expect(events).toEqual([{ type: "delta", text: "hello" }]);
    expect(remainder).toBe("event: delta\ndata: {\"text\":\"part");
  });

  it("ignores frames with no event name", () => {
    const events: ChatStreamEvent[] = [];
    parseSseChunk("data: {\"text\":\"orphan\"}\n\n", (e) => events.push(e));
    expect(events).toEqual([]);
  });

  it("skips frames with malformed JSON", () => {
    const events: ChatStreamEvent[] = [];
    parseSseChunk("event: delta\ndata: not-json\n\n", (e) => events.push(e));
    expect(events).toEqual([]);
  });
});

describe("chatApi.stream", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function streamingResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("dispatches parsed events from a streaming response", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        sse("delta", { text: "hello" }),
        sse("delta", { text: " world" }),
        sse("proposal", { proposal: { parents: [{ title: "T" }] } }),
        "event: done\ndata: {}\n\n",
      ])
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    await chatApi.stream({
      messages: [{ role: "user", content: "hi" }],
      repoId: 5,
      onEvent: (e) => events.push(e),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/chat");
    const init = call[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [{ role: "user", content: "hi" }],
      repo_id: 5,
    });
    expect(events).toEqual([
      { type: "delta", text: "hello" },
      { type: "delta", text: " world" },
      { type: "proposal", proposal: { parents: [{ title: "T" }] } },
      { type: "done" },
    ]);
  });

  it("handles event frames split across chunks", async () => {
    const full = sse("delta", { text: "abc" });
    const half = full.length / 2;
    const fetchMock = vi.fn(async () =>
      streamingResponse([full.slice(0, half), full.slice(half)])
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    await chatApi.stream({
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{ type: "delta", text: "abc" }]);
  });

  it("throws ApiError when the server returns a non-OK status", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    await expect(
      chatApi.stream({
        messages: [{ role: "user", content: "hi" }],
        onEvent: () => {},
      })
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "boom",
    });
  });
});

describe("chatApi.materialize", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the proposal to /api/repos/:id/materialize-tree", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: typeof input === "string" ? input : input.toString(),
          init: init ?? {},
        });
        return new Response(
          JSON.stringify({ parents: [] }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const result = await chatApi.materialize(7, {
      parents: [{ title: "T" }],
    });
    expect(result).toEqual({ parents: [] });
    expect(calls[0].url).toBe("/api/repos/7/materialize-tree");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(
      JSON.stringify({ parents: [{ title: "T" }] })
    );
  });

  it("surfaces server-side errors as ApiError", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Repo not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
    await expect(
      chatApi.materialize(7, { parents: [{ title: "T" }] })
    ).rejects.toBeInstanceOf(ApiError);
  });
});
