import { Knex } from "knex";

export interface ActiveWorkerRow {
  worker_id: string;
  task_id: number;
  task_title: string;
  repo_id: number;
  leased_until: Date;
}

export async function getActiveWorkers(db: Knex): Promise<ActiveWorkerRow[]> {
  const result = await db.raw<{ rows: ActiveWorkerRow[] }>(
    `SELECT t.worker_id AS worker_id,
            t.id AS task_id,
            t.title AS task_title,
            t.repo_id AS repo_id,
            t.leased_until AS leased_until
     FROM tasks t
     WHERE t.status = 'active'
       AND t.worker_id IS NOT NULL
       AND t.leased_until IS NOT NULL
       AND t.leased_until > NOW()
     ORDER BY t.worker_id ASC, t.id ASC`
  );
  return result.rows;
}
