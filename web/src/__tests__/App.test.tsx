import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { ThemeProvider } from "../theme/ThemeContext";

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

function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/setup")) {
      return jsonResponse({
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      });
    }
    if (url.startsWith("/api/repos")) {
      return jsonResponse([]);
    }
    if (url.startsWith("/api/system/worker-status")) {
      return jsonResponse({
        mode: "orchestrator",
        this_worker_id: null,
        active_workers: [],
      });
    }
    return jsonResponse([]);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  it("renders the grunt app bar heading", async () => {
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: /grunt/i })
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText(/no repos yet/i)).toBeInTheDocument()
    );
  });

  it("renders the Repos page", async () => {
    renderApp();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /repos/i })
      ).toBeInTheDocument();
    });
  });

  it("renders the worker mode chip in the header", async () => {
    renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("worker-mode-chip")).toHaveTextContent(
        /orchestrator/i
      );
    });
  });

  it("opens the planning chat drawer from the header button", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /open planning chat/i })
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /open planning chat/i })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /planning chat/i })
      ).toBeInTheDocument()
    );
  });
});
