import request from "supertest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import app from "../src/app";
import bcrypt from "bcrypt";

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

// Allow all requests through protectedRoute by mocking bcrypt.compare
jest.mock("bcrypt", () => ({
  compare: jest.fn().mockResolvedValue(true),
}));

const API_KEY = "test-key";

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

beforeAll(() => {
  app.set("secrets", {
    NODE_ENV: "development",
    API_KEY_HASH: "$2b$10$fakehash",
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
});

describe("tasksRouter", () => {
  // GET /api/tasks
  describe("GET /api/tasks", () => {
    it("returns 400 when repo_id is missing", async () => {
      const res = await request(app)
        .get("/api/tasks")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/repo_id/);
    });

    it("returns 200 with array when repo_id is provided", async () => {
      (getTasksByRepoId as jest.Mock).mockResolvedValue([mockTask]);
      (getChildTasks as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks?repo_id=1")
        .set("x-api-key", API_KEY);
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
        .set("x-api-key", API_KEY)
        .send({ description: "no repo or title" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/repo_id.*title/);
    });

    it("returns 201 with task and criteria when body is valid", async () => {
      (createTask as jest.Mock).mockResolvedValue(mockTask);
      (createCriterion as jest.Mock).mockResolvedValue(mockCriterion);

      const res = await request(app)
        .post("/api/tasks")
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
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
        .get("/api/tasks/1")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("acceptanceCriteria");
      expect(res.body).toHaveProperty("children");
    });

    it("returns 400 for invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc")
        .set("x-api-key", API_KEY);
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
        .set("x-api-key", API_KEY)
        .send({ title: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Updated");
    });

    it("accepts ordering_mode and passes it through to updateTask", async () => {
      const updated = { ...mockTask, ordering_mode: "parallel" };
      (updateTask as jest.Mock).mockResolvedValue(updated);

      const res = await request(app)
        .patch("/api/tasks/1")
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
        .send({ ordering_mode: "anarchy" });

      expect(res.status).toBe(400);
      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  // DELETE /api/tasks/:id
  describe("DELETE /api/tasks/:id", () => {
    it("returns 204", async () => {
      (deleteTask as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/tasks/1")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(204);
    });
  });

  // GET /api/tasks/:id/criteria
  describe("GET /api/tasks/:id/criteria", () => {
    it("returns 200 with criteria array", async () => {
      (getCriteriaByTaskId as jest.Mock).mockResolvedValue([mockCriterion]);

      const res = await request(app)
        .get("/api/tasks/1/criteria")
        .set("x-api-key", API_KEY);
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
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
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
        .delete("/api/tasks/1/criteria/2")
        .set("x-api-key", API_KEY);
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
        .get("/api/tasks/abc/log")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
    });

    it("returns 404 when the task does not exist", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/tasks/1/log")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("returns 404 when log_path is null on the task", async () => {
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: null,
      });
      const res = await request(app)
        .get("/api/tasks/1/log")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("returns 404 when the log file is missing on disk", async () => {
      const missing = path.join(tmpRoot, "missing.log");
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: missing,
      });
      const res = await request(app)
        .get("/api/tasks/1/log")
        .set("x-api-key", API_KEY);
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
        .get("/api/tasks/1/log")
        .set("x-api-key", API_KEY);
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
        .get("/api/tasks/abc/log/stream")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });

    it("returns 404 when the task does not exist", async () => {
      (getTaskById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/tasks/1/log/stream")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("returns 404 when log_path is null on the task", async () => {
      (getTaskById as jest.Mock).mockResolvedValue({
        ...mockTask,
        log_path: null,
      });
      const res = await request(app)
        .get("/api/tasks/1/log/stream")
        .set("x-api-key", API_KEY);
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
        .get("/api/tasks/1/log/stream")
        .set("x-api-key", API_KEY);

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
        .get("/api/tasks/1/events")
        .set("x-api-key", API_KEY);

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
        .get("/api/tasks/abc/events")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
      expect(getEventsByTaskId).not.toHaveBeenCalled();
    });

    it("returns 200 with an empty array when the task has no events", async () => {
      (getEventsByTaskId as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/tasks/1/events")
        .set("x-api-key", API_KEY);
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

    it("requires the API key (returns 401 when unauthorized)", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      const res = await request(app)
        .get("/api/tasks/1/notes")
        .set("x-api-key", "wrong-key");
      expect(res.status).toBe(401);
      expect(getNotesForTask).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get("/api/tasks/abc/notes")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid id/i);
      expect(getNotesForTask).not.toHaveBeenCalled();
    });

    it("returns 200 with the visible-notes array from getNotesForTask", async () => {
      (getNotesForTask as jest.Mock).mockResolvedValue([noteRow]);

      const res = await request(app)
        .get("/api/tasks/1/notes")
        .set("x-api-key", API_KEY);
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
        .get("/api/tasks/1/notes")
        .set("x-api-key", API_KEY);
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

    it("requires the API key (returns 401 when unauthorized)", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .set("x-api-key", "wrong-key")
        .send({ author: "user", visibility: "self", content: "x" });
      expect(res.status).toBe(401);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid task id", async () => {
      const res = await request(app)
        .post("/api/tasks/abc/notes")
        .set("x-api-key", API_KEY)
        .send({ author: "user", visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .set("x-api-key", API_KEY)
        .send({ visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author.*visibility.*content/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects an invalid author", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .set("x-api-key", API_KEY)
        .send({ author: "robot", visibility: "self", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects an invalid visibility", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .set("x-api-key", API_KEY)
        .send({ author: "user", visibility: "everyone", content: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/visibility/i);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("rejects tags that are not an array of strings", async () => {
      const res = await request(app)
        .post("/api/tasks/1/notes")
        .set("x-api-key", API_KEY)
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
        .set("x-api-key", API_KEY)
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
    it("requires the API key (returns 401 when unauthorized)", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      const res = await request(app)
        .delete("/api/tasks/1/notes/5")
        .set("x-api-key", "wrong-key");
      expect(res.status).toBe(401);
      expect(deleteNote).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid noteId", async () => {
      const res = await request(app)
        .delete("/api/tasks/1/notes/abc")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
      expect(deleteNote).not.toHaveBeenCalled();
    });

    it("returns 204 and calls deleteNote with the note id", async () => {
      (deleteNote as jest.Mock).mockResolvedValue(1);

      const res = await request(app)
        .delete("/api/tasks/1/notes/5")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(204);
      expect(deleteNote).toHaveBeenCalledWith(expect.anything(), 5);
    });
  });
});
