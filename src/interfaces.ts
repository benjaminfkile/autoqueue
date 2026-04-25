// ---- App / API secrets (stored in AWS Secrets Manager via AWS_SECRET_ARN) ----
export interface IAppSecrets {
  NODE_ENV: "development" | "production";
  PORT: string;
  DB_NAME: string;
  DB_HOST: string;
  DB_PROXY_URL: string;
  API_KEY_HASH: string;
  GH_PAT?: string;
  ANTHROPIC_API_KEY?: string;
  REPOS_PATH: string;
  POLL_INTERVAL_SECONDS?: string;
  CLAUDE_PATH?: string;
  IS_WORKER?: string;
  // Add additional app-level secrets here as needed
}

// ---- DB secrets (stored in AWS Secrets Manager via AWS_DB_SECRET_ARN) ----
export interface IDBSecrets {
  username: string;
  password: string;
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

// ---- Task payload for agent ----
export interface TaskPayload {
  task: {
    id: number;
    title: string;
    description: string;
    acceptanceCriteria: Array<{ id: number; description: string; met: boolean }>;
    parent: { id: number; title: string; description: string } | null;
    siblings: Array<{ id: number; title: string; status: string; order_position: number }>;
  };
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
