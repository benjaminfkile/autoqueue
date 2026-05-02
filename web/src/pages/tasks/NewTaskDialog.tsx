import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { tasksApi } from "../../api/client";
import type {
  OrderingMode,
  Repo,
  TaskDetail,
  TaskSummary,
} from "../../api/types";
import ModelSelect from "./ModelSelect";
import AcceptanceCriteriaEditor from "./AcceptanceCriteriaEditor";

const ORDERING_MODE_OPTIONS: Array<{
  value: OrderingMode | "inherit";
  label: string;
}> = [
  { value: "inherit", label: "Inherit from parent" },
  { value: "sequential", label: "Sequential" },
  { value: "parallel", label: "Parallel" },
];

interface FormState {
  title: string;
  description: string;
  parentId: number | null;
  orderPosition: string;
  orderingMode: OrderingMode | "inherit";
  model: string | null;
  requiresApproval: boolean;
  criteria: string[];
}

function buildInitialState(parentId: number | null | undefined): FormState {
  return {
    title: "",
    description: "",
    parentId: parentId ?? null,
    orderPosition: "",
    orderingMode: "inherit",
    model: null,
    requiresApproval: false,
    criteria: [],
  };
}

export interface NewTaskDialogProps {
  open: boolean;
  repos: Repo[];
  repoId: number | null;
  parentId?: number | null;
  onClose: () => void;
  onCreated: (task: TaskDetail) => void;
}

export default function NewTaskDialog({
  open,
  repos,
  repoId,
  parentId,
  onClose,
  onCreated,
}: NewTaskDialogProps) {
  const [effectiveRepoId, setEffectiveRepoId] = useState<number | null>(repoId);
  const [form, setForm] = useState<FormState>(() =>
    buildInitialState(parentId)
  );
  const [parentTasks, setParentTasks] = useState<TaskSummary[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isDirty =
    form.title !== "" ||
    form.description !== "" ||
    form.criteria.length > 0 ||
    form.requiresApproval !== false ||
    form.model !== null ||
    form.parentId !== null;

  // Reset state each time the dialog opens
  useEffect(() => {
    if (open) {
      setEffectiveRepoId(repoId);
      setForm(buildInitialState(parentId));
      setParentTasks([]);
      setServerError(null);
      setSubmitting(false);
      setConfirmDiscard(false);
    }
  }, [open, repoId, parentId]);

  // Load tasks for the selected repo to populate the parent selector
  useEffect(() => {
    if (!open || effectiveRepoId == null) {
      setParentTasks([]);
      return;
    }
    let cancelled = false;
    setLoadingTasks(true);
    tasksApi
      .listByRepo(effectiveRepoId)
      .then((tasks) => {
        if (!cancelled) setParentTasks(tasks);
      })
      .catch(() => {
        // non-critical — parent selector just stays empty
      })
      .finally(() => {
        if (!cancelled) setLoadingTasks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveRepoId]);

  function requestClose() {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): string | null {
    if (effectiveRepoId == null) return "Please select a repository.";
    if (!form.title.trim()) return "Title is required.";
    if (form.orderPosition !== "") {
      const n = Number(form.orderPosition);
      if (!Number.isInteger(n) || n < 0)
        return "Order position must be a non-negative integer.";
    }
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setServerError(validationError);
      return;
    }

    setSubmitting(true);
    setServerError(null);

    try {
      const created = await tasksApi.create({
        repo_id: effectiveRepoId!,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        parent_id: form.parentId,
        order_position:
          form.orderPosition !== "" ? Number(form.orderPosition) : undefined,
        ordering_mode:
          form.orderingMode === "inherit" ? null : form.orderingMode,
        model: form.model,
        requires_approval: form.requiresApproval,
        acceptanceCriteria:
          form.criteria.length > 0
            ? form.criteria.filter((c) => c.trim() !== "")
            : undefined,
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Request failed");
      setSubmitting(false);
    }
  }

  const showRepoSelector = repoId == null;

  return (
    <>
    <Dialog
      open={open}
      onClose={submitting ? undefined : (_, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") {
          requestClose();
        }
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void handleSubmit();
        }
      }}
      fullWidth
      maxWidth="sm"
      aria-labelledby="new-task-dialog-title"
    >
      <DialogTitle id="new-task-dialog-title">Add task</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {serverError && <Alert severity="error">{serverError}</Alert>}

          {showRepoSelector && (
            <TextField
              select
              label="Repository"
              value={effectiveRepoId ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                setEffectiveRepoId(val === "" ? null : Number(val));
                setForm((prev) => ({ ...prev, parentId: null }));
              }}
              fullWidth
              required
            >
              <MenuItem value="">
                <em>Select a repository</em>
              </MenuItem>
              {repos.map((repo) => (
                <MenuItem key={repo.id} value={repo.id}>
                  {repo.owner && repo.repo_name
                    ? `${repo.owner}/${repo.repo_name}`
                    : repo.local_path ?? `Repo ${repo.id}`}
                </MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label="Title"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            required
            fullWidth
            autoFocus={!showRepoSelector}
          />

          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            fullWidth
            multiline
            minRows={3}
          />

          <TextField
            select
            label="Parent task"
            value={form.parentId ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              update("parentId", val === "" ? null : Number(val));
            }}
            fullWidth
            disabled={loadingTasks}
            InputProps={
              loadingTasks
                ? {
                    endAdornment: (
                      <Box sx={{ display: "flex", mr: 2 }}>
                        <CircularProgress size={16} />
                      </Box>
                    ),
                  }
                : undefined
            }
          >
            <MenuItem value="">
              <em>No parent</em>
            </MenuItem>
            {parentTasks.map((t) => (
              <MenuItem key={t.id} value={t.id}>
                {t.title}
              </MenuItem>
            ))}
          </TextField>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Order position"
              value={form.orderPosition}
              onChange={(e) => update("orderPosition", e.target.value)}
              inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
              fullWidth
              helperText="Optional. Lower numbers appear first."
            />
            <TextField
              select
              label="Ordering mode"
              value={form.orderingMode}
              onChange={(e) =>
                update(
                  "orderingMode",
                  e.target.value as OrderingMode | "inherit"
                )
              }
              fullWidth
            >
              {ORDERING_MODE_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <ModelSelect value={form.model} onChange={(v) => update("model", v)} />

          <FormControlLabel
            control={
              <Switch
                checked={form.requiresApproval}
                onChange={(e) => update("requiresApproval", e.target.checked)}
                inputProps={{ "aria-label": "Requires approval" }}
              />
            }
            label="Requires approval before running"
          />

          <AcceptanceCriteriaEditor
            value={form.criteria}
            onChange={(next) => update("criteria", next)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={requestClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Creating…" : "Create task"}
        </Button>
      </DialogActions>
    </Dialog>
    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      maxWidth="xs"
      aria-labelledby="new-task-discard-title"
    >
      <DialogTitle id="new-task-discard-title">Discard changes?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          You have unsaved changes. Discard them and close?
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
        <Button
          color="error"
          onClick={() => {
            setConfirmDiscard(false);
            onClose();
          }}
        >
          Discard
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
}
