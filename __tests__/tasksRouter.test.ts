import request from "supertest";
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
});
