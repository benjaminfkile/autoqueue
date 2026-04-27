import request from "supertest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import app from "../src/app";

// Mock DB
jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

// Mock health (required by app)
jest.mock("../src/db/health", () => ({
  __esModule: true,
  default: {
    getDBConnectionHealth: jest.fn().mockResolvedValue({
      connected: true,
      connectionUsesProxy: false,
    }),
  },
}));

// Mock tasks DB layer
jest.mock("../src/db/tasks");
import {
  getTasksByRepoId,
  getTaskById,
  getChildTasks,
  createTask,
  updateTask,
  deleteTask,
  resolveTaskModelWithSource,
} from "../src/db/tasks";

// Mock acceptance criteria DB layer
jest.mock("../src/db/acceptanceCriteria");
import {
  getCriteriaByTaskId,
  createCriterion,
  updateCriterion,
  deleteCriterion,
} from "../src/db/acceptanceCriteria";

// Mock task events DB layer
jest.mock("../src/db/taskEvents");
import { getEventsByTaskId } from "../src/db/taskEvents";

// Mock task notes DB layer
jest.mock("../src/db/taskNotes");
import {
  createNote,
  deleteNote,
  getNotesForTask,
} from "../src/db/taskNotes";

// Mock task usage DB layer
jest.mock("../src/db/taskUsage");
import {
  getUsageRowsForTask,
  getUsageTotalsForTask,
} from "../src/db/taskUsage";

const mockTask = {
  id: 1,
  repo_id: 1,
  parent_id: null,
  title: "Test task",
  description: "desc",
  order_position: 0,
  status: "pending" as const,
  retry_count: 0,
  pr_url: null,
  ordering_mode: null,
  created_at: new Date(),
};

const mockCriterion = {
  id: 2,
  task_id: 1,
  description: "criterion desc",
  order_position: 0,
  met: false,
  created_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("tasksRouter", () => {
  // GET /api/tasks
  describe("GET /api/tasks", () => {
    it("returns 400 when repo_id is missing", async () => {
      const res = await request(app)
        .get("/api/tasks");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/repo_id/);
    });

    it("returns 200 with array when repo_id is provided", async () => {
      (getTasksByRepoId as jest.Mock).mockResolvedValue([mockTask]);
      (getChildTasks as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks?repo_id=1");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("children_count", 0);
    });
  });

  // POST /api/tasks
  describe("POST /api/tasks", () => {
    it("returns 400 when repo_id or title is missing", async () => {
      const res = await request(app)
        .post("/api/tasks")
        .send({ description: "no repo or title" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/repo_id.*title/);
    });

    it("returns 201 with task and criteria when body is valid", async () => {
      (createTask as jest.Mock).mockResolvedValue(mockTask);
      (createCriterion as jest.Mock).mockResolvedValue(mockCriterion);

      const res = await request(app)
        .post("/api/tasks")
        .send({
          repo_id: 1,
          title: "Test task",
          acceptanceCriteria: ["criterion desc"],
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", 1);
      expect(res.body.acceptanceCriteria).toHaveLength(1);
    });

    it("accepts ordering_mode and passes it through to createTask", async () => {
      (createTask as jest.Mock).mockResolvedValue({
        ...mockTask,
        ordering_mode: "parallel",
      });

      const res = await request(app)
        .post("/api/tasks")
        .send({
          repo_id: 1,
          title: "Phase parent",
          ordering_mode: "parallel",
        });
      expect(res.status).toBe(201);
      expect(createTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ordering_mode: "parallel" })
      );
      expect(res.body.ordering_mode).toBe("parallel");
    });

    it("creates a task without ordering_mode (override null) so the repo default applies", async () => {
      (createTask as jest.Mock).mockResolvedValue(mockTask);

      const res = await request(app)
        .post("/api/tasks")
        .send({ repo_id: 1, title: "child" });

      expect(res.status).toBe(201);
      expect(createTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ordering_mode: undefined })
      );
      expect(res.body.ordering_mode).toBeNull();
    });

    it("rejects an invalid ordering_mode", async () => {
      const res = await request(app)
        .post("/api/tasks")
        .send({
          repo_id: 1,
          title: "bad",
          ordering_mode: "chaotic",
        });
      expect(res.status).toBe(400);
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  // GET /api/tasks/:id
  describe("GET /api/tasks/:id", () => {
    it("returns 200 with task, acceptanceCriteria and children", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (getCriteriaByTaskId as jest.Mock).mockResolvedValue([mockCriterion]);
      (getChildTasks as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("acceptanceCriteria");
      expect(res.body).toHaveProperty("children");
    });

    it("returns 400 for invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
    });
  });

  // PATCH /api/tasks/:id
  describe("PATCH /api/tasks/:id", () => {
    it("returns 200 with updated task", async () => {
      const updated = { ...mockTask, title: "Updated" };
      (updateTask as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ title: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Updated");
    });

    it("accepts ordering_mode and passes it through to updateTask", async () => {
      const updated = { ...mockTask, ordering_mode: "parallel" };
      (updateTask as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ ordering_mode: "parallel" });

      expect(res.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ ordering_mode: "parallel" })
      );
      expect(res.body.ordering_mode).toBe("parallel");
    });

    it("rejects an invalid ordering_mode value", async () => {
      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ ordering_mode: "anarchy" });

      expect(res.status).toBe(400);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("accepts requires_approval=true and passes it through to updateTask (gate raised)", async () => {
      const updated = { ...mockTask, requires_approval: true };
      (updateTask as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ requires_approval: true });

      expect(res.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ requires_approval: true })
      );
      expect(res.body.requires_approval).toBe(true);
    });

    it("accepts requires_approval=false (the GUI 'Approve to run' flow) and passes it through", async () => {
      const updated = { ...mockTask, requires_approval: false };
      (updateTask as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ requires_approval: false });

      expect(res.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ requires_approval: false })
      );
      expect(res.body.requires_approval).toBe(false);
    });

    it("rejects a non-boolean requires_approval", async () => {
      const res = await request(app)
        .patch("/api/tasks/1")
        .send({ requires_approval: "yes" });

      expect(res.status).toBe(400);
      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  // DELETE /api/tasks/:id
  describe("DELETE /api/tasks/:id", () => {
    it("returns 204", async () => {
      (deleteTask as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/tasks/1");
      expect(res.status).toBe(204);
    });
  });

  // GET /api/tasks/:id/criteria
  describe("GET /api/tasks/:id/criteria", () => {
    it("returns 200 with criteria array", async () => {
      (getCriteriaByTaskId as jest.Mock).mockResolvedValue([mockCriterion]);

      const res = await request(app)
        .get("/api/tasks/1/criteria");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("description");
    });
  });

  // POST /api/tasks/:id/criteria
  describe("POST /api/tasks/:id/criteria", () => {
    it("returns 201 with created criterion", async () => {
      (createCriterion as jest.Mock).mockResolvedValue(mockCriterion);

      const res = await request(app)
        .post("/api/tasks/1/criteria")
        .send({ description: "criterion desc" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", 2);
    });
  });

  // PATCH /api/tasks/:taskId/criteria/:criterionId
  describe("PATCH /api/tasks/1/criteria/2", () => {
    it("returns 200 with updated criterion", async () => {
      const updated = { ...mockCriterion, met: true };
      (updateCriterion as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1/criteria/2")
        .send({ met: true });
      expect(res.status).toBe(200);
      expect(res.body.met).toBe(true);
    });
  });

  // DELETE /api/tasks/:taskId/criteria/:criterionId
  describe("DELETE /api/tasks/1/criteria/2", () => {
    it("returns 204", async () => {
      (deleteCriterion as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/tasks/1/criteria/2");
      expect(res.status).toBe(204);
    });
  });

  // GET /api/tasks/:id/log
  describe("GET /api/tasks/:id/log", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-router-log-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/log");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
    });

    it("returns 404 when the task does not exist", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/tasks/1/log");
      expect(res.status).toBe(404);
    });

    it("returns 404 when log_path is null on the task", async () => {
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: null,
      });
      const res = await request(app)
        .get("/api/tasks/1/log");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the log file is missing on disk", async () => {
      const missing = path.join(tmpRoot, "missing.log");
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: missing,
      });
      const res = await request(app)
        .get("/api/tasks/1/log");
      expect(res.status).toBe(404);
    });

    it("streams the file contents when the log exists on disk", async () => {
      const logFile = path.join(tmpRoot, "task-1.log");
      const expected = "line one\nline two\n";
      fs.writeFileSync(logFile, expected);
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: logFile,
      });

      const res = await request(app)
        .get("/api/tasks/1/log");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toBe(expected);
    });
  });

  // GET /api/tasks/:id/log/stream
  describe("GET /api/tasks/:id/log/stream", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-router-sse-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/log/stream");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the task does not exist", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/tasks/1/log/stream");
      expect(res.status).toBe(404);
    });

    it("returns 404 when log_path is null on the task", async () => {
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: null,
      });
      const res = await request(app)
        .get("/api/tasks/1/log/stream");
      expect(res.status).toBe(404);
    });

    it("opens an SSE stream that emits existing log content for an active task and closes when the task is no longer active", async () => {
      const logFile = path.join(tmpRoot, "task-1.log");
      fs.writeFileSync(logFile, "first chunk\n");

      let calls = 0;
      (getTaskById as jest.Mock).mockImplementation(async () => {
        calls += 1;
        // First call: tell the handler the task exists with a log_path and is active.
        // Subsequent status polls: report 'done' so the handler closes.
        if (calls === 1) {
          return { ...mockTask, status: "active", log_path: logFile };
        }
        return { ...mockTask, status: "done", log_path: logFile };
      });

      const res = await request(app)
        .get("/api/tasks/1/log/stream");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(res.text).toContain("first chunk");
    }, 15_000);
  });

  // GET /api/tasks/:id/events
  describe("GET /api/tasks/:id/events", () => {
    it("returns 200 with the chronological list of events from getEventsByTaskId", async () => {
      const events = [
        {
          id: 1,
          task_id: 1,
          ts: new Date("2026-04-25T10:00:00Z"),
          event: "claimed",
          data: { worker_id: "worker-a" },
        },
        {
          id: 2,
          task_id: 1,
          ts: new Date("2026-04-25T10:00:01Z"),
          event: "claude_started",
          data: { attempt: 1 },
        },
      ];
      (getEventsByTaskId as jest.Mock).mockResolvedValue(events);

      const res = await request(app)
        .get("/api/tasks/1/events");

      expect(res.status).toBe(200);
      expect(getEventsByTaskId).toHaveBeenCalledWith(expect.anything(), 1);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({
        id: 1,
        event: "claimed",
        data: { worker_id: "worker-a" },
      });
      expect(res.body[1]).toMatchObject({
        id: 2,
        event: "claude_started",
        data: { attempt: 1 },
      });
    });

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/events");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
      expect(getEventsByTaskId).not.toHaveBeenCalled();
    });

    it("returns 200 with an empty array when the task has no events", async () => {
      (getEventsByTaskId as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/1/events");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // GET /api/tasks/:id/notes
  describe("GET /api/tasks/:id/notes", () => {
    const noteRow = {
      id: 9,
      task_id: 1,
      author: "agent",
      visibility: "siblings",
      tags: ["context"],
      content: "heads up",
      created_at: new Date("2026-04-25T10:00:00Z"),
    };

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/notes");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
      expect(getNotesForTask).not.toHaveBeenCalled();
    });

    it("returns 200 with the visible-notes array from getNotesForTask", async () => {
      (getNotesForTask as jest.Mock).mockResolvedValue([noteRow]);

      const res = await request(app)
        .get("/api/tasks/1/notes");
      expect(res.status).toBe(200);
      expect(getNotesForTask).toHaveBeenCalledWith(expect.anything(), 1);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: 9,
        author: "agent",
        visibility: "siblings",
      });
    });

    it("returns 200 with an empty array when no notes are visible", async () => {
      (getNotesForTask as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/1/notes");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // POST /api/tasks/:id/notes
  describe("POST /api/tasks/:id/notes", () => {
    const created = {
      id: 5,
      task_id: 1,
      author: "user",
      visibility: "self",
      tags: [],
      content: "private",
      created_at: new Date(),
    };

    it("returns 400 for an invalid task id", async () => {
      const res = await request(app)
        .post("/api/tasks/abc/notes")
        .send({ author: "user", visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .send({ visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author.*visibility.*content/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects an invalid author", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .send({ author: "robot", visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects an invalid visibility", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .send({ author: "user", visibility: "everyone", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/visibility/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects tags that are not an array of strings", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .send({
          author: "user",
          visibility: "self",
          content: "x",
          tags: [1, 2, 3],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tags/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 201 with the created note when the body is valid", async () => {
      (createNote as jest.Mock).mockResolvedValue(created);

      const res = await request(app)
        .post("/api/tasks/1/notes")
        .send({
          author: "user",
          visibility: "self",
          content: "private",
          tags: ["a"],
        });

      expect(res.status).toBe(201);
      expect(createNote).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          task_id: 1,
          author: "user",
          visibility: "self",
          content: "private",
          tags: ["a"],
        })
      );
      expect(res.body).toMatchObject({ id: 5, author: "user" });
    });
  });

  // DELETE /api/tasks/:taskId/notes/:noteId
  describe("DELETE /api/tasks/:taskId/notes/:noteId", () => {
    it("returns 400 for an invalid noteId", async () => {
      const res = await request(app)
        .delete("/api/tasks/1/notes/abc");
      expect(res.status).toBe(400);
      expect(deleteNote).not.toHaveBeenCalled();
    });

    it("returns 204 and calls deleteNote with the note id", async () => {
      (deleteNote as jest.Mock).mockResolvedValue(1);

      const res = await request(app)
        .delete("/api/tasks/1/notes/5");
      expect(res.status).toBe(204);
      expect(deleteNote).toHaveBeenCalledWith(expect.anything(), 5);
    });
  });

  // ----------------------------------------------------------------------
  // GET /api/tasks/:id/usage — token usage totals + per-run breakdown.
  // The GUI uses the totals on the task detail page; the per-run rows let a
  // future drill-down show cost-per-attempt without an extra round trip.
  // ----------------------------------------------------------------------
  describe("GET /api/tasks/:id/usage", () => {
    it("returns 400 when id is not numeric", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/usage");
      expect(res.status).toBe(400);
      expect(getUsageTotalsForTask).not.toHaveBeenCalled();
      expect(getUsageRowsForTask).not.toHaveBeenCalled();
    });

    it("returns 200 with totals and runs", async () => {
      const totals = {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1000,
        run_count: 2,
      };
      const runs = [
        {
          id: 1,
          task_id: 1,
          repo_id: 1,
          input_tokens: 50,
          output_tokens: 100,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 500,
          created_at: new Date(),
        },
        {
          id: 2,
          task_id: 1,
          repo_id: 1,
          input_tokens: 50,
          output_tokens: 100,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 500,
          created_at: new Date(),
        },
      ];
      (getUsageTotalsForTask as jest.Mock).mockResolvedValue(totals);
      (getUsageRowsForTask as jest.Mock).mockResolvedValue(runs);

      const res = await request(app)
        .get("/api/tasks/1/usage");

      expect(res.status).toBe(200);
      expect(res.body.totals).toMatchObject(totals);
      expect(res.body.runs).toHaveLength(2);
      expect(getUsageTotalsForTask).toHaveBeenCalledWith(expect.anything(), 1);
      expect(getUsageRowsForTask).toHaveBeenCalledWith(expect.anything(), 1);
    });

    it("returns 200 with zeroed totals and an empty runs array when no usage has been recorded", async () => {
      (getUsageTotalsForTask as jest.Mock).mockResolvedValue({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        run_count: 0,
      });
      (getUsageRowsForTask as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/99/usage");

      expect(res.status).toBe(200);
      expect(res.body.totals.run_count).toBe(0);
      expect(res.body.runs).toEqual([]);
    });

    it("returns 500 when the underlying DB query throws", async () => {
      (getUsageTotalsForTask as jest.Mock).mockRejectedValue(
        new Error("db down")
      );
      (getUsageRowsForTask as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/1/usage");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/db down/);
    });
  });

  // Phase 11: per-task model override on the GUI relies on this endpoint to
  // render the resolved model with a "where it came from" badge.
  describe("GET /api/tasks/:id/effective-model", () => {
    it("returns 400 when id is not numeric", async () => {
      const res = await request(app).get("/api/tasks/abc/effective-model");
      expect(res.status).toBe(400);
      expect(resolveTaskModelWithSource).not.toHaveBeenCalled();
    });

    it("returns 404 when the task does not exist", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app).get("/api/tasks/999/effective-model");
      expect(res.status).toBe(404);
      expect(resolveTaskModelWithSource).not.toHaveBeenCalled();
    });

    it("returns 200 with model + source from the resolver", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (resolveTaskModelWithSource as jest.Mock).mockResolvedValue({
        model: "claude-sonnet-4-6",
        source: "parent",
      });

      const res = await request(app).get("/api/tasks/1/effective-model");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        model: "claude-sonnet-4-6",
        source: "parent",
      });
      expect(resolveTaskModelWithSource).toHaveBeenCalledWith(
        expect.anything(),
        1
      );
    });

    it("returns 500 when the resolver throws", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (resolveTaskModelWithSource as jest.Mock).mockRejectedValue(
        new Error("resolver boom")
      );

      const res = await request(app).get("/api/tasks/1/effective-model");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/resolver boom/);
    });
  });
});
