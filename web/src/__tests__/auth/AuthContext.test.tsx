import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "../../auth/AuthContext";
import {
  __resetTokenStoreForTests,
  getBearerToken,
  setBearerToken,
} from "../../auth/tokenStore";
import { API_KEY_STORAGE_KEY } from "../../api/client";
import type { AuthConfig } from "../../api/auth";

// Mirrors the env-driven assignment used by AuthContext when redirecting to
// hosted login or logout. We replace window.location with a stub for these
// tests so we can observe the redirects without actually navigating.
let assignSpy: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  __resetTokenStoreForTests();
  window.localStorage.clear();
  assignSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      assign: assignSpy,
      origin: "https://app.example.com",
      pathname: "/",
      search: "",
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
});

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="mode">{auth.config?.mode ?? ""}</span>
      <span data-testid="identity">{auth.identity ?? ""}</span>
      <button onClick={() => auth.logout()}>logout</button>
      <button
        onClick={() => {
          try {
            auth.loginWithHostedUi();
          } catch {
            // Surface as a data attribute so the test can assert on it.
          }
        }}
      >
        hosted
      </button>
    </div>
  );
}

function renderWithConfig(cfg: AuthConfig) {
  const loadConfig = vi.fn().mockResolvedValue(cfg);
  return render(
    <AuthProvider loadConfig={loadConfig}>
      <Probe />
    </AuthProvider>
  );
}

describe("AuthProvider boot sequence", () => {
  it("starts in 'loading' and transitions to 'logged-out' for cognito with no token", async () => {
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-out")
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("cognito");
  });

  it("transitions to 'logged-in' for cognito when an in-memory token is already present", async () => {
    setBearerToken("seeded.jwt");
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "inapp", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-in")
    );
  });

  it("transitions to 'logged-in' for apikey mode when a key is in localStorage", async () => {
    window.localStorage.setItem(API_KEY_STORAGE_KEY, "key");
    renderWithConfig({ mode: "apikey" });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-in")
    );
  });

  it("transitions to 'logged-out' for apikey mode when no key is in localStorage", async () => {
    renderWithConfig({ mode: "apikey" });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-out")
    );
  });

  it("transitions to 'error' when /api/auth/config rejects", async () => {
    const loadConfig = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <AuthProvider loadConfig={loadConfig}>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("error")
    );
  });
});

describe("AuthProvider.loginWithHostedUi", () => {
  it("redirects to the hosted-UI authorize endpoint when configured for hosted mode", async () => {
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-out")
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("hosted"));
    expect(assignSpy).toHaveBeenCalledTimes(1);
    const target = assignSpy.mock.calls[0][0] as string;
    expect(target).toMatch(/^https:\/\/d\.example\.com\/oauth2\/authorize\?/);
    expect(target).toContain(
      "redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback"
    );
  });
});

describe("AuthProvider.logout", () => {
  it("clears the bearer token and flips state to logged-out", async () => {
    setBearerToken("jwt.x");
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "inapp", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-in")
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("logout"));
    expect(getBearerToken()).toBeNull();
    expect(screen.getByTestId("status")).toHaveTextContent("logged-out");
  });

  it("redirects through Cognito /logout for hosted-mode deployments", async () => {
    setBearerToken("jwt.x");
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-in")
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("logout"));
    expect(getBearerToken()).toBeNull();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls[0][0]).toMatch(
      /^https:\/\/d\.example\.com\/logout\?/
    );
  });

  it("does NOT redirect for inapp-mode deployments (just clears state)", async () => {
    setBearerToken("jwt.x");
    renderWithConfig({
      mode: "cognito",
      cognito: { loginMode: "inapp", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-in")
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("logout"));
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe("AuthProvider.finalizeLogin", () => {
  function Capture() {
    const auth = useAuth();
    return (
      <div>
        <span data-testid="status">{auth.status}</span>
        <span data-testid="identity">{auth.identity ?? ""}</span>
        <button
          onClick={() =>
            auth.finalizeLogin(
              // eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0. — JWT with email claim
              "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0."
            )
          }
        >
          finalize
        </button>
      </div>
    );
  }

  it("stores the bearer token and pulls the identity from the JWT email claim", async () => {
    const loadConfig = vi.fn().mockResolvedValue({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    } satisfies AuthConfig);
    render(
      <AuthProvider loadConfig={loadConfig}>
        <Capture />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("logged-out")
    );
    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByText("finalize"));
    });
    expect(getBearerToken()).toBe(
      "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0."
    );
    expect(screen.getByTestId("status")).toHaveTextContent("logged-in");
    expect(screen.getByTestId("identity")).toHaveTextContent("alice@example.com");
  });
});
