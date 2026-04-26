// ---- App / API secrets ----
export interface IAppSecrets {
  NODE_ENV: "development" | "production";
  PORT: string;
  API_KEY_HASH: string;
  GH_PAT?: string;
  ANTHROPIC_API_KEY?: string;
  REPOS_PATH: string;
  POLL_INTERVAL_SECONDS?: string;
  CLAUDE_PATH?: string;
  IS_WORKER?: string;
  // Selects which auth provider chain protects the API. Comma-separated list;
  // providers are tried in the order listed. When omitted, defaults to
  // 'apikey' for backwards compatibility.
  AUTH_PROVIDER?: "apikey" | "cognito" | "apikey,cognito" | "cognito,apikey";
  // Cognito auth provider config (optional — only required when AUTH_PROVIDER
  // selects Cognito).
  COGNITO_USER_POOL_ID?: string;
  COGNITO_CLIENT_ID?: string;
  // Cognito hosted-UI config (only required when the GUI should redirect to
  // the Cognito-hosted login page). e.g. "mygrunt.auth.us-east-1.amazoncognito.com".
  COGNITO_DOMAIN?: string;
  // Region of the Cognito user pool, used for region-aware Cognito IdP calls
  // (in-app username/password login). Inferred from the user pool id when omitted.
  COGNITO_REGION?: string;
  // Selects how the GUI obtains a token when AUTH_PROVIDER includes cognito.
  //   "hosted" → redirect to the Cognito-hosted UI (OAuth code flow)
  //   "inapp"  → render an in-app username/password form that POSTs to
  //              /api/auth/login (server-side InitiateAuth USER_PASSWORD_AUTH)
  // Defaults to "hosted" when COGNITO_DOMAIN is configured, otherwise "inapp".
  COGNITO_LOGIN_MODE?: "hosted" | "inapp";
  // Add additional app-level secrets here as needed
}

// ---- Failure policy enums (per-repo) ----
export type RepoOnFailure = "halt_repo" | "halt_subtree" | "retry" | "continue";
export type RepoOnParentChildFail = "cascade_fail" | "mark_partial" | "ignore";

// ---- Ordering mode (per-repo default; per-task override) ----
export type OrderingMode = "sequential" | "parallel";

// ---- Repos table row ----
export interface Repo {
  id: number;
  owner: string | null;
  repo_name: string | null;
  active: boolean;
  base_branch: string;
  base_branch_parent: string;
  require_pr: boolean;
  github_token: string | null;
  is_local_folder: boolean;
  local_path: string | null;
  on_failure: RepoOnFailure;
  max_retries: number;
  on_parent_child_fail: RepoOnParentChildFail;
  ordering_mode: OrderingMode;
  created_at: Date;
}

// ---- Tasks table row ----
export interface Task {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  description: string;
  order_position: number;
  status: "pending" | "active" | "done" | "failed";
  retry_count: number;
  pr_url: string | null;
  worker_id: string | null;
  leased_until: Date | null;
  ordering_mode: OrderingMode | null;
  log_path: string | null;
  requires_approval: boolean;
  created_at: Date;
}

// ---- Acceptance criteria table row ----
export interface AcceptanceCriterion {
  id: number;
  task_id: number;
  description: string;
  order_position: number;
  met: boolean;
  created_at: Date;
}

// ---- Task events table row ----
export interface TaskEvent {
  id: number;
  task_id: number;
  ts: Date;
  event: string;
  data: Record<string, unknown> | null;
}

// ---- Task notes (Phase 4: cross-task notes and context) ----
export type NoteAuthor = "agent" | "user";
export type NoteVisibility =
  | "self"
  | "siblings"
  | "descendants"
  | "ancestors"
  | "all";

export interface TaskNote {
  id: number;
  task_id: number;
  author: NoteAuthor;
  visibility: NoteVisibility;
  tags: string[];
  content: string;
  created_at: Date;
}

// ---- Notes emitted by the agent via the NOTES_TO_SAVE protocol ----
// The agent embeds a <NOTES_TO_SAVE>...</NOTES_TO_SAVE> JSON-array block in its
// stdout. claudeRunner parses these into ParsedAgentNote entries; taskRunner
// then persists them with author='agent' and task_id=<current task>.
export interface ParsedAgentNote {
  visibility: NoteVisibility;
  content: string;
  tags?: string[];
}

// ---- Task payload for agent ----
export interface TaskPayloadNote {
  id: number;
  task_id: number;
  author: NoteAuthor;
  visibility: NoteVisibility;
  tags: string[];
  content: string;
  created_at: string;
}

export interface TaskPayload {
  task: {
    id: number;
    title: string;
    description: string;
    acceptanceCriteria: Array<{ id: number; description: string; met: boolean }>;
    parent: { id: number; title: string; description: string } | null;
    siblings: Array<{ id: number; title: string; status: string; order_position: number }>;
    notes: TaskPayloadNote[];
  };
}

// ---- Token usage parsed from a single Anthropic SDK / claude CLI response ----
// The four fields mirror the Anthropic API's `usage` object so we can store
// them verbatim and aggregate per-task / per-repo cost downstream without
// re-mapping. Cache hits live in `cache_read_input_tokens`; cache writes in
// `cache_creation_input_tokens`.
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

// ---- Webhooks (Phase 7: notify external systems on task state changes) ----
// Per-repo Slack-compatible webhook endpoints. Delivery is fire-and-forget with
// a small retry on 5xx responses; misconfigured URLs do not block the task
// pipeline.
export type WebhookEvent = "done" | "failed" | "halted";

export interface RepoWebhook {
  id: number;
  repo_id: number;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  created_at: Date;
}

// ---- task_usage table row ----
// One row per agent run (success or failure). Aggregations for the GUI live in
// dedicated DB helpers (sum per task, sum per repo) rather than denormalised
// columns, so the audit trail of individual runs is preserved.
export interface TaskUsage {
  id: number;
  task_id: number;
  repo_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  created_at: Date;
}

// ---- Task templates (Phase 7: save/reuse task tree patterns) ----
// `tree` stores a TaskTreeProposal (parents → children → acceptance_criteria).
// Kept as JSONB rather than relational rows so a template is a single, atomic
// document that the materializer can replay verbatim into any repo.
export interface TaskTemplate {
  id: number;
  name: string;
  description: string;
  tree: {
    parents: Array<{
      title: string;
      description?: string;
      acceptance_criteria?: string[];
      children?: unknown[];
    }>;
  };
  created_at: Date;
}

// ---- DB health check result ----
export interface IDBHealth {
  connected: boolean;
  connectionUsesProxy: boolean;
  logs?: {
    messages: string[];
    host?: string;
    timestamp: string;
    error?: string;
  };
}
