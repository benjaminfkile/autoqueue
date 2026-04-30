import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditTaskDialog from "../../../pages/tasks/EditTaskDialog";
import type { TaskDetail, TaskEffectiveModel } from "../../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 42,
    repo_id: 1,
    parent_id: null,
    title: "Existing task",
    description: "Some description",
    order_position: 0,
    status: "pending",
    retry_count: 0,
    pr_url: null,
    worker_id: null,
    leased_until: null,
    ordering_mode: null,
    log_path: null,
    requires_approval: false,
    model: null,
    created_at: new Date().toISOString(),
    acceptanceCriteria: [],
    children: [],
    ...overrides,
  };
}

const effectiveModel: TaskEffectiveModel = {
  model: "claude-sonnet-4-6",
  source: "default",
};

interface Routes {
  task?: TaskDetail;
  taskStatus?: number;
  updateStatus?: number;
  deleteStatus?: number;
  criteria?: unknown[];
}

function installFetch(routes: Routes = {}) {
  const task = routes.task ?? makeTaskDetail();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.match(/\/api\/tasks\/\d+\/effective-model$/) && method === "GET") {
      return jsonResponse(effectiveModel);
    }
    if (url.match(/\/api\/tasks\/\d+\/criteria$/) && method === "GET") {
      return jsonResponse(routes.criteria ?? []);
    }
    if (url.match(/\/api\/tasks\/\d+$/) && method === "GET") {
      if (routes.taskStatus && routes.taskStatus >= 400) {
        return jsonResponse({ error: "Not found" }, routes.taskStatus);
      }
      return jsonResponse(task);
    }
    if (url.match(/\/api\/tasks\/\d+$/) && method === "PATCH") {
      if (routes.updateStatus && routes.updateStatus >= 400) {
        return jsonResponse({ error: "Update failed" }, routes.updateStatus);
      }
      return jsonResponse(task);
    }
    if (url.match(/\/api\/tasks\/\d+$/) && method === "DELETE") {
      if (routes.deleteStatus && routes.deleteStatus >= 400) {
        return jsonResponse({ error: "Delete failed" }, routes.deleteStatus);
      }
      return new Response(null, { status: 204 });
    }
    return jsonResponse([]);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditTaskDialog", () => {
  it("renders the dialog and loads the task data when open=true", async () => {
    installFetch();
    render(
      <EditTaskDialog
        open
        taskId={42}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/title/i)).toHaveValue("Existing task")
    );
    expect(screen.getByLabelText(/description/i)).toHaveValue("Some description");
  });

  it("does not render when open=false", () => {
    installFetch();
    render(
      <EditTaskDialog
        open={false}
        taskId={42}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onUpdated and onClose after saving changes", async () => {
    installFetch();
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <EditTaskDialog
        open
        taskId={42}
        onClose={onClose}
        onUpdated={onUpdated}
        onDeleted={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/title/i)).toHaveValue("Existing task")
    );

    await user.clear(screen.getByLabelText(/title/i));
    await user.type(screen.getByLabelText(/title/i), "Updated task title");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a validation error when the title is cleared", async () => {
    installFetch();
    const user = userEvent.setup();

    render(
      <EditTaskDialog
        open
        taskId={42}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/title/i)).toHaveValue("Existing task")
    );

    await user.clear(screen.getByLabelText(/title/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/title is required/i)
    );
  });

  it("calls onDeleted after confirming deletion", async () => {
    installFetch();
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <EditTaskDialog
        open
        taskId={42}
        onClose={onClose}
        onUpdated={vi.fn()}
        onDeleted={onDeleted}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /delete task/i })).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: /delete task/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /confirm delete/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(42));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a discard-changes dialog when closing with unsaved edits", async () => {
    installFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <EditTaskDialog
        open
        taskId={42}
        onClose={onClose}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/title/i)).toHaveValue("Existing task")
    );

    await user.clear(screen.getByLabelText(/title/i));
    await user.type(screen.getByLabelText(/title/i), "Changed");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.getByText(/discard changes/i)).toBeInTheDocument()
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
