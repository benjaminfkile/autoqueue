import type {
  AcceptanceCriterion,
  AcceptanceCriterionUpdateInput,
  ChatMessage,
  ChatStreamEvent,
  MaterializedTaskTree,
  Repo,
  RepoInput,
  RepoUsageResponse,
  SetupInput,
  SetupStatus,
  TaskDetail,
  TaskEvent,
  TaskNote,
  TaskNoteInput,
  TaskSummary,
  TaskTreeProposal,
  TaskUpdateInput,
  TaskUsageResponse,
  WorkerStatus,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
  usage: (id: number) =>
    apiFetch<RepoUsageResponse>(`/api/repos/${id}/usage`),
  clone: (id: number) =>
    apiFetch<Repo>(`/api/repos/${id}/clone`, { method: "POST" }),
};

export const tasksApi = {
  listByRepo: (repoId: number) =>
    apiFetch<TaskSummary[]>(`/api/tasks?repo_id=${repoId}`),
  get: (id: number) => apiFetch<TaskDetail>(`/api/tasks/${id}`),
  update: (id: number, input: TaskUpdateInput) =>
    apiFetch<TaskSummary>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  events: (id: number) => apiFetch<TaskEvent[]>(`/api/tasks/${id}/events`),
  usage: (id: number) =>
    apiFetch<TaskUsageResponse>(`/api/tasks/${id}/usage`),
  log: async (id: number): Promise<string> => {
    const res = await fetch(`/api/tasks/${id}/log`, {
      headers: { Accept: "text/plain" },
    });
    if (res.status === 404) return "";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `Log fetch failed (${res.status})`);
    }
    return res.text();
  },
  logStreamUrl: (id: number) => `/api/tasks/${id}/log/stream`,
};

export const notesApi = {
  list: (taskId: number) =>
    apiFetch<TaskNote[]>(`/api/tasks/${taskId}/notes`),
  create: (taskId: number, input: TaskNoteInput) =>
    apiFetch<TaskNote>(`/api/tasks/${taskId}/notes`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  delete: (taskId: number, noteId: number) =>
    apiFetch<void>(`/api/tasks/${taskId}/notes/${noteId}`, {
      method: "DELETE",
    }),
};

export const systemApi = {
  workerStatus: () => apiFetch<WorkerStatus>("/api/system/worker-status"),
};

export const setupApi = {
  status: () => apiFetch<SetupStatus>("/api/setup"),
  save: (input: SetupInput) =>
    apiFetch<SetupStatus>("/api/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (input: Partial<SetupInput>) =>
    apiFetch<SetupStatus>("/api/setup", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  clear: (key: keyof SetupInput) =>
    apiFetch<SetupStatus>(`/api/setup/${key}`, {
      method: "DELETE",
    }),
  reset: () =>
    apiFetch<SetupStatus>("/api/setup", {
      method: "DELETE",
    }),
};

export interface ChatStreamOptions {
  messages: ChatMessage[];
  repoId?: number | null;
  signal?: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

// Parse SSE chunks emitted by /api/chat. Each event is a `event: <name>\n
// data: <json>\n\n` block; we keep a leftover buffer for partial frames.
export function parseSseChunk(
  buffer: string,
  onEvent: (event: ChatStreamEvent) => void
): string {
  let remainder = buffer;
  while (true) {
    const sep = remainder.indexOf("\n\n");
    if (sep === -1) return remainder;
    const block = remainder.slice(0, sep);
    remainder = remainder.slice(sep + 2);

    let eventName: string | null = null;
    let dataLine = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLine += line.slice(5).trim();
      }
    }
    if (!eventName) continue;
    if (eventName === "done") {
      onEvent({ type: "done" });
      continue;
    }
    let parsed: unknown = {};
    if (dataLine.length > 0) {
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }
    }
    if (eventName === "delta") {
      const text =
        parsed && typeof parsed === "object" && "text" in parsed
          ? String((parsed as { text: unknown }).text)
          : "";
      onEvent({ type: "delta", text });
    } else if (eventName === "proposal") {
      const proposal =
        parsed && typeof parsed === "object" && "proposal" in parsed
          ? ((parsed as { proposal: unknown }).proposal as TaskTreeProposal)
          : { parents: [] };
      onEvent({ type: "proposal", proposal });
    } else if (eventName === "proposal_error") {
      const error =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : "Unknown proposal error";
      onEvent({ type: "proposal_error", error });
    } else if (eventName === "error") {
      const error =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : "Unknown error";
      onEvent({ type: "error", error });
    }
  }
}

export const chatApi = {
  // Open a streaming POST to /api/chat and dispatch parsed SSE events. The
  // returned promise resolves once the stream ends (server-side `done` or
  // socket close); rejects on network/HTTP errors. Pass an AbortSignal to
  // cancel mid-stream.
  stream: async (options: ChatStreamOptions): Promise<void> => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        messages: options.messages,
        repo_id: options.repoId ?? null,
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text || res.statusText || `Chat failed (${res.status})`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          message = String((parsed as { error: unknown }).error);
        }
      } catch {
        // text wasn't JSON — fall through with the raw message.
      }
      throw new ApiError(res.status, message);
    }

    if (!res.body) {
      throw new ApiError(500, "Streaming response had no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, options.onEvent);
    }
    buffer += decoder.decode();
    parseSseChunk(buffer, options.onEvent);
  },
  materialize: (repoId: number, proposal: TaskTreeProposal) =>
    apiFetch<MaterializedTaskTree>(
      `/api/repos/${repoId}/materialize-tree`,
      {
        method: "POST",
        body: JSON.stringify(proposal),
      }
    ),
};

export const criteriaApi = {
  update: (taskId: number, criterionId: number, input: AcceptanceCriterionUpdateInput) =>
    apiFetch<AcceptanceCriterion>(
      `/api/tasks/${taskId}/criteria/${criterionId}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    ),
};
