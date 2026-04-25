export type RepoOnFailure = "halt_repo" | "halt_subtree" | "retry" | "continue";
export type RepoOnParentChildFail = "cascade_fail" | "mark_partial" | "ignore";
export type OrderingMode = "sequential" | "parallel";
export type TaskStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "interrupted";

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
  created_at: string;
}

export interface RepoInput {
  owner?: string | null;
  repo_name?: string | null;
  active?: boolean;
  base_branch?: string;
  base_branch_parent?: string;
  require_pr?: boolean;
  github_token?: string | null;
  is_local_folder?: boolean;
  local_path?: string | null;
  on_failure?: RepoOnFailure;
  max_retries?: number;
  on_parent_child_fail?: RepoOnParentChildFail;
  ordering_mode?: OrderingMode;
}

export interface TaskSummary {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  status: TaskStatus;
  order_position: number;
  children_count: number;
  created_at: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  order_position?: number;
  status?: TaskStatus;
  ordering_mode?: OrderingMode | null;
}

export interface AcceptanceCriterion {
  id: number;
  task_id: number;
  description: string;
  order_position: number;
  met: boolean;
  created_at: string;
}

export interface AcceptanceCriterionUpdateInput {
  description?: string;
  order_position?: number;
  met?: boolean;
}

export interface TaskChildSummary {
  id: number;
  title: string;
  status: TaskStatus;
  order_position: number;
}

export interface TaskDetail {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  description: string;
  order_position: number;
  status: TaskStatus;
  retry_count: number;
  pr_url: string | null;
  worker_id: string | null;
  leased_until: string | null;
  ordering_mode: OrderingMode | null;
  log_path: string | null;
  created_at: string;
  acceptanceCriteria: AcceptanceCriterion[];
  children: TaskChildSummary[];
}

export interface TaskEvent {
  id: number;
  task_id: number;
  ts: string;
  event: string;
  data: Record<string, unknown> | null;
}
