import { useEffect, useMemo, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import type {
  OrderingMode,
  Repo,
  RepoInput,
  RepoOnFailure,
  RepoOnParentChildFail,
} from "../../api/types";

const ON_FAILURE_OPTIONS: RepoOnFailure[] = [
  "halt_repo",
  "halt_subtree",
  "retry",
  "continue",
];
const ON_PARENT_CHILD_FAIL_OPTIONS: RepoOnParentChildFail[] = [
  "cascade_fail",
  "mark_partial",
  "ignore",
];
const ORDERING_MODE_OPTIONS: OrderingMode[] = ["sequential", "parallel"];

interface FormState {
  owner: string;
  repo_name: string;
  base_branch: string;
  base_branch_parent: string;
  is_local_folder: boolean;
  local_path: string;
  github_token: string;
  require_pr: boolean;
  on_failure: RepoOnFailure;
  max_retries: string;
  on_parent_child_fail: RepoOnParentChildFail;
  ordering_mode: OrderingMode;
  active: boolean;
}

function buildInitialState(repo: Repo | null): FormState {
  return {
    owner: repo?.owner ?? "",
    repo_name: repo?.repo_name ?? "",
    base_branch: repo?.base_branch ?? "main",
    base_branch_parent: repo?.base_branch_parent ?? "main",
    is_local_folder: repo?.is_local_folder ?? false,
    local_path: repo?.local_path ?? "",
    github_token: repo?.github_token ?? "",
    require_pr: repo?.require_pr ?? true,
    on_failure: repo?.on_failure ?? "halt_subtree",
    max_retries: repo ? String(repo.max_retries) : "0",
    on_parent_child_fail: repo?.on_parent_child_fail ?? "cascade_fail",
    ordering_mode: repo?.ordering_mode ?? "sequential",
    active: repo?.active ?? true,
  };
}

export interface RepoFormDialogProps {
  open: boolean;
  mode: "create" | "edit";
  repo: Repo | null;
  onClose: () => void;
  onSubmit: (input: RepoInput) => Promise<void>;
}

export default function RepoFormDialog({
  open,
  mode,
  repo,
  onClose,
  onSubmit,
}: RepoFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => buildInitialState(repo));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(buildInitialState(repo));
      setError(null);
      setSubmitting(false);
    }
  }, [open, repo]);

  const title = useMemo(
    () => (mode === "create" ? "Connect a repo" : "Edit repo"),
    [mode]
  );

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): string | null {
    if (form.is_local_folder) {
      if (!form.local_path.trim()) {
        return "Local path is required for local folder repos.";
      }
    } else {
      if (!form.owner.trim() || !form.repo_name.trim()) {
        return "Owner and repo name are required.";
      }
    }
    if (!form.base_branch.trim()) {
      return "Base branch is required.";
    }
    const retries = Number(form.max_retries);
    if (!Number.isInteger(retries) || retries < 0) {
      return "Max retries must be a non-negative integer.";
    }
    return null;
  }

  function buildPayload(): RepoInput {
    const retries = Number(form.max_retries);
    const payload: RepoInput = {
      active: form.active,
      base_branch: form.base_branch.trim(),
      base_branch_parent: form.base_branch_parent.trim() || form.base_branch.trim(),
      require_pr: form.require_pr,
      is_local_folder: form.is_local_folder,
      on_failure: form.on_failure,
      max_retries: retries,
      on_parent_child_fail: form.on_parent_child_fail,
      ordering_mode: form.ordering_mode,
    };
    if (form.is_local_folder) {
      payload.local_path = form.local_path.trim();
      payload.owner = form.owner.trim() || null;
      payload.repo_name = form.repo_name.trim() || null;
    } else {
      payload.owner = form.owner.trim();
      payload.repo_name = form.repo_name.trim();
      payload.local_path = form.local_path.trim() || null;
    }
    payload.github_token = form.github_token.trim()
      ? form.github_token.trim()
      : null;
    return payload;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(buildPayload());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="repo-form-dialog-title"
    >
      <DialogTitle id="repo-form-dialog-title">{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <FormControlLabel
            control={
              <Switch
                checked={form.is_local_folder}
                onChange={(e) => update("is_local_folder", e.target.checked)}
                inputProps={{ "aria-label": "Local folder" }}
              />
            }
            label="Local folder"
          />
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Owner"
              value={form.owner}
              onChange={(e) => update("owner", e.target.value)}
              required={!form.is_local_folder}
              fullWidth
            />
            <TextField
              label="Repo name"
              value={form.repo_name}
              onChange={(e) => update("repo_name", e.target.value)}
              required={!form.is_local_folder}
              fullWidth
            />
          </Stack>
          {form.is_local_folder && (
            <TextField
              label="Local path"
              value={form.local_path}
              onChange={(e) => update("local_path", e.target.value)}
              required
              fullWidth
            />
          )}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Base branch"
              value={form.base_branch}
              onChange={(e) => update("base_branch", e.target.value)}
              required
              fullWidth
            />
            <TextField
              label="Base branch parent"
              value={form.base_branch_parent}
              onChange={(e) => update("base_branch_parent", e.target.value)}
              fullWidth
            />
          </Stack>
          <TextField
            label="GitHub token"
            value={form.github_token}
            onChange={(e) => update("github_token", e.target.value)}
            type="password"
            fullWidth
            helperText="Optional. Overrides the server-wide token for this repo."
          />
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              select
              label="On failure"
              value={form.on_failure}
              onChange={(e) =>
                update("on_failure", e.target.value as RepoOnFailure)
              }
              fullWidth
            >
              {ON_FAILURE_OPTIONS.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="On parent/child fail"
              value={form.on_parent_child_fail}
              onChange={(e) =>
                update(
                  "on_parent_child_fail",
                  e.target.value as RepoOnParentChildFail
                )
              }
              fullWidth
            >
              {ON_PARENT_CHILD_FAIL_OPTIONS.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              select
              label="Ordering mode"
              value={form.ordering_mode}
              onChange={(e) =>
                update("ordering_mode", e.target.value as OrderingMode)
              }
              fullWidth
            >
              {ORDERING_MODE_OPTIONS.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Max retries"
              value={form.max_retries}
              onChange={(e) => update("max_retries", e.target.value)}
              inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
              fullWidth
            />
          </Stack>
          <Stack direction="row" spacing={3}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.require_pr}
                  onChange={(e) => update("require_pr", e.target.checked)}
                  inputProps={{ "aria-label": "Require PR" }}
                />
              }
              label="Require PR"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.active}
                  onChange={(e) => update("active", e.target.checked)}
                  inputProps={{ "aria-label": "Active" }}
                />
              }
              label="Active"
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {mode === "create" ? "Connect" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
