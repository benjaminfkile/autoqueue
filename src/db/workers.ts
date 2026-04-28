import { Knex } from "knex";

export interface ActiveWorkerRow {
  worker_id: string;
  task_id: number;
  task_title: string;
  repo_id: number;
  leased_until: Date;
}

export async function getActiveWorkers(db: Knex): Promise<ActiveWorkerRow[]> {
  const now = new Date().toISOString();
  return db("tasks")
    .select<ActiveWorkerRow[]>(
      "worker_id",
      { task_id: "id" },
      { task_title: "title" },
      "repo_id",
      "leased_until"
    )
    .where("status", "active")
    .whereNotNull("worker_id")
    .whereNotNull("leased_until")
    .where("leased_until", ">", now)
    .orderBy([
      { column: "worker_id", order: "asc" },
      { column: "id", order: "asc" },
    ]);
}
