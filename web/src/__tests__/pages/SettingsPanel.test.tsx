import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import type { AppSettings, SetupStatus } from "../../api/types";
import { ThemeProvider } from "../../theme/ThemeContext";

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

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
  initialSettings?: AppSettings;
  settingsPatchOverride?: (body: unknown) => Response | Promise<Response>;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function installFetchMock(scenario: FetchScenario) {
  let currentStatus = scenario.initialStatus;
  let currentSettings: AppSettings =
    scenario.initialSettings ?? {
      id: 1,
      default_model: "claude-sonnet-4-6",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: "2026-04-26T00:00:00.000Z",
    };
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
      if (url === "/api/settings") {
        if (method === "GET") return jsonResponse(currentSettings);
        if (method === "PATCH") {
          if (scenario.settingsPatchOverride) {
            return scenario.settingsPatchOverride(body);
          }
          if (
            body &&
            typeof body === "object" &&
            "default_model" in body &&
            typeof (body as { default_model: unknown }).default_model ===
              "string"
          ) {
            currentSettings = {
              ...currentSettings,
              default_model: (body as { default_model: string }).default_model,
              updated_at: new Date().toISOString(),
            };
          }
          for (const key of [
            "weekly_token_cap",
            "session_token_cap",
          ] as const) {
            if (body && typeof body === "object" && key in body) {
              const raw = (body as Record<string, unknown>)[key];
              currentSettings = {
                ...currentSettings,
                [key]:
                  raw === null
                    ? null
                    : typeof raw === "number"
                    ? raw
                    : currentSettings[key],
                updated_at: new Date().toISOString(),
              };
            }
          }
          return jsonResponse(currentSettings);
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
    renderApp();
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
    renderApp();
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
    renderApp();
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
    renderApp();
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
    renderApp();
    await openSettingsPanel(user);

    expect(screen.getByTestId("settings-anthropic-key-save")).toBeDisabled();
    await user.type(
      screen.getByTestId("settings-anthropic-key-input"),
      "sk-x"
    );
    expect(screen.getByTestId("settings-anthropic-key-save")).toBeEnabled();
  });

  it("renders the default Claude model dropdown with the loaded value", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-opus-4-7",
        weekly_token_cap: null,
        session_token_cap: null,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-default-model-input")
      ).toHaveValue("claude-opus-4-7");
    });
  });

  it("PATCHes /api/settings when the user picks a new model", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-sonnet-4-6",
        weekly_token_cap: null,
        session_token_cap: null,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-default-model-input")
      ).toHaveValue("claude-sonnet-4-6")
    );

    // MUI's TextField select uses an underlying combobox; we click the
    // labelled trigger to open the listbox and pick the option by its label.
    await user.click(screen.getByLabelText("Default Claude model"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Haiku 4.5"));

    await waitFor(() => {
      const patchCall = calls.find(
        (c) => c.url === "/api/settings" && c.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toEqual({ default_model: "claude-haiku-4-5" });
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-default-model-input")
      ).toHaveValue("claude-haiku-4-5")
    );
  });

  it("renders an inline error when the model PATCH fails", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-sonnet-4-6",
        weekly_token_cap: null,
        session_token_cap: null,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
      settingsPatchOverride: () =>
        jsonResponse({ error: "default_model must be a non-empty string" }, 400),
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-default-model-input")
      ).toHaveValue("claude-sonnet-4-6")
    );

    await user.click(screen.getByLabelText("Default Claude model"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Opus 4.7"));

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-default-model-error")
      ).toHaveTextContent(/default_model/)
    );
  });

  it("PATCHes /api/settings with a numeric weekly_token_cap when the user enters a value", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-weekly-token-cap-input")
      ).toBeInTheDocument()
    );

    const weeklyInput = screen.getByTestId("settings-weekly-token-cap-input");
    await user.type(weeklyInput, "1000000000");
    await user.click(screen.getByTestId("settings-weekly-token-cap-save"));

    await waitFor(() => {
      const patchCall = calls.find(
        (c) =>
          c.url === "/api/settings" &&
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "weekly_token_cap" in (c.body as Record<string, unknown>)
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toEqual({ weekly_token_cap: 1000000000 });
    });
  });

  it("PATCHes /api/settings with null when the user clears a cap", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-sonnet-4-6",
        weekly_token_cap: 250000,
        session_token_cap: 8000,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(screen.getByTestId("settings-session-token-cap-input")).toHaveValue(
        "8000"
      )
    );

    const sessionInput = screen.getByTestId("settings-session-token-cap-input");
    await user.clear(sessionInput);
    await user.click(screen.getByTestId("settings-session-token-cap-save"));

    await waitFor(() => {
      const patchCall = calls.find(
        (c) =>
          c.url === "/api/settings" &&
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "session_token_cap" in (c.body as Record<string, unknown>)
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toEqual({ session_token_cap: null });
    });
  });

  it("rejects non-numeric cap input client-side without hitting the API", async () => {
    const { calls } = installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-weekly-token-cap-input")
      ).toBeInTheDocument()
    );

    const weeklyInput = screen.getByTestId("settings-weekly-token-cap-input");
    await user.type(weeklyInput, "not-a-number");
    await user.click(screen.getByTestId("settings-weekly-token-cap-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-token-cap-error")).toHaveTextContent(
        /weekly_token_cap/
      )
    );
    expect(
      calls.find(
        (c) => c.url === "/api/settings" && c.method === "PATCH"
      )
    ).toBeUndefined();
  });

  it("loads existing cap values into the inputs", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-sonnet-4-6",
        weekly_token_cap: 5000000,
        session_token_cap: 50000,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(screen.getByTestId("settings-weekly-token-cap-input")).toHaveValue(
        "5000000"
      )
    );
    expect(
      screen.getByTestId("settings-session-token-cap-input")
    ).toHaveValue("50000");
  });

  it("keeps a non-curated saved model selectable in the dropdown", async () => {
    installFetchMock({
      initialStatus: {
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      },
      initialSettings: {
        id: 1,
        default_model: "claude-experimental-99",
        weekly_token_cap: null,
        session_token_cap: null,
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderApp();
    await openSettingsPanel(user);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-default-model-input")
      ).toHaveValue("claude-experimental-99")
    );

    await user.click(screen.getByLabelText("Default Claude model"));
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByText(/claude-experimental-99/)
    ).toBeInTheDocument();
  });
});
