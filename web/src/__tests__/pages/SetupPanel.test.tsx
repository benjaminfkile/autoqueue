import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import type { SetupStatus } from "../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchScenario {
  setupStatus: SetupStatus;
  postOverride?: (body: unknown) => Response | Promise<Response>;
  deleteOverride?: () => Response | Promise<Response>;
}

function installFetchMock(scenario: FetchScenario) {
  let currentStatus = scenario.setupStatus;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/setup") {
        if (method === "GET") return jsonResponse(currentStatus);
        if (method === "POST") {
          const body = init?.body
            ? JSON.parse(init.body as string)
            : undefined;
          if (scenario.postOverride) {
            return scenario.postOverride(body);
          }
          currentStatus = {
            ready: true,
            configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
          };
          return jsonResponse(currentStatus);
        }
        if (method === "DELETE") {
          if (scenario.deleteOverride) {
            return scenario.deleteOverride();
          }
          currentStatus = {
            ready: false,
            configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
          };
          return jsonResponse(currentStatus);
        }
      }
      if (url.startsWith("/api/system/worker-status")) {
        return jsonResponse({
          mode: "orchestrator",
          this_worker_id: null,
          active_workers: [],
        });
      }
      if (url.startsWith("/api/repos")) {
        return jsonResponse([]);
      }
      return jsonResponse([]);
    }
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  // each test installs its own scenario
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("First-run setup flow", () => {
  it("shows the setup panel when secrets are missing", async () => {
    installFetchMock({
      setupStatus: {
        ready: false,
        configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
      },
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("setup-panel")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("heading", { name: /welcome to grunt/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/no repos yet/i)).not.toBeInTheDocument();
  });

  it("submits both secrets and switches to the main UI without a reload", async () => {
    const fetchMock = installFetchMock({
      setupStatus: {
        ready: false,
        configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
      },
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("setup-panel")).toBeInTheDocument()
    );

    await user.type(screen.getByTestId("setup-anthropic-key"), "sk-test");
    await user.type(screen.getByTestId("setup-gh-pat"), "ghp_test");
    await user.click(screen.getByTestId("setup-submit"));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: /grunt/i })
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText(/no repos yet/i)).toBeInTheDocument()
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/setup" &&
        ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() ===
          "POST"
    );
    expect(postCall).toBeDefined();
    const postedBody = JSON.parse(
      (postCall?.[1] as RequestInit).body as string
    );
    expect(postedBody).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      GH_PAT: "ghp_test",
    });
  });

  it("renders an inline error when /api/setup POST fails", async () => {
    installFetchMock({
      setupStatus: {
        ready: false,
        configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
      },
      postOverride: () =>
        jsonResponse({ error: "GH_PAT is required" }, 400),
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("setup-panel")).toBeInTheDocument()
    );

    await user.type(screen.getByTestId("setup-anthropic-key"), "sk-test");
    await user.type(screen.getByTestId("setup-gh-pat"), "ghp_test");
    await user.click(screen.getByTestId("setup-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("setup-error")).toHaveTextContent(/GH_PAT/)
    );
    // still on setup panel
    expect(screen.getByTestId("setup-panel")).toBeInTheDocument();
  });

  it("returns to the setup panel after the user resets secrets", async () => {
    installFetchMock({
      setupStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("settings-button")).toBeInTheDocument()
    );

    await user.click(screen.getByTestId("settings-button"));
    await user.click(screen.getByTestId("reset-secrets-menu-item"));
    await waitFor(() =>
      expect(screen.getByTestId("reset-secrets-dialog")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("confirm-reset-secrets"));

    await waitFor(() =>
      expect(screen.getByTestId("setup-panel")).toBeInTheDocument()
    );
    expect(screen.getByTestId("setup-anthropic-key")).toBeInTheDocument();
    expect(screen.getByTestId("setup-gh-pat")).toBeInTheDocument();
  });
});
