import { Knex } from "knex";
import { RepoWebhook, WebhookEvent } from "../interfaces";

export async function getWebhooksByRepoId(
  db: Knex,
  repoId: number
): Promise<RepoWebhook[]> {
  return db<RepoWebhook>("repo_webhooks")
    .where({ repo_id: repoId })
    .orderBy("id", "asc");
}

export async function getWebhookById(
  db: Knex,
  id: number
): Promise<RepoWebhook | undefined> {
  return db<RepoWebhook>("repo_webhooks").where({ id }).first();
}

export async function createWebhook(
  db: Knex,
  data: {
    repo_id: number;
    url: string;
    events: WebhookEvent[];
    active?: boolean;
  }
): Promise<RepoWebhook> {
  const [row] = await db<RepoWebhook>("repo_webhooks")
    .insert({
      repo_id: data.repo_id,
      url: data.url,
      events: JSON.stringify(data.events) as unknown as WebhookEvent[],
      active: data.active ?? true,
    })
    .returning("*");
  return row;
}

export async function updateWebhook(
  db: Knex,
  id: number,
  data: Partial<{
    url: string;
    events: WebhookEvent[];
    active: boolean;
  }>
): Promise<RepoWebhook> {
  const patch: Record<string, unknown> = {};
  if (data.url !== undefined) patch.url = data.url;
  if (data.events !== undefined) patch.events = JSON.stringify(data.events);
  if (data.active !== undefined) patch.active = data.active;

  const [row] = await db<RepoWebhook>("repo_webhooks")
    .where({ id })
    .update(patch)
    .returning("*");
  return row;
}

export async function deleteWebhook(db: Knex, id: number): Promise<number> {
  return db<RepoWebhook>("repo_webhooks").where({ id }).delete();
}
