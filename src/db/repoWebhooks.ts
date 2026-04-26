import { Knex } from "knex";
import { RepoWebhook, WebhookEvent } from "../interfaces";

interface RepoWebhookRow extends Omit<RepoWebhook, "events" | "active"> {
  events: string;
  active: number | boolean;
}

function decodeEvents(raw: string | null | undefined): WebhookEvent[] {
  if (raw == null) return [];
  return JSON.parse(raw) as WebhookEvent[];
}

function hydrate(row: RepoWebhookRow): RepoWebhook {
  return {
    ...row,
    events: decodeEvents(row.events),
    active: Boolean(row.active),
  };
}

export async function getWebhooksByRepoId(
  db: Knex,
  repoId: number
): Promise<RepoWebhook[]> {
  const rows = await db<RepoWebhookRow>("repo_webhooks")
    .where({ repo_id: repoId })
    .orderBy("id", "asc");
  return rows.map(hydrate);
}

export async function getWebhookById(
  db: Knex,
  id: number
): Promise<RepoWebhook | undefined> {
  const row = await db<RepoWebhookRow>("repo_webhooks").where({ id }).first();
  return row ? hydrate(row) : undefined;
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
  const [row] = await db<RepoWebhookRow>("repo_webhooks")
    .insert({
      repo_id: data.repo_id,
      url: data.url,
      events: JSON.stringify(data.events),
      active: data.active ?? true,
    })
    .returning("*");
  return hydrate(row);
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

  const [row] = await db<RepoWebhookRow>("repo_webhooks")
    .where({ id })
    .update(patch)
    .returning("*");
  return hydrate(row);
}

export async function deleteWebhook(db: Knex, id: number): Promise<number> {
  return db<RepoWebhookRow>("repo_webhooks").where({ id }).delete();
}
