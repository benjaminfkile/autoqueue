import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import {
  getTasksByRepoId,
  getTaskById,
  getChildTasks,
  createTask,
  updateTask,
  deleteTask,
} from "../db/tasks";
import {
  getCriteriaByTaskId,
  createCriterion,
  updateCriterion,
  deleteCriterion,
} from "../db/acceptanceCriteria";
import { getEventsByTaskId } from "../db/taskEvents";
import { OrderingMode } from "../interfaces";

const VALID_ORDERING_MODE: OrderingMode[] = ["sequential", "parallel"];

const tasksRouter = express.Router();

// GET /api/tasks?repo_id=X — return all tasks for a repo with children_count
tasksRouter.get("/", async (req: Request, res: Response) => {
  try {
    const repoId = parseInt(req.query.repo_id as string, 10);
    if (isNaN(repoId)) {
      return res.status(400).json({ error: "repo_id query param is required" });
    }

    const db = getDb();
    const tasks = await getTasksByRepoId(db, repoId);

    const tasksWithCounts = await Promise.all(
      tasks.map(async (task) => {
        const children = await getChildTasks(db, task.id);
        return { ...task, children_count: children.length };
      })
    );

    return res.status(200).json(tasksWithCounts);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/tasks/:id — return single task with acceptanceCriteria and children
tasksRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const task = await getTaskById(db, id);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const acceptanceCriteria = await getCriteriaByTaskId(db, id);
    const childTasks = await getChildTasks(db, id);
    const children = childTasks.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      order_position: c.order_position,
    }));

    return res.status(200).json({ ...task, acceptanceCriteria, children });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/tasks — create a task with optional acceptanceCriteria
tasksRouter.post("/", async (req: Request, res: Response) => {
  try {
    const {
      repo_id,
      parent_id,
      title,
      description,
      order_position,
      ordering_mode,
      acceptanceCriteria,
    } = req.body as {
      repo_id: number;
      parent_id?: number | null;
      title: string;
      description?: string;
      order_position?: number;
      ordering_mode?: OrderingMode | null;
      acceptanceCriteria?: string[];
    };

    if (!repo_id || !title) {
      return res.status(400).json({ error: "repo_id and title are required" });
    }

    if (
      ordering_mode !== undefined &&
      ordering_mode !== null &&
      !VALID_ORDERING_MODE.includes(ordering_mode)
    ) {
      return res.status(400).json({ error: "Invalid ordering_mode" });
    }

    const db = getDb();
    const task = await createTask(db, {
      repo_id,
      parent_id,
      title,
      description,
      order_position,
      ordering_mode,
    });

    let criteria: Awaited<ReturnType<typeof createCriterion>>[] = [];
    if (acceptanceCriteria && acceptanceCriteria.length > 0) {
      for (let i = 0; i < acceptanceCriteria.length; i++) {
        const criterion = await createCriterion(db, {
          task_id: task.id,
          description: acceptanceCriteria[i],
          order_position: i,
        });
        criteria.push(criterion);
      }
    }

    return res.status(201).json({ ...task, acceptanceCriteria: criteria });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/tasks/:id — update a task
tasksRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const data = req.body as Partial<{
      title: string;
      description: string;
      order_position: number;
      status: "pending" | "active" | "done" | "failed";
      ordering_mode: OrderingMode | null;
    }>;

    if (
      data.ordering_mode !== undefined &&
      data.ordering_mode !== null &&
      !VALID_ORDERING_MODE.includes(data.ordering_mode)
    ) {
      return res.status(400).json({ error: "Invalid ordering_mode" });
    }

    const db = getDb();
    const task = await updateTask(db, id, data);
    return res.status(200).json(task);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/tasks/:id — delete a task (children and criteria cascade)
tasksRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    await deleteTask(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/tasks/:id/events — return events for a task in chronological order
tasksRouter.get("/:id/events", async (req: Request, res: Response) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const events = await getEventsByTaskId(db, taskId);
    return res.status(200).json(events);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// --- Criteria sub-routes ---

// GET /api/tasks/:id/criteria — return criteria for a task
tasksRouter.get("/:id/criteria", async (req: Request, res: Response) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const criteria = await getCriteriaByTaskId(db, taskId);
    return res.status(200).json(criteria);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/tasks/:id/criteria — create a criterion for a task
tasksRouter.post("/:id/criteria", async (req: Request, res: Response) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const { description, order_position } = req.body as {
      description: string;
      order_position?: number;
    };

    if (!description) {
      return res.status(400).json({ error: "description is required" });
    }

    const db = getDb();
    const criterion = await createCriterion(db, {
      task_id: taskId,
      description,
      order_position,
    });

    return res.status(201).json(criterion);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/tasks/:taskId/criteria/:criterionId — update a criterion
tasksRouter.patch(
  "/:taskId/criteria/:criterionId",
  async (req: Request, res: Response) => {
    try {
      const criterionId = parseInt(req.params.criterionId, 10);
      if (isNaN(criterionId)) {
        return res.status(400).json({ error: "Invalid criterionId" });
      }

      const data = req.body as Partial<{
        description: string;
        order_position: number;
        met: boolean;
      }>;

      const db = getDb();
      const criterion = await updateCriterion(db, criterionId, data);
      return res.status(200).json(criterion);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

// DELETE /api/tasks/:taskId/criteria/:criterionId — delete a criterion
tasksRouter.delete(
  "/:taskId/criteria/:criterionId",
  async (req: Request, res: Response) => {
    try {
      const criterionId = parseInt(req.params.criterionId, 10);
      if (isNaN(criterionId)) {
        return res.status(400).json({ error: "Invalid criterionId" });
      }

      const db = getDb();
      await deleteCriterion(db, criterionId);
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

export default tasksRouter;
