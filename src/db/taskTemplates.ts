import { Knex } from "knex";
import { TaskTemplate } from "../interfaces";
import { TaskTreeProposal } from "../services/chatService";

export async function getAllTemplates(db: Knex): Promise<TaskTemplate[]> {
  return db<TaskTemplate>("task_templates").orderBy("created_at", "desc");
}

export async function getTemplateById(
  db: Knex,
  id: number
): Promise<TaskTemplate | undefined> {
  return db<TaskTemplate>("task_templates").where({ id }).first();
}

export async function createTemplate(
  db: Knex,
  data: {
    name: string;
    description?: string;
    tree: TaskTreeProposal;
  }
): Promise<TaskTemplate> {
  const [row] = await db<TaskTemplate>("task_templates")
    .insert({
      name: data.name,
      description: data.description ?? "",
      // Serialize so the pg driver hands the jsonb column a string it accepts
      // without per-call type-casting (mirrors how task_notes.tags is written).
      tree: JSON.stringify(data.tree) as unknown as TaskTemplate["tree"],
    })
    .returning("*");
  return row;
}

export async function deleteTemplate(db: Knex, id: number): Promise<number> {
  return db<TaskTemplate>("task_templates").where({ id }).delete();
}
