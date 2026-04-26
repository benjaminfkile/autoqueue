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

// ---- propose_task_tree tool ------------------------------------------------
// The agent calls this tool (Anthropic tool use) when it is ready to commit a
// proposed task tree. Server-side we validate the input and surface it to the
// caller as a structured `proposal` event.

export const PROPOSE_TASK_TREE_TOOL_NAME = "propose_task_tree";

const TASK_NODE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptance_criteria: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    children: {
      type: "array",
      items: { $ref: "#/$defs/task_node" },
    },
  },
};

export const PROPOSE_TASK_TREE_TOOL = {
  name: PROPOSE_TASK_TREE_TOOL_NAME,
  description:
    "Propose a tree of tasks the user can review and materialize into Grunt. " +
    "Call this tool only when you have a concrete plan. Each `parent` may have " +
    "nested `children` (recursive). Workers only run leaves, so put concrete " +
    "actionable work in the leaves and use parents for grouping. " +
    "Acceptance criteria should be terse, testable bullet points.",
  input_schema: {
    type: "object" as const,
    required: ["parents"],
    $defs: {
      task_node: TASK_NODE_SCHEMA,
    },
    properties: {
      parents: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/task_node" },
      },
    },
  },
};

export interface ProposedTaskNode {
  title: string;
  description?: string;
  acceptance_criteria?: string[];
  children?: ProposedTaskNode[];
}

export interface TaskTreeProposal {
  parents: ProposedTaskNode[];
}

// ---- Read-only repo tools --------------------------------------------------
// These three tools let the planning assistant inspect the clone of the repo
// it is discussing. They are read-only by construction: there is no write/edit
// /exec counterpart. Each tool takes the `repo_id` it operates on so the
// server-side handler can resolve the right clone, and `path` is always
// interpreted relative to the repo root with traversal explicitly forbidden.
// All three handlers MUST route untrusted `path` input through
// `resolveRepoPath` in services/repoPath.ts — that is the single, audited
// place where repo-id + relative-path is turned into an absolute filesystem
// path. Any handler that builds an absolute path some other way is a bug.

export const LIST_FILES_TOOL_NAME = "list_files";
export const READ_FILE_TOOL_NAME = "read_file";
export const SEARCH_TOOL_NAME = "search";

export const LIST_FILES_TOOL = {
  name: LIST_FILES_TOOL_NAME,
  description:
    "List directory entries inside a repo's clone. Use this to discover the " +
    "layout of the codebase before reading specific files. Returns names, " +
    "type (file/dir), and (for files) byte size. " +
    "Constraints: `path` is relative to the repo root; absolute paths and " +
    "anything that escapes the repo (`..`, symlink targets outside the clone) " +
    "are rejected. `depth` controls recursion (1 = the directory itself, " +
    "2 = one level of children, …); default 1, max 3. Results are capped to " +
    "a sane number of entries — do not rely on listing very large trees in " +
    "one call. Read-only; this tool never modifies the working tree.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["repo_id"],
    properties: {
      repo_id: {
        type: "integer",
        minimum: 1,
        description: "Id of the repo whose clone should be listed.",
      },
      path: {
        type: "string",
        description:
          "Directory path relative to the repo root. Defaults to the repo " +
          "root when omitted. Must not contain `..` segments.",
      },
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        description:
          "How many levels of nesting to include (default 1, max 3). " +
          "Use 1 for a flat listing of the directory itself.",
      },
    },
  },
};

export const READ_FILE_TOOL = {
  name: READ_FILE_TOOL_NAME,
  description:
    "Read a slice of a file from a repo's clone. Use this to inspect the " +
    "actual contents of source files you have already located via " +
    "`list_files` or `search`. Returns the requested lines as text. " +
    "Constraints: `path` is relative to the repo root; absolute paths and " +
    "traversal (`..`, symlinks pointing outside the clone) are rejected. " +
    "Output is truncated to a fixed byte cap, so for large files you must " +
    "pass `start_line`/`end_line` to scope the read. `start_line` and " +
    "`end_line` are 1-indexed and inclusive. Binary files are not returned. " +
    "Read-only; this tool never modifies the working tree.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["repo_id", "path"],
    properties: {
      repo_id: {
        type: "integer",
        minimum: 1,
        description: "Id of the repo whose clone should be read.",
      },
      path: {
        type: "string",
        minLength: 1,
        description:
          "File path relative to the repo root. Must not contain `..` " +
          "segments and must resolve to a regular file inside the clone.",
      },
      start_line: {
        type: "integer",
        minimum: 1,
        description:
          "1-indexed inclusive line to start reading from. Defaults to 1.",
      },
      end_line: {
        type: "integer",
        minimum: 1,
        description:
          "1-indexed inclusive line to stop reading at. Defaults to the end " +
          "of the file (subject to the byte cap).",
      },
    },
  },
};

export const SEARCH_TOOL = {
  name: SEARCH_TOOL_NAME,
  description:
    "Search a repo's clone for a regex pattern, ripgrep-style. Use this to " +
    "find symbols, references, or strings across the codebase before " +
    "reading specific files. Returns matching path/line/preview tuples. " +
    "Constraints: `pattern` is a regular expression; keep it specific — " +
    "broad patterns are rejected to avoid huge result sets. Optional " +
    "`path` scopes the search to a subdirectory (relative to the repo " +
    "root, no `..`). Results are capped to a fixed number of matches; if " +
    "you hit the cap, narrow `pattern` or scope by `path`. Read-only; this " +
    "tool never modifies the working tree.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["repo_id", "pattern"],
    properties: {
      repo_id: {
        type: "integer",
        minimum: 1,
        description: "Id of the repo whose clone should be searched.",
      },
      pattern: {
        type: "string",
        minLength: 1,
        description:
          "Regular expression to search for. Be specific to keep the " +
          "result set small.",
      },
      path: {
        type: "string",
        description:
          "Optional subdirectory (relative to the repo root) to scope the " +
          "search to. Must not contain `..` segments.",
      },
    },
  },
};

// Convenience bundle of every read-only repo tool. Call sites that wire the
// planning chat into the Anthropic streaming call should pass these alongside
// `PROPOSE_TASK_TREE_TOOL` so the model can browse the discussed repo.
export const REPO_READ_TOOLS = [
  LIST_FILES_TOOL,
  READ_FILE_TOOL,
  SEARCH_TOOL,
];

export type ValidateProposalResult =
  | { valid: true; proposal: TaskTreeProposal }
  | { valid: false; error: string };

export function validateTaskTreeProposal(input: unknown): ValidateProposalResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "proposal must be an object" };
  }
  const root = input as { parents?: unknown };
  if (!Array.isArray(root.parents) || root.parents.length === 0) {
    return { valid: false, error: "parents must be a non-empty array" };
  }
  const parents: ProposedTaskNode[] = [];
  for (let i = 0; i < root.parents.length; i++) {
    const result = validateNode(root.parents[i], `parents[${i}]`);
    if (!result.valid) return result;
    parents.push(result.node);
  }
  return { valid: true, proposal: { parents } };
}

type NodeResult =
  | { valid: true; node: ProposedTaskNode }
  | { valid: false; error: string };

function validateNode(input: unknown, path: string): NodeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: `${path} must be an object` };
  }
  const raw = input as {
    title?: unknown;
    description?: unknown;
    acceptance_criteria?: unknown;
    children?: unknown;
  };
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    return { valid: false, error: `${path}.title must be a non-empty string` };
  }
  const node: ProposedTaskNode = { title: raw.title };
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      return { valid: false, error: `${path}.description must be a string` };
    }
    node.description = raw.description;
  }
  if (raw.acceptance_criteria !== undefined) {
    if (!Array.isArray(raw.acceptance_criteria)) {
      return {
        valid: false,
        error: `${path}.acceptance_criteria must be an array of strings`,
      };
    }
    const ac: string[] = [];
    for (let i = 0; i < raw.acceptance_criteria.length; i++) {
      const item = raw.acceptance_criteria[i];
      if (typeof item !== "string" || item.trim().length === 0) {
        return {
          valid: false,
          error: `${path}.acceptance_criteria[${i}] must be a non-empty string`,
        };
      }
      ac.push(item);
    }
    node.acceptance_criteria = ac;
  }
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) {
      return { valid: false, error: `${path}.children must be an array` };
    }
    const children: ProposedTaskNode[] = [];
    for (let i = 0; i < raw.children.length; i++) {
      const childResult = validateNode(
        raw.children[i],
        `${path}.children[${i}]`
      );
      if (!childResult.valid) return childResult;
      children.push(childResult.node);
    }
    node.children = children;
  }
  return { valid: true, node };
}

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

  sections.push(
    `## Proposing a task tree\nWhen — and only when — you and the user have converged on a concrete plan, call the \`${PROPOSE_TASK_TREE_TOOL_NAME}\` tool with the proposed tree. Until then, keep discussing in plain text. Workers only run leaf tasks, so put concrete actionable work in the leaves and use parents for grouping. Each task's \`acceptance_criteria\` should be terse, testable bullet points.`
  );

  sections.push(
    `## Read-only repo tools\nWhen the user is discussing a specific repo, you can browse its clone with three read-only tools — there are no write/edit/exec counterparts.\n- \`${LIST_FILES_TOOL_NAME}(repo_id, path?, depth?)\` — list directory entries to understand the layout. \`path\` is relative to the repo root; \`depth\` defaults to 1 (max 3).\n- \`${READ_FILE_TOOL_NAME}(repo_id, path, start_line?, end_line?)\` — read a slice of a file. Output is byte-capped, so for large files pass \`start_line\`/\`end_line\` (1-indexed, inclusive).\n- \`${SEARCH_TOOL_NAME}(repo_id, pattern, path?)\` — regex search across the clone. Be specific; results are capped, so narrow \`pattern\` or scope by \`path\` if you hit the cap.\nUse these to ground your suggestions in the actual code instead of guessing. Prefer \`${SEARCH_TOOL_NAME}\` to locate symbols, then \`${READ_FILE_TOOL_NAME}\` to inspect them. Paths are always relative to the repo root and traversal (\`..\`) is rejected.`
  );

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
  tools?: AnthropicTool[];
}

// Anthropic tool definition (Tool from the SDK). We mirror the relevant
// fields here to avoid leaking the SDK's full type tree into call sites.
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    [k: string]: unknown;
  };
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
      tools?: AnthropicTool[];
    }) => Promise<AsyncIterable<AnthropicStreamEvent>>;
  };
}

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    name?: string;
    id?: string;
    [k: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    [k: string]: unknown;
  };
  [key: string]: unknown;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "proposal"; proposal: TaskTreeProposal }
  | { type: "proposal_error"; error: string; raw: unknown };

export async function* streamChatEvents(
  options: StreamChatOptions
): AsyncGenerator<ChatStreamEvent, void, void> {
  const client: AnthropicLike =
    options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicLike);

  const stream = await client.messages.create({
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: options.system,
    messages: options.messages,
    stream: true,
    ...(options.tools ? { tools: options.tools } : {}),
  });

  // Track in-flight tool_use blocks by stream index so we can buffer the
  // partial_json deltas and assemble the full input on content_block_stop.
  const toolBlocks = new Map<number, { name: string; partials: string[] }>();

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (
        block &&
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        typeof event.index === "number"
      ) {
        toolBlocks.set(event.index, { name: block.name, partials: [] });
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      if (
        event.delta &&
        event.delta.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        yield { type: "text", text: event.delta.text };
        continue;
      }
      if (
        event.delta &&
        event.delta.type === "input_json_delta" &&
        typeof event.delta.partial_json === "string" &&
        typeof event.index === "number"
      ) {
        const tracked = toolBlocks.get(event.index);
        if (tracked) tracked.partials.push(event.delta.partial_json);
      }
      continue;
    }

    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const tracked = toolBlocks.get(event.index);
      if (!tracked) continue;
      toolBlocks.delete(event.index);
      if (tracked.name !== PROPOSE_TASK_TREE_TOOL_NAME) continue;

      const joined = tracked.partials.join("");
      // The model may emit zero deltas when the input object is empty.
      const raw = joined.length === 0 ? {} : safeJsonParse(joined);
      if (raw === SAFE_PARSE_FAILURE) {
        yield {
          type: "proposal_error",
          error: "tool input was not valid JSON",
          raw: joined,
        };
        continue;
      }
      const result = validateTaskTreeProposal(raw);
      if (result.valid) {
        yield { type: "proposal", proposal: result.proposal };
      } else {
        yield { type: "proposal_error", error: result.error, raw };
      }
    }
  }
}

const SAFE_PARSE_FAILURE = Symbol("json-parse-failure");
function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return SAFE_PARSE_FAILURE;
  }
}

// Backwards-compatible thin wrapper that yields only text deltas. New callers
// should prefer `streamChatEvents`, which surfaces tool-use proposals too.
export async function* streamChatTextDeltas(
  options: StreamChatOptions
): AsyncGenerator<string, void, void> {
  for await (const event of streamChatEvents(options)) {
    if (event.type === "text") yield event.text;
  }
}
