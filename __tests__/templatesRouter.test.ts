import request from "supertest";
import bcrypt from "bcrypt";

jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock("../src/db/health", () => ({
  __esModule: true,
  default: {
    getDBConnectionHealth: jest.fn().mockResolvedValue({
      connected: true,
      connectionUsesProxy: false,
    }),
  },
}));

jest.mock("../src/db/repos");
import { getRepoById } from "../src/db/repos";

jest.mock("../src/db/taskTemplates");
import {
  createTemplate,
  deleteTemplate,
  getAllTemplates,
  getTemplateById,
} from "../src/db/taskTemplates";

jest.mock("../src/services/taskTemplateBuilder");
import { buildTemplateFromRepo } from "../src/services/taskTemplateBuilder";

jest.mock("../src/services/taskTreeMaterializer");
import { materializeTaskTree } from "../src/services/taskTreeMaterializer";

jest.mock("bcrypt", () => ({
  compare: jest.fn().mockResolvedValue(true),
}));

import app from "../src/app";

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
  on_failure: "halt_repo",
  max_retries: 3,
  on_parent_child_fail: "mark_partial",
  ordering_mode: "sequential",
  created_at: new Date(),
};

const mockTemplate = {
  id: 10,
  name: "Bug fix",
  description: "Standard bug fix layout",
  tree: {
    parents: [
      {
        title: "Reproduce",
        acceptance_criteria: ["repro steps documented"],
        children: [{ title: "Write failing test" }],
      },
    ],
  },
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

describe("templatesRouter", () => {
  describe("GET /api/templates", () => {
    it("returns 200 and the list of templates", async () => {
      (getAllTemplates as jest.Mock).mockResolvedValue([mockTemplate]);

      const res = await request(app)
        .get("/api/templates")
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: 10, name: "Bug fix" });
    });

    it("returns 401 without a valid API key", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      const res = await request(app)
        .get("/api/templates")
        .set("x-api-key", "wrong");
      expect(res.status).toBe(401);
      expect(getAllTemplates).not.toHaveBeenCalled();
    });

    it("returns 500 when the DB layer throws", async () => {
      (getAllTemplates as jest.Mock).mockRejectedValue(new Error("db down"));
      const res = await request(app)
        .get("/api/templates")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/db down/);
    });
  });

  describe("POST /api/templates (with `tree` body)", () => {
    const validTree = {
      parents: [
        {
          title: "Phase 1",
          description: "Foundation",
          acceptance_criteria: ["repo bootstrapped"],
          children: [{ title: "Schema" }],
        },
      ],
    };

    it("validates the tree, persists it, and returns the new template", async () => {
      (createTemplate as jest.Mock).mockResolvedValue({
        ...mockTemplate,
        tree: validTree,
      });

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "My template", description: "desc", tree: validTree });

      expect(res.status).toBe(201);
      expect(createTemplate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "My template",
          description: "desc",
          tree: expect.objectContaining({
            parents: expect.arrayContaining([
              expect.objectContaining({ title: "Phase 1" }),
            ]),
          }),
        })
      );
      expect(res.body.id).toBe(10);
    });

    it("rejects when name is missing", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ tree: validTree });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/);
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("rejects when name is empty/whitespace-only", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "   ", tree: validTree });
      expect(res.status).toBe(400);
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("rejects when neither tree nor repo_id is supplied", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tree.*repo_id|repo_id.*tree/);
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("rejects when both tree AND repo_id are supplied (ambiguous source)", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", tree: validTree, repo_id: 1 });
      expect(res.status).toBe(400);
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("returns 400 when the supplied tree fails proposal validation", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", tree: { parents: [] } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/parents/);
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("returns 400 when a node in the tree is missing a title", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", tree: { parents: [{}] } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/title/);
      expect(createTemplate).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/templates (with `repo_id` body — capture from existing tree, AC #801)", () => {
    const builtTree = {
      parents: [
        {
          title: "Captured",
          acceptance_criteria: ["did the thing"],
        },
      ],
    };

    it("loads the repo, builds a tree from its tasks, and persists it", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (buildTemplateFromRepo as jest.Mock).mockResolvedValue(builtTree);
      (createTemplate as jest.Mock).mockResolvedValue({
        ...mockTemplate,
        tree: builtTree,
      });

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "From repo", repo_id: 1 });

      expect(res.status).toBe(201);
      expect(buildTemplateFromRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        undefined
      );
      expect(createTemplate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "From repo", tree: builtTree })
      );
    });

    it("forwards root_task_ids to the builder so the GUI can pick which roots to capture", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (buildTemplateFromRepo as jest.Mock).mockResolvedValue(builtTree);
      (createTemplate as jest.Mock).mockResolvedValue(mockTemplate);

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "Subset", repo_id: 1, root_task_ids: [42, 99] });

      expect(res.status).toBe(201);
      expect(buildTemplateFromRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        [42, 99]
      );
    });

    it("returns 404 when the repo does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", repo_id: 999 });

      expect(res.status).toBe(404);
      expect(buildTemplateFromRepo).not.toHaveBeenCalled();
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it("returns 400 when repo_id is not an integer", async () => {
      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", repo_id: "not-a-number" });
      expect(res.status).toBe(400);
      expect(buildTemplateFromRepo).not.toHaveBeenCalled();
    });

    it("returns 400 when root_task_ids is not an array of integers", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", repo_id: 1, root_task_ids: ["a", "b"] });
      expect(res.status).toBe(400);
      expect(buildTemplateFromRepo).not.toHaveBeenCalled();
    });

    it("surfaces the builder's error as a 400 (e.g. unknown root task id, empty repo)", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (buildTemplateFromRepo as jest.Mock).mockRejectedValue(
        new Error("Task 99 is not a top-level task in repo 1")
      );

      const res = await request(app)
        .post("/api/templates")
        .set("x-api-key", API_KEY)
        .send({ name: "x", repo_id: 1, root_task_ids: [99] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a top-level task/);
      expect(createTemplate).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/templates/:id", () => {
    it("returns the template when it exists", async () => {
      (getTemplateById as jest.Mock).mockResolvedValue(mockTemplate);

      const res = await request(app)
        .get("/api/templates/10")
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(10);
    });

    it("returns 400 for a non-numeric id", async () => {
      const res = await request(app)
        .get("/api/templates/abc")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });

    it("returns 404 when no template matches", async () => {
      (getTemplateById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/templates/999")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/templates/:id", () => {
    it("returns 204 on successful delete", async () => {
      (getTemplateById as jest.Mock).mockResolvedValue(mockTemplate);
      (deleteTemplate as jest.Mock).mockResolvedValue(1);

      const res = await request(app)
        .delete("/api/templates/10")
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(204);
      expect(deleteTemplate).toHaveBeenCalledWith(expect.anything(), 10);
    });

    it("returns 404 when the template doesn't exist", async () => {
      (getTemplateById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .delete("/api/templates/999")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(404);
      expect(deleteTemplate).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/repos/:id/instantiate-template/:templateId
//
// AC #802: instantiating creates a fresh tree from the template. The repos
// router owns the route (instantiation is a write to the repo, not the
// template); this block lives in the templates test file so the
// save-and-reuse contract is exercised end-to-end in one place.
// ---------------------------------------------------------------------------
describe("POST /api/repos/:id/instantiate-template/:templateId (AC #802)", () => {
  const stored = {
    ...mockTemplate,
    tree: {
      parents: [
        {
          title: "Phase 1",
          acceptance_criteria: ["bootstrapped"],
          children: [{ title: "Schema" }, { title: "Routes" }],
        },
      ],
    },
  };

  it("loads the template, materializes its tree under the target repo, and returns the new ids", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
    (getTemplateById as jest.Mock).mockResolvedValue(stored);
    const materialized = {
      parents: [
        {
          id: 200,
          title: "Phase 1",
          parent_id: null,
          order_position: 0,
          acceptance_criteria_ids: [900],
          children: [
            {
              id: 201,
              title: "Schema",
              parent_id: 200,
              order_position: 0,
              acceptance_criteria_ids: [],
              children: [],
            },
            {
              id: 202,
              title: "Routes",
              parent_id: 200,
              order_position: 1,
              acceptance_criteria_ids: [],
              children: [],
            },
          ],
        },
      ],
    };
    (materializeTaskTree as jest.Mock).mockResolvedValue(materialized);

    const res = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(201);
    expect(materializeTaskTree).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.objectContaining({
        parents: expect.arrayContaining([
          expect.objectContaining({ title: "Phase 1" }),
        ]),
      })
    );
    // The response must surface the freshly-created ids so the GUI can
    // navigate to them — same contract as POST /materialize-tree.
    expect(res.body.parents[0].id).toBe(200);
    expect(res.body.parents[0].children[0].id).toBe(201);
    expect(res.body.parents[0].children[1].id).toBe(202);
    expect(res.body.parents[0].acceptance_criteria_ids).toEqual([900]);
  });

  it("a brand-new instantiation does not depend on prior instantiations — each call materializes independently (fresh tree)", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
    (getTemplateById as jest.Mock).mockResolvedValue(stored);

    let nextId = 1000;
    (materializeTaskTree as jest.Mock).mockImplementation(async (_db, _repoId, proposal) => {
      const assign = (nodes: any[]): any[] =>
        nodes.map((n) => ({
          id: nextId++,
          title: n.title,
          parent_id: null,
          order_position: 0,
          acceptance_criteria_ids: [],
          children: assign(n.children ?? []),
        }));
      return { parents: assign(proposal.parents) };
    });

    const a = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", API_KEY);
    const b = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", API_KEY);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Two materializations → distinct id sets, proving each call produced a
    // fresh tree rather than reusing rows from the prior call.
    expect(a.body.parents[0].id).not.toBe(b.body.parents[0].id);
    expect(materializeTaskTree).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for a non-numeric repo id", async () => {
    const res = await request(app)
      .post("/api/repos/abc/instantiate-template/10")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric template id", async () => {
    const res = await request(app)
      .post("/api/repos/1/instantiate-template/abc")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });

  it("returns 404 when the repo does not exist", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(undefined);
    (getTemplateById as jest.Mock).mockResolvedValue(stored);

    const res = await request(app)
      .post("/api/repos/999/instantiate-template/10")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });

  it("returns 404 when the template does not exist", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
    (getTemplateById as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/repos/1/instantiate-template/999")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });

  it("returns 400 when the stored template tree fails validation (corrupt template surfaces clearly)", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
    (getTemplateById as jest.Mock).mockResolvedValue({
      ...stored,
      tree: { parents: [] },
    });

    const res = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Stored template is invalid/);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });

  it("returns 500 when the materializer rolls back mid-insert", async () => {
    (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
    (getTemplateById as jest.Mock).mockResolvedValue(stored);
    (materializeTaskTree as jest.Mock).mockRejectedValue(
      new Error("rolled back")
    );

    const res = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/rolled back/);
  });

  it("returns 401 without a valid API key", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
    const res = await request(app)
      .post("/api/repos/1/instantiate-template/10")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
    expect(materializeTaskTree).not.toHaveBeenCalled();
  });
});
