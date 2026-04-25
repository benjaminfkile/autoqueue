import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "../../auth/LoginPage";
import { AuthProvider } from "../../auth/AuthContext";
import {
  __resetTokenStoreForTests,
  getBearerToken,
} from "../../auth/tokenStore";
import { API_KEY_STORAGE_KEY } from "../../api/client";
import type { AuthConfig } from "../../api/auth";

let fetchMock: ReturnType<typeof vi.fn>;
let assignSpy: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetTokenStoreForTests();
  window.localStorage.clear();
  fetchMock = vi.fn();
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
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

function renderLogin(cfg: AuthConfig) {
  return render(
    <AuthProvider loadConfig={async () => cfg}>
      <LoginPage />
    </AuthProvider>
  );
}

describe("LoginPage — apikey mode", () => {
  it("stores the API key in localStorage and reloads the SPA", async () => {
    renderLogin({ mode: "apikey" });
    await waitFor(() =>
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/api key/i), "k-123");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(window.localStorage.getItem(API_KEY_STORAGE_KEY)).toBe("k-123");
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("starts with the API key field empty so a real submit needs typed input", async () => {
    renderLogin({ mode: "apikey" });
    await waitFor(() =>
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
    );
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toBeRequired();
  });
});

describe("LoginPage — cognito hosted mode", () => {
  it("redirects to the hosted UI when 'Sign in with Cognito' is clicked", async () => {
    renderLogin({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in with cognito/i })
      ).toBeInTheDocument()
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /sign in with cognito/i })
    );
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls[0][0]).toMatch(
      /^https:\/\/d\.example\.com\/oauth2\/authorize\?/
    );
  });

  it("disables the Sign-in button when the cognito domain is not configured", async () => {
    renderLogin({
      mode: "cognito",
      cognito: { loginMode: "hosted", clientId: "c" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in with cognito/i })
      ).toBeDisabled()
    );
  });
});

describe("LoginPage — cognito inapp mode", () => {
  it("submits credentials to /api/auth/login and stores the returned bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        accessToken: "atk",
        idToken: undefined,
        expiresIn: 3600,
        tokenType: "Bearer",
      })
    );
    renderLogin({
      mode: "cognito",
      cognito: { loginMode: "inapp", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "hunter2");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(getBearerToken()).toBe("atk"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/login");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ username: "alice", password: "hunter2" });
  });

  it("renders the server error inline when login fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Incorrect username or password." }, 401)
    );
    renderLogin({
      mode: "cognito",
      cognito: { loginMode: "inapp", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /incorrect username/i
      )
    );
    expect(getBearerToken()).toBeNull();
  });
});
