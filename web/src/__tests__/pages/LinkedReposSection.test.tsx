import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LinkedReposSection from "../../pages/repos/LinkedReposSection";
import type { Repo, RepoLink } from "../../api/types";

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

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function makeRepo(partial: Partial<Repo> & { id: number }): Repo {
  return {
    owner: `owner${partial.id}`,
    repo_name: `repo${partial.id}`,
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
    clone_status: "ready",
    clone_error: null,
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function makeLink(partial: Partial<RepoLink> & { id: number }): RepoLink {
  return {
    repo_a_id: 1,
    repo_b_id: 2,
    role: null,
    permission: "read",
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

interface Routes {
  listLinks?: (urlObj: URL) => Response | Promise<Response>;
  createLink?: (init: RequestInit, urlObj: URL) => Response | Promise<Response>;
  patchLink?: (init: RequestInit, urlObj: URL) => Response | Promise<Response>;
  deleteLink?: (urlObj: URL) => Response | Promise<Response>;
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
        /^\/api\/repos\/\d+\/links$/.test(path) &&
        routes.listLinks
      ) {
        return routes.listLinks(urlObj);
      }
      if (
        method === "POST" &&
        /^\/api\/repos\/\d+\/links$/.test(path) &&
        routes.createLink
      ) {
        return routes.createLink(init ?? {}, urlObj);
      }
      if (
        method === "PATCH" &&
        /^\/api\/repos\/\d+\/links\/\d+$/.test(path) &&
        routes.patchLink
      ) {
        return routes.patchLink(init ?? {}, urlObj);
      }
      if (
        method === "DELETE" &&
        /^\/api\/repos\/\d+\/links\/\d+$/.test(path) &&
        routes.deleteLink
      ) {
        return routes.deleteLink(urlObj);
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinkedReposSection", () => {
  it("lists existing links with role and permission", async () => {
    const repo1 = makeRepo({ id: 1, owner: "alice", repo_name: "alpha" });
    const repo2 = makeRepo({ id: 2, owner: "bob", repo_name: "beta" });
    installFetch({
      listLinks: () =>
        jsonResponse([
          makeLink({
            id: 50,
            repo_a_id: 1,
            repo_b_id: 2,
            role: "client",
            permission: "read",
          }),
        ]),
    });

    render(<LinkedReposSection repo={repo1} allRepos={[repo1, repo2]} />);

    const table = await screen.findByTestId("linked-repos-table");
    expect(within(table).getByText("bob/beta")).toBeInTheDocument();
    expect(within(table).getByText("client")).toBeInTheDocument();
    const permSelect = within(table).getByLabelText("Permission for bob/beta");
    expect(permSelect).toHaveTextContent("read");
  });

  it("adds a link via the picker", async () => {
    const repo1 = makeRepo({ id: 1, owner: "alice", repo_name: "alpha" });
    const repo2 = makeRepo({ id: 2, owner: "bob", repo_name: "beta" });
    installFetch({
      listLinks: () => jsonResponse([]),
      createLink: (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse(
          makeLink({
            id: 99,
            repo_a_id: 1,
            repo_b_id: body.other_repo_id,
            role: body.role ?? null,
            permission: body.permission ?? "read",
          }),
          201
        );
      },
    });

    const user = userEvent.setup();
    render(<LinkedReposSection repo={repo1} allRepos={[repo1, repo2]} />);

    await screen.findByText(/no linked repos yet/i);

    await user.click(screen.getByLabelText("Pick a repo to link"));
    const repoListbox = await screen.findByRole("listbox");
    await user.click(within(repoListbox).getByText("bob/beta"));

    await user.type(screen.getByLabelText("Link role"), "client");

    await user.click(screen.getByLabelText("Link permission"));
    const permListbox = await screen.findByRole("listbox");
    await user.click(within(permListbox).getByText("write"));

    await user.click(screen.getByRole("button", { name: /add linked repo/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url === "/api/repos/1/links"
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({
        other_repo_id: 2,
        role: "client",
        permission: "write",
      });
    });

    const table = await screen.findByTestId("linked-repos-table");
    expect(within(table).getByText("bob/beta")).toBeInTheDocument();
  });

  it("changes permission on an existing link", async () => {
    const repo1 = makeRepo({ id: 1, owner: "alice", repo_name: "alpha" });
    const repo2 = makeRepo({ id: 2, owner: "bob", repo_name: "beta" });
    installFetch({
      listLinks: () =>
        jsonResponse([
          makeLink({
            id: 7,
            repo_a_id: 1,
            repo_b_id: 2,
            permission: "read",
          }),
        ]),
      patchLink: (init) => {
        const body = JSON.parse(String(init.body));
        return jsonResponse(
          makeLink({ id: 7, repo_a_id: 1, repo_b_id: 2, permission: body.permission })
        );
      },
    });

    const user = userEvent.setup();
    render(<LinkedReposSection repo={repo1} allRepos={[repo1, repo2]} />);

    const select = await screen.findByLabelText("Permission for bob/beta");
    await user.click(select);
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("write"));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/repos/1/links/7"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ permission: "write" });
    });
  });

  it("removes an existing link", async () => {
    const repo1 = makeRepo({ id: 1, owner: "alice", repo_name: "alpha" });
    const repo2 = makeRepo({ id: 2, owner: "bob", repo_name: "beta" });
    installFetch({
      listLinks: () =>
        jsonResponse([
          makeLink({ id: 7, repo_a_id: 1, repo_b_id: 2, permission: "read" }),
        ]),
      deleteLink: () => emptyResponse(204),
    });

    const user = userEvent.setup();
    render(<LinkedReposSection repo={repo1} allRepos={[repo1, repo2]} />);

    const removeBtn = await screen.findByRole("button", {
      name: /remove link to bob\/beta/i,
    });
    await user.click(removeBtn);

    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === "DELETE" && c.url === "/api/repos/1/links/7"
      );
      expect(del).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.queryByText("bob/beta")).not.toBeInTheDocument();
    });
  });

  it("excludes the current repo and already-linked repos from the picker", async () => {
    const repo1 = makeRepo({ id: 1, owner: "alice", repo_name: "alpha" });
    const repo2 = makeRepo({ id: 2, owner: "bob", repo_name: "beta" });
    const repo3 = makeRepo({ id: 3, owner: "carol", repo_name: "gamma" });
    installFetch({
      listLinks: () =>
        jsonResponse([
          makeLink({ id: 11, repo_a_id: 1, repo_b_id: 2, permission: "read" }),
        ]),
    });

    const user = userEvent.setup();
    render(
      <LinkedReposSection repo={repo1} allRepos={[repo1, repo2, repo3]} />
    );

    await screen.findByTestId("linked-repos-table");

    await user.click(screen.getByLabelText("Pick a repo to link"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("carol/gamma")).toBeInTheDocument();
    expect(within(listbox).queryByText("bob/beta")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("alice/alpha")).not.toBeInTheDocument();
  });
});
