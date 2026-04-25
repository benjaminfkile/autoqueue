import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatDrawer from "../../pages/chat/ChatDrawer";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const calls: FetchCall[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface DeferredStream {
  response: Response;
  emit: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
}

// Build a streaming Response whose body we can drive chunk-by-chunk from the
// test. Each `emit` enqueues an SSE frame and yields the microtask queue so
// React state updates from the consumer flush before assertions run.
function makeDeferredStream(): DeferredStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  return {
    response,
    emit: async (chunk: string) => {
      controller.enqueue(encoder.encode(chunk));
      await flush();
    },
    close: async () => {
      controller.close();
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  calls.length = 0;
  fetchMock = vi.fn();
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  // Default: empty repo list for /api/repos.
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init: init ?? {},
    });
    return jsonResponse([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatDrawer", () => {
  it("does not render content when closed", () => {
    render(<ChatDrawer open={false} onClose={() => {}} />);
    expect(screen.queryByRole("heading", { name: /planning chat/i })).toBeNull();
  });

  it("renders the heading and Close button when open", () => {
    render(<ChatDrawer open={true} onClose={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /planning chat/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /close chat drawer/i })
    ).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ChatDrawer open={true} onClose={onClose} />);
    await user.click(
      screen.getByRole("button", { name: /close chat drawer/i })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("streams delta tokens into an assistant bubble", async () => {
    const stream = makeDeferredStream();
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        if (url === "/api/repos") return jsonResponse([]);
        if (url === "/api/chat") return stream.response;
        return jsonResponse({});
      }
    );

    const user = userEvent.setup();
    render(<ChatDrawer open={true} onClose={() => {}} />);

    const input = screen.getByLabelText(/chat message/i);
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/chat")).toBe(true)
    );

    await stream.emit("event: delta\ndata: {\"text\":\"Hi\"}\n\n");
    await waitFor(() =>
      expect(screen.getByTestId("chat-message-assistant")).toHaveTextContent(
        /^Hi$/
      )
    );

    await stream.emit("event: delta\ndata: {\"text\":\" there\"}\n\n");
    await waitFor(() =>
      expect(screen.getByTestId("chat-message-assistant")).toHaveTextContent(
        /Hi there/
      )
    );

    await stream.emit("event: done\ndata: {}\n\n");
    await stream.close();

    const chatBody = JSON.parse(
      String(calls.find((c) => c.url === "/api/chat")?.init.body ?? "{}")
    );
    expect(chatBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(chatBody.repo_id).toBeNull();
  });

  it("renders an interactive proposal card from a proposal event and saves it via materialize", async () => {
    const stream = makeDeferredStream();
    const repo = {
      id: 9,
      owner: "me",
      repo_name: "x",
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: false,
      local_path: null,
      on_failure: "halt_subtree",
      max_retries: 0,
      on_parent_child_fail: "cascade_fail",
      ordering_mode: "sequential",
      created_at: new Date().toISOString(),
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        if (url === "/api/repos") return jsonResponse([repo]);
        if (url === "/api/chat") return stream.response;
        if (url === "/api/repos/9/materialize-tree") {
          return jsonResponse(
            {
              parents: [
                {
                  id: 1,
                  title: "Edited title",
                  parent_id: null,
                  order_position: 0,
                  acceptance_criteria_ids: [],
                  children: [],
                },
              ],
            },
            201
          );
        }
        return jsonResponse({});
      }
    );

    const user = userEvent.setup();
    render(<ChatDrawer open={true} onClose={() => {}} />);

    // Wait for the repo list to load so the chat drawer has a default.
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/repos")).toBe(true)
    );

    await user.type(screen.getByLabelText(/chat message/i), "make it");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/chat")).toBe(true)
    );

    const proposalPayload = JSON.stringify({
      proposal: {
        parents: [
          { title: "Original", description: "desc" },
        ],
      },
    });
    await stream.emit(`event: proposal\ndata: ${proposalPayload}\n\n`);
    await stream.emit("event: done\ndata: {}\n\n");
    await stream.close();

    const card = await screen.findByTestId("proposal-card");
    const titleField = within(card).getByLabelText(/^title for 1$/i);
    await user.clear(titleField);
    await user.type(titleField, "Edited title");

    await user.click(within(card).getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/api/repos/9/materialize-tree")
      ).toBe(true)
    );

    const materializeCall = calls.find(
      (c) => c.url === "/api/repos/9/materialize-tree"
    );
    expect(materializeCall?.init.method).toBe("POST");
    const body = JSON.parse(String(materializeCall?.init.body ?? "{}"));
    expect(body.parents[0].title).toBe("Edited title");

    await waitFor(() =>
      expect(within(card).getByText(/saved 1 task/i)).toBeInTheDocument()
    );
  });

  it("shows an error in the assistant bubble when the chat request fails", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        if (url === "/api/repos") return jsonResponse([]);
        if (url === "/api/chat") {
          return jsonResponse({ error: "no api key" }, 500);
        }
        return jsonResponse({});
      }
    );

    const user = userEvent.setup();
    render(<ChatDrawer open={true} onClose={() => {}} />);
    await user.type(screen.getByLabelText(/chat message/i), "hi");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() =>
      expect(screen.getByTestId("chat-message-assistant")).toHaveTextContent(
        /no api key/i
      )
    );
  });

  it("disables Send when the input is empty", () => {
    render(<ChatDrawer open={true} onClose={() => {}} />);
    expect(
      screen.getByRole("button", { name: /send message/i })
    ).toBeDisabled();
  });
});
