import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewPhaseDialog from "../../../pages/tasks/NewPhaseDialog";
import type { Repo } from "../../../api/types";

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
    github_token: null,
    is_local_folder: false,
    local_path: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface Routes {
  materializeStatus?: number;
  templateSaveStatus?: number;
}

function installFetch(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.match(/\/api\/repos\/\d+\/links$/) && method === "GET") {
      return jsonResponse([]);
    }
    if (url.match(/\/api\/repos\/\d+\/materialize-tree$/) && method === "POST") {
      if (routes.materializeStatus && routes.materializeStatus >= 400) {
        return jsonResponse({ error: "Materialize failed" }, routes.materializeStatus);
      }
      return jsonResponse({ tasks: [{ id: 1, title: "Created" }] });
    }
    if (url === "/api/templates" && method === "POST") {
      if (routes.templateSaveStatus && routes.templateSaveStatus >= 400) {
        return jsonResponse({ error: "Save template failed" }, routes.templateSaveStatus);
      }
      return jsonResponse({ id: 1, name: "My template", description: "", tree: { parents: [] }, created_at: new Date().toISOString() });
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

describe("NewPhaseDialog", () => {
  it("renders the dialog when open=true with Visual and JSON tabs", () => {
    installFetch();
    render(
      <NewPhaseDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /visual/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /json/i })).toBeInTheDocument();
  });

  it("does not render when open=false", () => {
    installFetch();
    render(
      <NewPhaseDialog
        open={false}
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onCreated and onClose after creating a phase from the visual editor", async () => {
    installFetch();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NewPhaseDialog
        open
        repos={repos}
        repoId={1}
        onClose={onClose}
        onCreated={onCreated}
      />
    );

    // The visual editor starts with one empty node input
    const titleInput = await screen.findByLabelText(/task title/i);
    await user.type(titleInput, "My new task");

    await user.click(screen.getByRole("button", { name: /create phase/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an error alert when materializeTree fails", async () => {
    installFetch({ materializeStatus: 500 });
    const user = userEvent.setup();

    render(
      <NewPhaseDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    const titleInput = await screen.findByLabelText(/task title/i);
    await user.type(titleInput, "Failing task");
    await user.click(screen.getByRole("button", { name: /create phase/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
  });

  it("opens the save-as-template dialog and saves on confirm", async () => {
    installFetch();
    const user = userEvent.setup();

    render(
      <NewPhaseDialog
        open
        repos={repos}
        repoId={1}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("new-phase-save-template"));

    await waitFor(() =>
      expect(screen.getByTestId("phase-save-template-dialog")).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/template name/i), "My Template");
    await user.click(screen.getByTestId("phase-template-confirm"));

    await waitFor(() =>
      expect(screen.queryByTestId("phase-save-template-dialog")).not.toBeInTheDocument()
    );
  });

  it("shows a discard-changes dialog when closing with unsaved changes", async () => {
    installFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NewPhaseDialog
        open
        repos={repos}
        repoId={1}
        onClose={onClose}
        onCreated={vi.fn()}
      />
    );

    const titleInput = await screen.findByLabelText(/task title/i);
    await user.type(titleInput, "Some text");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.getByText(/discard changes/i)).toBeInTheDocument()
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
