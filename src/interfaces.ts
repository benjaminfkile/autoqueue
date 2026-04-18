// ---- App / API secrets (stored in AWS Secrets Manager via AWS_SECRET_ARN) ----
export interface IAppSecrets {
  NODE_ENV: "development" | "production";
  PORT: string;
  DB_NAME: string;
  DB_HOST: string;
  DB_PROXY_URL: string;
  API_KEY_HASH: string;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  REPOS_PATH: string;
  POLL_INTERVAL_SECONDS: string;
  CLAUDE_PATH?: string;
  // Add additional app-level secrets here as needed
}

// ---- DB secrets (stored in AWS Secrets Manager via AWS_DB_SECRET_ARN) ----
export interface IDBSecrets {
  username: string;
  password: string;
}

// ---- Repos table row ----
export interface Repo {
  id: number;
  owner: string;
  repo_name: string;
  active: boolean;
  base_branch: string;
  require_pr: boolean;
  github_token: string | null;
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
