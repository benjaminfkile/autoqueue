import { Knex } from "knex";
import { OrderingMode, RepoOnParentChildFail, Task } from "../interfaces";

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
    ordering_mode?: OrderingMode | null;
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
      ordering_mode: data.ordering_mode ?? null,
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
      | "ordering_mode"
      | "log_path"
      | "requires_approval"
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
               ARRAY[order_position] AS path,
               ARRAY[id]::int[] AS ancestor_ids
        FROM tasks
        WHERE repo_id = ? AND parent_id IS NULL

        UNION ALL

        SELECT t.id, t.parent_id, t.order_position,
               tp.path || t.order_position,
               tp.ancestor_ids || t.id
        FROM tasks t
        JOIN task_path tp ON t.parent_id = tp.id
      ),
      candidate AS (
        SELECT t.id
        FROM tasks t
        JOIN task_path tp ON t.id = tp.id
        JOIN repos r ON r.id = t.repo_id
        LEFT JOIN tasks parent ON parent.id = t.parent_id
        WHERE t.repo_id = ?
          AND t.status = 'pending'
          AND NOT t.requires_approval
          AND NOT EXISTS (
            SELECT 1 FROM tasks child
            WHERE child.parent_id = t.id
              AND child.status IN ('pending', 'active')
          )
          AND CASE r.on_failure
            WHEN 'continue' THEN TRUE
            WHEN 'halt_subtree' THEN
              NOT EXISTS (
                SELECT 1 FROM tasks failed
                WHERE failed.repo_id = t.repo_id
                  AND failed.status = 'failed'
                  AND failed.parent_id IS NOT DISTINCT FROM t.parent_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM task_path failed_tp
                JOIN tasks failed ON failed.id = failed_tp.id
                WHERE failed.status = 'failed'
                  AND t.id = ANY(failed_tp.ancestor_ids)
              )
            ELSE
              NOT EXISTS (
                SELECT 1 FROM tasks failed
                WHERE failed.repo_id = t.repo_id
                  AND failed.status = 'failed'
              )
          END
          AND (
            COALESCE(parent.ordering_mode, r.ordering_mode) = 'parallel'
            OR NOT EXISTS (
              SELECT 1 FROM tasks sibling
              WHERE sibling.repo_id = t.repo_id
                AND sibling.parent_id IS NOT DISTINCT FROM t.parent_id
                AND sibling.order_position < t.order_position
                AND sibling.status IN ('pending', 'active')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(tp.ancestor_ids) AS aid
            JOIN tasks a ON a.id = aid
            LEFT JOIN tasks ap ON ap.id = a.parent_id
            WHERE aid <> t.id
              AND COALESCE(ap.ordering_mode, r.ordering_mode) = 'sequential'
              AND EXISTS (
                SELECT 1 FROM task_path bp
                JOIN tasks blocker ON blocker.id = bp.id
                JOIN tasks earlier ON earlier.id = ANY(bp.ancestor_ids)
                WHERE blocker.repo_id = t.repo_id
                  AND blocker.status IN ('pending', 'active')
                  AND earlier.parent_id IS NOT DISTINCT FROM a.parent_id
                  AND earlier.order_position < a.order_position
              )
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
      [repoId, repoId, workerId, leaseSeconds]
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
  repoId: number,
  policy: RepoOnParentChildFail = "ignore"
): Promise<number> {
  let totalUpdated = 0;

  while (true) {
    let count = 0;

    if (policy === "cascade_fail") {
      const failResult = await db.raw<{ rowCount: number }>(
        `UPDATE tasks SET status = 'failed'
         WHERE repo_id = ?
           AND status NOT IN ('done', 'failed')
           AND EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
               AND child.status NOT IN ('done', 'failed')
           )
           AND EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
               AND child.status = 'failed'
           )`,
        [repoId]
      );
      count += failResult.rowCount ?? 0;

      const doneResult = await db.raw<{ rowCount: number }>(
        `UPDATE tasks SET status = 'done'
         WHERE repo_id = ?
           AND status NOT IN ('done', 'failed')
           AND EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
               AND child.status != 'done'
           )`,
        [repoId]
      );
      count += doneResult.rowCount ?? 0;
    } else if (policy === "mark_partial") {
      const result = await db.raw<{ rowCount: number }>(
        `UPDATE tasks SET status = 'done'
         WHERE repo_id = ?
           AND status NOT IN ('done', 'failed')
           AND EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks child
             WHERE child.parent_id = tasks.id
               AND child.status != 'done'
           )`,
        [repoId]
      );
      count = result.rowCount ?? 0;
    } else {
      const result = await db.raw<{ rowCount: number }>(
        `UPDATE tasks SET status = 'done'
         WHERE repo_id = ?
           AND status NOT IN ('done', 'failed')
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
      count = result.rowCount ?? 0;
    }

    if (count === 0) break;
    totalUpdated += count;
  }

  return totalUpdated;
}
