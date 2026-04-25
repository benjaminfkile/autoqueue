import { Knex } from "knex";
import { TaskEvent } from "../interfaces";

export async function recordEvent(
  db: Knex,
  taskId: number,
  event: string,
  data?: Record<string, unknown> | null
): Promise<TaskEvent> {
  const [row] = await db<TaskEvent>("task_events")
    .insert({
      task_id: taskId,
      event,
      data: data ?? null,
    })
    .returning("*");
  return row;
}

export async function getEventsByTaskId(
  db: Knex,
  taskId: number
): Promise<TaskEvent[]> {
  return db<TaskEvent>("task_events")
    .where({ task_id: taskId })
    .orderBy("ts", "asc")
    .orderBy("id", "asc");
}
