import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getRepoById } from "../db/repos";
import {
  createTemplate,
  deleteTemplate,
  getAllTemplates,
  getTemplateById,
} from "../db/taskTemplates";
import { validateTaskTreeProposal } from "../services/chatService";
import { buildTemplateFromRepo } from "../services/taskTemplateBuilder";

const templatesRouter = express.Router();

// GET /api/templates — list all saved templates.
templatesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const templates = await getAllTemplates(db);
    return res.status(200).json(templates);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/templates — save a new template. Two shapes accepted:
//   1. { name, description?, tree: TaskTreeProposal }
//      Persists the supplied tree as-is (the materializer's input shape, so
//      anything the chat planner can propose can also be templated).
//   2. { name, description?, repo_id, root_task_ids?: number[] }
//      Captures the current task tree under `repo_id` and stores it. When
//      `root_task_ids` is supplied, only those top-level tasks are included;
//      otherwise the whole repo's tree is captured.
templatesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const body = req.body as {
      name?: unknown;
      description?: unknown;
      tree?: unknown;
      repo_id?: unknown;
      root_task_ids?: unknown;
    };

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }

    const hasTree = body.tree !== undefined;
    const hasRepo = body.repo_id !== undefined;
    if (hasTree === hasRepo) {
      return res
        .status(400)
        .json({ error: "supply exactly one of `tree` or `repo_id`" });
    }

    let tree;
    if (hasTree) {
      const validation = validateTaskTreeProposal(body.tree);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      tree = validation.proposal;
    } else {
      if (typeof body.repo_id !== "number" || !Number.isInteger(body.repo_id)) {
        return res.status(400).json({ error: "repo_id must be an integer" });
      }
      const repo = await getRepoById(db, body.repo_id);
      if (!repo) {
        return res.status(404).json({ error: "Repo not found" });
      }

      let rootIds: number[] | undefined;
      if (body.root_task_ids !== undefined) {
        if (
          !Array.isArray(body.root_task_ids) ||
          !body.root_task_ids.every(
            (id) => typeof id === "number" && Number.isInteger(id)
          )
        ) {
          return res
            .status(400)
            .json({ error: "root_task_ids must be an array of integers" });
        }
        rootIds = body.root_task_ids as number[];
      }

      try {
        tree = await buildTemplateFromRepo(db, body.repo_id, rootIds);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }

    const template = await createTemplate(db, {
      name: body.name,
      description: body.description as string | undefined,
      tree,
    });
    return res.status(201).json(template);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/templates/:id — fetch a single template by id (handy for the GUI's
// preview-before-instantiate flow).
templatesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const db = getDb();
    const template = await getTemplateById(db, id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    return res.status(200).json(template);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/templates/:id — drop a template.
templatesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const db = getDb();
    const existing = await getTemplateById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Template not found" });
    }
    await deleteTemplate(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default templatesRouter;
