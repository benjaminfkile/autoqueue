import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CognitoCallback from "../../auth/CognitoCallback";
import { AuthProvider } from "../../auth/AuthContext";
import {
  __resetTokenStoreForTests,
  getBearerToken,
} from "../../auth/tokenStore";
import type { AuthConfig } from "../../api/auth";

let fetchMock: ReturnType<typeof vi.fn>;
const originalLocation = window.location;
const originalReplaceState = window.history.replaceState;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setLocation(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      origin: "https://app.example.com",
      pathname: "/auth/callback",
      search,
      assign: vi.fn(),
    },
  });
}

beforeEach(() => {
  __resetTokenStoreForTests();
  window.localStorage.clear();
  fetchMock = vi.fn();
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  window.history.replaceState = originalReplaceState;
  vi.restoreAllMocks();
});

function renderCallback(cfg: AuthConfig) {
  return render(
    <AuthProvider loadConfig={async () => cfg}>
      <CognitoCallback />
    </AuthProvider>
  );
}

describe("CognitoCallback", () => {
  it("exchanges the authorization code and stores the access token", async () => {
    setLocation("?code=abc-123&state=xyz");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "atk",
        id_token: "itk",
        token_type: "Bearer",
        expires_in: 3600,
      })
    );
    const replaceSpy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});
    renderCallback({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });

    await waitFor(() => expect(getBearerToken()).toBe("atk"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://d.example.com/oauth2/token"
    );
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("code=abc-123");
    expect(body).toContain("grant_type=authorization_code");
    expect(replaceSpy).toHaveBeenCalledWith({}, "", "/");
  });

  it("renders the Cognito-supplied error_description without exchanging anything", async () => {
    setLocation("?error=access_denied&error_description=User+aborted+login");
    renderCallback({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/user aborted login/i)
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBearerToken()).toBeNull();
  });

  it("renders an error when the URL is missing the code parameter", async () => {
    setLocation("?state=xyz");
    renderCallback({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/missing/i)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders an error when the deployment is not configured for cognito", async () => {
    setLocation("?code=abc-123");
    renderCallback({ mode: "apikey" });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/cognito/i)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces token-exchange errors from Cognito", async () => {
    setLocation("?code=stale");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "Authorization code has expired",
        },
        400
      )
    );
    renderCallback({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /authorization code has expired/i
      )
    );
    expect(getBearerToken()).toBeNull();
  });
});
