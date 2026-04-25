import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiError,
  API_KEY_STORAGE_KEY,
  reposApi,
  tasksApi,
} from "../../api/client";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;
const calls: FetchCall[] = [];

function mockFetchOnce(response: Response) {
  fetchMock.mockImplementationOnce(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        init: init ?? {},
      });
      return response;
    }
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls.length = 0;
  fetchMock = vi.fn();
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("includes the x-api-key header when stored in localStorage", async () => {
    window.localStorage.setItem(API_KEY_STORAGE_KEY, "secret-key");
    mockFetchOnce(jsonResponse([]));
    await reposApi.list();
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret-key");
  });

  it("omits x-api-key when no key is stored", async () => {
    mockFetchOnce(jsonResponse([]));
    await reposApi.list();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("throws ApiError with the server-provided error message", async () => {
    mockFetchOnce(jsonResponse({ error: "boom" }, 500));
    await expect(reposApi.list()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "boom",
    });
  });

  it("throws ApiError on 401 even with empty body", async () => {
    mockFetchOnce(new Response("", { status: 401 }));
    await expect(reposApi.list()).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined for 204 responses", async () => {
    mockFetchOnce(new Response(null, { status: 204 }));
    await expect(reposApi.delete(7)).resolves.toBeUndefined();
    expect(calls[0].url).toBe("/api/repos/7");
    expect(calls[0].init.method).toBe("DELETE");
  });
});

describe("reposApi", () => {
  it("posts JSON to /api/repos on create", async () => {
    mockFetchOnce(jsonResponse({ id: 1, owner: "me" }, 201));
    await reposApi.create({ owner: "me", repo_name: "x" });
    expect(calls[0].url).toBe("/api/repos");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(
      JSON.stringify({ owner: "me", repo_name: "x" })
    );
  });

  it("patches /api/repos/:id with the active flag", async () => {
    mockFetchOnce(jsonResponse({ id: 5, active: false }));
    await reposApi.update(5, { active: false });
    expect(calls[0].url).toBe("/api/repos/5");
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe(JSON.stringify({ active: false }));
  });
});

describe("tasksApi", () => {
  it("fetches tasks by repo id", async () => {
    mockFetchOnce(jsonResponse([]));
    await tasksApi.listByRepo(42);
    expect(calls[0].url).toBe("/api/tasks?repo_id=42");
  });
});
