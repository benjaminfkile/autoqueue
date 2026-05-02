import { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/Delete";
import { tasksApi } from "../../api/client";
import type {
  OrderingMode,
  TaskDetail,
  TaskEffectiveModel,
  TaskStatus,
  TaskUpdateInput,
} from "../../api/types";
import LiveAcceptanceCriteriaEditor from "./LiveAcceptanceCriteriaEditor";
import ModelSelect from "./ModelSelect";

const ORDERING_MODE_OPTIONS: Array<{
  value: OrderingMode | "inherit";
  label: string;
}> = [
  { value: "inherit", label: "Inherit from parent" },
  { value: "sequential", label: "Sequential" },
  { value: "parallel", label: "Parallel" },
];

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "interrupted", label: "Interrupted" },
];

interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  orderPosition: string;
  orderingMode: OrderingMode | "inherit";
  model: string | null;
  requiresApproval: boolean;
}

function taskToForm(task: TaskDetail): FormState {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    orderPosition: String(task.order_position),
    orderingMode: task.ordering_mode ?? "inherit",
    model: task.model,
    requiresApproval: task.requires_approval,
  };
}

function buildPatch(original: TaskDetail, form: FormState): TaskUpdateInput {
  const patch: TaskUpdateInput = {};
  if (form.title.trim() !== original.title) patch.title = form.title.trim();
  if ((form.description.trim() || "") !== (original.description ?? ""))
    patch.description = form.description.trim();
  if (form.status !== original.status) patch.status = form.status;
  const numericPosition = Number(form.orderPosition);
  if (
    form.orderPosition !== "" &&
    Number.isFinite(numericPosition) &&
    numericPosition !== original.order_position
  ) {
    patch.order_position = numericPosition;
  }
  const newMode: OrderingMode | null =
    form.orderingMode === "inherit" ? null : form.orderingMode;
  if (newMode !== (original.ordering_mode ?? null))
    patch.ordering_mode = newMode;
  if (form.model !== original.model) patch.model = form.model;
  if (form.requiresApproval !== original.requires_approval)
    patch.requires_approval = form.requiresApproval;
  return patch;
}

export interface EditTaskDialogProps {
  open: boolean;
  taskId: number | null;
  focusOnModel?: boolean;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: (taskId: number) => void;
}

export default function EditTaskDialog({
  open,
  taskId,
  focusOnModel = false,
  onClose,
  onUpdated,
  onDeleted,
}: EditTaskDialogProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [effectiveModel, setEffectiveModel] =
    useState<TaskEffectiveModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Track the taskId we last loaded so we can avoid redundant fetches
  const loadedForId = useRef<number | null>(null);
  const modelSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || taskId == null) {
      setTask(null);
      setForm(null);
      setEffectiveModel(null);
      setLoadError(null);
      setServerError(null);
      setConfirmDelete(false);
      setConfirmDiscard(false);
      loadedForId.current = null;
      return;
    }
    if (loadedForId.current === taskId) return;
    loadedForId.current = taskId;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setTask(null);
    setForm(null);
    setEffectiveModel(null);
    setConfirmDelete(false);

    Promise.all([
      tasksApi.get(taskId),
      tasksApi.effectiveModel(taskId).catch(() => null),
    ])
      .then(([t, em]) => {
        if (cancelled) return;
        setTask(t);
        setForm(taskToForm(t));
        setEffectiveModel(em);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load task");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  // Scroll the model section into view when focusOnModel is requested and the
  // form has loaded — gives a clear visual cue when the model chip was clicked.
  useEffect(() => {
    if (focusOnModel && form && modelSectionRef.current) {
      const el = modelSectionRef.current;
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    }
  }, [focusOnModel, form]);

  const isDirty = task && form ? Object.keys(buildPatch(task, form)).length > 0 : false;

  function requestClose() {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function validate(): string | null {
    if (!form) return null;
    if (!form.title.trim()) return "Title is required.";
    if (form.orderPosition !== "") {
      const n = Number(form.orderPosition);
      if (!Number.isInteger(n) || n < 0)
        return "Order position must be a non-negative integer.";
    }
    return null;
  }

  async function handleSubmit() {
    if (!task || !form) return;
    const validationError = validate();
    if (validationError) {
      setServerError(validationError);
      return;
    }
    const patch = buildPatch(task, form);
    // Nothing changed — just close.
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      await tasksApi.update(task.id, patch);
      onUpdated();
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Request failed");
      setSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!task) return;
    setDeleting(true);
    setServerError(null);
    try {
      await tasksApi.delete(task.id);
      onDeleted(task.id);
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const busy = submitting || deleting;

  return (
    <>
    <Dialog
      open={open}
      onClose={busy ? undefined : (_, reason) => {
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
      aria-labelledby="edit-task-dialog-title"
    >
      <DialogTitle id="edit-task-dialog-title">
        {task ? `Edit task: ${task.title}` : "Edit task"}
      </DialogTitle>
      <DialogContent>
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        )}
        {loadError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {loadError}
          </Alert>
        )}
        {!loading && !loadError && form && task && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            {serverError && <Alert severity="error">{serverError}</Alert>}

            <TextField
              label="Title"
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
              required
              fullWidth
              autoFocus
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
              label="Status"
              value={form.status}
              onChange={(e) => update("status", e.target.value as TaskStatus)}
              fullWidth
            >
              {STATUS_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
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

            <Box ref={modelSectionRef}>
              <ModelSelect
                value={form.model}
                onChange={(v) => update("model", v)}
              />
              {effectiveModel && (
                <Box sx={{ mt: 1 }}>
                  <Chip
                    size="small"
                    label={
                      <Typography variant="caption">
                        Effective model:{" "}
                        <strong>{effectiveModel.model}</strong>{" "}
                        (source: {effectiveModel.source})
                      </Typography>
                    }
                    variant="outlined"
                    color={
                      effectiveModel.source === "override"
                        ? "primary"
                        : "default"
                    }
                  />
                </Box>
              )}
            </Box>

            <FormControlLabel
              control={
                <Switch
                  checked={form.requiresApproval}
                  onChange={(e) =>
                    update("requiresApproval", e.target.checked)
                  }
                  inputProps={{ "aria-label": "Requires approval" }}
                />
              }
              label="Requires approval before running"
            />

            <LiveAcceptanceCriteriaEditor
              taskId={task.id}
              initialCriteria={task.acceptanceCriteria}
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: "space-between" }}>
        {/* Left side: delete */}
        <Box>
          {confirmDelete ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="error">
                Delete this task and all its children?
              </Typography>
              <Button
                color="error"
                variant="contained"
                onClick={() => void handleDeleteConfirm()}
                disabled={deleting}
                startIcon={
                  deleting ? <CircularProgress size={14} /> : <DeleteIcon />
                }
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </Button>
              <Button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
            </Stack>
          ) : (
            <Button
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setConfirmDelete(true)}
              disabled={busy || !task}
            >
              Delete task
            </Button>
          )}
        </Box>
        {/* Right side: cancel / save */}
        <Stack direction="row" spacing={1}>
          <Button onClick={requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSubmit()}
            disabled={busy || !form}
          >
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      maxWidth="xs"
      aria-labelledby="edit-task-discard-title"
    >
      <DialogTitle id="edit-task-discard-title">Discard changes?</DialogTitle>
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
