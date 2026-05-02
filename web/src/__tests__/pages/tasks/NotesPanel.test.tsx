import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotesPanel from "../../../pages/tasks/NotesPanel";
import type { TaskNote } from "../../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeNote(overrides: Partial<TaskNote> = {}): TaskNote {
  return {
    id: 1,
    task_id: 42,
    author: "user",
    visibility: "all",
    content: "Test note content",
    tags: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface Routes {
  list?: TaskNote[];
  listStatus?: number;
  createNote?: TaskNote;
  createStatus?: number;
  deleteStatus?: number;
}

function installFetch(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.match(/\/api\/tasks\/\d+\/notes$/) && method === "GET") {
      return jsonResponse(routes.list ?? [], routes.listStatus ?? 200);
    }
    if (url.match(/\/api\/tasks\/\d+\/notes$/) && method === "POST") {
      if (routes.createStatus && routes.createStatus >= 400) {
        return jsonResponse({ error: "Failed to create note" }, routes.createStatus);
      }
      return jsonResponse(routes.createNote ?? makeNote(), 200);
    }
    if (url.match(/\/api\/tasks\/\d+\/notes\/\d+$/) && method === "DELETE") {
      if (routes.deleteStatus && routes.deleteStatus >= 400) {
        return jsonResponse({ error: "Failed to delete" }, routes.deleteStatus);
      }
      return new Response(null, { status: 204 });
    }
    return jsonResponse([], 200);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  // suppress window.confirm
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotesPanel", () => {
  it("renders the note form and an empty state message when there are no notes", async () => {
    installFetch({ list: [] });
    render(<NotesPanel taskId={42} />);

    await waitFor(() =>
      expect(screen.getByTestId("task-detail-note-form")).toBeInTheDocument()
    );
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();
  });

  it("renders existing notes fetched from the API", async () => {
    const note = makeNote({ id: 7, content: "Hello from agent", author: "agent", visibility: "siblings" });
    installFetch({ list: [note] });
    render(<NotesPanel taskId={42} />);

    await waitFor(() =>
      expect(screen.getByTestId("note-7")).toBeInTheDocument()
    );
    expect(screen.getByTestId("note-7-content")).toHaveTextContent("Hello from agent");
    expect(screen.getByTestId("note-7-author")).toHaveTextContent("agent");
    expect(screen.getByTestId("note-7-visibility")).toHaveTextContent("siblings");
  });

  it("creates a note and appends it to the list on success", async () => {
    const created = makeNote({ id: 99, content: "My new note", author: "user", visibility: "all" });
    installFetch({ list: [], createNote: created });
    const user = userEvent.setup();
    render(<NotesPanel taskId={42} />);

    await waitFor(() =>
      expect(screen.getByText(/no notes yet/i)).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/note content/i), "My new note");
    await user.click(screen.getByRole("button", { name: /add note/i }));

    await waitFor(() =>
      expect(screen.getByTestId("note-99")).toBeInTheDocument()
    );
    expect(screen.getByTestId("note-99-content")).toHaveTextContent("My new note");
  });

  it("shows an error alert when note creation fails", async () => {
    installFetch({ list: [], createStatus: 500 });
    const user = userEvent.setup();
    render(<NotesPanel taskId={42} />);

    await waitFor(() =>
      expect(screen.getByTestId("task-detail-note-form")).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/note content/i), "failing note");
    await user.click(screen.getByRole("button", { name: /add note/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
  });

  it("deletes a note from the list after confirmation", async () => {
    const note = makeNote({ id: 5, content: "To be deleted" });
    installFetch({ list: [note] });
    const user = userEvent.setup();
    render(<NotesPanel taskId={42} />);

    await waitFor(() =>
      expect(screen.getByTestId("note-5")).toBeInTheDocument()
    );

    await user.click(screen.getByTestId("note-5-delete"));

    await waitFor(() =>
      expect(screen.queryByTestId("note-5")).not.toBeInTheDocument()
    );
  });
});
