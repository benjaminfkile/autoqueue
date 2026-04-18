// ---- App / API secrets (stored in AWS Secrets Manager via AWS_SECRET_ARN) ----
export interface IAppSecrets {
  NODE_ENV: "development" | "production";
  PORT: string;
  DB_NAME: string;
  DB_HOST: string;
  DB_PROXY_URL: string;
  API_KEY_HASH: string;
  GH_PAT: string;
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

// ---- Issues table row ----
export interface Issue {
  id: number;
  repo_id: number;
  issue_number: number;
  parent_issue_number: number | null;
  queue_position: number;
  status: "pending" | "active" | "done" | "failed";
  is_manual: boolean;
  retry_count: number;
  is_container: boolean;
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
