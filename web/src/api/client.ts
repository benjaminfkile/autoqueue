import type { Repo, RepoInput, TaskSummary } from "./types";

export const API_KEY_STORAGE_KEY = "grunt_api_key";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function getApiKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  const key = getApiKey();
  if (key) headers["x-api-key"] = key;

  const res = await fetch(path, { ...init, headers });

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }

  return data as T;
}

export const reposApi = {
  list: () => apiFetch<Repo[]>("/api/repos"),
  create: (input: RepoInput) =>
    apiFetch<Repo>("/api/repos", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: number, input: RepoInput) =>
    apiFetch<Repo>(`/api/repos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  delete: (id: number) =>
    apiFetch<void>(`/api/repos/${id}`, { method: "DELETE" }),
};

export const tasksApi = {
  listByRepo: (repoId: number) =>
    apiFetch<TaskSummary[]>(`/api/tasks?repo_id=${repoId}`),
};
