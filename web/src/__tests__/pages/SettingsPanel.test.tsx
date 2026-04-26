import { describe, it, expect, afterEach, vi } from "vitest";
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
  initialStatus: SetupStatus;
  patchOverride?: (body: unknown) => Response | Promise<Response>;
  clearOverride?: (key: string) => Response | Promise<Response>;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function installFetchMock(scenario: FetchScenario) {
  let currentStatus = scenario.initialStatus;
  const calls: RecordedCall[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? JSON.parse(init.body as string)
        : undefined;
      calls.push({ url, method, body });

      if (url === "/api/setup") {
        if (method === "GET") return jsonResponse(currentStatus);
        if (method === "POST") {
          currentStatus = {
            ready: true,
            configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
          };
          return jsonResponse(currentStatus);
        }
        if (method === "PATCH") {
          if (scenario.patchOverride) {
            return scenario.patchOverride(body);
          }
          const next: SetupStatus = {
            ...currentStatus,
            configured: { ...currentStatus.configured },
          };
          if (
            body &&
            typeof body === "object" &&
            "ANTHROPIC_API_KEY" in body
          ) {
            next.configured.ANTHROPIC_API_KEY = true;
          }
          if (body && typeof body === "object" && "GH_PAT" in body) {
            next.configured.GH_PAT = true;
          }
          next.ready =
            next.configured.ANTHROPIC_API_KEY && next.configured.GH_PAT;
          currentStatus = next;
          return jsonResponse(currentStatus);
        }
        if (method === "DELETE") {
          currentStatus = {
            ready: false,
            configured: { ANTHROPIC_API_KEY: false, GH_PAT: false },
          };
          return jsonResponse(currentStatus);
        }
      }
      const clearMatch = url.match(/^\/api\/setup\/([A-Z_]+)$/);
      if (clearMatch && method === "DELETE") {
        const key = clearMatch[1];
        if (scenario.clearOverride) return scenario.clearOverride(key);
        const next: SetupStatus = {
          ...currentStatus,
          configured: { ...currentStatus.configured },
        };
        if (key === "ANTHROPIC_API_KEY") next.configured.ANTHROPIC_API_KEY = false;
        if (key === "GH_PAT") next.configured.GH_PAT = false;
        next.ready =
          next.configured.ANTHROPIC_API_KEY && next.configured.GH_PAT;
        currentStatus = next;
        return jsonResponse(currentStatus);
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
  return { fetchMock, calls };
}

async function openSettingsPanel(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByTestId("settings-button")).toBeInTheDocument()
  );
  await user.click(screen.getByTestId("settings-button"));
  await user.click(screen.getByTestId("manage-secrets-menu-item"));
  await waitFor(() =>
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument()
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPanel", () => {
  it("renders existing secrets as masked when configured", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await openSettingsPanel(user);

    expect(
      screen.getByTestId("settings-anthropic-key-status")
    ).toHaveTextContent("•");
    expect(screen.getByTestId("settings-gh-pat-status")).toHaveTextContent(
      "•"
    );
    // No plaintext anywhere on the panel
    expect(screen.queryByText(/sk-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ghp_/)).not.toBeInTheDocument();
  });

  it("PATCHes /api/setup when the user updates one secret", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await openSettingsPanel(user);

    await user.type(
      screen.getByTestId("settings-anthropic-key-input"),
      "sk-rotated"
    );
    await user.click(screen.getByTestId("settings-anthropic-key-save"));

    await waitFor(() => {
      const patchCall = calls.find(
        (c) => c.url === "/api/setup" && c.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toEqual({ ANTHROPIC_API_KEY: "sk-rotated" });
    });
    // Input cleared after successful save
    expect(screen.getByTestId("settings-anthropic-key-input")).toHaveValue("");
  });

  it("DELETEs /api/setup/:key when the user clears a secret", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await openSettingsPanel(user);

    await user.click(screen.getByTestId("settings-gh-pat-clear"));

    await waitFor(() => {
      const deleteCall = calls.find(
        (c) => c.url === "/api/setup/GH_PAT" && c.method === "DELETE"
      );
      expect(deleteCall).toBeDefined();
    });

    // After clearing GH_PAT, ready becomes false → App falls back to SetupPanel
    await waitFor(() =>
      expect(screen.getByTestId("setup-panel")).toBeInTheDocument()
    );
  });

  it("renders an inline error when PATCH fails", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      patchOverride: () =>
        jsonResponse({ error: "ANTHROPIC_API_KEY must be a non-empty string" }, 400),
    });
    const user = userEvent.setup();
    render(<App />);
    await openSettingsPanel(user);

    await user.type(
      screen.getByTestId("settings-anthropic-key-input"),
      "x"
    );
    await user.click(screen.getByTestId("settings-anthropic-key-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-error")).toHaveTextContent(
        /ANTHROPIC_API_KEY/
      )
    );
    // Panel still open
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });

  it("disables Save until a value is entered", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await openSettingsPanel(user);

    expect(screen.getByTestId("settings-anthropic-key-save")).toBeDisabled();
    await user.type(
      screen.getByTestId("settings-anthropic-key-input"),
      "sk-x"
    );
    expect(screen.getByTestId("settings-anthropic-key-save")).toBeEnabled();
  });
});
