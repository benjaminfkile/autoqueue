import { Knex } from "knex";
import { Task } from "../interfaces";

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

export async function reconcileOrphanedTasks(
  db: Knex,
  workerId: string
): Promise<number> {
  const result = await db.raw<{ rows: Array<{ id: number }> }>(
    `UPDATE tasks
     SET status = 'pending',
         worker_id = NULL,
         leased_until = NULL
     WHERE status = 'active'
       AND (worker_id = ? OR leased_until IS NULL OR leased_until < NOW())
     RETURNING id`,
    [workerId]
  );
  return result.rows.length;
}

export async function claimNextPendingLeafTask(
  db: Knex,
  repoId: number,
  workerId: string,
  leaseSeconds: number
): Promise<Task | undefined> {
  return db.transaction(async (trx) => {
    const result = await trx.raw<{ rows: Task[] }>(
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
      ),
      candidate AS (
        SELECT t.id
        FROM tasks t
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
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE tasks
      SET status = 'active',
          worker_id = ?,
          leased_until = NOW() + (? * interval '1 second')
      FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*`,
      [repoId, repoId, repoId, workerId, leaseSeconds]
    );
    return result.rows[0];
  });
}

export async function renewTaskLease(
  db: Knex,
  taskId: number,
  leaseSeconds: number
): Promise<void> {
  await db.raw(
    `UPDATE tasks
     SET leased_until = NOW() + (? * interval '1 second')
     WHERE id = ?`,
    [leaseSeconds, taskId]
  );
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
