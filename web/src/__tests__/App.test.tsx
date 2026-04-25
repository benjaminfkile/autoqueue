import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import {
  __resetTokenStoreForTests,
  setBearerToken,
} from "../auth/tokenStore";
import { API_KEY_STORAGE_KEY } from "../api/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockOpts {
  authConfig?: unknown;
}

function installFetchMock(opts: MockOpts = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/auth/config")) {
      return jsonResponse(opts.authConfig ?? { mode: "apikey" });
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
  window.localStorage.clear();
  __resetTokenStoreForTests();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App (api-key mode, key already set)", () => {
  beforeEach(() => {
    window.localStorage.setItem(API_KEY_STORAGE_KEY, "secret-key");
    installFetchMock();
  });

  it("renders the grunt app bar heading", async () => {
    render(<App />);
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
    render(<App />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /repos/i })
      ).toBeInTheDocument();
    });
  });

  it("renders the worker mode chip in the header", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("worker-mode-chip")).toHaveTextContent(
        /orchestrator/i
      );
    });
  });

  it("opens the planning chat drawer from the header button", async () => {
    const user = userEvent.setup();
    render(<App />);
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

  it("renders a Sign out button when authenticated", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument()
    );
  });
});

describe("App (api-key mode, no key set)", () => {
  beforeEach(() => {
    installFetchMock();
  });

  it("renders the api-key login form when no key is in localStorage", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
    );
    expect(
      screen.queryByRole("heading", { level: 1, name: /repos/i })
    ).not.toBeInTheDocument();
  });
});

describe("App (Cognito mode)", () => {
  it("renders 'Sign in with Cognito' for hosted login mode", async () => {
    installFetchMock({
      authConfig: {
        mode: "cognito",
        cognito: {
          loginMode: "hosted",
          domain: "x.auth.us-east-1.amazoncognito.com",
          clientId: "client-1",
        },
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in with cognito/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the in-app username/password form for inapp login mode", async () => {
    installFetchMock({
      authConfig: {
        mode: "cognito",
        cognito: { loginMode: "inapp", clientId: "client-1" },
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    );
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("when a bearer token already exists, jumps straight into the authed shell", async () => {
    setBearerToken("seed-token");
    installFetchMock({
      authConfig: {
        mode: "cognito",
        cognito: { loginMode: "inapp", clientId: "client-1" },
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: /repos/i })
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByLabelText(/^username$/i)
    ).not.toBeInTheDocument();
  });
});
