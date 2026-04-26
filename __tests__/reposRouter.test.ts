import request from "supertest";
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

// Mock the task-tree materializer service so the route tests stay focused on
// HTTP plumbing — the materializer's atomicity contract is unit-tested
// separately.
jest.mock("../src/services/taskTreeMaterializer");
import { materializeTaskTree } from "../src/services/taskTreeMaterializer";

// Mock the task-usage DB layer so /api/repos/:id/usage tests stay focused on
// HTTP plumbing — the SQL aggregation is unit-tested in taskUsage.test.ts.
jest.mock("../src/db/taskUsage");
import { getUsageTotalsForRepo } from "../src/db/taskUsage";

// Mock the webhooks DB layer so /api/repos/:id/webhooks tests stay focused on
// HTTP plumbing — the persistence contract is unit-tested in repoWebhooks.test.ts.
jest.mock("../src/db/repoWebhooks");
import {
  createWebhook,
  deleteWebhook,
  getWebhookById,
  getWebhooksByRepoId,
  updateWebhook,
} from "../src/db/repoWebhooks";

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

beforeEach(() => {
  jest.clearAllMocks();
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
        .send({ owner: "octocat", repo_name: "hello" });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ base_branch_parent: undefined })
      );
    });

    it("accepts on_failure, max_retries, on_parent_child_fail and passes them through", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        on_failure: "retry",
        max_retries: 5,
        on_parent_child_fail: "cascade_fail",
      });

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          on_failure: "retry",
          max_retries: 5,
          on_parent_child_fail: "cascade_fail",
        });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          on_failure: "retry",
          max_retries: 5,
          on_parent_child_fail: "cascade_fail",
        })
      );
      expect(res.body.on_failure).toBe("retry");
      expect(res.body.max_retries).toBe(5);
      expect(res.body.on_parent_child_fail).toBe("cascade_fail");
    });

    it("creates a repo without failure policy fields (undefined) so DB defaults apply", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/repos")
        .send({ owner: "octocat", repo_name: "hello" });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          on_failure: undefined,
          max_retries: undefined,
          on_parent_child_fail: undefined,
        })
      );
    });

    it("rejects an invalid on_failure value", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          on_failure: "explode",
        });

      expect(res.status).toBe(400);
      expect(createRepo).not.toHaveBeenCalled();
    });

    it("rejects an invalid on_parent_child_fail value", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          on_parent_child_fail: "ignite",
        });

      expect(res.status).toBe(400);
      expect(createRepo).not.toHaveBeenCalled();
    });

    it("rejects a negative max_retries", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          max_retries: -1,
        });

      expect(res.status).toBe(400);
      expect(createRepo).not.toHaveBeenCalled();
    });

    it("accepts ordering_mode and passes it through to createRepo", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        ordering_mode: "parallel",
      });

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          ordering_mode: "parallel",
        });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ordering_mode: "parallel" })
      );
      expect(res.body.ordering_mode).toBe("parallel");
    });

    it("creates a repo without ordering_mode (undefined) so DB default 'sequential' applies", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);
      (createRepo as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/repos")
        .send({ owner: "octocat", repo_name: "hello" });

      expect(res.status).toBe(201);
      expect(createRepo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ordering_mode: undefined })
      );
      expect(res.body.ordering_mode).toBe("sequential");
    });

    it("rejects an invalid ordering_mode value", async () => {
      (getRepoByOwnerAndName as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/repos")
        .send({
          owner: "octocat",
          repo_name: "hello",
          ordering_mode: "chaotic",
        });

      expect(res.status).toBe(400);
      expect(createRepo).not.toHaveBeenCalled();
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
        .send({ base_branch_parent: "release" });

      expect(res.status).toBe(200);
      expect(updateRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ base_branch_parent: "release" })
      );
      expect(res.body.base_branch_parent).toBe("release");
    });

    it("accepts on_failure, max_retries, on_parent_child_fail and passes them through", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (updateRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        on_failure: "halt_subtree",
        max_retries: 7,
        on_parent_child_fail: "ignore",
      });

      const res = await request(app)
        .patch("/api/repos/1")
        .send({
          on_failure: "halt_subtree",
          max_retries: 7,
          on_parent_child_fail: "ignore",
        });

      expect(res.status).toBe(200);
      expect(updateRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({
          on_failure: "halt_subtree",
          max_retries: 7,
          on_parent_child_fail: "ignore",
        })
      );
      expect(res.body.on_failure).toBe("halt_subtree");
      expect(res.body.max_retries).toBe(7);
      expect(res.body.on_parent_child_fail).toBe("ignore");
    });

    it("rejects an invalid on_failure value", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .patch("/api/repos/1")
        .send({ on_failure: "nuke" });

      expect(res.status).toBe(400);
      expect(updateRepo).not.toHaveBeenCalled();
    });

    it("rejects an invalid on_parent_child_fail value", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .patch("/api/repos/1")
        .send({ on_parent_child_fail: "blowup" });

      expect(res.status).toBe(400);
      expect(updateRepo).not.toHaveBeenCalled();
    });

    it("rejects a non-integer max_retries", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .patch("/api/repos/1")
        .send({ max_retries: 1.5 });

      expect(res.status).toBe(400);
      expect(updateRepo).not.toHaveBeenCalled();
    });

    it("accepts ordering_mode and passes it through to updateRepo", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (updateRepo as jest.Mock).mockResolvedValue({
        ...mockRepo,
        ordering_mode: "parallel",
      });

      const res = await request(app)
        .patch("/api/repos/1")
        .send({ ordering_mode: "parallel" });

      expect(res.status).toBe(200);
      expect(updateRepo).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.objectContaining({ ordering_mode: "parallel" })
      );
      expect(res.body.ordering_mode).toBe("parallel");
    });

    it("rejects an invalid ordering_mode value", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .patch("/api/repos/1")
        .send({ ordering_mode: "anarchy" });

      expect(res.status).toBe(400);
      expect(updateRepo).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/repos", () => {
    it("returns repos including base_branch_parent", async () => {
      (getAllRepos as jest.Mock).mockResolvedValue([mockRepo]);

      const res = await request(app)
        .get("/api/repos");

      expect(res.status).toBe(200);
      expect(res.body[0]).toHaveProperty("base_branch_parent", "main");
    });
  });

  describe("DELETE /api/repos/:id", () => {
    it("returns 204 on successful delete", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (deleteRepo as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/repos/1");

      expect(res.status).toBe(204);
    });
  });

  describe("POST /api/repos/:id/materialize-tree", () => {
    const validProposal = {
      parents: [
        {
          title: "Phase 1",
          description: "Foundation",
          acceptance_criteria: ["repo bootstrapped"],
          children: [{ title: "Schema" }],
        },
      ],
    };

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .post("/api/repos/abc/materialize-tree")
        .send(validProposal);
      expect(res.status).toBe(400);
      expect(materializeTaskTree).not.toHaveBeenCalled();
    });

    it("returns 404 when the repo does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .post("/api/repos/1/materialize-tree")
        .send(validProposal);
      expect(res.status).toBe(404);
      expect(materializeTaskTree).not.toHaveBeenCalled();
    });

    it("returns 400 when the proposal body fails validation", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/repos/1/materialize-tree")
        .send({ parents: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/parents/);
      expect(materializeTaskTree).not.toHaveBeenCalled();
    });

    it("rejects nodes missing a title with 400", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);

      const res = await request(app)
        .post("/api/repos/1/materialize-tree")
        .send({ parents: [{}] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/title/);
      expect(materializeTaskTree).not.toHaveBeenCalled();
    });

    it("creates the tree atomically and returns ids the GUI can navigate to", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const materialized = {
        parents: [
          {
            id: 100,
            title: "Phase 1",
            parent_id: null,
            order_position: 0,
            acceptance_criteria_ids: [500],
            children: [
              {
                id: 101,
                title: "Schema",
                parent_id: 100,
                order_position: 0,
                acceptance_criteria_ids: [],
                children: [],
              },
            ],
          },
        ],
      };
      (materializeTaskTree as jest.Mock).mockResolvedValue(materialized);

      const res = await request(app)
        .post("/api/repos/1/materialize-tree")
        .send(validProposal);

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
      // Returned ids let the GUI deep-link to the created tasks.
      expect(res.body.parents[0].id).toBe(100);
      expect(res.body.parents[0].children[0].id).toBe(101);
      expect(res.body.parents[0].acceptance_criteria_ids).toEqual([500]);
    });

    it("returns 500 when the materializer rejects (e.g. transaction rolled back)", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (materializeTaskTree as jest.Mock).mockRejectedValue(
        new Error("rolled back")
      );

      const res = await request(app)
        .post("/api/repos/1/materialize-tree")
        .send(validProposal);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/rolled back/);
    });
  });

  // --------------------------------------------------------------------
  // GET /api/repos/:id/usage — aggregated token usage across every task
  // in the repo. Used by the GUI repos table to surface per-repo spend.
  // --------------------------------------------------------------------
  describe("GET /api/repos/:id/usage", () => {
    it("returns 400 when id is not numeric", async () => {
      const res = await request(app)
        .get("/api/repos/abc/usage");
      expect(res.status).toBe(400);
      expect(getUsageTotalsForRepo).not.toHaveBeenCalled();
    });

    it("returns 404 when the repo does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .get("/api/repos/42/usage");

      expect(res.status).toBe(404);
      expect(getUsageTotalsForRepo).not.toHaveBeenCalled();
    });

    it("returns 200 with totals scoped to the requested repo_id", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getUsageTotalsForRepo as jest.Mock).mockResolvedValue({
        input_tokens: 1000,
        output_tokens: 2000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 5000,
        run_count: 10,
      });

      const res = await request(app)
        .get("/api/repos/1/usage");

      expect(res.status).toBe(200);
      expect(res.body.totals).toMatchObject({
        input_tokens: 1000,
        output_tokens: 2000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 5000,
        run_count: 10,
      });
      expect(getUsageTotalsForRepo).toHaveBeenCalledWith(expect.anything(), 1);
    });

    it("returns 200 with zeroed totals when no usage has been recorded for the repo yet", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getUsageTotalsForRepo as jest.Mock).mockResolvedValue({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        run_count: 0,
      });

      const res = await request(app)
        .get("/api/repos/1/usage");

      expect(res.status).toBe(200);
      expect(res.body.totals.run_count).toBe(0);
    });
  });

  // --------------------------------------------------------------------
  // /api/repos/:id/webhooks — per-repo Slack-compatible webhooks. The DB
  // layer is mocked; these tests pin the HTTP contract: validation,
  // 404/400 paths, and pass-through to the DB helpers.
  // --------------------------------------------------------------------
  describe("GET /api/repos/:id/webhooks", () => {
    it("returns 400 when id is not numeric", async () => {
      const res = await request(app)
        .get("/api/repos/abc/webhooks");
      expect(res.status).toBe(400);
      expect(getWebhooksByRepoId).not.toHaveBeenCalled();
    });

    it("returns 404 when the repo does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .get("/api/repos/1/webhooks");
      expect(res.status).toBe(404);
      expect(getWebhooksByRepoId).not.toHaveBeenCalled();
    });

    it("returns 200 with the webhooks scoped to the repo", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const rows = [
        {
          id: 1,
          repo_id: 1,
          url: "https://hooks.slack.com/services/X",
          events: ["done"],
          active: true,
          created_at: new Date(),
        },
      ];
      (getWebhooksByRepoId as jest.Mock).mockResolvedValue(rows);

      const res = await request(app)
        .get("/api/repos/1/webhooks");

      expect(res.status).toBe(200);
      expect(getWebhooksByRepoId).toHaveBeenCalledWith(expect.anything(), 1);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: 1,
        url: "https://hooks.slack.com/services/X",
      });
    });
  });

  describe("POST /api/repos/:id/webhooks", () => {
    const validBody = {
      url: "https://hooks.slack.com/services/X/Y/Z",
      events: ["done", "halted"],
    };

    it("returns 400 when id is not numeric", async () => {
      const res = await request(app)
        .post("/api/repos/abc/webhooks")
        .send(validBody);
      expect(res.status).toBe(400);
      expect(createWebhook).not.toHaveBeenCalled();
    });

    it("returns 404 when the repo does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send(validBody);
      expect(res.status).toBe(404);
      expect(createWebhook).not.toHaveBeenCalled();
    });

    it("rejects a non-http(s) URL with 400 (so misconfigured callers fail loudly)", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send({ url: "ftp://wrong/", events: ["done"] });
      expect(res.status).toBe(400);
      expect(createWebhook).not.toHaveBeenCalled();
    });

    it("rejects a missing url with 400", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send({ events: ["done"] });
      expect(res.status).toBe(400);
    });

    it("rejects an empty events array with 400 (subscribing to nothing is meaningless)", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send({ url: validBody.url, events: [] });
      expect(res.status).toBe(400);
    });

    it("rejects an unknown event name with 400", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send({ url: validBody.url, events: ["done", "exploded"] });
      expect(res.status).toBe(400);
    });

    it("rejects a non-boolean active with 400", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send({ ...validBody, active: "yes" });
      expect(res.status).toBe(400);
    });

    it("creates the webhook and returns 201 with the inserted row", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      const inserted = {
        id: 9,
        repo_id: 1,
        url: validBody.url,
        events: ["done", "halted"],
        active: true,
        created_at: new Date(),
      };
      (createWebhook as jest.Mock).mockResolvedValue(inserted);

      const res = await request(app)
        .post("/api/repos/1/webhooks")
        .send(validBody);

      expect(res.status).toBe(201);
      expect(createWebhook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          repo_id: 1,
          url: validBody.url,
          events: ["done", "halted"],
        })
      );
      expect(res.body).toMatchObject({ id: 9, url: validBody.url });
    });

    it("deduplicates repeated events on the way to the DB layer", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (createWebhook as jest.Mock).mockResolvedValue({ id: 1 });

      await request(app)
        .post("/api/repos/1/webhooks")
        .send({ url: validBody.url, events: ["done", "done", "failed"] });

      expect(createWebhook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ events: ["done", "failed"] })
      );
    });
  });

  describe("PATCH /api/repos/:id/webhooks/:webhookId", () => {
    it("returns 404 when the webhook does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .patch("/api/repos/1/webhooks/99")
        .send({ active: false });
      expect(res.status).toBe(404);
      expect(updateWebhook).not.toHaveBeenCalled();
    });

    it("returns 404 when the webhook belongs to a different repo (cross-tenant safety)", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 999,
        url: "https://x/",
        events: ["done"],
        active: true,
      });

      const res = await request(app)
        .patch("/api/repos/1/webhooks/9")
        .send({ active: false });
      expect(res.status).toBe(404);
      expect(updateWebhook).not.toHaveBeenCalled();
    });

    it("rejects an invalid url with 400 even when other fields are valid", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 1,
        url: "https://x/",
        events: ["done"],
        active: true,
      });

      const res = await request(app)
        .patch("/api/repos/1/webhooks/9")
        .send({ url: "not-a-url" });
      expect(res.status).toBe(400);
      expect(updateWebhook).not.toHaveBeenCalled();
    });

    it("patches only the supplied fields and returns the updated row", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 1,
        url: "https://old/",
        events: ["done"],
        active: true,
      });
      (updateWebhook as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 1,
        url: "https://old/",
        events: ["done", "halted"],
        active: false,
        created_at: new Date(),
      });

      const res = await request(app)
        .patch("/api/repos/1/webhooks/9")
        .send({ events: ["done", "halted"], active: false });

      expect(res.status).toBe(200);
      expect(updateWebhook).toHaveBeenCalledWith(
        expect.anything(),
        9,
        expect.objectContaining({ events: ["done", "halted"], active: false })
      );
      // url was NOT in the patch body, so the DB helper should not see it.
      expect(updateWebhook).toHaveBeenCalledWith(
        expect.anything(),
        9,
        expect.not.objectContaining({ url: expect.anything() })
      );
    });
  });

  describe("DELETE /api/repos/:id/webhooks/:webhookId", () => {
    it("returns 404 when the webhook does not exist", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app)
        .delete("/api/repos/1/webhooks/9");
      expect(res.status).toBe(404);
      expect(deleteWebhook).not.toHaveBeenCalled();
    });

    it("returns 404 when the webhook belongs to a different repo", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 555,
        url: "https://x/",
        events: ["done"],
        active: true,
      });

      const res = await request(app)
        .delete("/api/repos/1/webhooks/9");
      expect(res.status).toBe(404);
      expect(deleteWebhook).not.toHaveBeenCalled();
    });

    it("returns 204 on successful delete", async () => {
      (getRepoById as jest.Mock).mockResolvedValue(mockRepo);
      (getWebhookById as jest.Mock).mockResolvedValue({
        id: 9,
        repo_id: 1,
        url: "https://x/",
        events: ["done"],
        active: true,
      });
      (deleteWebhook as jest.Mock).mockResolvedValue(1);

      const res = await request(app)
        .delete("/api/repos/1/webhooks/9");

      expect(res.status).toBe(204);
      expect(deleteWebhook).toHaveBeenCalledWith(expect.anything(), 9);
    });
  });
});
