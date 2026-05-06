import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewTaskDialog from "../../../pages/tasks/NewTaskDialog";
import type { Repo, TaskDetail } from "../../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    owner: "acme",
    repo_name: "myrepo",
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    git_pat: null, git_provider: "github" as const, ado_project: null,
    is_local_folder: false,
    local_path: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 10,
    repo_id: 1,
    parent_id: null,
    title: "Created task",
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
    model: null,
    created_at: new Date().toISOString(),
    acceptanceCriteria: [],
    children: [],
    ...overrides,
  };
}

interface Routes {
  createResponse?: TaskDetail;
  createStatus?: number;
  tasksList?: { id: number; title: string }[];
}

function installFetch(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.match(/\/api\/tasks\?repo_id=/) && method === "GET") {
      return jsonResponse(routes.tasksList ?? []);
    }
    if (url === "/api/tasks" && method === "POST") {
      if (routes.createStatus && routes.createStatus >= 400) {
        return jsonResponse({ error: "Title is required" }, routes.createStatus);
      }
      return jsonResponse(routes.createResponse ?? makeTaskDetail());
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

const repo = makeRepo();
const repos = [repo];

describe("NewTaskDialog", () => {
  it("renders the dialog when open=true", () => {
    installFetch();
    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
  });

  it("does not render when open=false", () => {
    installFetch();
    render(
      <NewTaskDialog
        open={false}
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onCreated and onClose after a successful form submission", async () => {
    const created = makeTaskDetail({ title: "My task" });
    installFetch({ createResponse: created });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={1}
        onClose={onClose}
        onCreated={onCreated}
      />
    );

    await user.type(screen.getByLabelText(/title/i), "My task");
    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a validation error when the title is empty", async () => {
    installFetch();
    const user = userEvent.setup();

    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/title is required/i)
    );
  });

  it("shows a server error when the API rejects the request", async () => {
    installFetch({ createStatus: 400 });
    const user = userEvent.setup();

    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/title/i), "failing task");
    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
  });

  it("shows the repo selector when repoId is null", () => {
    installFetch();
    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={null}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/repository/i)).toBeInTheDocument();
  });

  it("shows a discard-changes dialog when closing with unsaved changes", async () => {
    installFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NewTaskDialog
        open
        repos={repos}
        repoId={1}
        onClose={onClose}
        onCreated={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/title/i), "some text");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.getByText(/discard changes/i)).toBeInTheDocument()
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
