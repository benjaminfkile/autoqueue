import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTreeView, {
  buildTaskTree,
} from "../../pages/repos/TaskTreeView";
import type { TaskStatus, TaskSummary } from "../../api/types";

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

const calls: FetchCall[] = [];

function makeTask(partial: Partial<TaskSummary> & { id: number }): TaskSummary {
  return {
    repo_id: 1,
    parent_id: null,
    title: `Task ${partial.id}`,
    status: "pending",
    order_position: 0,
    children_count: 0,
    requires_approval: false,
    created_at: new Date("2026-04-01T00:00:00Z").toISOString(),
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RouteHandler {
  (init: RequestInit, urlObj: URL): Response | Promise<Response>;
}

interface Routes {
  "GET /api/tasks"?: RouteHandler;
  "PATCH /api/tasks/:id"?: RouteHandler;
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
      if (method === "GET" && path === "/api/tasks" && routes["GET /api/tasks"]) {
        return routes["GET /api/tasks"](init ?? {}, urlObj);
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

interface DataTransferMock {
  effectAllowed: string;
  dropEffect: string;
  setData: (k: string, v: string) => void;
  getData: (k: string) => string;
  types: string[];
  files: FileList;
  items: DataTransferItemList;
  clearData: () => void;
}

function makeDataTransfer(): DataTransferMock {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (k, v) => {
      store[k] = v;
    },
    getData: (k) => store[k] ?? "",
    types: [],
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: () => {},
  };
}

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTaskTree", () => {
  it("nests children under parents and sorts by order_position", () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: 1, parent_id: null, order_position: 1 }),
      makeTask({ id: 2, parent_id: null, order_position: 0 }),
      makeTask({ id: 3, parent_id: 1, order_position: 1 }),
      makeTask({ id: 4, parent_id: 1, order_position: 0 }),
      makeTask({ id: 5, parent_id: 4, order_position: 0 }),
    ];
    const tree = buildTaskTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual([2, 1]);
    const root1 = tree.find((n) => n.task.id === 1)!;
    expect(root1.children.map((n) => n.task.id)).toEqual([4, 3]);
    expect(root1.children[0].children.map((n) => n.task.id)).toEqual([5]);
  });

  it("returns an empty array for no tasks", () => {
    expect(buildTaskTree([])).toEqual([]);
  });
});

describe("TaskTreeView", () => {
  it("shows a loading indicator then an empty state when there are no tasks", async () => {
    installFetch({ "GET /api/tasks": () => jsonResponse([]) });
    render(<TaskTreeView repoId={1} />);
    expect(screen.getByLabelText(/loading tasks/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument()
    );
  });

  it("surfaces a load error", async () => {
    installFetch({
      "GET /api/tasks": () => jsonResponse({ error: "boom" }, 500),
    });
    render(<TaskTreeView repoId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/boom/i)).toBeInTheDocument()
    );
  });

  it("renders parent/child rows with status chips and indentation", async () => {
    const tasks: TaskSummary[] = [
      makeTask({
        id: 1,
        title: "Phase A",
        status: "active",
        order_position: 0,
      }),
      makeTask({
        id: 2,
        title: "Step 1",
        status: "done",
        parent_id: 1,
        order_position: 0,
      }),
      makeTask({
        id: 3,
        title: "Step 2",
        status: "failed",
        parent_id: 1,
        order_position: 1,
      }),
      makeTask({
        id: 4,
        title: "Phase B",
        status: "interrupted",
        order_position: 1,
      }),
    ];
    installFetch({ "GET /api/tasks": () => jsonResponse(tasks) });
    render(<TaskTreeView repoId={1} />);

    await waitFor(() =>
      expect(screen.getByText("Phase A")).toBeInTheDocument()
    );
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.getByText("Phase B")).toBeInTheDocument();

    const phaseARow = screen.getByTestId("task-row-1");
    const step1Row = screen.getByTestId("task-row-2");
    expect(step1Row.compareDocumentPosition(phaseARow)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    );

    expect(screen.getByTestId("task-status-1")).toHaveAttribute(
      "aria-label",
      "Status of Phase A: active"
    );
    expect(screen.getByTestId("task-status-2")).toHaveAttribute(
      "aria-label",
      "Status of Step 1: done"
    );
    expect(screen.getByTestId("task-status-3")).toHaveAttribute(
      "aria-label",
      "Status of Step 2: failed"
    );
    expect(screen.getByTestId("task-status-4")).toHaveAttribute(
      "aria-label",
      "Status of Phase B: interrupted"
    );

    const statusClasses: Record<TaskStatus, string> = {
      pending: "MuiChip-colorDefault",
      active: "MuiChip-colorPrimary",
      done: "MuiChip-colorSuccess",
      failed: "MuiChip-colorError",
      interrupted: "MuiChip-colorWarning",
    };
    expect(screen.getByTestId("task-status-1").className).toContain(
      statusClasses.active
    );
    expect(screen.getByTestId("task-status-2").className).toContain(
      statusClasses.done
    );
    expect(screen.getByTestId("task-status-3").className).toContain(
      statusClasses.failed
    );
    expect(screen.getByTestId("task-status-4").className).toContain(
      statusClasses.interrupted
    );
  });

  it("collapses and expands parent rows", async () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: 1, title: "Phase A", order_position: 0 }),
      makeTask({
        id: 2,
        title: "Step 1",
        parent_id: 1,
        order_position: 0,
      }),
    ];
    installFetch({ "GET /api/tasks": () => jsonResponse(tasks) });
    const user = userEvent.setup();
    render(<TaskTreeView repoId={1} />);

    await waitFor(() =>
      expect(screen.getByText("Step 1")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /collapse phase a/i })
    );
    expect(screen.queryByText("Step 1")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /expand phase a/i })
    );
    expect(screen.getByText("Step 1")).toBeInTheDocument();
  });

  it("re-runs a failed task by PATCHing status=pending", async () => {
    const failedTask = makeTask({
      id: 10,
      title: "Bad task",
      status: "failed",
    });
    installFetch({
      "GET /api/tasks": () => jsonResponse([failedTask]),
      "PATCH /api/tasks/:id": () =>
        jsonResponse({ ...failedTask, status: "pending" }),
    });
    const user = userEvent.setup();
    render(<TaskTreeView repoId={1} />);

    await waitFor(() =>
      expect(screen.getByText("Bad task")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /re-run bad task/i })
    );

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/10"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ status: "pending" });
    });
  });

  it("disables re-run for active tasks and abandon for done tasks", async () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: 1, title: "Active task", status: "active" }),
      makeTask({ id: 2, title: "Done task", status: "done" }),
    ];
    installFetch({ "GET /api/tasks": () => jsonResponse(tasks) });
    render(<TaskTreeView repoId={1} />);
    await waitFor(() =>
      expect(screen.getByText("Active task")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: /re-run active task/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /abandon done task/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /abandon active task/i })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /re-run done task/i })
    ).toBeEnabled();
  });

  it("abandons an active task by PATCHing status=interrupted", async () => {
    const task = makeTask({ id: 5, title: "Running", status: "active" });
    installFetch({
      "GET /api/tasks": () => jsonResponse([task]),
      "PATCH /api/tasks/:id": () =>
        jsonResponse({ ...task, status: "interrupted" }),
    });
    const user = userEvent.setup();
    render(<TaskTreeView repoId={1} />);
    await waitFor(() =>
      expect(screen.getByText("Running")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /abandon running/i })
    );
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/tasks/5"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ status: "interrupted" });
    });
  });

  it("invokes the onViewDetail callback for the task", async () => {
    const task = makeTask({ id: 9, title: "Inspectable" });
    installFetch({ "GET /api/tasks": () => jsonResponse([task]) });
    const onViewDetail = vi.fn();
    const user = userEvent.setup();
    render(<TaskTreeView repoId={1} onViewDetail={onViewDetail} />);
    await waitFor(() =>
      expect(screen.getByText("Inspectable")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /view detail of inspectable/i })
    );
    expect(onViewDetail).toHaveBeenCalledTimes(1);
    expect(onViewDetail.mock.calls[0][0].id).toBe(9);
  });

  it("persists drag-to-reorder by PATCHing order_position for both siblings", async () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: 1, title: "First", order_position: 0 }),
      makeTask({ id: 2, title: "Second", order_position: 1 }),
      makeTask({ id: 3, title: "Third", order_position: 2 }),
    ];
    installFetch({
      "GET /api/tasks": () => jsonResponse(tasks),
      "PATCH /api/tasks/:id": (init) =>
        jsonResponse({ id: 0, ...JSON.parse(String(init.body)) }),
    });
    render(<TaskTreeView repoId={1} />);
    await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());

    const sourceRow = screen.getByTestId("task-row-3");
    const targetRow = screen.getByTestId("task-row-1");
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(sourceRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer });

    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === "PATCH" && /^\/api\/tasks\/\d+$/.test(c.url)
      );
      expect(patches.length).toBe(2);
    });
    const patches = calls.filter(
      (c) => c.method === "PATCH" && /^\/api\/tasks\/\d+$/.test(c.url)
    );
    const sourcePatch = patches.find((c) => c.url === "/api/tasks/3");
    const targetPatch = patches.find((c) => c.url === "/api/tasks/1");
    expect(sourcePatch).toBeDefined();
    expect(targetPatch).toBeDefined();
    expect(JSON.parse(sourcePatch!.body!)).toEqual({ order_position: 0 });
    expect(JSON.parse(targetPatch!.body!)).toEqual({ order_position: 2 });
  });

  it("rejects drag-to-reorder across non-siblings with an error", async () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: 1, title: "Phase", order_position: 0 }),
      makeTask({ id: 2, title: "Child", parent_id: 1, order_position: 0 }),
    ];
    installFetch({ "GET /api/tasks": () => jsonResponse(tasks) });
    render(<TaskTreeView repoId={1} />);
    await waitFor(() =>
      expect(screen.getByText("Child")).toBeInTheDocument()
    );

    const childRow = screen.getByTestId("task-row-2");
    const phaseRow = screen.getByTestId("task-row-1");
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(childRow, { dataTransfer });
    fireEvent.dragOver(phaseRow, { dataTransfer });
    fireEvent.drop(phaseRow, { dataTransfer });

    await waitFor(() =>
      expect(
        screen.getByText(/can only be reordered among siblings/i)
      ).toBeInTheDocument()
    );
    expect(
      calls.filter((c) => c.method === "PATCH").length
    ).toBe(0);
  });
});
