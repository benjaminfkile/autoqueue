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

// Mock repos DB layer
jest.mock("../src/db/repos");
import {
  getAllRepos,
  getRepoById,
  getRepoByOwnerAndName,
  createRepo,
  updateRepo,
  deleteRepo,
} from "../src/db/repos";

// Allow all requests through protectedRoute by mocking bcrypt.compare
jest.mock("bcrypt", () => ({
  compare: jest.fn().mockResolvedValue(true),
}));

const API_KEY = "test-key";

const mockRepo = {
  id: 1,
  owner: "octocat",
  repo_name: "hello",
  active: true,
  base_branch: "main",
  base_branch_parent: "main",
  require_pr: false,
  github_token: null,
  is_local_folder: false,
  local_path: null,
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

describe("reposRouter", () => {
  describe("POST /api/repos", () => {
    it("accepts base_branch_parent and passes it through to createRepo", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        base_branch_parent: "develop",
      });

      const res = await request(app)
        .post("/api/repos")
        .set("x-api-key", API_KEY)
        .send({
          owner: "octocat",
          repo_name: "hello",
          base_branch_parent: "develop",
        });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ base_branch_parent: "develop" })
      );
      expect(res.body.base_branch_parent).toBe("develop");
    });

    it("creates a repo without base_branch_parent (undefined) so DB default applies", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/repos")
        .set("x-api-key", API_KEY)
        .send({ owner: "octocat", repo_name: "hello" });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ base_branch_parent: undefined })
      );
    });
  });

  describe("PATCH /api/repos/:id", () => {
    it("accepts base_branch_parent and passes it through to updateRepo", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (updateRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        base_branch_parent: "release",
      });

      const res = await request(app)
        .patch("/api/repos/1")
        .set("x-api-key", API_KEY)
        .send({ base_branch_parent: "release" });

      expect(res.status).toBe(200);
      expect(updateRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ base_branch_parent: "release" })
      );
      expect(res.body.base_branch_parent).toBe("release");
    });
  });

  describe("GET /api/repos", () => {
    it("returns repos including base_branch_parent", async () => {
      (getAllRepos as jest.Mock).mockResolvedValue([mockRepo]);

      const res = await request(app)
        .get("/api/repos")
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body[0]).toHaveProperty("base_branch_parent", "main");
    });
  });

  describe("DELETE /api/repos/:id", () => {
    it("returns 204 on successful delete", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (deleteRepo as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/repos/1")
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(204);
    });
  });
});
