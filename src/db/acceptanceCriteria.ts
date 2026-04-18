import { Knex } from "knex";
import { AcceptanceCriterion } from "../interfaces";

export async function getCriteriaByTaskId(
  db: Knex,
  taskId: number
): Promise<AcceptanceCriterion[]> {
  return db<AcceptanceCriterion>("acceptance_criteria")
    .where({ task_id: taskId })
    .orderBy("order_position", "asc");
}

export async function createCriterion(
  db: Knex,
  data: {
    task_id: number;
    description: string;
    order_position?: number;
  }
): Promise<AcceptanceCriterion> {
  let orderPosition = data.order_position;

  if (orderPosition == null) {
    const result = await db("acceptance_criteria")
      .where({ task_id: data.task_id })
      .max("order_position as max_pos")
      .first();

    const maxPos = result?.max_pos;
    orderPosition = maxPos != null ? maxPos + 1 : 0;
  }

  const [criterion] = await db<AcceptanceCriterion>("acceptance_criteria")
    .insert({
      task_id: data.task_id,
      description: data.description,
      order_position: orderPosition,
    })
    .returning("*");

  return criterion;
}

export async function updateCriterion(
  db: Knex,
  id: number,
  data: Partial<Pick<AcceptanceCriterion, "met" | "description" | "order_position">>
): Promise<AcceptanceCriterion> {
  const [criterion] = await db<AcceptanceCriterion>("acceptance_criteria")
    .where({ id })
    .update(data)
    .returning("*");
  return criterion;
}

export async function deleteCriterion(
  db: Knex,
  id: number
): Promise<void> {
  await db<AcceptanceCriterion>("acceptance_criteria").where({ id }).delete();
}

export async function deleteAllCriteriaForTask(
  db: Knex,
  taskId: number
): Promise<void> {
  await db<AcceptanceCriterion>("acceptance_criteria")
    .where({ task_id: taskId })
    .delete();
}
