import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplatesDrawer from "../../../pages/tasks/TemplatesDrawer";
import type { Repo, TaskTemplate } from "../../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: 1,
    name: "My Template",
    description: "A test template",
    tree: {
      parents: [
        { title: "Root task", description: "Root desc", children: [] },
      ],
    },
    created_at: new Date().toISOString(),
    ...overrides,
  };
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
  templates?: TaskTemplate[];
  repos?: Repo[];
  deleteStatus?: number;
  applyStatus?: number;
}

function installFetch(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/templates" && method === "GET") {
      return jsonResponse(routes.templates ?? []);
    }
    if (url.match(/^\/api\/templates\/\d+$/) && method === "DELETE") {
      if (routes.deleteStatus && routes.deleteStatus >= 400) {
        return jsonResponse({ error: "Delete failed" }, routes.deleteStatus);
      }
      return new Response(null, { status: 204 });
    }
    if (url === "/api/repos" && method === "GET") {
      return jsonResponse(routes.repos ?? []);
    }
    if (url.match(/\/api\/repos\/\d+\/instantiate-template\/\d+$/) && method === "POST") {
      if (routes.applyStatus && routes.applyStatus >= 400) {
        return jsonResponse({ error: "Apply failed" }, routes.applyStatus);
      }
      return jsonResponse({ tasks: [] });
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

describe("TemplatesDrawer", () => {
  it("shows an empty state when there are no templates", async () => {
    installFetch({ templates: [] });
    render(<TemplatesDrawer open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/no templates yet/i)).toBeInTheDocument()
    );
  });

  it("renders template names in the list", async () => {
    installFetch({
      templates: [
        makeTemplate({ id: 1, name: "Alpha" }),
        makeTemplate({ id: 2, name: "Beta", description: "Beta desc" }),
      ],
    });
    render(<TemplatesDrawer open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("template-item-1")).toBeInTheDocument()
    );
    expect(screen.getByTestId("template-item-2")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("shows the template detail and task tree preview when a template is clicked", async () => {
    installFetch({ templates: [makeTemplate({ id: 3, name: "Detail" })] });
    const user = userEvent.setup();
    render(<TemplatesDrawer open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("template-item-3")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-item-3"));

    await waitFor(() =>
      expect(screen.getByTestId("template-preview")).toBeInTheDocument()
    );
    expect(within(screen.getByTestId("template-preview")).getByText("Root task")).toBeInTheDocument();
  });

  it("opens a delete confirmation dialog and removes the template on confirm", async () => {
    installFetch({ templates: [makeTemplate({ id: 10, name: "ToDelete" })] });
    const user = userEvent.setup();
    render(<TemplatesDrawer open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("template-item-10")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-delete-10"));

    await waitFor(() =>
      expect(screen.getByTestId("template-delete-dialog")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-delete-confirm"));

    await waitFor(() =>
      expect(screen.queryByTestId("template-item-10")).not.toBeInTheDocument()
    );
  });

  it("opens the apply dialog, selects a repo, and calls the instantiate endpoint", async () => {
    const onApplied = vi.fn();
    installFetch({
      templates: [makeTemplate({ id: 5, name: "Applicable" })],
      repos: [makeRepo({ id: 99, owner: "org", repo_name: "the-repo" })],
    });
    const user = userEvent.setup();
    render(<TemplatesDrawer open onClose={vi.fn()} onApplied={onApplied} />);

    await waitFor(() =>
      expect(screen.getByTestId("template-item-5")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-item-5"));

    await waitFor(() =>
      expect(screen.getByTestId("template-apply-button")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-apply-button"));

    await waitFor(() =>
      expect(screen.getByTestId("template-apply-dialog")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("template-apply-confirm"));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });
});
