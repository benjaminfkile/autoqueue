// ---- App / API secrets (stored in AWS Secrets Manager via AWS_SECRET_ARN) ----
export interface IAppSecrets {
  NODE_ENV: "development" | "production";
  PORT: string;
  DB_NAME: string;
  DB_HOST: string;
  DB_PROXY_URL: string;
  API_KEY_HASH: string;
  GH_PAT: string;
  WEBHOOK_SECRET: string;
  BASE_URL: string;
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
  webhook_id: number | null;
  created_at: Date;
}

// ---- Issues table row ----
export interface Issue {
  id: number;
  repo_id: number;
  issue_number: number;
  parent_issue_number: number | null;
  queue_position: number;
  status: "pending" | "active" | "done";
  is_manual: boolean;
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
