import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReposPage from "../../pages/ReposPage";
import type { Repo, TaskSummary } from "../../api/types";

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

const calls: FetchCall[] = [];

function makeRepo(partial: Partial<Repo> & { id: number }): Repo {
  return {
    owner: "octo",
    repo_name: "demo",
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: true,
    github_token: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_subtree",
    max_retries: 0,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...partial,
  };
}

function makeTask(partial: Partial<TaskSummary> & { id: number }): TaskSummary {
  return {
    repo_id: 1,
    parent_id: null,
    title: "t",
    status: "pending",
    order_position: 0,
    children_count: 0,
    created_at: new Date("2026-01-02T00:00:00Z").toISOString(),
    ...partial,
  };
}

interface RouteHandler {
  (init: RequestInit, urlObj: URL): Response | Promise<Response>;
}

interface Routes {
  "GET /api/repos"?: RouteHandler;
  "POST /api/repos"?: RouteHandler;
  "PATCH /api/repos/:id"?: RouteHandler;
  "DELETE /api/repos/:id"?: RouteHandler;
  "GET /api/tasks"?: RouteHandler;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
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

      if (method === "GET" && path === "/api/repos" && routes["GET /api/repos"]) {
        return routes["GET /api/repos"](init ?? {}, urlObj);
      }
      if (method === "POST" && path === "/api/repos" && routes["POST /api/repos"]) {
        return routes["POST /api/repos"](init ?? {}, urlObj);
      }
      if (method === "PATCH" && /^\/api\/repos\/\d+$/.test(path) && routes["PATCH /api/repos/:id"]) {
        return routes["PATCH /api/repos/:id"](init ?? {}, urlObj);
      }
      if (method === "DELETE" && /^\/api\/repos\/\d+$/.test(path) && routes["DELETE /api/repos/:id"]) {
        return routes["DELETE /api/repos/:id"](init ?? {}, urlObj);
      }
      if (method === "GET" && path === "/api/tasks" && routes["GET /api/tasks"]) {
        return routes["GET /api/tasks"](init ?? {}, urlObj);
      }
      return jsonResponse({ error: `unhandled ${method} ${path}` }, 500);
    }
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReposPage", () => {
  it("shows the empty state with a Connect a repo CTA when no repos exist", async () => {
    installFetch({ "GET /api/repos": () => jsonResponse([]) });
    render(<ReposPage />);
    await waitFor(() => {
      expect(screen.getByText(/no repos yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /connect a repo/i })
    ).toBeInTheDocument();
  });

  it("lists repos with status counts and last activity", async () => {
    installFetch({
      "GET /api/repos": () =>
        jsonResponse([
          makeRepo({ id: 1, owner: "alice", repo_name: "alpha" }),
          makeRepo({ id: 2, owner: "bob", repo_name: "beta", active: false }),
        ]),
      "GET /api/tasks": (_init, urlObj) => {
        const repoId = urlObj.searchParams.get("repo_id");
        if (repoId === "1") {
          return jsonResponse([
            makeTask({ id: 11, status: "pending" }),
            makeTask({ id: 12, status: "active" }),
            makeTask({ id: 13, status: "done" }),
            makeTask({ id: 14, status: "done" }),
            makeTask({ id: 15, status: "failed" }),
          ]);
        }
        return jsonResponse([]);
      },
    });

    render(<ReposPage />);
    await waitFor(() =>
      expect(screen.getByText("alice/alpha")).toBeInTheDocument()
    );
    expect(screen.getByText("bob/beta")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByLabelText("pending count for alice/alpha")
      ).toHaveTextContent("pending: 1");
    });
    expect(
      screen.getByLabelText("active count for alice/alpha")
    ).toHaveTextContent("active: 1");
    expect(
      screen.getByLabelText("done count for alice/alpha")
    ).toHaveTextContent("done: 2");
    expect(
      screen.getByLabelText("failed count for alice/alpha")
    ).toHaveTextContent("failed: 1");

    expect(
      screen.getByLabelText("pending count for bob/beta")
    ).toHaveTextContent("pending: 0");
  });

  it("toggles active flag via PATCH /api/repos/:id", async () => {
    installFetch({
      "GET /api/repos": () =>
        jsonResponse([
          makeRepo({ id: 7, owner: "alice", repo_name: "alpha", active: true }),
        ]),
      "GET /api/tasks": () => jsonResponse([]),
      "PATCH /api/repos/:id": () =>
        jsonResponse(
          makeRepo({ id: 7, owner: "alice", repo_name: "alpha", active: false })
        ),
    });

    const user = userEvent.setup();
    render(<ReposPage />);
    const toggle = await screen.findByRole("checkbox", {
      name: /toggle active for alice\/alpha/i,
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => {
      const patchCall = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/repos/7"
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall!.body!)).toEqual({ active: false });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", {
          name: /toggle active for alice\/alpha/i,
        })
      ).not.toBeChecked();
    });
  });

  it("creates a repo via the Connect a repo dialog from the empty state", async () => {
    let listCallCount = 0;
    const newRepo = makeRepo({
      id: 99,
      owner: "carol",
      repo_name: "gamma",
      active: true,
    });
    installFetch({
      "GET /api/repos": () => {
        listCallCount += 1;
        return jsonResponse([]);
      },
      "POST /api/repos": () => jsonResponse(newRepo, 201),
      "GET /api/tasks": () => jsonResponse([]),
    });

    const user = userEvent.setup();
    render(<ReposPage />);
    await user.click(
      await screen.findByRole("button", { name: /connect a repo/i })
    );

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/owner/i), "carol");
    await user.type(within(dialog).getByLabelText(/repo name/i), "gamma");
    await user.click(within(dialog).getByRole("button", { name: /connect/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url === "/api/repos"
      );
      expect(post).toBeDefined();
      const payload = JSON.parse(post!.body!);
      expect(payload.owner).toBe("carol");
      expect(payload.repo_name).toBe("gamma");
      expect(payload.is_local_folder).toBe(false);
    });

    await waitFor(() =>
      expect(screen.getByText("carol/gamma")).toBeInTheDocument()
    );
    expect(listCallCount).toBe(1);
  });

  it("edits an existing repo and PATCHes the changes", async () => {
    installFetch({
      "GET /api/repos": () =>
        jsonResponse([
          makeRepo({
            id: 3,
            owner: "alice",
            repo_name: "alpha",
            base_branch: "main",
          }),
        ]),
      "GET /api/tasks": () => jsonResponse([]),
      "PATCH /api/repos/:id": () =>
        jsonResponse(
          makeRepo({
            id: 3,
            owner: "alice",
            repo_name: "alpha",
            base_branch: "develop",
          })
        ),
    });

    const user = userEvent.setup();
    render(<ReposPage />);
    await user.click(
      await screen.findByRole("button", { name: /edit alice\/alpha/i })
    );
    const dialog = await screen.findByRole("dialog");
    const baseBranch = within(dialog).getByRole("textbox", {
      name: /^base branch$/i,
    });
    await user.clear(baseBranch);
    await user.type(baseBranch, "develop");
    await user.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/repos/3"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!).base_branch).toBe("develop");
    });
  });

  it("deletes a repo via the Delete dialog", async () => {
    installFetch({
      "GET /api/repos": () =>
        jsonResponse([
          makeRepo({ id: 4, owner: "alice", repo_name: "alpha" }),
        ]),
      "GET /api/tasks": () => jsonResponse([]),
      "DELETE /api/repos/:id": () => emptyResponse(204),
    });

    const user = userEvent.setup();
    render(<ReposPage />);
    await user.click(
      await screen.findByRole("button", { name: /delete alice\/alpha/i })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === "DELETE" && c.url === "/api/repos/4"
      );
      expect(del).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.queryByText("alice/alpha")).not.toBeInTheDocument();
    });
  });

  it("surfaces a load error and lets the user retry", async () => {
    let attempt = 0;
    installFetch({
      "GET /api/repos": () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return jsonResponse([]);
      },
    });

    const user = userEvent.setup();
    render(<ReposPage />);
    await waitFor(() =>
      expect(screen.getByText(/unauthorized/i)).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(screen.getByText(/no repos yet/i)).toBeInTheDocument()
    );
  });
});
