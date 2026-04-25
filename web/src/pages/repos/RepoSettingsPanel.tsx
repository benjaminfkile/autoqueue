import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { reposApi } from "../../api/client";
import type {
  OrderingMode,
  Repo,
  RepoInput,
  RepoOnFailure,
  RepoOnParentChildFail,
} from "../../api/types";
import { repoDisplayName } from "./repoDisplay";

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

export interface RepoSettingsPanelProps {
  repo: Repo;
  onChange: (repo: Repo) => void;
}

export default function RepoSettingsPanel({
  repo,
  onChange,
}: RepoSettingsPanelProps) {
  const [savingField, setSavingField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [baseBranchParentDraft, setBaseBranchParentDraft] = useState(
    repo.base_branch_parent
  );
  const [maxRetriesDraft, setMaxRetriesDraft] = useState(
    String(repo.max_retries)
  );

  useEffect(() => {
    setBaseBranchParentDraft(repo.base_branch_parent);
    setMaxRetriesDraft(String(repo.max_retries));
  }, [repo.id, repo.base_branch_parent, repo.max_retries]);

  async function persist(field: string, input: RepoInput): Promise<void> {
    setSavingField(field);
    setError(null);
    try {
      const updated = await reposApi.update(repo.id, input);
      onChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save setting");
      throw err;
    } finally {
      setSavingField(null);
    }
  }

  const onFailureChange = (value: RepoOnFailure) =>
    void persist("on_failure", { on_failure: value }).catch(() => {});

  const onParentChildFailChange = (value: RepoOnParentChildFail) =>
    void persist("on_parent_child_fail", {
      on_parent_child_fail: value,
    }).catch(() => {});

  const onOrderingModeChange = (value: OrderingMode) =>
    void persist("ordering_mode", { ordering_mode: value }).catch(() => {});

  const onRequirePrChange = (checked: boolean) =>
    void persist("require_pr", { require_pr: checked }).catch(() => {});

  async function saveBaseBranchParent() {
    const value = baseBranchParentDraft.trim();
    if (!value) {
      setError("Base branch parent cannot be empty.");
      return;
    }
    if (value === repo.base_branch_parent) return;
    try {
      await persist("base_branch_parent", { base_branch_parent: value });
    } catch {
      // Error already surfaced in `error` state.
    }
  }

  async function saveMaxRetries() {
    const n = Number(maxRetriesDraft);
    if (!Number.isInteger(n) || n < 0) {
      setError("Max retries must be a non-negative integer.");
      return;
    }
    if (n === repo.max_retries) return;
    try {
      await persist("max_retries", { max_retries: n });
    } catch {
      // Error surfaced in `error` state.
    }
  }

  const baseBranchParentDirty =
    baseBranchParentDraft.trim() !== repo.base_branch_parent;
  const maxRetriesDirty = maxRetriesDraft !== String(repo.max_retries);

  return (
    <Box aria-label={`Settings for ${repoDisplayName(repo)}`}>
      <Stack spacing={2}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box>
          <Typography variant="caption" color="text.secondary" component="div">
            Failure policy
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              label="On failure"
              value={repo.on_failure}
              onChange={(e) => onFailureChange(e.target.value as RepoOnFailure)}
              disabled={savingField === "on_failure"}
              fullWidth
              data-testid="setting-on-failure"
              SelectProps={{ inputProps: { "aria-label": "On failure" } }}
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
              value={repo.on_parent_child_fail}
              onChange={(e) =>
                onParentChildFailChange(
                  e.target.value as RepoOnParentChildFail
                )
              }
              disabled={savingField === "on_parent_child_fail"}
              fullWidth
              data-testid="setting-on-parent-child-fail"
              SelectProps={{
                inputProps: { "aria-label": "On parent/child fail" },
              }}
            >
              {ON_PARENT_CHILD_FAIL_OPTIONS.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" component="div">
            Scheduling
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              label="Ordering mode"
              value={repo.ordering_mode}
              onChange={(e) =>
                onOrderingModeChange(e.target.value as OrderingMode)
              }
              disabled={savingField === "ordering_mode"}
              fullWidth
              data-testid="setting-ordering-mode"
              SelectProps={{ inputProps: { "aria-label": "Ordering mode" } }}
            >
              {ORDERING_MODE_OPTIONS.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1} sx={{ flexGrow: 1 }}>
              <TextField
                label="Max retries"
                value={maxRetriesDraft}
                onChange={(e) => setMaxRetriesDraft(e.target.value)}
                inputProps={{
                  inputMode: "numeric",
                  pattern: "[0-9]*",
                  "aria-label": "Max retries",
                }}
                disabled={savingField === "max_retries"}
                fullWidth
              />
              <Button
                variant="outlined"
                onClick={() => void saveMaxRetries()}
                disabled={!maxRetriesDirty || savingField === "max_retries"}
                aria-label="Save max retries"
              >
                {savingField === "max_retries" ? (
                  <CircularProgress size={18} />
                ) : (
                  "Save"
                )}
              </Button>
            </Stack>
          </Stack>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" component="div">
            Branching
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
            <TextField
              label="Base branch parent"
              value={baseBranchParentDraft}
              onChange={(e) => setBaseBranchParentDraft(e.target.value)}
              disabled={savingField === "base_branch_parent"}
              fullWidth
              inputProps={{ "aria-label": "Base branch parent" }}
              helperText="Branch that worker branches are cut from."
            />
            <Button
              variant="outlined"
              onClick={() => void saveBaseBranchParent()}
              disabled={
                !baseBranchParentDirty || savingField === "base_branch_parent"
              }
              aria-label="Save base branch parent"
            >
              {savingField === "base_branch_parent" ? (
                <CircularProgress size={18} />
              ) : (
                "Save"
              )}
            </Button>
          </Stack>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Switch
                checked={repo.require_pr}
                disabled={savingField === "require_pr"}
                onChange={(e) => onRequirePrChange(e.target.checked)}
                inputProps={{ "aria-label": "Require PR" }}
              />
            }
            label="Require PR before merge"
          />
        </Box>
      </Stack>
    </Box>
  );
}
