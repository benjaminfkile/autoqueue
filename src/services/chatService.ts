import Anthropic from "@anthropic-ai/sdk";
import { Knex } from "knex";
import { getRepoById } from "../db/repos";
import { listLinksForRepo } from "../db/repoLinks";
import { getTasksByRepoId } from "../db/tasks";
import { Repo, Task } from "../interfaces";
import {
  listFiles,
  ListFilesInput,
  readFile,
  ReadFileInput,
  search,
  SearchInput,
} from "./repoTools";

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
export const LIST_REPOS_TOOL_NAME = "list_repos";

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
    "Search a repo's clone for a pattern, ripgrep-style. Use this to find " +
    "symbols, references, or strings across the codebase before reading " +
    "specific files. Returns matching path/line/preview tuples. " +
    "Constraints: `pattern` is a regular expression by default; pass " +
    "`literal: true` to search for the pattern as a fixed string instead " +
    "(useful when the query contains regex metacharacters you don't want " +
    "interpreted). Optional `path` scopes the search to a subdirectory " +
    "(relative to the repo root, no `..`). `.gitignore` is respected and " +
    "results are capped to a fixed number of matches; if you hit the cap, " +
    "narrow `pattern` or scope by `path`. Read-only; this tool never " +
    "modifies the working tree.",
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
          "Pattern to search for. Treated as a regular expression unless " +
          "`literal` is true. Be specific to keep the result set small.",
      },
      path: {
        type: "string",
        description:
          "Optional subdirectory (relative to the repo root) to scope the " +
          "search to. Must not contain `..` segments.",
      },
      literal: {
        type: "boolean",
        description:
          "When true, treat `pattern` as a literal string instead of a " +
          "regular expression. Defaults to false (regex mode).",
      },
    },
  },
};

export const LIST_REPOS_TOOL = {
  name: LIST_REPOS_TOOL_NAME,
  description:
    "List the repos this chat can browse with the other read-only tools. " +
    "When the chat is scoped to a repo, the available set is that repo plus " +
    "any directly-linked repos (a single hop — transitive links are NOT " +
    "followed). Each entry includes its `id`, a human-readable `slug`, " +
    "whether it is the primary (the repo the chat is anchored to), and the " +
    "link `role` for non-primary entries (the descriptive label set when the " +
    "link was created; null when no role was given). Use this whenever you " +
    "need to know which `repo_id` values you may pass to `list_files`, " +
    "`read_file`, or `search`. Read-only.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
};

// Convenience bundle of every read-only repo tool. Call sites that wire the
// planning chat into the Anthropic streaming call should pass these alongside
// `PROPOSE_TASK_TREE_TOOL` so the model can browse the discussed repo.
export const REPO_READ_TOOLS = [
  LIST_FILES_TOOL,
  READ_FILE_TOOL,
  SEARCH_TOOL,
  LIST_REPOS_TOOL,
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

// One repo entry in the chat's read-only scope. Each row corresponds to
// either the primary repo (the one the chat is anchored to) or a directly-
// linked sibling. `role` is the link's descriptive label (e.g. "frontend"),
// shared by both sides of the symmetric link; the primary itself has no role.
export interface ChatRepoScopeEntry {
  id: number;
  slug: string;
  is_primary: boolean;
  role: string | null;
}

// The complete set of repos a chat may browse via list_files/read_file/search.
// Built once per chat request as: { primary repo } ∪ { repos directly linked
// to primary }. Transitive links are deliberately NOT followed — a regression
// that walks more than one hop would bypass the per-link permission boundary
// the user set up when creating the link.
export interface ChatRepoScope {
  primary_repo_id: number;
  repos: ChatRepoScopeEntry[];
}

export interface ChatContext {
  repo?: Repo;
  recentTasks?: Task[];
  scope?: ChatRepoScope;
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
    `## Read-only repo tools\nWhen the user is discussing a specific repo, you can browse its clone with four read-only tools — there are no write/edit/exec counterparts.\n- \`${LIST_REPOS_TOOL_NAME}()\` — list the repos in scope for this chat (the primary repo plus any directly-linked repos). Each entry has an \`id\`, a \`slug\`, an \`is_primary\` flag, and the link \`role\` for non-primary entries. Call this whenever you are unsure which \`repo_id\` values are valid.\n- \`${LIST_FILES_TOOL_NAME}(repo_id, path?, depth?)\` — list directory entries to understand the layout. \`path\` is relative to the repo root; \`depth\` defaults to 1 (max 3).\n- \`${READ_FILE_TOOL_NAME}(repo_id, path, start_line?, end_line?)\` — read a slice of a file. Output is byte-capped, so for large files pass \`start_line\`/\`end_line\` (1-indexed, inclusive).\n- \`${SEARCH_TOOL_NAME}(repo_id, pattern, path?, literal?)\` — regex search across the clone (pass \`literal: true\` for a fixed-string match). Be specific; results are capped, so narrow \`pattern\` or scope by \`path\` if you hit the cap.\nUse these to ground your suggestions in the actual code instead of guessing. Prefer \`${SEARCH_TOOL_NAME}\` to locate symbols, then \`${READ_FILE_TOOL_NAME}\` to inspect them. Paths are always relative to the repo root and traversal (\`..\`) is rejected. \`repo_id\` must be one of the repos returned by \`${LIST_REPOS_TOOL_NAME}\` — the chat sees the primary repo and its directly-linked siblings only (no transitive expansion).`
  );

  if (context.repo) {
    sections.push(`## Current repo\n${formatRepo(context.repo)}`);
  }

  if (context.scope && context.scope.repos.length > 1) {
    const linked = context.scope.repos.filter((r) => !r.is_primary);
    const lines = linked.map((r) => {
      const role = r.role ? ` (role: ${r.role})` : "";
      return `- id ${r.id}: ${r.slug}${role}`;
    });
    sections.push(
      `## Linked repos (read-only, one hop)\nThe primary repo is linked to the following repos. You can pass any of their ids to \`${LIST_FILES_TOOL_NAME}\`/\`${READ_FILE_TOOL_NAME}\`/\`${SEARCH_TOOL_NAME}\`. Links are NOT transitive — repos linked to these repos are not in scope.\n${lines.join("\n")}`
    );
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

function repoSlug(repo: Repo): string {
  if (repo.owner && repo.repo_name) return `${repo.owner}/${repo.repo_name}`;
  return repo.local_path ?? `repo#${repo.id}`;
}

function formatRepo(repo: Repo): string {
  return [
    `id: ${repo.id}`,
    `slug: ${repoSlug(repo)}`,
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
  const scope = await loadRepoScope(db, repo);
  return { repo, recentTasks, scope };
}

// Build the read-only scope for a chat anchored to `primary`. Walks the
// repo_links table once and resolves each linked id to a real repo row so
// callers see slugs/roles, not just ids. Links pointing to repos that no
// longer exist are dropped silently — the caller cannot meaningfully use a
// dangling id and a hard error here would block the whole chat.
//
// IMPORTANT: this is a single-hop expansion. We do NOT recurse into the
// linked repos' own links — that would silently widen the scope past what the
// user explicitly authorized when they created each link.
async function loadRepoScope(db: Knex, primary: Repo): Promise<ChatRepoScope> {
  const links = await listLinksForRepo(db, primary.id);
  const linkedEntries: ChatRepoScopeEntry[] = [];
  for (const link of links) {
    const otherId =
      link.repo_a_id === primary.id ? link.repo_b_id : link.repo_a_id;
    const other = await getRepoById(db, otherId);
    if (!other) continue;
    linkedEntries.push({
      id: other.id,
      slug: repoSlug(other),
      is_primary: false,
      role: link.role,
    });
  }
  return {
    primary_repo_id: primary.id,
    repos: [
      {
        id: primary.id,
        slug: repoSlug(primary),
        is_primary: true,
        role: null,
      },
      ...linkedEntries,
    ],
  };
}

export interface StreamChatOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  system: string;
  messages: ChatMessage[];
  client?: AnthropicLike;
  tools?: AnthropicTool[];
  // When provided, the streaming loop will execute server-side handlers for
  // the read-only repo tools (list_files, read_file, search) and feed the
  // results back to the model so the conversation can continue across as many
  // tool turns as the model needs. Without this, repo tools surface as
  // is_error=true tool_results telling the model the tool is unavailable.
  repoToolsContext?: RepoToolsContext;
  // Safety net for the multi-turn tool-use loop: if the model keeps issuing
  // tool calls without ever stopping, we bail after this many turns. Defaults
  // to MAX_TOOL_TURNS.
  maxToolTurns?: number;
}

export interface RepoToolsContext {
  db: Knex;
  reposPath: string;
  // When set, list_files/read_file/search calls whose `repo_id` is not in
  // `scope.repos` are rejected with an is_error tool_result. When undefined
  // (e.g. a chat with no anchoring repo, or a test that does not bother
  // building a scope), no enforcement happens — the underlying tool's own
  // repo lookup is the only gate.
  scope?: ChatRepoScope;
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

// One slot of an assistant or user message's `content` array. Mirrors the
// subset of Anthropic content blocks we actually emit during the tool-use
// loop. The SDK accepts a richer union; we narrow to what the loop needs.
export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

// Anthropic accepts message content as a string OR an array of content
// blocks. The chatRouter feeds in plain strings; the multi-turn loop appends
// content-block arrays to carry tool_use / tool_result blocks.
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ChatContentBlock[];
}

// Narrow surface of the SDK we actually use, kept as an interface so tests can
// inject a fake client without depending on the full SDK type tree.
export interface AnthropicLike {
  messages: {
    create: (body: {
      model: string;
      max_tokens: number;
      system: string;
      messages: AnthropicMessage[];
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
    stop_reason?: string;
    [k: string]: unknown;
  };
  [key: string]: unknown;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "proposal"; proposal: TaskTreeProposal }
  | { type: "proposal_error"; error: string; raw: unknown };

// Default upper bound on tool-use round trips per chat reply. Real planning
// conversations rarely need more than a handful; the cap is just a safety
// net against a runaway model that keeps re-issuing tool calls.
const MAX_TOOL_TURNS = 16;

export async function* streamChatEvents(
  options: StreamChatOptions
): AsyncGenerator<ChatStreamEvent, void, void> {
  const client: AnthropicLike =
    options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicLike);

  // Working copy of the conversation. Each tool-use round appends:
  //   - the assistant turn (text + tool_use blocks)
  //   - the user turn (tool_result blocks)
  // ...so the next API call sees the full context.
  const conversation: AnthropicMessage[] = options.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const maxTurns = options.maxToolTurns ?? MAX_TOOL_TURNS;

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = await client.messages.create({
      model: options.model ?? DEFAULT_MODEL,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: options.system,
      messages: conversation,
      stream: true,
      ...(options.tools ? { tools: options.tools } : {}),
    });

    // Per-turn state: text we've seen on this assistant turn (so we can
    // replay it back into the conversation history) and tool_use blocks
    // assembled from input_json_delta events keyed by stream index.
    const textParts: string[] = [];
    const toolBlocks = new Map<
      number,
      { id: string; name: string; partials: string[] }
    >();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (
          block &&
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          typeof block.id === "string" &&
          typeof event.index === "number"
        ) {
          toolBlocks.set(event.index, {
            id: block.id,
            name: block.name,
            partials: [],
          });
        }
        continue;
      }

      if (event.type === "content_block_delta") {
        if (
          event.delta &&
          event.delta.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          // Stream user-visible text deltas straight through so the SSE
          // consumer sees the assistant's reply build up in real time.
          yield { type: "text", text: event.delta.text };
          textParts.push(event.delta.text);
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
      // Other events (message_start, content_block_stop, message_delta,
      // message_stop) carry no payload we need for this loop.
    }

    // No tool calls in this turn → the model is done; exit the loop.
    if (toolBlocks.size === 0) return;

    // Assemble the assistant turn we just streamed so the next API call
    // sees the same content blocks the model emitted.
    const assistantContent: ChatContentBlock[] = [];
    if (textParts.length > 0) {
      assistantContent.push({ type: "text", text: textParts.join("") });
    }
    // Iterate in stream-index order so the assistant message preserves the
    // original block sequence.
    const orderedBlocks = Array.from(toolBlocks.entries()).sort(
      (a, b) => a[0] - b[0]
    );
    for (const [, tu] of orderedBlocks) {
      const joined = tu.partials.join("");
      const parsedInput = joined.length === 0 ? {} : safeJsonParse(joined);
      assistantContent.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        // If parsing failed we still need *some* input on the assistant
        // turn so the message echoes what the model actually emitted; we
        // fall back to an empty object since the model's downstream view
        // will be the matching is_error tool_result anyway.
        input: parsedInput === SAFE_PARSE_FAILURE ? {} : parsedInput,
      });
    }
    conversation.push({ role: "assistant", content: assistantContent });

    // Run every tool_use, gather tool_results, surface SSE events for the
    // proposal tool. Errors become tool_result blocks with is_error=true so
    // the model can read the failure and either retry or apologize.
    //
    // `propose_task_tree` is treated as a terminal tool: once the model
    // emits a proposal (valid or invalid), the user owns the next move
    // (review, materialize, edit) and the assistant has nothing useful to
    // add. We still process every other tool_use in the same turn so the
    // SSE consumer sees any read-only tool calls the model issued, but we
    // skip the follow-up API call that would otherwise feed tool_results
    // back in.
    let sawProposalTool = false;
    const toolResults: ChatContentBlock[] = [];
    for (const [, tu] of orderedBlocks) {
      const joined = tu.partials.join("");
      const parsedInput = joined.length === 0 ? {} : safeJsonParse(joined);

      if (parsedInput === SAFE_PARSE_FAILURE) {
        const errMsg = "tool input was not valid JSON";
        if (tu.name === PROPOSE_TASK_TREE_TOOL_NAME) {
          sawProposalTool = true;
          yield { type: "proposal_error", error: errMsg, raw: joined };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: errMsg,
          is_error: true,
        });
        continue;
      }

      if (tu.name === PROPOSE_TASK_TREE_TOOL_NAME) {
        sawProposalTool = true;
        const validated = validateTaskTreeProposal(parsedInput);
        if (validated.valid) {
          yield { type: "proposal", proposal: validated.proposal };
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Task tree proposal recorded. The user is reviewing it now.",
          });
        } else {
          yield {
            type: "proposal_error",
            error: validated.error,
            raw: parsedInput,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: validated.error,
            is_error: true,
          });
        }
        continue;
      }

      // All remaining tools are read-only repo tools. Without a context, we
      // cannot dispatch them — surface that explicitly so the model gets a
      // useful error rather than a silent hang.
      if (!options.repoToolsContext) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `tool ${tu.name} is not available in this context`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await dispatchRepoTool(
          options.repoToolsContext,
          tu.name,
          parsedInput
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: (err as Error).message,
          is_error: true,
        });
      }
    }

    // If the model emitted propose_task_tree this turn, stop here — the
    // proposal is the conversation's terminal artifact and any further
    // assistant text would just delay the user's review of it.
    if (sawProposalTool) return;

    conversation.push({ role: "user", content: toolResults });
  }
}

// Dispatch a single read-only repo tool by name. Each branch returns the
// tool_result `content` string the model will see plus whether the call
// failed (so the loop can flip is_error on the tool_result block). We only
// throw for things truly outside the model's control (e.g. an unexpected JS
// error inside the tool); a normal "ok:false" result is mapped to is_error
// rather than thrown so the model can read and react to it.
async function dispatchRepoTool(
  ctx: RepoToolsContext,
  name: string,
  input: unknown
): Promise<{ content: string; isError: boolean }> {
  if (name === LIST_REPOS_TOOL_NAME) {
    if (!ctx.scope) {
      return {
        content:
          "list_repos: this chat is not scoped to a repo, so no repos are available.",
        isError: true,
      };
    }
    return {
      content: JSON.stringify({ repos: ctx.scope.repos }),
      isError: false,
    };
  }
  if (
    name === LIST_FILES_TOOL_NAME ||
    name === READ_FILE_TOOL_NAME ||
    name === SEARCH_TOOL_NAME
  ) {
    const scopeError = checkRepoIdInScope(ctx, input);
    if (scopeError) return { content: scopeError, isError: true };
  }
  if (name === LIST_FILES_TOOL_NAME) {
    const result = await listFiles(
      ctx.db,
      ctx.reposPath,
      input as ListFilesInput
    );
    if (!result.ok) return { content: result.error, isError: true };
    return {
      content: JSON.stringify({
        entries: result.entries,
        truncated: result.truncated,
      }),
      isError: false,
    };
  }
  if (name === READ_FILE_TOOL_NAME) {
    const result = await readFile(
      ctx.db,
      ctx.reposPath,
      input as ReadFileInput
    );
    if (!result.ok) return { content: result.error, isError: true };
    return { content: result.content, isError: false };
  }
  if (name === SEARCH_TOOL_NAME) {
    const result = await search(
      ctx.db,
      ctx.reposPath,
      input as SearchInput
    );
    if (!result.ok) return { content: result.error, isError: true };
    return {
      content: JSON.stringify({
        matches: result.matches,
        truncated: result.truncated,
      }),
      isError: false,
    };
  }
  return { content: `unknown tool: ${name}`, isError: true };
}

// Reject a tool call whose `repo_id` is not in the chat's scope. Only runs
// when the caller built a scope; absent a scope (no anchoring repo) the
// underlying tool's own repo lookup is the only gate, which is the same
// behavior the tools had before scope was introduced.
function checkRepoIdInScope(
  ctx: RepoToolsContext,
  input: unknown
): string | null {
  if (!ctx.scope) return null;
  const requested = (input as { repo_id?: unknown })?.repo_id;
  // Defer non-numeric/missing repo_id to the tool's own validator — its
  // error message is more specific than anything we could produce here.
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return null;
  }
  if (ctx.scope.repos.some((r) => r.id === requested)) return null;
  const allowed = ctx.scope.repos.map((r) => r.id).join(", ");
  return (
    `repo_id ${requested} is not in scope for this chat. ` +
    `Allowed repo ids: ${allowed}. ` +
    `Call list_repos to see the available repos with their roles.`
  );
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
