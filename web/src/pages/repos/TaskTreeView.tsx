import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import EditIcon from "@mui/icons-material/Edit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ReplayIcon from "@mui/icons-material/Replay";
import StopIcon from "@mui/icons-material/Stop";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import AddIcon from "@mui/icons-material/Add";
import PlaylistAddIcon from "@mui/icons-material/PlaylistAdd";
import BookmarkAddIcon from "@mui/icons-material/BookmarkAdd";
import Button from "@mui/material/Button";
import { notesApi, tasksApi, templatesApi } from "../../api/client";
import type { TaskEffectiveModel, TaskStatus, TaskSummary } from "../../api/types";
import { useVisibilityAwarePolling } from "../../hooks/useVisibilityAwarePolling";
import { TASK_STATUS_CHIP_COLOR } from "./repoDisplay";

export interface TaskNode {
  task: TaskSummary;
  children: TaskNode[];
}

export function buildTaskTree(tasks: TaskSummary[]): TaskNode[] {
  const byParent = new Map<number | null, TaskSummary[]>();
  for (const t of tasks) {
    const key = t.parent_id ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(t);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.order_position - b.order_position);
  }
  function build(parentId: number | null): TaskNode[] {
    const list = byParent.get(parentId) ?? [];
    return list.map((t) => ({ task: t, children: build(t.id) }));
  }
  return build(null);
}

const RERUNNABLE: TaskStatus[] = ["failed", "interrupted", "done"];
const ABANDONABLE: TaskStatus[] = ["pending", "active"];

export interface TaskTreeViewProps {
  repoId: number;
  onViewDetail?: (task: TaskSummary) => void;
  selectedTaskId?: number | null;
  onAddChild?: (task: TaskSummary) => void;
  onAddTask?: () => void;
  onAddPhase?: () => void;
  onEdit?: (task: TaskSummary) => void;
  onEditFocusModel?: (task: TaskSummary) => void;
  refreshTrigger?: number;
}

export default function TaskTreeView({
  repoId,
  onViewDetail,
  selectedTaskId = null,
  onAddChild,
  onAddTask,
  onAddPhase,
  onEdit,
  onEditFocusModel,
  refreshTrigger,
}: TaskTreeViewProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [noteCountByTaskId, setNoteCountByTaskId] = useState<Record<number, number>>({});
  const [criteriaSummaryByTaskId, setCriteriaSummaryByTaskId] = useState<
    Record<number, { met: number; total: number }>
  >({});
  const [effectiveModelByTaskId, setEffectiveModelByTaskId] = useState<
    Record<number, TaskEffectiveModel>
  >({});

  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDesc, setTemplateDesc] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saveTemplateError, setSaveTemplateError] = useState<string | null>(null);
  const [saveTemplateSuccess, setSaveTemplateSuccess] = useState(false);

  const fetchNoteCounts = useCallback(async (taskList: TaskSummary[]) => {
    if (taskList.length === 0) return;
    const counts: Record<number, number> = {};
    await Promise.allSettled(
      taskList.map(async (t) => {
        try {
          const noteList = await notesApi.list(t.id);
          counts[t.id] = noteList.length;
        } catch {
          // silently ignored — badge simply won't show for this task
        }
      })
    );
    setNoteCountByTaskId(counts);
  }, []);

  const fetchCriteriaSummaries = useCallback(async (taskList: TaskSummary[]) => {
    if (taskList.length === 0) return;
    const summaries: Record<number, { met: number; total: number }> = {};
    await Promise.allSettled(
      taskList.map(async (t) => {
        try {
          const criteria = await tasksApi.criteria.list(t.id);
          if (criteria.length > 0) {
            summaries[t.id] = {
              total: criteria.length,
              met: criteria.filter((c) => c.met).length,
            };
          }
        } catch {
          // silently ignored — chip simply won't show for this task
        }
      })
    );
    setCriteriaSummaryByTaskId(summaries);
  }, []);

  const fetchEffectiveModels = useCallback(async (taskList: TaskSummary[]) => {
    if (taskList.length === 0) return;
    const models: Record<number, TaskEffectiveModel> = {};
    await Promise.allSettled(
      taskList.map(async (t) => {
        try {
          const em = await tasksApi.effectiveModel(t.id);
          if (em && em.source !== "default") {
            models[t.id] = em;
          }
        } catch {
          // silently ignored
        }
      })
    );
    setEffectiveModelByTaskId(models);
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean; refreshExtras?: boolean }) => {
      const silent = opts?.silent ?? false;
      const refreshExtras = opts?.refreshExtras ?? false;
      if (!silent) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const list = await tasksApi.listByRepo(repoId);
        setTasks(list);
        void fetchNoteCounts(list);
        // Criteria and effective-model data are only fetched on initial/explicit
        // loads — not on every silent poll tick — to avoid N×2 requests per
        // second per open repo panel.
        if (!silent || refreshExtras) {
          void fetchCriteriaSummaries(list);
          void fetchEffectiveModels(list);
        }
        if (!silent) {
          // Auto-expand root tasks on the initial (visible) load. Polling
          // refreshes intentionally skip this so a user-driven collapse is
          // not undone on the next tick.
          setExpanded((prev) => {
            const next = new Set(prev);
            for (const t of list) {
              if (t.parent_id === null) next.add(t.id);
            }
            return next;
          });
        }
      } catch (err) {
        if (!silent) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load tasks"
          );
        }
        // Silent polling failures are intentionally swallowed — the next
        // tick will retry, and we don't want a transient hiccup to flash a
        // banner over an otherwise-stable tree.
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [repoId, fetchNoteCounts, fetchCriteriaSummaries, fetchEffectiveModels]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Re-fetch when a task is created externally (e.g. from NewTaskDialog).
  // Also refresh criteria/model data since the new/updated task may have them.
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    void load({ silent: true, refreshExtras: true });
  }, [refreshTrigger, load]);

  const pollFetcher = useCallback(() => load({ silent: true }), [load]);
  useVisibilityAwarePolling(pollFetcher);

  const tree = useMemo(() => buildTaskTree(tasks), [tasks]);

  const toggleExpanded = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateLocalStatus = useCallback(
    (id: number, status: TaskStatus) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status } : t))
      );
    },
    []
  );

  const handleRerun = useCallback(
    async (task: TaskSummary) => {
      setActionError(null);
      const previous = task.status;
      updateLocalStatus(task.id, "pending");
      try {
        const updated = await tasksApi.update(task.id, { status: "pending" });
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t))
        );
      } catch (err) {
        updateLocalStatus(task.id, previous);
        setActionError(
          err instanceof Error ? err.message : "Failed to re-run task"
        );
      }
    },
    [updateLocalStatus]
  );

  const handleApprove = useCallback(
    async (task: TaskSummary) => {
      setActionError(null);
      const previous = task.requires_approval;
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...t, requires_approval: false } : t
        )
      );
      try {
        const updated = await tasksApi.update(task.id, {
          requires_approval: false,
        });
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t))
        );
      } catch (err) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === task.id ? { ...t, requires_approval: previous } : t
          )
        );
        setActionError(
          err instanceof Error ? err.message : "Failed to approve task"
        );
      }
    },
    []
  );

  const handleAbandon = useCallback(
    async (task: TaskSummary) => {
      setActionError(null);
      const previous = task.status;
      updateLocalStatus(task.id, "interrupted");
      try {
        const updated = await tasksApi.update(task.id, {
          status: "interrupted",
        });
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t))
        );
      } catch (err) {
        updateLocalStatus(task.id, previous);
        setActionError(
          err instanceof Error ? err.message : "Failed to abandon task"
        );
      }
    },
    [updateLocalStatus]
  );

  const handleReorder = useCallback(
    async (sourceId: number, targetId: number) => {
      if (sourceId === targetId) return;
      const source = tasks.find((t) => t.id === sourceId);
      const target = tasks.find((t) => t.id === targetId);
      if (!source || !target) return;
      if ((source.parent_id ?? null) !== (target.parent_id ?? null)) {
        setActionError("Tasks can only be reordered among siblings.");
        return;
      }
      if (source.order_position === target.order_position) return;

      const previous = tasks;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === source.id)
            return { ...t, order_position: target.order_position };
          if (t.id === target.id)
            return { ...t, order_position: source.order_position };
          return t;
        })
      );

      try {
        await tasksApi.update(source.id, {
          order_position: target.order_position,
        });
        await tasksApi.update(target.id, {
          order_position: source.order_position,
        });
      } catch (err) {
        setTasks(previous);
        setActionError(
          err instanceof Error ? err.message : "Failed to reorder task"
        );
      }
    },
    [tasks]
  );

  async function handleSaveAsTemplate() {
    const name = templateName.trim();
    if (!name) {
      setSaveTemplateError("Template name is required.");
      return;
    }
    setSavingTemplate(true);
    setSaveTemplateError(null);
    try {
      await templatesApi.save({
        name,
        description: templateDesc.trim() || undefined,
        repo_id: repoId,
      });
      setSaveTemplateOpen(false);
      setTemplateName("");
      setTemplateDesc("");
      setSaveTemplateSuccess(true);
      setTimeout(() => setSaveTemplateSuccess(false), 3000);
    } catch (err) {
      setSaveTemplateError(
        err instanceof Error ? err.message : "Failed to save template"
      );
    } finally {
      setSavingTemplate(false);
    }
  }

  if (loading) {
    return (
      <Box
        sx={{ display: "flex", justifyContent: "center", py: 4 }}
        aria-label="Loading tasks"
      >
        <CircularProgress />
      </Box>
    );
  }

  if (loadError) {
    return (
      <Alert severity="error" sx={{ my: 2 }}>
        {loadError}
      </Alert>
    );
  }

  if (tasks.length === 0) {
    return (
      <Box sx={{ py: 3, textAlign: "center" }} role="status">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          No tasks yet.
        </Typography>
        <Stack direction="row" spacing={1} justifyContent="center">
          {onAddPhase && (
            <Button
              variant="outlined"
              startIcon={<PlaylistAddIcon />}
              onClick={onAddPhase}
              data-testid="tasktree-add-phase"
            >
              Add phase
            </Button>
          )}
          {onAddTask && (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={onAddTask}
            >
              Add task
            </Button>
          )}
        </Stack>
      </Box>
    );
  }

  return (
    <Box aria-label="Task tree" role="tree">
      {(onAddPhase || tasks.length > 0) && (
        <Box sx={{ mb: 1, display: "flex", justifyContent: "flex-end", gap: 1 }}>
          {saveTemplateSuccess && (
            <Alert severity="success" sx={{ py: 0, flex: 1 }}>
              Template saved!
            </Alert>
          )}
          <Button
            size="small"
            variant="outlined"
            startIcon={<BookmarkAddIcon />}
            onClick={() => {
              setTemplateName("");
              setTemplateDesc("");
              setSaveTemplateError(null);
              setSaveTemplateOpen(true);
            }}
            data-testid="tasktree-save-template"
          >
            Save as template
          </Button>
          {onAddPhase && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<PlaylistAddIcon />}
              onClick={onAddPhase}
              data-testid="tasktree-add-phase"
            >
              Add phase
            </Button>
          )}
        </Box>
      )}
      {actionError && (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
          onClose={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      )}
      <Stack spacing={0.5}>
        {tree.map((node) => (
          <TaskTreeNode
            key={node.task.id}
            node={node}
            depth={0}
            expanded={expanded}
            onToggleExpand={toggleExpanded}
            onRerun={handleRerun}
            onAbandon={handleAbandon}
            onApprove={handleApprove}
            onViewDetail={onViewDetail}
            onAddChild={onAddChild}
            onEdit={onEdit}
            onEditFocusModel={onEditFocusModel}
            draggingId={draggingId}
            dropTargetId={dropTargetId}
            setDraggingId={setDraggingId}
            setDropTargetId={setDropTargetId}
            onReorder={handleReorder}
            selectedTaskId={selectedTaskId}
            noteCountByTaskId={noteCountByTaskId}
            criteriaSummaryByTaskId={criteriaSummaryByTaskId}
            effectiveModelByTaskId={effectiveModelByTaskId}
          />
        ))}
      </Stack>

      <Dialog
        open={saveTemplateOpen}
        onClose={() => !savingTemplate && setSaveTemplateOpen(false)}
        aria-labelledby="save-template-dialog-title"
        data-testid="save-template-dialog"
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id="save-template-dialog-title">
          Save as template
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {saveTemplateError && (
              <Alert severity="error" onClose={() => setSaveTemplateError(null)}>
                {saveTemplateError}
              </Alert>
            )}
            <TextField
              label="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              disabled={savingTemplate}
              size="small"
              fullWidth
              required
              inputProps={{ "aria-label": "Template name" }}
              data-testid="save-template-name"
            />
            <TextField
              label="Description"
              value={templateDesc}
              onChange={(e) => setTemplateDesc(e.target.value)}
              disabled={savingTemplate}
              size="small"
              fullWidth
              multiline
              minRows={2}
              inputProps={{ "aria-label": "Template description" }}
              data-testid="save-template-description"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setSaveTemplateOpen(false)}
            disabled={savingTemplate}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveAsTemplate()}
            disabled={savingTemplate || templateName.trim() === ""}
            startIcon={
              savingTemplate ? (
                <CircularProgress color="inherit" size={16} />
              ) : null
            }
            data-testid="save-template-confirm"
          >
            {savingTemplate ? "Saving…" : "Save template"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

interface TaskTreeNodeProps {
  node: TaskNode;
  depth: number;
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onRerun: (task: TaskSummary) => void;
  onAbandon: (task: TaskSummary) => void;
  onApprove: (task: TaskSummary) => void;
  onViewDetail?: (task: TaskSummary) => void;
  onAddChild?: (task: TaskSummary) => void;
  onEdit?: (task: TaskSummary) => void;
  onEditFocusModel?: (task: TaskSummary) => void;
  draggingId: number | null;
  dropTargetId: number | null;
  setDraggingId: (id: number | null) => void;
  setDropTargetId: (id: number | null) => void;
  onReorder: (sourceId: number, targetId: number) => void;
  selectedTaskId: number | null;
  noteCountByTaskId: Record<number, number>;
  criteriaSummaryByTaskId: Record<number, { met: number; total: number }>;
  effectiveModelByTaskId: Record<number, TaskEffectiveModel>;
}

function abbreviateModel(model: string): string {
  return model.replace(/^claude[-_]/i, "");
}

function TaskTreeNode({
  node,
  depth,
  expanded,
  onToggleExpand,
  onRerun,
  onAbandon,
  onApprove,
  onViewDetail,
  onAddChild,
  onEdit,
  onEditFocusModel,
  draggingId,
  dropTargetId,
  setDraggingId,
  setDropTargetId,
  onReorder,
  selectedTaskId,
  noteCountByTaskId,
  criteriaSummaryByTaskId,
  effectiveModelByTaskId,
}: TaskTreeNodeProps) {
  const { task, children } = node;
  const noteCount = noteCountByTaskId[task.id] ?? 0;
  const criteriaSummary = criteriaSummaryByTaskId[task.id];
  const effectiveModel = effectiveModelByTaskId[task.id];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(task.id);
  const isDragging = draggingId === task.id;
  const isDropTarget = dropTargetId === task.id && draggingId !== task.id;
  const isSelected = selectedTaskId === task.id;

  const canRerun = RERUNNABLE.includes(task.status);
  const canAbandon = ABANDONABLE.includes(task.status);

  return (
    <Box role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(task.id));
          setDraggingId(task.id);
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTargetId(null);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (draggingId !== null && draggingId !== task.id) {
            setDropTargetId(task.id);
          }
        }}
        onDragLeave={() => {
          if (dropTargetId === task.id) setDropTargetId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const raw =
            e.dataTransfer.getData("text/plain") ||
            (draggingId !== null ? String(draggingId) : "");
          const sourceId = parseInt(raw, 10);
          setDropTargetId(null);
          setDraggingId(null);
          if (!Number.isFinite(sourceId)) return;
          onReorder(sourceId, task.id);
        }}
        sx={{
          pl: depth * 3,
          py: 0.5,
          pr: 1,
          borderRadius: 1,
          bgcolor: isDropTarget
            ? "action.hover"
            : isSelected
              ? "action.selected"
              : "transparent",
          opacity: isDragging ? 0.5 : 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
        data-testid={`task-row-${task.id}`}
        aria-selected={isSelected || undefined}
      >
        <Box
          aria-label={`Drag handle for ${task.title}`}
          sx={{ display: "flex", alignItems: "center", color: "text.disabled", cursor: "grab" }}
        >
          <DragIndicatorIcon fontSize="small" />
        </Box>
        {hasChildren ? (
          <IconButton
            size="small"
            onClick={() => onToggleExpand(task.id)}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${task.title}`}
          >
            {isExpanded ? (
              <ExpandMoreIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )}
          </IconButton>
        ) : (
          <Box sx={{ width: 30 }} aria-hidden />
        )}
        <Typography
          variant="body2"
          sx={{ flexGrow: 1, fontWeight: hasChildren ? 500 : 400 }}
        >
          {task.title}
        </Typography>
        {noteCount > 0 && (
          <Chip
            size="small"
            label={noteCount}
            color="info"
            variant="outlined"
            aria-label={`${noteCount} visible note${noteCount !== 1 ? "s" : ""}`}
            data-testid={`task-notes-badge-${task.id}`}
            sx={{
              height: 18,
              fontSize: "0.7rem",
              "& .MuiChip-label": { px: 0.75, py: 0 },
            }}
          />
        )}
        {criteriaSummary && criteriaSummary.total > 0 && (
          <Tooltip
            title={`${criteriaSummary.met} of ${criteriaSummary.total} acceptance criteria met`}
          >
            <Chip
              size="small"
              label={`${criteriaSummary.met}/${criteriaSummary.total}`}
              color={criteriaSummary.met === criteriaSummary.total ? "success" : "default"}
              variant="outlined"
              aria-label={`${criteriaSummary.met} of ${criteriaSummary.total} criteria met`}
              data-testid={`task-criteria-badge-${task.id}`}
              sx={{
                height: 18,
                fontSize: "0.7rem",
                "& .MuiChip-label": { px: 0.75, py: 0 },
              }}
            />
          </Tooltip>
        )}
        {task.requires_approval && (
          <Tooltip title="Requires approval before running">
            <Chip
              size="small"
              label="approval"
              color="warning"
              variant="outlined"
              aria-label="Requires approval before running"
              data-testid={`task-approval-badge-${task.id}`}
              sx={{
                height: 18,
                fontSize: "0.7rem",
                "& .MuiChip-label": { px: 0.75, py: 0 },
              }}
            />
          </Tooltip>
        )}
        {effectiveModel && (
          <Tooltip
            title={`Model: ${effectiveModel.model} (${effectiveModel.source})`}
          >
            <Chip
              size="small"
              label={abbreviateModel(effectiveModel.model)}
              color={effectiveModel.source === "override" ? "primary" : "secondary"}
              variant="outlined"
              onClick={() => onEditFocusModel?.(task)}
              aria-label={`Model: ${effectiveModel.model}`}
              data-testid={`task-model-badge-${task.id}`}
              sx={{
                height: 18,
                fontSize: "0.7rem",
                cursor: onEditFocusModel ? "pointer" : "default",
                "& .MuiChip-label": { px: 0.75, py: 0 },
              }}
            />
          </Tooltip>
        )}
        <Chip
          size="small"
          label={task.status}
          color={TASK_STATUS_CHIP_COLOR[task.status]}
          variant={task.status === "pending" ? "outlined" : "filled"}
          aria-label={`Status of ${task.title}: ${task.status}`}
          data-testid={`task-status-${task.id}`}
        />
        <Tooltip title="Approve to run">
          <span>
            <IconButton
              size="small"
              onClick={() => onApprove(task)}
              disabled={!task.requires_approval}
              aria-label={`Approve ${task.title} to run`}
            >
              <CheckCircleIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Re-run">
          <span>
            <IconButton
              size="small"
              onClick={() => onRerun(task)}
              disabled={!canRerun}
              aria-label={`Re-run ${task.title}`}
            >
              <ReplayIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Abandon">
          <span>
            <IconButton
              size="small"
              onClick={() => onAbandon(task)}
              disabled={!canAbandon}
              aria-label={`Abandon ${task.title}`}
            >
              <StopIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="View detail">
          <span>
            <IconButton
              size="small"
              onClick={() => onViewDetail?.(task)}
              disabled={!onViewDetail}
              aria-label={`View detail of ${task.title}`}
            >
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {onAddChild && (
          <Tooltip title="Add child task">
            <IconButton
              size="small"
              onClick={() => onAddChild(task)}
              aria-label={`Add child task to ${task.title}`}
              data-testid={`task-add-child-${task.id}`}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Edit task">
          <IconButton
            size="small"
            onClick={() => onEdit?.(task)}
            disabled={!onEdit}
            aria-label={`Edit ${task.title}`}
            data-testid={`task-edit-${task.id}`}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {hasChildren && isExpanded && (
        <Box role="group">
          {children.map((child) => (
            <TaskTreeNode
              key={child.task.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onRerun={onRerun}
              onAbandon={onAbandon}
              onApprove={onApprove}
              onViewDetail={onViewDetail}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onEditFocusModel={onEditFocusModel}
              draggingId={draggingId}
              dropTargetId={dropTargetId}
              setDraggingId={setDraggingId}
              setDropTargetId={setDropTargetId}
              onReorder={onReorder}
              selectedTaskId={selectedTaskId}
              noteCountByTaskId={noteCountByTaskId}
              criteriaSummaryByTaskId={criteriaSummaryByTaskId}
              effectiveModelByTaskId={effectiveModelByTaskId}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
