import { Knex } from "knex";
import { TaskEvent } from "../interfaces";

interface TaskEventRow extends Omit<TaskEvent, "data"> {
  data: string | null;
}

function decodeData(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function recordEvent(
  db: Knex,
  taskId: number,
  event: string,
  data?: Record<string, unknown> | null
): Promise<TaskEvent> {
  const [row] = await db<TaskEventRow>("task_events")
    .insert({
      task_id: taskId,
      event,
      data: data == null ? null : JSON.stringify(data),
    })
    .returning("*");
  return { ...row, data: decodeData(row.data) };
}

export async function getEventsByTaskId(
  db: Knex,
  taskId: number
): Promise<TaskEvent[]> {
  const rows = await db<TaskEventRow>("task_events")
    .where({ task_id: taskId })
    .orderBy("ts", "asc")
    .orderBy("id", "asc");
  return rows.map((r) => ({ ...r, data: decodeData(r.data) }));
}
