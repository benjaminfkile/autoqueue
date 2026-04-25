import Anthropic from "@anthropic-ai/sdk";
import { Knex } from "knex";
import { getRepoById } from "../db/repos";
import { getTasksByRepoId } from "../db/tasks";
import { Repo, Task } from "../interfaces";

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 4096;
const RECENT_TASK_LIMIT = 10;

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// The schema block embedded in the system prompt so the model understands the
// shape of the planning artifacts it is going to propose. Kept terse — the
// authoritative definitions live in src/interfaces.ts.
export const GRUNT_SCHEMA = `Grunt data model (relevant fields only):
- repos(id, owner, repo_name, base_branch, ordering_mode, on_failure, on_parent_child_fail, is_local_folder, local_path)
- tasks(id, repo_id, parent_id, title, description, order_position, status, ordering_mode)
  status ∈ {pending, active, done, failed}
  ordering_mode ∈ {sequential, parallel} (per-task override; nullable)
- acceptance_criteria(id, task_id, description, order_position, met)
- task_notes(id, task_id, author, visibility, tags, content)
  author ∈ {agent, user}
  visibility ∈ {self, siblings, descendants, ancestors, all}
- task_events(id, task_id, ts, event, data)

Tasks form a tree via parent_id. A task is a "leaf" when it has no children.
Workers only run leaf tasks; parents auto-complete when their children do.`;

export interface ChatContext {
  repo?: Repo;
  recentTasks?: Task[];
}

export function buildSystemPrompt(context: ChatContext = {}): string {
  const sections: string[] = [];

  sections.push(
    "You are Grunt's in-app planning assistant. The user is describing a project, feature, or bug; your job is to help them think through it and ultimately propose a task tree they can materialize."
  );

  sections.push(`## Schema\n${GRUNT_SCHEMA}`);

  if (context.repo) {
    sections.push(`## Current repo\n${formatRepo(context.repo)}`);
  }

  if (context.recentTasks && context.recentTasks.length > 0) {
    sections.push(
      `## Recent task history (most recent ${context.recentTasks.length})\n${context.recentTasks
        .map(formatTask)
        .join("\n")}`
    );
  }

  return sections.join("\n\n");
}

function formatRepo(repo: Repo): string {
  const slug =
    repo.owner && repo.repo_name
      ? `${repo.owner}/${repo.repo_name}`
      : repo.local_path ?? `repo#${repo.id}`;
  return [
    `id: ${repo.id}`,
    `slug: ${slug}`,
    `base_branch: ${repo.base_branch}`,
    `ordering_mode: ${repo.ordering_mode}`,
    `on_failure: ${repo.on_failure}`,
    repo.is_local_folder ? `local_folder: ${repo.local_path ?? ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTask(task: Task): string {
  const parent = task.parent_id != null ? ` parent=${task.parent_id}` : "";
  return `- #${task.id} [${task.status}]${parent} ${task.title}`;
}

export async function loadChatContext(
  db: Knex,
  repoId: number | null | undefined
): Promise<ChatContext> {
  if (repoId == null) return {};
  const repo = await getRepoById(db, repoId);
  if (!repo) return {};
  const allTasks = await getTasksByRepoId(db, repoId);
  const recentTasks = allTasks
    .slice()
    .sort((a, b) => {
      const aTs = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTs = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bTs - aTs;
    })
    .slice(0, RECENT_TASK_LIMIT);
  return { repo, recentTasks };
}

export interface StreamChatOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  system: string;
  messages: ChatMessage[];
  client?: AnthropicLike;
}

// Narrow surface of the SDK we actually use, kept as an interface so tests can
// inject a fake client without depending on the full SDK type tree.
export interface AnthropicLike {
  messages: {
    create: (body: {
      model: string;
      max_tokens: number;
      system: string;
      messages: ChatMessage[];
      stream: true;
    }) => Promise<AsyncIterable<AnthropicStreamEvent>>;
  };
}

export interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string };
  [key: string]: unknown;
}

export async function* streamChatTextDeltas(
  options: StreamChatOptions
): AsyncGenerator<string, void, void> {
  const client: AnthropicLike =
    options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicLike);

  const stream = await client.messages.create({
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: options.system,
    messages: options.messages,
    stream: true,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      yield event.delta.text;
    }
  }
}
