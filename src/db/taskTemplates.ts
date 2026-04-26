import { Knex } from "knex";
import { TaskTemplate } from "../interfaces";
import { TaskTreeProposal } from "../services/chatService";

interface TaskTemplateRow extends Omit<TaskTemplate, "tree"> {
  tree: string;
}

function decodeTree(raw: string): TaskTemplate["tree"] {
  return JSON.parse(raw) as TaskTemplate["tree"];
}

function hydrate(row: TaskTemplateRow): TaskTemplate {
  return { ...row, tree: decodeTree(row.tree) };
}

export async function getAllTemplates(db: Knex): Promise<TaskTemplate[]> {
  const rows = await db<TaskTemplateRow>("task_templates").orderBy(
    "created_at",
    "desc"
  );
  return rows.map(hydrate);
}

export async function getTemplateById(
  db: Knex,
  id: number
): Promise<TaskTemplate | undefined> {
  const row = await db<TaskTemplateRow>("task_templates").where({ id }).first();
  return row ? hydrate(row) : undefined;
}

export async function createTemplate(
  db: Knex,
  data: {
    name: string;
    description?: string;
    tree: TaskTreeProposal;
  }
): Promise<TaskTemplate> {
  const [row] = await db<TaskTemplateRow>("task_templates")
    .insert({
      name: data.name,
      description: data.description ?? "",
      tree: JSON.stringify(data.tree),
    })
    .returning("*");
  return hydrate(row);
}

export async function deleteTemplate(db: Knex, id: number): Promise<number> {
  return db<TaskTemplateRow>("task_templates").where({ id }).delete();
}
