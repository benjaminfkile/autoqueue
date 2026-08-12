import { Knex } from "knex";
import { OrderingMode, Repo, RepoOnParentChildFail, Task } from "../interfaces";
import { getDefaultModel } from "./settings";
import { recordEvent } from "./taskEvents";

// Per-repo dashboard aggregates: total task count (all statuses), completed
// count ("done" tasks — used as the default "cumulative work" sort key), and
// the most recent activity timestamp across tasks + task_events. Returned as
// a map keyed by repo id so a single query batch feeds the whole repos list.
export interface RepoTaskStats {
  task_total: number;
  task_done: number;
  // ISO string of the latest activity across:
  //   - tasks.created_at
  //   - task_events.ts (task_events cascade-delete with tasks, so restricting
  //     the join to tasks.repo_id keeps rows attributable to a repo)
  // Null when the repo has no tasks yet — the UI renders "no activity".
  last_activity_at: string | null;
}

export async function getRepoTaskStatsMap(
  db: Knex
): Promise<Map<number, RepoTaskStats>> {
  const result = new Map<number, RepoTaskStats>();

  // Task counts + max(created_at) come straight off tasks. Raw SELECT
  // expressions instead of the knex helpers because the "done" column is a
  // conditional aggregate — SUM(CASE WHEN ... END) — which knex's `.sum()`
  // helper doesn't compose cleanly. Raw expressions stay portable
  // (SQLite/Postgres both understand SUM(CASE...) and MAX(created_at)) and
  // avoid a per-repo N+1.
  const totals = await db("tasks")
    .select("repo_id")
    .select(
      db.raw("COUNT(*) as total"),
      db.raw("SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done"),
      db.raw("MAX(created_at) as max_created")
    )
    .groupBy("repo_id");

  for (const row of totals as Array<{
    repo_id: number;
    total: string | number;
    done: string | number;
    max_created: string | Date | null;
  }>) {
    result.set(row.repo_id, {
      task_total: Number(row.total),
      task_done: Number(row.done),
      last_activity_at: toIso(row.max_created),
    });
  }

  // Fold in the latest task_events timestamp per repo. A repo may have events
  // more recent than its newest task (retries, status flips, notes) — the
  // "activity heat" cue should track those too, not just when the task row
  // was inserted.
  const eventTotals = await db("task_events as e")
    .join("tasks as t", "t.id", "e.task_id")
    .select("t.repo_id as repo_id")
    .max("e.ts as max_ts")
    .groupBy("t.repo_id");

  for (const row of eventTotals as Array<{
    repo_id: number;
    max_ts: string | Date | null;
  }>) {
    const existing = result.get(row.repo_id);
    const eventIso = toIso(row.max_ts);
    if (!existing) {
      // Should not happen (event without a task) but degrade gracefully.
      result.set(row.repo_id, {
        task_total: 0,
        task_done: 0,
        last_activity_at: eventIso,
      });
      continue;
    }
    if (eventIso && (!existing.last_activity_at || eventIso > existing.last_activity_at)) {
      existing.last_activity_at = eventIso;
    }
  }

  return result;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  // SQLite returns timestamps as strings. Normalize via Date so callers get
  // a predictable ISO 8601 shape (Postgres/pg also returns Date objects, so
  // both backends land on the same string form).
  const parsed = new Date(value);
  const t = parsed.getTime();
  return Number.isFinite(t) ? parsed.toISOString() : null;
}

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
    model?: string | null;
    requires_approval?: boolean;
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
      model: data.model ?? null,
      ...(data.requires_approval !== undefined
        ? { requires_approval: data.requires_approval }
        : {}),
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
      | "model"
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

// Strict single-task guard (task #29). True when any task, in any repo, is
// currently 'active' with a still-valid lease — i.e. some worker owns it and
// is presumed alive. The scheduler uses this at the start of each cycle to
// decide whether to claim new work: if a valid-lease active task exists, we
// claim nothing else so at no instant are two tasks 'active' at once. Expired
// leases are cleaned up beforehand by reclaimExpiredLeaseTasks (task #27),
// so a survivor here is genuinely in-flight, not a crash residue.
export async function hasActiveLeasedTask(
  db: Knex,
  now: Date = new Date()
): Promise<boolean> {
  const row = await db<Task>("tasks")
    .where({ status: "active" })
    .andWhere("leased_until", ">=", now.toISOString())
    .first();
  return row !== undefined;
}

export async function reconcileOrphanedTasks(
  db: Knex,
  workerId: string
): Promise<number> {
  const now = new Date().toISOString();
  return db<Task>("tasks")
    .where("status", "active")
    .andWhere((b) =>
      b
        .where("worker_id", workerId)
        .orWhereNull("leased_until")
        .orWhere("leased_until", "<", now)
    )
    .update({
      status: "pending",
      worker_id: null,
      leased_until: null,
    });
}

export interface ReclaimResult {
  resetToPending: number;
  markedFailed: number;
}

// Finds active tasks for a repo whose lease has expired (beyond the grace
// period) and either resets them to pending (if retries remain) or marks them
// failed (if MAX_ATTEMPTS is exhausted). Records a lease_expired_reclaimed
// event for each reclaimed task.
//
// Called at the start of each scheduler cycle so a crashed or wedged worker
// never leaves a task stranded 'active' indefinitely. A task whose lease is
// still valid (leased_until >= now) is never touched.
export async function reclaimExpiredLeaseTasks(
  db: Knex,
  repoId: number,
  maxAttempts: number,
  graceSeconds = 5
): Promise<ReclaimResult> {
  const cutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();

  const staleTasks = await db<Task>("tasks")
    .where({ repo_id: repoId, status: "active" })
    .andWhere((b) =>
      b.whereNull("leased_until").orWhere("leased_until", "<", cutoff)
    );

  let resetToPending = 0;
  let markedFailed = 0;

  for (const task of staleTasks) {
    const newRetryCount = task.retry_count + 1;
    const exhausted = newRetryCount >= maxAttempts;
    const newStatus = exhausted ? "failed" : "pending";

    await db<Task>("tasks").where({ id: task.id }).update({
      status: newStatus,
      worker_id: null,
      leased_until: null,
      retry_count: newRetryCount,
    });

    await recordEvent(db, task.id, "lease_expired_reclaimed", {
      action: exhausted ? "marked_failed" : "reset_to_pending",
      old_retry_count: task.retry_count,
      new_retry_count: newRetryCount,
      previous_worker_id: task.worker_id,
    });

    if (exhausted) {
      markedFailed++;
    } else {
      resetToPending++;
    }
  }

  return { resetToPending, markedFailed };
}

// Single-process desktop port of the original Postgres recursive-CTE claim.
// Loads the repo's task tree into memory, applies the same eligibility rules
// (ordering_mode, on_failure, requires_approval, no pending/active children),
// and updates the chosen row inside a transaction. No FOR UPDATE / SKIP LOCKED
// because grunt only ever runs as one process.
export async function claimNextPendingLeafTask(
  db: Knex,
  repoId: number,
  workerId: string,
  leaseSeconds: number
): Promise<Task | undefined> {
  return db.transaction(async (trx) => {
    const repo = await trx<Repo>("repos").where({ id: repoId }).first();
    if (!repo) return undefined;
    const all = await trx<Task>("tasks").where({ repo_id: repoId });
    if (all.length === 0) return undefined;

    const byId = new Map<number, Task>();
    const childrenOf = new Map<number | null, Task[]>();
    for (const t of all) byId.set(t.id, t);
    for (const t of all) {
      const key = t.parent_id ?? null;
      const arr = childrenOf.get(key) ?? [];
      arr.push(t);
      childrenOf.set(key, arr);
    }
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => a.order_position - b.order_position);
    }

    const onFailure = repo.on_failure;
    const repoOrdering: OrderingMode = repo.ordering_mode;

    // halt_repo (and any unimplemented policy that falls through to ELSE):
    // a single failed task anywhere in the repo blocks all pickup.
    if (
      onFailure !== "continue" &&
      onFailure !== "halt_subtree" &&
      all.some((t) => t.status === "failed")
    ) {
      return undefined;
    }

    // ancestors[t.id] = [root, ..., t.id] (chain top-down, includes self).
    const ancestors = new Map<number, number[]>();
    const dfsOrder: Task[] = [];
    const walk = (parentId: number | null, chain: number[]): void => {
      const kids = childrenOf.get(parentId) ?? [];
      for (const c of kids) {
        const next = [...chain, c.id];
        ancestors.set(c.id, next);
        dfsOrder.push(c);
        walk(c.id, next);
      }
    };
    walk(null, []);

    const orderingFor = (parent: Task | undefined | null): OrderingMode =>
      parent?.ordering_mode ?? repoOrdering;

    const subtreeBusyMemo = new Map<number, boolean>();
    const subtreeHasPendingOrActive = (id: number): boolean => {
      const cached = subtreeBusyMemo.get(id);
      if (cached !== undefined) return cached;
      const t = byId.get(id);
      if (!t) {
        subtreeBusyMemo.set(id, false);
        return false;
      }
      if (t.status === "pending" || t.status === "active") {
        subtreeBusyMemo.set(id, true);
        return true;
      }
      const kids = childrenOf.get(id) ?? [];
      for (const k of kids) {
        if (subtreeHasPendingOrActive(k.id)) {
          subtreeBusyMemo.set(id, true);
          return true;
        }
      }
      subtreeBusyMemo.set(id, false);
      return false;
    };

    const subtreeFailedMemo = new Map<number, boolean>();
    const subtreeHasFailed = (id: number): boolean => {
      const cached = subtreeFailedMemo.get(id);
      if (cached !== undefined) return cached;
      const t = byId.get(id);
      if (!t) {
        subtreeFailedMemo.set(id, false);
        return false;
      }
      if (t.status === "failed") {
        subtreeFailedMemo.set(id, true);
        return true;
      }
      const kids = childrenOf.get(id) ?? [];
      for (const k of kids) {
        if (subtreeHasFailed(k.id)) {
          subtreeFailedMemo.set(id, true);
          return true;
        }
      }
      subtreeFailedMemo.set(id, false);
      return false;
    };

    const isEligible = (t: Task): boolean => {
      if (t.status !== "pending") return false;
      if (t.requires_approval) return false;

      // A task with ANY children is a phase parent — never claim it directly.
      // Parents reach done/failed only via autoCompleteParentTasks.
      const kids = childrenOf.get(t.id) ?? [];
      if (kids.length > 0) return false;

      if (onFailure === "halt_subtree") {
        const siblings = childrenOf.get(t.parent_id ?? null) ?? [];
        if (siblings.some((s) => s.id !== t.id && s.status === "failed")) {
          return false;
        }
        if (subtreeHasFailed(t.id)) return false;
      }

      const parent = t.parent_id != null ? byId.get(t.parent_id) : undefined;
      if (orderingFor(parent) === "sequential") {
        const siblings = childrenOf.get(t.parent_id ?? null) ?? [];
        const blocked = siblings.some(
          (s) =>
            s.id !== t.id &&
            s.order_position < t.order_position &&
            (s.status === "pending" || s.status === "active")
        );
        if (blocked) return false;
      }

      const chain = ancestors.get(t.id) ?? [];
      for (const aid of chain) {
        if (aid === t.id) continue;
        const a = byId.get(aid);
        if (!a) continue;
        const ap = a.parent_id != null ? byId.get(a.parent_id) : undefined;
        if (orderingFor(ap) !== "sequential") continue;
        const aSiblings = childrenOf.get(a.parent_id ?? null) ?? [];
        for (const earlier of aSiblings) {
          if (earlier.id === a.id) continue;
          if (earlier.order_position >= a.order_position) continue;
          if (subtreeHasPendingOrActive(earlier.id)) return false;
        }
      }

      return true;
    };

    const chosen = dfsOrder.find(isEligible);
    if (!chosen) return undefined;

    const expiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const [updated] = await trx<Task>("tasks")
      .where({ id: chosen.id })
      .update({
        status: "active",
        worker_id: workerId,
        leased_until: new Date(expiry),
      })
      .returning("*");
    return updated;
  });
}

export async function renewTaskLease(
  db: Knex,
  taskId: number,
  leaseSeconds: number
): Promise<void> {
  const expiry = new Date(Date.now() + leaseSeconds * 1000);
  await db<Task>("tasks").where({ id: taskId }).update({ leased_until: expiry });
}

export async function autoCompleteParentTasks(
  db: Knex,
  repoId: number,
  policy: RepoOnParentChildFail = "ignore"
): Promise<number> {
  // SQLite doesn't allow UPDATE ... FROM tasks_self_reference cleanly, so we
  // resolve the candidate ids via SELECT and then update them in a second
  // statement. The whole sweep loops until a pass finds no rows to flip,
  // mirroring the original cascading semantics.
  const hasChildren = (parentId: number): Promise<boolean> =>
    db<Task>("tasks")
      .where({ parent_id: parentId })
      .first()
      .then((row) => row !== undefined);

  const childStatuses = (parentId: number): Promise<string[]> =>
    db<Task>("tasks")
      .where({ parent_id: parentId })
      .pluck("status");

  const sweep = async (
    targetStatus: "done" | "failed",
    predicate: (statuses: string[]) => boolean
  ): Promise<number> => {
    const candidates = await db<Task>("tasks")
      .where({ repo_id: repoId })
      .whereNotIn("status", ["done", "failed"]);

    const ids: number[] = [];
    for (const t of candidates) {
      if (!(await hasChildren(t.id))) continue;
      const statuses = await childStatuses(t.id);
      if (predicate(statuses)) ids.push(t.id);
    }
    if (ids.length === 0) return 0;
    return db<Task>("tasks").whereIn("id", ids).update({ status: targetStatus });
  };

  let totalUpdated = 0;
  while (true) {
    let count = 0;

    if (policy === "cascade_fail") {
      count += await sweep(
        "failed",
        (s) =>
          s.every((x) => x === "done" || x === "failed") &&
          s.some((x) => x === "failed")
      );
      count += await sweep("done", (s) => s.every((x) => x === "done"));
    } else if (policy === "mark_partial") {
      count = await sweep("done", (s) => s.every((x) => x === "done"));
    } else {
      count = await sweep(
        "done",
        (s) => s.every((x) => x === "done" || x === "failed")
      );
    }

    if (count === 0) break;
    totalUpdated += count;
  }

  return totalUpdated;
}

// Phase 11: resolve the effective Claude model for a task.
//
// Resolution rule (the chosen, documented contract):
//   1. The task's own `model` column, if non-null.
//   2. Otherwise, walk the parent_id chain and return the first ancestor
//      whose `model` is non-null. This means a parent's override applies to
//      its entire subtree unless a descendant overrides it again.
//   3. Otherwise, fall back to settings.default_model (the single-row
//      app-wide default).
//
// Storing each task's model nullable (rather than denormalising the resolved
// value at create time) keeps inheritance live: editing a parent's model
// instantly re-routes every descendant that hasn't itself opted out, and
// clearing a child's model snaps it back to whatever the ancestor/default
// currently resolves to. The walk is bounded by the depth of the tree and
// in practice issues at most O(depth) cheap point reads on tasks.
export async function resolveTaskModel(
  db: Knex,
  taskId: number
): Promise<string> {
  const { model } = await resolveTaskModelWithSource(db, taskId);
  return model;
}

// Phase 11: same resolution as resolveTaskModel, but also reports where the
// effective model came from so the GUI can render an "override / parent /
// default" badge without re-implementing the walk.
//   - 'override' → the task itself has a non-empty model column.
//   - 'parent'   → an ancestor (walking parent_id) had a non-empty model.
//   - 'default'  → no override anywhere in the chain; settings.default_model.
export type TaskModelSource = "override" | "parent" | "default";

export interface ResolvedTaskModel {
  model: string;
  source: TaskModelSource;
}

export async function resolveTaskModelWithSource(
  db: Knex,
  taskId: number
): Promise<ResolvedTaskModel> {
  const visited = new Set<number>();
  let currentId: number | null = taskId;
  let isOriginTask = true;

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const row: Pick<Task, "model" | "parent_id"> | undefined = await db<Task>(
      "tasks"
    )
      .select("model", "parent_id")
      .where({ id: currentId })
      .first();
    if (!row) break;
    if (row.model != null && row.model !== "") {
      return {
        model: row.model,
        source: isOriginTask ? "override" : "parent",
      };
    }
    isOriginTask = false;
    currentId = row.parent_id;
  }

  const model = await getDefaultModel(db);
  return { model, source: "default" };
}

