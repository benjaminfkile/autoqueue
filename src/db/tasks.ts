import { Knex } from "knex";

interface Task {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  description: string;
  order_position: number;
  status: "pending" | "active" | "done" | "failed";
  retry_count: number;
  pr_url: string | null;
  created_at: Date;
}

export type { Task };

export async function getTasksByRepoId(
  db: Knex,
  repoId: number
): Promise<Task[]> {
  return db<Task>("tasks")
    .where({ repo_id: repoId })
    .orderBy("order_position", "asc");
}

export async function getTaskById(
  db: Knex,
  id: number
): Promise<Task | undefined> {
  return db<Task>("tasks").where({ id }).first();
}

export async function getChildTasks(
  db: Knex,
  parentId: number
): Promise<Task[]> {
  return db<Task>("tasks")
    .where({ parent_id: parentId })
    .orderBy("order_position", "asc");
}

export async function createTask(
  db: Knex,
  data: {
    repo_id: number;
    parent_id?: number | null;
    title: string;
    description?: string;
    order_position?: number;
  }
): Promise<Task> {
  let orderPosition = data.order_position;

  if (orderPosition == null) {
    const result = await db("tasks")
      .where({ repo_id: data.repo_id })
      .andWhere(function () {
        if (data.parent_id != null) {
          this.where({ parent_id: data.parent_id });
        } else {
          this.whereNull("parent_id");
        }
      })
      .max("order_position as max_pos")
      .first();

    const maxPos = result?.max_pos;
    orderPosition = maxPos != null ? maxPos + 1 : 0;
  }

  const [task] = await db<Task>("tasks")
    .insert({
      repo_id: data.repo_id,
      parent_id: data.parent_id ?? null,
      title: data.title,
      description: data.description ?? "",
      order_position: orderPosition,
    })
    .returning("*");

  return task;
}

export async function updateTask(
  db: Knex,
  id: number,
  data: Partial<
    Pick<
      Task,
      | "status"
      | "order_position"
      | "retry_count"
      | "title"
      | "description"
      | "pr_url"
    >
  >
): Promise<Task> {
  const [task] = await db<Task>("tasks")
    .where({ id })
    .update(data)
    .returning("*");
  return task;
}

export async function deleteTask(db: Knex, id: number): Promise<void> {
  await db<Task>("tasks").where({ id }).delete();
}

export async function resetActiveTasks(db: Knex): Promise<number> {
  const rows = await db<Task>("tasks")
    .where({ status: "active" })
    .update({ status: "pending" })
    .returning("id");
  return rows.length;
}

export async function getNextPendingLeafTask(
  db: Knex,
  repoId: number
): Promise<Task | undefined> {
  const result = await db.raw<{ rows: Task[] }>(
    `WITH RECURSIVE task_path AS (
      SELECT id, parent_id, order_position,
             ARRAY[order_position] AS path
      FROM tasks
      WHERE repo_id = ? AND parent_id IS NULL

      UNION ALL

      SELECT t.id, t.parent_id, t.order_position,
             tp.path || t.order_position
      FROM tasks t
      JOIN task_path tp ON t.parent_id = tp.id
    )
    SELECT t.* FROM tasks t
    JOIN task_path tp ON t.id = tp.id
    WHERE t.repo_id = ?
      AND t.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM tasks child
        WHERE child.parent_id = t.id
          AND child.status IN ('pending', 'active')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks failed
        WHERE failed.repo_id = ?
          AND failed.status = 'failed'
      )
    ORDER BY tp.path ASC
    LIMIT 1`,
    [repoId, repoId, repoId]
  );
  return result.rows[0];
}

export async function autoCompleteParentTasks(
  db: Knex,
  repoId: number
): Promise<number> {
  let totalUpdated = 0;

  while (true) {
    const result = await db.raw<{ rowCount: number }>(
      `UPDATE tasks SET status = 'done'
       WHERE repo_id = ?
         AND status != 'done'
         AND EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.parent_id = tasks.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.parent_id = tasks.id
             AND child.status NOT IN ('done', 'failed')
         )`,
      [repoId]
    );

    const count = result.rowCount ?? 0;
    if (count === 0) break;
    totalUpdated += count;
  }

  return totalUpdated;
}
