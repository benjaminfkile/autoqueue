import express, { Request, Response } from "express";
import * as fs from "fs";
import { getDb } from "../db/db";
import {
  createRepo,
  deleteRepo,
  getAllRepos,
  getRepoByOwnerAndName,
  getRepoById,
  updateRepo,
} from "../db/repos";
import {
  OrderingMode,
  RepoOnFailure,
  RepoOnParentChildFail,
  WebhookEvent,
} from "../interfaces";
import { validateTaskTreeProposal } from "../services/chatService";
import { materializeTaskTree } from "../services/taskTreeMaterializer";
import { cloneRepoFresh } from "../services/git";
import { getTemplateById } from "../db/taskTemplates";
import { getUsageTotalsForRepo } from "../db/taskUsage";
import {
  createWebhook,
  deleteWebhook,
  getWebhookById,
  getWebhooksByRepoId,
  updateWebhook,
} from "../db/repoWebhooks";

const VALID_ON_FAILURE: RepoOnFailure[] = [
  "halt_repo",
  "halt_subtree",
  "retry",
  "continue",
];
const VALID_ON_PARENT_CHILD_FAIL: RepoOnParentChildFail[] = [
  "cascade_fail",
  "mark_partial",
  "ignore",
];
const VALID_ORDERING_MODE: OrderingMode[] = ["sequential", "parallel"];
const VALID_WEBHOOK_EVENTS: WebhookEvent[] = ["done", "failed", "halted"];

function validateWebhookEvents(input: unknown): WebhookEvent[] | string {
  if (!Array.isArray(input) || input.length === 0) {
    return "events must be a non-empty array";
  }
  const seen = new Set<string>();
  const out: WebhookEvent[] = [];
  for (const e of input) {
    if (typeof e !== "string" || !VALID_WEBHOOK_EVENTS.includes(e as WebhookEvent)) {
      return `Invalid webhook event: ${String(e)}`;
    }
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e as WebhookEvent);
    }
  }
  return out;
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const reposRouter = express.Router();

// GET /api/repos — return all repos
reposRouter.get("/", async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const repos = await getAllRepos(db);
    return res.status(200).json(repos);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos — create a repo
reposRouter.post("/", async (req: Request, res: Response) => {
  try {
    const db = getDb();

    const {
      owner,
      repo_name,
      active,
      base_branch,
      base_branch_parent,
      require_pr,
      github_token,
      is_local_folder,
      local_path,
      on_failure,
      max_retries,
      on_parent_child_fail,
      ordering_mode,
    } = req.body as {
      owner?: string;
      repo_name?: string;
      active?: boolean;
      base_branch?: string;
      base_branch_parent?: string;
      require_pr?: boolean;
      github_token?: string | null;
      is_local_folder?: boolean;
      local_path?: string | null;
      on_failure?: RepoOnFailure;
      max_retries?: number;
      on_parent_child_fail?: RepoOnParentChildFail;
      ordering_mode?: OrderingMode;
    };

    if (!is_local_folder && (!owner || !repo_name)) {
      return res.status(400).json({ error: "owner and repo_name are required" });
    }

    if (on_failure !== undefined && !VALID_ON_FAILURE.includes(on_failure)) {
      return res.status(400).json({ error: "Invalid on_failure" });
    }
    if (
      on_parent_child_fail !== undefined &&
      !VALID_ON_PARENT_CHILD_FAIL.includes(on_parent_child_fail)
    ) {
      return res.status(400).json({ error: "Invalid on_parent_child_fail" });
    }
    if (
      max_retries !== undefined &&
      (!Number.isInteger(max_retries) || max_retries < 0)
    ) {
      return res
        .status(400)
        .json({ error: "max_retries must be a non-negative integer" });
    }
    if (
      ordering_mode !== undefined &&
      !VALID_ORDERING_MODE.includes(ordering_mode)
    ) {
      return res.status(400).json({ error: "Invalid ordering_mode" });
    }

    if (!is_local_folder) {
      const existing = await getRepoByOwnerAndName(db, owner as string, repo_name as string);
      if (existing) {
        return res.status(409).json({ error: "Repo already exists" });
      }
    }

    const isActive = active !== false;

    // For git-backed repos, clone first so the row only ever exists when the
    // working tree is on disk. A failed clone returns 422 with the git error
    // and inserts nothing; a successful clone followed by a failed insert
    // removes the cloned directory so we don't leak an orphaned tree.
    let cloned = false;
    let clonedDir: string | null = null;
    if (!is_local_folder) {
      const reposPath = process.env.REPOS_PATH ?? "";
      if (!reposPath) {
        return res
          .status(500)
          .json({ error: "REPOS_PATH is not configured on the server" });
      }
      try {
        clonedDir = await cloneRepoFresh(
          reposPath,
          owner as string,
          repo_name as string
        );
        cloned = true;
      } catch (cloneErr) {
        return res.status(422).json({
          error: `Failed to clone ${owner}/${repo_name}: ${(cloneErr as Error).message}`,
        });
      }
    }

    try {
      const repo = await createRepo(db, {
        owner,
        repo_name,
        active: isActive,
        base_branch,
        base_branch_parent,
        require_pr,
        github_token,
        is_local_folder,
        local_path,
        on_failure,
        max_retries,
        on_parent_child_fail,
        ordering_mode,
        clone_status: cloned ? "ready" : undefined,
      });

      return res.status(201).json(repo);
    } catch (insertErr) {
      if (cloned && clonedDir) {
        try {
          fs.rmSync(clonedDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup; the insert failure is what we surface
        }
      }
      return res.status(500).json({ error: (insertErr as Error).message });
    }
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/repos/:id — update a repo
reposRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const data = req.body as Partial<{
      active: boolean;
      owner: string;
      repo_name: string;
      base_branch: string;
      base_branch_parent: string;
      require_pr: boolean;
      github_token: string | null;
      is_local_folder: boolean;
      local_path: string | null;
      on_failure: RepoOnFailure;
      max_retries: number;
      on_parent_child_fail: RepoOnParentChildFail;
      ordering_mode: OrderingMode;
    }>;

    if (
      data.on_failure !== undefined &&
      !VALID_ON_FAILURE.includes(data.on_failure)
    ) {
      return res.status(400).json({ error: "Invalid on_failure" });
    }
    if (
      data.on_parent_child_fail !== undefined &&
      !VALID_ON_PARENT_CHILD_FAIL.includes(data.on_parent_child_fail)
    ) {
      return res.status(400).json({ error: "Invalid on_parent_child_fail" });
    }
    if (
      data.max_retries !== undefined &&
      (!Number.isInteger(data.max_retries) || data.max_retries < 0)
    ) {
      return res
        .status(400)
        .json({ error: "max_retries must be a non-negative integer" });
    }
    if (
      data.ordering_mode !== undefined &&
      !VALID_ORDERING_MODE.includes(data.ordering_mode)
    ) {
      return res.status(400).json({ error: "Invalid ordering_mode" });
    }

    const updated = await updateRepo(db, id, data);

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos/:id/advance — manually kick the queue for a repo (stub — queue logic pending)
reposRouter.post("/:id/advance", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos/:id/materialize-tree — atomically create a proposed task
// tree (parents → children → acceptance criteria) under this repo.
reposRouter.post("/:id/materialize-tree", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const validation = validateTaskTreeProposal(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const result = await materializeTaskTree(db, id, validation.proposal);
    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos/:id/instantiate-template/:templateId — replay a saved
// template into this repo as a fresh task tree. Validates the stored proposal
// before handing it to the materializer so a corrupted template surfaces as a
// 400 rather than a transactional failure mid-insert.
reposRouter.post(
  "/:id/instantiate-template/:templateId",
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const templateId = parseInt(req.params.templateId, 10);
      if (isNaN(templateId)) {
        return res.status(400).json({ error: "Invalid templateId" });
      }

      const db = getDb();
      const repo = await getRepoById(db, id);
      if (!repo) {
        return res.status(404).json({ error: "Repo not found" });
      }
      const template = await getTemplateById(db, templateId);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      const validation = validateTaskTreeProposal(template.tree);
      if (!validation.valid) {
        return res
          .status(400)
          .json({ error: `Stored template is invalid: ${validation.error}` });
      }

      const result = await materializeTaskTree(db, id, validation.proposal);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

// GET /api/repos/:id/usage — return aggregated token usage across every task
// in this repo. Mirrors the per-task /usage shape (totals only — no per-run
// detail at this level) so GUI cards can share rendering logic.
reposRouter.get("/:id/usage", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const totals = await getUsageTotalsForRepo(db, id);
    return res.status(200).json({ totals });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/repos/:id/webhooks — list webhooks configured on the repo
reposRouter.get("/:id/webhooks", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const repo = await getRepoById(db, id);
    if (!repo) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const webhooks = await getWebhooksByRepoId(db, id);
    return res.status(200).json(webhooks);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos/:id/webhooks — register a new webhook on the repo
reposRouter.post("/:id/webhooks", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const repo = await getRepoById(db, id);
    if (!repo) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const { url, events, active } = req.body as {
      url?: unknown;
      events?: unknown;
      active?: unknown;
    };

    if (!isHttpUrl(url)) {
      return res
        .status(400)
        .json({ error: "url must be a valid http/https URL" });
    }
    const validatedEvents = validateWebhookEvents(events);
    if (typeof validatedEvents === "string") {
      return res.status(400).json({ error: validatedEvents });
    }
    if (active !== undefined && typeof active !== "boolean") {
      return res.status(400).json({ error: "active must be boolean" });
    }

    const webhook = await createWebhook(db, {
      repo_id: id,
      url: url as string,
      events: validatedEvents,
      active: active as boolean | undefined,
    });
    return res.status(201).json(webhook);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/repos/:id/webhooks/:webhookId — update a webhook
reposRouter.patch(
  "/:id/webhooks/:webhookId",
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (isNaN(id) || isNaN(webhookId)) {
        return res.status(400).json({ error: "Invalid id" });
      }

      const db = getDb();
      const repo = await getRepoById(db, id);
      if (!repo) {
        return res.status(404).json({ error: "Repo not found" });
      }
      const existing = await getWebhookById(db, webhookId);
      if (!existing || existing.repo_id !== id) {
        return res.status(404).json({ error: "Webhook not found" });
      }

      const { url, events, active } = req.body as {
        url?: unknown;
        events?: unknown;
        active?: unknown;
      };

      const patch: { url?: string; events?: WebhookEvent[]; active?: boolean } =
        {};
      if (url !== undefined) {
        if (!isHttpUrl(url)) {
          return res
            .status(400)
            .json({ error: "url must be a valid http/https URL" });
        }
        patch.url = url;
      }
      if (events !== undefined) {
        const validated = validateWebhookEvents(events);
        if (typeof validated === "string") {
          return res.status(400).json({ error: validated });
        }
        patch.events = validated;
      }
      if (active !== undefined) {
        if (typeof active !== "boolean") {
          return res.status(400).json({ error: "active must be boolean" });
        }
        patch.active = active;
      }

      const updated = await updateWebhook(db, webhookId, patch);
      return res.status(200).json(updated);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

// DELETE /api/repos/:id/webhooks/:webhookId — remove a webhook
reposRouter.delete(
  "/:id/webhooks/:webhookId",
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (isNaN(id) || isNaN(webhookId)) {
        return res.status(400).json({ error: "Invalid id" });
      }

      const db = getDb();
      const repo = await getRepoById(db, id);
      if (!repo) {
        return res.status(404).json({ error: "Repo not found" });
      }
      const existing = await getWebhookById(db, webhookId);
      if (!existing || existing.repo_id !== id) {
        return res.status(404).json({ error: "Webhook not found" });
      }

      await deleteWebhook(db, webhookId);
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

// DELETE /api/repos/:id — delete a repo
reposRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    await deleteRepo(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default reposRouter;
