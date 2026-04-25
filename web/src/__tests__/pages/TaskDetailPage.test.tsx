import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskDetailPage, {
  formatEventData,
  formatEventTimestamp,
  taskBranchName,
} from "../../pages/repos/TaskDetailPage";
import type {
  AcceptanceCriterion,
  TaskDetail,
  TaskEvent,
} from "../../api/types";

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

const calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

interface RouteHandler {
  (init: RequestInit, urlObj: URL): Response | Promise<Response>;
}

interface Routes {
  "GET /api/tasks"?: RouteHandler;
  "GET /api/tasks/:id"?: RouteHandler;
  "GET /api/tasks/:id/events"?: RouteHandler;
  "GET /api/tasks/:id/log"?: RouteHandler;
  "PATCH /api/tasks/:id"?: RouteHandler;
  "PATCH /api/tasks/:taskId/criteria/:criterionId"?: RouteHandler;
}

function installFetch(routes: Routes) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input.toString();
      const urlObj = new URL(rawUrl, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? String(init.body) : null;
      calls.push({ url: rawUrl, method, body });
      const path = urlObj.pathname;

      if (
        method === "GET" &&
        path === "/api/tasks" &&
        routes["GET /api/tasks"]
      ) {
        return routes["GET /api/tasks"](init ?? {}, urlObj);
      }
      if (
        method === "GET" &&
        path === "/api/tasks" &&
        !routes["GET /api/tasks"]
      ) {
        return jsonResponse([]);
      }
      if (
        method === "GET" &&
        /^\/api\/tasks\/\d+$/.test(path) &&
        routes["GET /api/tasks/:id"]
      ) {
        return routes["GET /api/tasks/:id"](init ?? {}, urlObj);
      }
      if (
        method === "GET" &&
        /^\/api\/tasks\/\d+\/events$/.test(path) &&
        routes["GET /api/tasks/:id/events"]
      ) {
        return routes["GET /api/tasks/:id/events"](init ?? {}, urlObj);
      }
      if (
        method === "GET" &&
        /^\/api\/tasks\/\d+\/log$/.test(path) &&
        routes["GET /api/tasks/:id/log"]
      ) {
        return routes["GET /api/tasks/:id/log"](init ?? {}, urlObj);
      }
      if (
        method === "PATCH" &&
        /^\/api\/tasks\/\d+\/criteria\/\d+$/.test(path) &&
        routes["PATCH /api/tasks/:taskId/criteria/:criterionId"]
      ) {
        return routes["PATCH /api/tasks/:taskId/criteria/:criterionId"](
          init ?? {},
          urlObj
        );
      }
      if (
        method === "PATCH" &&
        /^\/api\/tasks\/\d+$/.test(path) &&
        routes["PATCH /api/tasks/:id"]
      ) {
        return routes["PATCH /api/tasks/:id"](init ?? {}, urlObj);
      }
      return jsonResponse({ error: `unhandled ${method} ${path}` }, 500);
    }
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeCriterion(
  partial: Partial<AcceptanceCriterion> & { id: number }
): AcceptanceCriterion {
  return {
    task_id: 1,
    description: "Criterion text",
    order_position: 0,
    met: false,
    created_at: "2026-04-01T00:00:00Z",
    ...partial,
  };
}

function makeDetail(partial: Partial<TaskDetail> & { id: number }): TaskDetail {
  return {
    repo_id: 1,
    parent_id: null,
    title: "Build the rocket",
    description: "Initial description",
    order_position: 0,
    status: "pending",
    retry_count: 0,
    pr_url: null,
    worker_id: null,
    leased_until: null,
    ordering_mode: null,
    log_path: null,
    created_at: "2026-04-01T00:00:00Z",
    acceptanceCriteria: [],
    children: [],
    ...partial,
  };
}

function makeEvent(partial: Partial<TaskEvent> & { id: number }): TaskEvent {
  return {
    task_id: 1,
    ts: "2026-04-01T00:00:00Z",
    event: "status_change",
    data: null,
    ...partial,
  };
}

interface MockEventSourceInstance {
  url: string;
  close: () => void;
  emit: (data: string) => void;
  emitError: () => void;
  isClosed: () => boolean;
}

const mockEventSourceInstances: MockEventSourceInstance[] = [];

class MockEventSource {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    mockEventSourceInstances.push({
      url,
      close: () => {
        this.closed = true;
      },
      emit: (data: string) => {
        if (!this.closed) {
          this.onmessage?.({ data } as MessageEvent);
        }
      },
      emitError: () => {
        this.onerror?.(new Event("error"));
      },
      isClosed: () => this.closed,
    });
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  calls.length = 0;
  mockEventSourceInstances.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { EventSource?: typeof EventSource })
    .EventSource;
});

describe("taskBranchName", () => {
  it("derives the canonical branch name from a task id", () => {
    expect(taskBranchName(42)).toBe("grunt/task-42");
  });
});

describe("formatEventTimestamp", () => {
  it("returns a locale string for valid ISO timestamps", () => {
    const out = formatEventTimestamp("2026-04-01T12:00:00Z");
    expect(out).not.toBe("2026-04-01T12:00:00Z");
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns the input for unparseable values", () => {
    expect(formatEventTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatEventData", () => {
  it("returns an empty string when data is null", () => {
    expect(formatEventData(null)).toBe("");
  });

  it("serializes data as JSON", () => {
    expect(formatEventData({ branch: "grunt/task-1" })).toContain(
      "grunt/task-1"
    );
  });
});

describe("TaskDetailPage", () => {
  it("loads and renders all core fields including branch and PR link", async () => {
    const detail = makeDetail({
      id: 7,
      title: "Implement feature",
      description: "Long description goes here.",
      pr_url: "https://github.com/me/x/pull/1",
      acceptanceCriteria: [
        makeCriterion({ id: 11, description: "Tests pass", met: true }),
        makeCriterion({
          id: 12,
          description: "Docs updated",
          met: false,
          order_position: 1,
        }),
      ],
      children: [
        {
          id: 99,
          title: "Subtask A",
          status: "pending",
          order_position: 0,
        },
      ],
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse("hello world"),
    });
    render(<TaskDetailPage taskId={7} />);

    expect(screen.getByLabelText(/loading task/i)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText("Implement feature")).toBeInTheDocument()
    );

    expect(screen.getByTestId("task-detail-status")).toHaveAttribute(
      "aria-label",
      "Status: pending"
    );
    expect(screen.getByTestId("task-detail-branch")).toHaveAttribute(
      "aria-label",
      "Current branch: grunt/task-7"
    );
    const prChip = screen.getByTestId("task-detail-pr");
    expect(prChip).toHaveAttribute("href", "https://github.com/me/x/pull/1");

    expect(screen.getByText("Tests pass")).toBeInTheDocument();
    expect(screen.getByText("Docs updated")).toBeInTheDocument();
    expect(screen.getByText("Subtask A")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-log")).toHaveTextContent(
        "hello world"
      )
    );
  });

  it("shows 'no PR' chip when pr_url is null", async () => {
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(makeDetail({ id: 1 })),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    render(<TaskDetailPage taskId={1} />);
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-pr-none")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("task-detail-pr")).not.toBeInTheDocument();
  });

  it("edits the title and PATCHes /api/tasks/:id with the new value", async () => {
    const detail = makeDetail({ id: 3, title: "Old title" });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "PATCH /api/tasks/:id": (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...detail, ...body });
      },
    });
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={3} />);
    await waitFor(() =>
      expect(screen.getByText("Old title")).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: /edit title/i }));
    const input = screen.getByLabelText("Title");
    await user.clear(input);
    await user.type(input, "New title");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/3"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ title: "New title" });
    });
    await waitFor(() =>
      expect(screen.getByText("New title")).toBeInTheDocument()
    );
  });

  it("edits the description and PATCHes the new value", async () => {
    const detail = makeDetail({
      id: 4,
      description: "Original description",
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "PATCH /api/tasks/:id": (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...detail, ...body });
      },
    });
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={4} />);
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-description")).toHaveTextContent(
        "Original description"
      )
    );

    await user.click(
      screen.getByRole("button", { name: /edit description/i })
    );
    const input = screen.getByLabelText("Description");
    await user.clear(input);
    await user.type(input, "Updated description");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/4"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({
        description: "Updated description",
      });
    });
  });

  it("checks off an acceptance criterion via PATCH", async () => {
    const criterion = makeCriterion({
      id: 21,
      task_id: 5,
      description: "Tests pass",
      met: false,
    });
    const detail = makeDetail({
      id: 5,
      acceptanceCriteria: [criterion],
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "PATCH /api/tasks/:taskId/criteria/:criterionId": (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...criterion, ...body });
      },
    });
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={5} />);
    await waitFor(() =>
      expect(screen.getByText("Tests pass")).toBeInTheDocument()
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /acceptance criterion: tests pass/i,
    });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" && c.url === "/api/tasks/5/criteria/21"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ met: true });
    });
    await waitFor(() => {
      const updated = screen.getByRole("checkbox", {
        name: /acceptance criterion: tests pass/i,
      });
      expect(updated).toBeChecked();
    });
  });

  it("renders parent and siblings derived from /api/tasks", async () => {
    const detail = makeDetail({ id: 50, parent_id: 10 });
    const allTasks = [
      {
        id: 10,
        repo_id: 1,
        parent_id: null,
        title: "Parent task",
        status: "active" as const,
        order_position: 0,
        children_count: 3,
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: 49,
        repo_id: 1,
        parent_id: 10,
        title: "Sibling A",
        status: "done" as const,
        order_position: 0,
        children_count: 0,
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: 50,
        repo_id: 1,
        parent_id: 10,
        title: "Self",
        status: "pending" as const,
        order_position: 1,
        children_count: 0,
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: 51,
        repo_id: 1,
        parent_id: 10,
        title: "Sibling B",
        status: "pending" as const,
        order_position: 2,
        children_count: 0,
        created_at: "2026-04-01T00:00:00Z",
      },
    ];
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "GET /api/tasks": () => jsonResponse(allTasks),
    });
    render(<TaskDetailPage taskId={50} />);
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-parent")).toHaveTextContent(
        "#10 · Parent task"
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-siblings")).toBeInTheDocument()
    );
    expect(screen.getByTestId("sibling-49")).toHaveTextContent("Sibling A");
    expect(screen.getByTestId("sibling-51")).toHaveTextContent("Sibling B");
    expect(screen.queryByTestId("sibling-50")).not.toBeInTheDocument();
  });

  it("renders events in chronological order", async () => {
    const events: TaskEvent[] = [
      makeEvent({
        id: 2,
        ts: "2026-04-01T12:00:00Z",
        event: "claude_started",
        data: { attempt: 1 },
      }),
      makeEvent({
        id: 1,
        ts: "2026-04-01T11:00:00Z",
        event: "branch_created",
        data: { branch: "grunt/task-9" },
      }),
      makeEvent({
        id: 3,
        ts: "2026-04-01T13:00:00Z",
        event: "claude_finished",
        data: { success: true },
      }),
    ];
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(makeDetail({ id: 9 })),
      "GET /api/tasks/:id/events": () => jsonResponse(events),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    render(<TaskDetailPage taskId={9} />);
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-events")).toBeInTheDocument()
    );
    const items = screen
      .getByTestId("task-detail-events")
      .querySelectorAll("[data-testid^='event-']");
    expect(items.length).toBe(3);
    expect(items[0]).toHaveAttribute("data-testid", "event-1");
    expect(items[1]).toHaveAttribute("data-testid", "event-2");
    expect(items[2]).toHaveAttribute("data-testid", "event-3");
    expect(items[0]).toHaveTextContent("branch_created");
    expect(items[0]).toHaveTextContent("grunt/task-9");
  });

  it("loads the static log when status is not active", async () => {
    installFetch({
      "GET /api/tasks/:id": () =>
        jsonResponse(makeDetail({ id: 6, status: "done" })),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse("static log lines"),
    });
    render(<TaskDetailPage taskId={6} />);
    await waitFor(() =>
      expect(screen.getByTestId("task-detail-log")).toHaveTextContent(
        "static log lines"
      )
    );
    const logCalls = calls.filter((c) => c.url === "/api/tasks/6/log");
    expect(logCalls.length).toBe(1);
  });

  it("streams the log via EventSource when status is active", async () => {
    (window as unknown as { EventSource: typeof EventSource }).EventSource =
      MockEventSource as unknown as typeof EventSource;

    installFetch({
      "GET /api/tasks/:id": () =>
        jsonResponse(makeDetail({ id: 8, status: "active" })),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse("should not be used"),
    });
    render(<TaskDetailPage taskId={8} />);

    await waitFor(() => expect(mockEventSourceInstances.length).toBe(1));
    const inst = mockEventSourceInstances[0];
    expect(inst.url).toBe("/api/tasks/8/log/stream");

    await waitFor(() =>
      expect(screen.getByLabelText(/log is streaming/i)).toBeInTheDocument()
    );

    act(() => inst.emit("first line"));
    act(() => inst.emit("second line"));

    await waitFor(() =>
      expect(screen.getByTestId("task-detail-log")).toHaveTextContent(
        "first line"
      )
    );
    expect(screen.getByTestId("task-detail-log")).toHaveTextContent(
      "second line"
    );

    // Static log endpoint should not be called for active streams.
    expect(calls.find((c) => c.url === "/api/tasks/8/log")).toBeUndefined();
  });

  it("renders an error alert when loading the task fails", async () => {
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse({ error: "kaboom" }, 500),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    render(<TaskDetailPage taskId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/kaboom/i)).toBeInTheDocument()
    );
  });

  it("does not show the ordering mode override when there are no children", async () => {
    installFetch({
      "GET /api/tasks/:id": () =>
        jsonResponse(makeDetail({ id: 60, ordering_mode: null })),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    render(<TaskDetailPage taskId={60} />);
    await waitFor(() =>
      expect(screen.getByText("Build the rocket")).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("task-detail-ordering-mode")
    ).not.toBeInTheDocument();
  });

  it("shows ordering mode override on parent tasks and defaults to inherit when null", async () => {
    const detail = makeDetail({
      id: 70,
      ordering_mode: null,
      children: [
        { id: 71, title: "Child A", status: "pending", order_position: 0 },
      ],
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    render(<TaskDetailPage taskId={70} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("task-detail-ordering-mode")
      ).toBeInTheDocument()
    );
    expect(
      within(screen.getByTestId("task-detail-ordering-mode")).getByText(
        /inherit/i
      )
    ).toBeInTheDocument();
  });

  it("PATCHes ordering_mode when the override is changed to a concrete value", async () => {
    const detail = makeDetail({
      id: 80,
      ordering_mode: null,
      children: [
        { id: 81, title: "Child A", status: "pending", order_position: 0 },
      ],
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "PATCH /api/tasks/:id": (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...detail, ...body });
      },
    });
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={80} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("task-detail-ordering-mode")
      ).toBeInTheDocument()
    );

    await user.click(screen.getByLabelText("Ordering mode"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("parallel"));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/80"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ ordering_mode: "parallel" });
    });

    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-detail-ordering-mode")).getByText(
          /^parallel$/
        )
      ).toBeInTheDocument()
    );
  });

  it("PATCHes ordering_mode as null when the override is set back to inherit", async () => {
    const detail = makeDetail({
      id: 90,
      ordering_mode: "parallel",
      children: [
        { id: 91, title: "Child A", status: "pending", order_position: 0 },
      ],
    });
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(detail),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
      "PATCH /api/tasks/:id": (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...detail, ...body });
      },
    });
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={90} />);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-detail-ordering-mode")).getByText(
          /^parallel$/
        )
      ).toBeInTheDocument()
    );

    await user.click(screen.getByLabelText("Ordering mode"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText(/inherit/i));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/90"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ ordering_mode: null });
    });

    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-detail-ordering-mode")).getByText(
          /inherit/i
        )
      ).toBeInTheDocument()
    );
  });

  it("invokes onClose when the close icon is clicked", async () => {
    installFetch({
      "GET /api/tasks/:id": () => jsonResponse(makeDetail({ id: 1 })),
      "GET /api/tasks/:id/events": () => jsonResponse([]),
      "GET /api/tasks/:id/log": () => textResponse(""),
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TaskDetailPage taskId={1} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByText("Build the rocket")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /close task detail/i })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
