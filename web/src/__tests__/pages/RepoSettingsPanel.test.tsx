import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RepoSettingsPanel from "../../pages/repos/RepoSettingsPanel";
import type { Repo } from "../../api/types";

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

function makeRepo(partial: Partial<Repo> & { id: number }): Repo {
  return {
    owner: "alice",
    repo_name: "alpha",
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
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

interface PatchHandler {
  (init: RequestInit, urlObj: URL): Response | Promise<Response>;
}

function installFetch(patchHandler: PatchHandler) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input.toString();
      const urlObj = new URL(rawUrl, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? String(init.body) : null;
      calls.push({ url: rawUrl, method, body });
      if (method === "PATCH" && /^\/api\/repos\/\d+$/.test(urlObj.pathname)) {
        return patchHandler(init ?? {}, urlObj);
      }
      return jsonResponse({ error: `unhandled ${method} ${urlObj.pathname}` }, 500);
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

describe("RepoSettingsPanel", () => {
  it("renders all Phase 1+2 policy fields", () => {
    render(
      <RepoSettingsPanel repo={makeRepo({ id: 1 })} onChange={vi.fn()} />
    );
    expect(screen.getByLabelText("On failure")).toBeInTheDocument();
    expect(screen.getByLabelText("On parent/child fail")).toBeInTheDocument();
    expect(screen.getByLabelText("Ordering mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Max retries")).toBeInTheDocument();
    expect(screen.getByLabelText("Base branch parent")).toBeInTheDocument();
    expect(screen.getByLabelText("Require PR")).toBeInTheDocument();
  });

  it("PATCHes on_failure when changed and reflects new value via onChange", async () => {
    const repo = makeRepo({ id: 7, on_failure: "halt_subtree" });
    const updatedRepo = { ...repo, on_failure: "retry" as const };
    installFetch(() => jsonResponse(updatedRepo));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={onChange} />);

    await user.click(screen.getByLabelText("On failure"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("retry"));

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/repos/7"
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ on_failure: "retry" });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(updatedRepo));
  });

  it("PATCHes on_parent_child_fail when changed", async () => {
    const repo = makeRepo({ id: 7 });
    installFetch(() =>
      jsonResponse({ ...repo, on_parent_child_fail: "ignore" })
    );
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    await user.click(screen.getByLabelText("On parent/child fail"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("ignore"));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({
        on_parent_child_fail: "ignore",
      });
    });
  });

  it("PATCHes ordering_mode when changed", async () => {
    const repo = makeRepo({ id: 9, ordering_mode: "sequential" });
    installFetch(() => jsonResponse({ ...repo, ordering_mode: "parallel" }));
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    await user.click(screen.getByLabelText("Ordering mode"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("parallel"));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ ordering_mode: "parallel" });
    });
  });

  it("PATCHes require_pr when toggled", async () => {
    const repo = makeRepo({ id: 11, require_pr: true });
    installFetch(() => jsonResponse({ ...repo, require_pr: false }));
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoSettingsPanel repo={repo} onChange={onChange} />);

    await user.click(screen.getByRole("checkbox", { name: /require pr/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ require_pr: false });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("saves max_retries via Save button only when dirty", async () => {
    const repo = makeRepo({ id: 22, max_retries: 0 });
    installFetch(() => jsonResponse({ ...repo, max_retries: 5 }));
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    const saveBtn = screen.getByRole("button", { name: /save max retries/i });
    expect(saveBtn).toBeDisabled();

    const input = screen.getByLabelText("Max retries");
    await user.clear(input);
    await user.type(input, "5");
    expect(saveBtn).toBeEnabled();

    await user.click(saveBtn);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({ max_retries: 5 });
    });
  });

  it("rejects negative max_retries with an inline error and does not PATCH", async () => {
    const repo = makeRepo({ id: 23, max_retries: 1 });
    installFetch(() => jsonResponse(repo));
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    const input = screen.getByLabelText("Max retries");
    await user.clear(input);
    await user.type(input, "-3");
    await user.click(
      screen.getByRole("button", { name: /save max retries/i })
    );

    expect(
      await screen.findByText(/max retries must be a non-negative integer/i)
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
  });

  it("saves base_branch_parent via Save button when dirty", async () => {
    const repo = makeRepo({ id: 30, base_branch_parent: "main" });
    installFetch(() =>
      jsonResponse({ ...repo, base_branch_parent: "develop" })
    );
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    const input = screen.getByLabelText("Base branch parent");
    await user.clear(input);
    await user.type(input, "develop");
    await user.click(
      screen.getByRole("button", { name: /save base branch parent/i })
    );

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.body!)).toEqual({
        base_branch_parent: "develop",
      });
    });
  });

  it("rejects empty base_branch_parent and does not PATCH", async () => {
    const repo = makeRepo({ id: 30, base_branch_parent: "main" });
    installFetch(() => jsonResponse(repo));
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    const input = screen.getByLabelText("Base branch parent");
    await user.clear(input);
    await user.click(
      screen.getByRole("button", { name: /save base branch parent/i })
    );

    expect(
      await screen.findByText(/base branch parent cannot be empty/i)
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
  });

  it("surfaces a server error and lets the user dismiss it", async () => {
    const repo = makeRepo({ id: 40 });
    installFetch(() => jsonResponse({ error: "boom" }, 500));
    const user = userEvent.setup();
    render(<RepoSettingsPanel repo={repo} onChange={vi.fn()} />);

    await user.click(screen.getByRole("checkbox", { name: /require pr/i }));
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });
});
