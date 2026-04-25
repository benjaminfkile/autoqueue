import { Knex } from "knex";
import { Repo, RepoWebhook, Task, WebhookEvent } from "../interfaces";
import { getWebhooksByRepoId } from "../db/repoWebhooks";

// Slack-compatible incoming-webhook payload. Slack accepts `text` as the only
// required field; richer renderers (Slack, Discord, Teams via their Slack
// shims) ignore unknown fields, so adding `event` / `repo` / `task` keeps the
// payload portable while still letting consumers route on event type without
// re-parsing the human-readable string.
export interface WebhookPayload {
  text: string;
  event: WebhookEvent;
  repo: {
    id: number;
    owner: string | null;
    repo_name: string | null;
  };
  task: {
    id: number;
    title: string;
    status: Task["status"];
    pr_url: string | null;
  };
}

export const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;

function buildPayload(
  event: WebhookEvent,
  repo: Repo,
  task: Task
): WebhookPayload {
  const repoLabel = repo.is_local_folder
    ? repo.local_path ?? `repo#${repo.id}`
    : `${repo.owner}/${repo.repo_name}`;

  const verb =
    event === "done"
      ? "completed"
      : event === "halted"
      ? "halted (max retries exhausted)"
      : "failed";

  return {
    text: `Task #${task.id} "${task.title}" ${verb} in ${repoLabel}`,
    event,
    repo: {
      id: repo.id,
      owner: repo.owner,
      repo_name: repo.repo_name,
    },
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      pr_url: task.pr_url,
    },
  };
}

interface DeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

// Posts the payload to the URL with retry on 5xx. Drops after
// MAX_DELIVERY_ATTEMPTS. 4xx is a permanent client error and is not retried.
// Network errors retry the same as 5xx (transient by assumption).
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts?: { maxAttempts?: number; backoffMs?: number }
): Promise<DeliveryResult> {
  const max = opts?.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const backoff = opts?.backoffMs ?? RETRY_BACKOFF_MS;

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, attempts: attempt, status: res.status };
      }
      // 4xx is a permanent client error — don't retry.
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          attempts: attempt,
          status: res.status,
          error: `HTTP ${res.status}`,
        };
      }
      // 5xx and other non-2xx → fall through to retry.
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }

    if (attempt < max) {
      await new Promise((r) => setTimeout(r, backoff * attempt));
    }
  }

  return { ok: false, attempts: max, status: lastStatus, error: lastError };
}

// Looks up every active webhook configured on the repo, filters by the
// event type, and posts to each in parallel. Errors are logged but never
// thrown — task-pipeline progress must not be coupled to webhook delivery.
export async function fireWebhooksForRepo(
  db: Knex,
  repo: Repo,
  task: Task,
  event: WebhookEvent
): Promise<void> {
  let webhooks: RepoWebhook[];
  try {
    webhooks = await getWebhooksByRepoId(db, repo.id);
  } catch (err) {
    console.error(
      `[webhookDelivery] Failed to load webhooks for repo #${repo.id}:`,
      err
    );
    return;
  }

  const targets = webhooks.filter(
    (w) => w.active && Array.isArray(w.events) && w.events.includes(event)
  );

  if (targets.length === 0) return;

  const payload = buildPayload(event, repo, task);

  await Promise.all(
    targets.map(async (w) => {
      try {
        const result = await deliverWebhook(w.url, payload);
        if (!result.ok) {
          console.error(
            `[webhookDelivery] Webhook #${w.id} (${w.url}) failed after ${result.attempts} attempt(s): ${result.error ?? "unknown"}`
          );
        }
      } catch (err) {
        console.error(
          `[webhookDelivery] Unexpected error delivering webhook #${w.id}:`,
          err
        );
      }
    })
  );
}

// Fire-and-forget wrapper: returns immediately so callers (taskRunner) don't
// block on HTTP. Errors are swallowed at this layer — fireWebhooksForRepo
// already logs.
export function triggerWebhooks(
  db: Knex,
  repo: Repo,
  task: Task,
  event: WebhookEvent
): void {
  fireWebhooksForRepo(db, repo, task, event).catch((err) => {
    console.error(
      `[webhookDelivery] Unhandled error firing '${event}' webhooks for repo #${repo.id}:`,
      err
    );
  });
}
