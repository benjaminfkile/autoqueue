import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import { tasksApi } from "../../api/client";
import type { Repo, TaskSummary } from "../../api/types";
import { CLAUDE_MODELS } from "../../api/claudeModels";
import { repoDisplayName } from "../repos/repoDisplay";

const MODEL_INHERIT_VALUE = "__inherit__";

export interface NewTaskDialogProps {
  open: boolean;
  /** List of repos for the repo selector. Only needed when initialRepoId is absent. */
  repos?: Repo[];
  /** When set, locks the dialog to this repo and hides the repo selector. */
  initialRepoId?: number | null;
  /** When set, pre-selects this task as the parent. null = explicit root task. */
  initialParentId?: number | null;
  onClose: () => void;
  onCreated: (task: TaskSummary) => void;
}

interface FormState {
  repoId: number | "";
  parentId: number | null;
  title: string;
  description: string;
  orderPosition: string;
  orderingMode: "" | "sequential" | "parallel";
  model: string;
  requiresApproval: boolean;
  criteria: string[];
}

function buildInitialState(
  initialRepoId?: number | null,
  initialParentId?: number | null
): FormState {
  return {
    repoId: initialRepoId ?? "",
    parentId: initialParentId !== undefined ? (initialParentId ?? null) : null,
    title: "",
    description: "",
    orderPosition: "",
    orderingMode: "",
    model: MODEL_INHERIT_VALUE,
    requiresApproval: false,
    criteria: [],
  };
}

export default function NewTaskDialog({
  open,
  repos = [],
  initialRepoId,
  initialParentId,
  onClose,
  onCreated,
}: NewTaskDialogProps) {
  const [form, setForm] = useState<FormState>(() =>
    buildInitialState(initialRepoId, initialParentId)
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [parentTasks, setParentTasks] = useState<TaskSummary[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(buildInitialState(initialRepoId, initialParentId));
      setError(null);
      setParentTasks([]);
    }
  }, [open, initialRepoId, initialParentId]);

  const activeRepoId = form.repoId;
  useEffect(() => {
    if (!activeRepoId) {
      setParentTasks([]);
      return;
    }
    let cancelled = false;
    setLoadingTasks(true);
    tasksApi
      .listByRepo(activeRepoId as number)
      .then((tasks) => {
        if (!cancelled) setParentTasks(tasks);
      })
      .catch(() => {
        if (!cancelled) setParentTasks([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTasks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRepoId]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): string | null {
    if (!form.repoId) return "Please select a repository.";
    if (!form.title.trim()) return "Title is required.";
    if (
      form.orderPosition !== "" &&
      (!Number.isInteger(Number(form.orderPosition)) ||
        Number(form.orderPosition) < 0)
    ) {
      return "Order position must be a non-negative integer.";
    }
    return null;
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
      const raw = await tasksApi.create({
        repo_id: form.repoId as number,
        parent_id: form.parentId,
        title: form.title.trim(),
        description: form.description || undefined,
        order_position:
          form.orderPosition !== ""
            ? parseInt(form.orderPosition, 10)
            : undefined,
        ordering_mode: form.orderingMode || null,
        model:
          form.model === MODEL_INHERIT_VALUE ? null : form.model || null,
        requires_approval: form.requiresApproval,
        acceptanceCriteria: form.criteria.filter((c) => c.trim()),
      });
      const summary: TaskSummary = {
        id: raw.id,
        repo_id: raw.repo_id,
        parent_id: raw.parent_id,
        title: raw.title,
        status: raw.status,
        order_position: raw.order_position,
        children_count: 0,
        requires_approval: raw.requires_approval,
        created_at: raw.created_at,
      };
      onCreated(summary);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create task"
      );
    } finally {
      setSubmitting(false);
    }
  }

  const showRepoSelector = !initialRepoId;
  const parentSelectValue =
    form.parentId === null ? "null" : String(form.parentId);

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>New task</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          {showRepoSelector && (
            <FormControl fullWidth>
              <InputLabel id="new-task-repo-label">Repository</InputLabel>
              <Select
                labelId="new-task-repo-label"
                value={form.repoId}
                label="Repository"
                onChange={(e) => {
                  update("repoId", e.target.value as number | "");
                  update("parentId", null);
                }}
              >
                {repos.map((repo) => (
                  <MenuItem key={repo.id} value={repo.id}>
                    {repoDisplayName(repo)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          <TextField
            label="Title"
            required
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
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

          <FormControl fullWidth>
            <InputLabel id="new-task-parent-label">Parent task</InputLabel>
            <Select
              labelId="new-task-parent-label"
              value={parentSelectValue}
              label="Parent task"
              disabled={loadingTasks || !form.repoId}
              onChange={(e) => {
                const val = e.target.value;
                update(
                  "parentId",
                  val === "null" ? null : parseInt(val, 10)
                );
              }}
            >
              <MenuItem value="null">No parent (root task)</MenuItem>
              {parentTasks.map((t) => (
                <MenuItem key={t.id} value={String(t.id)}>
                  {t.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Order position"
            type="number"
            value={form.orderPosition}
            onChange={(e) => update("orderPosition", e.target.value)}
            fullWidth
            inputProps={{ min: 0 }}
            helperText="Leave blank to append at the end"
          />

          <FormControl fullWidth>
            <InputLabel id="new-task-ordering-label">
              Ordering mode
            </InputLabel>
            <Select
              labelId="new-task-ordering-label"
              value={form.orderingMode}
              label="Ordering mode"
              onChange={(e) =>
                update(
                  "orderingMode",
                  e.target.value as FormState["orderingMode"]
                )
              }
            >
              <MenuItem value="">Inherit from parent</MenuItem>
              <MenuItem value="sequential">Sequential</MenuItem>
              <MenuItem value="parallel">Parallel</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel id="new-task-model-label">Model</InputLabel>
            <Select
              labelId="new-task-model-label"
              value={form.model}
              label="Model"
              onChange={(e) => update("model", e.target.value)}
            >
              <MenuItem value={MODEL_INHERIT_VALUE}>
                Inherit from parent
              </MenuItem>
              {CLAUDE_MODELS.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                checked={form.requiresApproval}
                onChange={(e) =>
                  update("requiresApproval", e.target.checked)
                }
              />
            }
            label="Requires approval"
          />

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Acceptance criteria
            </Typography>
            <Stack spacing={1}>
              {form.criteria.map((criterion, i) => (
                <Stack
                  key={i}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                >
                  <TextField
                    size="small"
                    fullWidth
                    value={criterion}
                    onChange={(e) => {
                      const next = [...form.criteria];
                      next[i] = e.target.value;
                      update("criteria", next);
                    }}
                    placeholder={`Criterion ${i + 1}`}
                    inputProps={{
                      "aria-label": `Acceptance criterion ${i + 1}`,
                    }}
                  />
                  <IconButton
                    size="small"
                    onClick={() =>
                      update(
                        "criteria",
                        form.criteria.filter((_, j) => j !== i)
                      )
                    }
                    aria-label={`Remove criterion ${i + 1}`}
                  >
                    <RemoveCircleOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() =>
                  update("criteria", [...form.criteria, ""])
                }
                sx={{ alignSelf: "flex-start" }}
              >
                Add criterion
              </Button>
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          startIcon={
            submitting ? <CircularProgress size={16} /> : undefined
          }
        >
          Create task
        </Button>
      </DialogActions>
    </Dialog>
  );
}
