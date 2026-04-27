export type RepoOnFailure = "halt_repo" | "halt_subtree" | "retry" | "continue";
export type RepoOnParentChildFail = "cascade_fail" | "mark_partial" | "ignore";
export type OrderingMode = "sequential" | "parallel";
export type RepoCloneStatus = "pending" | "cloning" | "ready" | "error";
export type RepoLinkPermission = "read" | "write";

export interface RepoLink {
  id: number;
  repo_a_id: number;
  repo_b_id: number;
  role: string | null;
  permission: RepoLinkPermission;
  created_at: string;
}

export interface RepoLinkCreateInput {
  other_repo_id: number;
  role?: string | null;
  permission?: RepoLinkPermission;
}
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
  clone_status: RepoCloneStatus;
  clone_error: string | null;
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
  requires_approval: boolean;
  created_at: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  order_position?: number;
  status?: TaskStatus;
  ordering_mode?: OrderingMode | null;
  requires_approval?: boolean;
  model?: string | null;
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
  requires_approval: boolean;
  // Phase 11: per-task Claude model override. NULL → inherit from the nearest
  // ancestor with a model set, else fall back to the app-wide default_model.
  model: string | null;
  created_at: string;
  acceptanceCriteria: AcceptanceCriterion[];
  children: TaskChildSummary[];
}

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  run_count: number;
}

export interface TaskUsageRun {
  id: number;
  task_id: number;
  repo_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  created_at: string;
}

export interface TaskUsageResponse {
  totals: TokenUsageTotals;
  runs: TaskUsageRun[];
}

export interface RepoUsageResponse {
  totals: TokenUsageTotals;
}

// Phase 12 usage dashboard payload. `weekly_cap === null` means "unlimited"
// (the SPA renders that as "—" or hides the cap row); `weekly_total` is
// directly comparable against `weekly_cap` because both sum the same four
// token categories. `daily` is a contiguous trailing-30-day timeline with
// zero-filled days, so the chart can render bars by index without re-deriving
// the date axis.
export interface DailyUsageBucket {
  date: string;
  total: number;
}

export interface WeeklyUsageBreakdown {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export interface WeeklyUsageResponse {
  weekly_total: number;
  weekly_cap: number | null;
  weekly_breakdown: WeeklyUsageBreakdown;
  daily: DailyUsageBucket[];
}

// Phase 11: shape returned by GET /api/tasks/:id/effective-model. `source` is
// where the resolved model came from:
//   - 'override' → the task itself has a non-empty model column.
//   - 'parent'   → an ancestor (walking parent_id) had a non-empty model.
//   - 'default'  → no override anywhere in the chain; settings.default_model.
export type TaskModelSource = "override" | "parent" | "default";

export interface TaskEffectiveModel {
  model: string;
  source: TaskModelSource;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  ts: string;
  event: string;
  data: Record<string, unknown> | null;
}

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
  created_at: string;
}

export interface TaskNoteInput {
  author: NoteAuthor;
  visibility: NoteVisibility;
  content: string;
  tags?: string[];
}

export type WorkerMode = "worker" | "orchestrator";

export interface ActiveWorker {
  worker_id: string;
  task_id: number;
  task_title: string;
  repo_id: number;
  leased_until: string;
  is_self: boolean;
}

export interface WorkerStatus {
  mode: WorkerMode;
  this_worker_id: string | null;
  active_workers: ActiveWorker[];
}

export interface DockerStatus {
  available: boolean;
  error: string | null;
  last_checked_at: string | null;
  install_url: string;
}

export type RunnerImageStatus =
  | "idle"
  | "checking"
  | "building"
  | "ready"
  | "error";

export interface RunnerImageState {
  image: string;
  status: RunnerImageStatus;
  hash: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface SetupStatus {
  ready: boolean;
  configured: {
    ANTHROPIC_API_KEY: boolean;
    GH_PAT: boolean;
  };
}

export interface SetupInput {
  ANTHROPIC_API_KEY: string;
  GH_PAT: string;
}

export interface AppSettings {
  id: number;
  default_model: string;
  // NULL = unlimited. Callers must branch on `=== null` rather than treating
  // the field as a numeric ceiling.
  weekly_token_cap: number | null;
  session_token_cap: number | null;
  updated_at: string;
}

export interface AppSettingsUpdateInput {
  default_model?: string;
  // null clears the cap (NULL in the DB → unlimited). Numbers must be
  // non-negative integers; the server rejects anything else.
  weekly_token_cap?: number | null;
  session_token_cap?: number | null;
}

export interface ProposedTaskNode {
  title: string;
  description?: string;
  acceptance_criteria?: string[];
  children?: ProposedTaskNode[];
  // Top-level proposed parents may target a specific repo (the chat's
  // primary repo or one of its directly-linked siblings). Children always
  // inherit their parent's repo, so this is only meaningful at the top level.
  repo_id?: number;
}

export interface TaskTreeProposal {
  parents: ProposedTaskNode[];
}

export interface MaterializedTaskNode {
  id: number;
  title: string;
  parent_id: number | null;
  order_position: number;
  repo_id: number;
  acceptance_criteria_ids: number[];
  children: MaterializedTaskNode[];
}

export interface MaterializedTaskTree {
  parents: MaterializedTaskNode[];
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "proposal"; proposal: TaskTreeProposal }
  | { type: "proposal_error"; error: string }
  | { type: "error"; error: string }
  | { type: "done" };
