import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import EditIcon from "@mui/icons-material/Edit";
import SaveIcon from "@mui/icons-material/Save";
import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import { criteriaApi, tasksApi } from "../../api/client";
import type {
  AcceptanceCriterion,
  TaskDetail,
  TaskEvent,
  TaskSummary,
} from "../../api/types";
import { TASK_STATUS_CHIP_COLOR } from "./repoDisplay";

export interface TaskDetailPageProps {
  taskId: number;
  onClose?: () => void;
}

export function taskBranchName(taskId: number): string {
  return `grunt/task-${taskId}`;
}

export function formatEventTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatEventData(
  data: Record<string, unknown> | null
): string {
  if (!data) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export default function TaskDetailPage({ taskId, onClose }: TaskDetailPageProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [parentTask, setParentTask] = useState<TaskSummary | null>(null);
  const [siblings, setSiblings] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  const [savingField, setSavingField] = useState<string | null>(null);

  const [logText, setLogText] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [logStreaming, setLogStreaming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, evs] = await Promise.all([
        tasksApi.get(taskId),
        tasksApi.events(taskId),
      ]);
      setTask(detail);
      setEvents(evs);
      const repoTasks = await tasksApi.listByRepo(detail.repo_id);
      const sibs = repoTasks
        .filter(
          (t) => (t.parent_id ?? null) === (detail.parent_id ?? null) && t.id !== detail.id
        )
        .sort((a, b) => a.order_position - b.order_position);
      setSiblings(sibs);
      if (detail.parent_id !== null) {
        const parent = repoTasks.find((t) => t.id === detail.parent_id) ?? null;
        setParentTask(parent);
      } else {
        setParentTask(null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Log fetching: SSE when active, static otherwise.
  useEffect(() => {
    if (!task) return;
    setLogText("");
    setLogError(null);
    let cancelled = false;
    let source: EventSource | null = null;

    if (task.status === "active") {
      const Ctor: typeof EventSource | undefined =
        typeof window !== "undefined"
          ? (window as unknown as { EventSource?: typeof EventSource })
              .EventSource
          : undefined;
      if (Ctor) {
        try {
          source = new Ctor(tasksApi.logStreamUrl(task.id));
          setLogStreaming(true);
          source.onmessage = (ev: MessageEvent) => {
            if (cancelled) return;
            setLogText((prev) =>
              prev.length === 0 ? ev.data : `${prev}\n${ev.data}`
            );
          };
          source.onerror = () => {
            setLogStreaming(false);
            source?.close();
          };
        } catch (err) {
          setLogError(
            err instanceof Error ? err.message : "Failed to open log stream"
          );
        }
      } else {
        // No EventSource available — fall back to a one-shot static fetch.
        tasksApi
          .log(task.id)
          .then((text) => {
            if (!cancelled) setLogText(text);
          })
          .catch((err) => {
            if (!cancelled)
              setLogError(
                err instanceof Error ? err.message : "Failed to load log"
              );
          });
      }
    } else {
      tasksApi
        .log(task.id)
        .then((text) => {
          if (!cancelled) setLogText(text);
        })
        .catch((err) => {
          if (!cancelled)
            setLogError(
              err instanceof Error ? err.message : "Failed to load log"
            );
        });
    }

    return () => {
      cancelled = true;
      setLogStreaming(false);
      if (source) source.close();
    };
  }, [task?.id, task?.status]);

  const sortedEvents = useMemo(
    () =>
      [...events].sort((a, b) => {
        const ta = Date.parse(a.ts);
        const tb = Date.parse(b.ts);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb)
          return ta - tb;
        return a.id - b.id;
      }),
    [events]
  );

  const sortedCriteria = useMemo(
    () =>
      task
        ? [...task.acceptanceCriteria].sort(
            (a, b) => a.order_position - b.order_position
          )
        : [],
    [task]
  );

  const startEditTitle = () => {
    if (!task) return;
    setTitleDraft(task.title);
    setEditingTitle(true);
  };

  const startEditDescription = () => {
    if (!task) return;
    setDescriptionDraft(task.description);
    setEditingDescription(true);
  };

  async function persist(field: string, fn: () => Promise<void>) {
    setActionError(null);
    setSavingField(field);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingField(null);
    }
  }

  const saveTitle = () =>
    persist("title", async () => {
      if (!task) return;
      const trimmed = titleDraft.trim();
      if (trimmed === "") throw new Error("Title cannot be empty");
      await tasksApi.update(task.id, { title: trimmed });
      setTask((prev) => (prev ? { ...prev, title: trimmed } : prev));
      setEditingTitle(false);
    });

  const saveDescription = () =>
    persist("description", async () => {
      if (!task) return;
      await tasksApi.update(task.id, { description: descriptionDraft });
      setTask((prev) =>
        prev ? { ...prev, description: descriptionDraft } : prev
      );
      setEditingDescription(false);
    });

  const toggleCriterion = (criterion: AcceptanceCriterion) =>
    persist(`criterion-${criterion.id}-met`, async () => {
      if (!task) return;
      const next = !criterion.met;
      const updated = await criteriaApi.update(task.id, criterion.id, {
        met: next,
      });
      setTask((prev) =>
        prev
          ? {
              ...prev,
              acceptanceCriteria: prev.acceptanceCriteria.map((c) =>
                c.id === criterion.id ? { ...c, ...updated } : c
              ),
            }
          : prev
      );
    });

  return (
    <Box aria-label="Task detail">
      {loading && (
        <Box
          sx={{ display: "flex", justifyContent: "center", py: 4 }}
          aria-label="Loading task"
        >
          <CircularProgress />
        </Box>
      )}

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {!loading && task && (
        <Stack spacing={3}>
          {actionError && (
            <Alert
              severity="error"
              onClose={() => setActionError(null)}
            >
              {actionError}
            </Alert>
          )}

          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ flexWrap: "wrap" }}
          >
            {!editingTitle ? (
              <>
                <Typography variant="h5" component="h2" sx={{ flexGrow: 1 }}>
                  {task.title}
                </Typography>
                <Tooltip title="Edit title">
                  <IconButton
                    size="small"
                    onClick={startEditTitle}
                    aria-label="Edit title"
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            ) : (
              <>
                <TextField
                  size="small"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  inputProps={{ "aria-label": "Title" }}
                  sx={{ flexGrow: 1 }}
                  autoFocus
                />
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<SaveIcon />}
                  disabled={savingField === "title"}
                  onClick={() => void saveTitle()}
                >
                  Save
                </Button>
                <Button
                  size="small"
                  onClick={() => setEditingTitle(false)}
                  disabled={savingField === "title"}
                >
                  Cancel
                </Button>
              </>
            )}
            {onClose && (
              <Tooltip title="Close">
                <IconButton
                  size="small"
                  onClick={onClose}
                  aria-label="Close task detail"
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            <Chip
              size="small"
              label={`status: ${task.status}`}
              color={TASK_STATUS_CHIP_COLOR[task.status]}
              variant={task.status === "pending" ? "outlined" : "filled"}
              data-testid="task-detail-status"
              aria-label={`Status: ${task.status}`}
            />
            <Chip
              size="small"
              label={`branch: ${taskBranchName(task.id)}`}
              variant="outlined"
              data-testid="task-detail-branch"
              aria-label={`Current branch: ${taskBranchName(task.id)}`}
            />
            {task.pr_url ? (
              <Chip
                size="small"
                component="a"
                href={task.pr_url}
                target="_blank"
                rel="noreferrer"
                clickable
                icon={<OpenInNewIcon fontSize="small" />}
                label="Pull request"
                data-testid="task-detail-pr"
                aria-label={`Pull request: ${task.pr_url}`}
              />
            ) : (
              <Chip
                size="small"
                label="no PR"
                variant="outlined"
                data-testid="task-detail-pr-none"
              />
            )}
          </Stack>

          <Box>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
            >
              <Typography variant="subtitle1" component="h3">
                Description
              </Typography>
              {!editingDescription && (
                <IconButton
                  size="small"
                  onClick={startEditDescription}
                  aria-label="Edit description"
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              )}
            </Stack>
            {!editingDescription ? (
              <Typography
                variant="body2"
                color={task.description ? "text.primary" : "text.secondary"}
                sx={{ whiteSpace: "pre-wrap" }}
                data-testid="task-detail-description"
              >
                {task.description || "No description."}
              </Typography>
            ) : (
              <Stack spacing={1}>
                <TextField
                  size="small"
                  multiline
                  minRows={3}
                  fullWidth
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  inputProps={{ "aria-label": "Description" }}
                />
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    disabled={savingField === "description"}
                    onClick={() => void saveDescription()}
                  >
                    Save
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setEditingDescription(false)}
                    disabled={savingField === "description"}
                  >
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              Acceptance criteria
            </Typography>
            {sortedCriteria.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No acceptance criteria.
              </Typography>
            ) : (
              <List dense disablePadding>
                {sortedCriteria.map((c) => (
                  <ListItem
                    key={c.id}
                    disablePadding
                    data-testid={`criterion-${c.id}`}
                    sx={{ alignItems: "flex-start" }}
                  >
                    <Checkbox
                      checked={c.met}
                      disabled={savingField === `criterion-${c.id}-met`}
                      onChange={() => void toggleCriterion(c)}
                      inputProps={{
                        "aria-label": `Acceptance criterion: ${c.description}`,
                      }}
                    />
                    <ListItemText
                      primary={
                        <Typography
                          variant="body2"
                          sx={{
                            textDecoration: c.met ? "line-through" : "none",
                            color: c.met ? "text.secondary" : "text.primary",
                          }}
                        >
                          {c.description}
                        </Typography>
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              Context
            </Typography>
            <Stack spacing={1}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Parent
                </Typography>
                <Typography
                  variant="body2"
                  data-testid="task-detail-parent"
                >
                  {task.parent_id === null
                    ? "None (root task)"
                    : parentTask
                      ? `#${parentTask.id} · ${parentTask.title}`
                      : `#${task.parent_id}`}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Siblings
                </Typography>
                {siblings.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No siblings.
                  </Typography>
                ) : (
                  <List
                    dense
                    disablePadding
                    aria-label="Siblings"
                    data-testid="task-detail-siblings"
                  >
                    {siblings.map((sib) => (
                      <ListItem
                        key={sib.id}
                        disablePadding
                        data-testid={`sibling-${sib.id}`}
                      >
                        <ListItemText
                          primary={
                            <Stack
                              direction="row"
                              spacing={1}
                              alignItems="center"
                            >
                              <Typography variant="body2">
                                {sib.title}
                              </Typography>
                              <Chip
                                size="small"
                                label={sib.status}
                                color={TASK_STATUS_CHIP_COLOR[sib.status]}
                                variant={
                                  sib.status === "pending"
                                    ? "outlined"
                                    : "filled"
                                }
                              />
                            </Stack>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Children
                </Typography>
                {task.children.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No children.
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {task.children.map((child) => (
                      <ListItem
                        key={child.id}
                        disablePadding
                        data-testid={`child-${child.id}`}
                      >
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2">
                                {child.title}
                              </Typography>
                              <Chip
                                size="small"
                                label={child.status}
                                color={TASK_STATUS_CHIP_COLOR[child.status]}
                                variant={
                                  child.status === "pending"
                                    ? "outlined"
                                    : "filled"
                                }
                              />
                            </Stack>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 1 }}
            >
              <Typography variant="subtitle1" component="h3">
                Log
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                {logStreaming && (
                  <Chip
                    size="small"
                    label="streaming"
                    color="primary"
                    aria-label="Log is streaming"
                  />
                )}
              </Stack>
            </Stack>
            {logError && (
              <Alert severity="error" sx={{ mb: 1 }}>
                {logError}
              </Alert>
            )}
            <Paper
              variant="outlined"
              sx={{
                p: 1,
                bgcolor: "grey.50",
                maxHeight: 300,
                overflow: "auto",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                whiteSpace: "pre-wrap",
              }}
              data-testid="task-detail-log"
              aria-label="Task log"
            >
              {logText
                ? logText
                : (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    component="span"
                  >
                    {logStreaming ? "Waiting for log output…" : "No log yet."}
                  </Typography>
                )}
            </Paper>
          </Box>

          <Divider />

          <Box>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 1 }}
            >
              <Typography variant="subtitle1" component="h3">
                Event timeline
              </Typography>
              <Tooltip title="Refresh events">
                <IconButton
                  size="small"
                  aria-label="Refresh events"
                  onClick={() => void load()}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            {sortedEvents.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No events yet.
              </Typography>
            ) : (
              <List
                dense
                disablePadding
                aria-label="Event timeline"
                data-testid="task-detail-events"
              >
                {sortedEvents.map((ev) => (
                  <ListItem
                    key={ev.id}
                    disablePadding
                    data-testid={`event-${ev.id}`}
                    sx={{ alignItems: "flex-start", py: 0.25 }}
                  >
                    <ListItemText
                      primary={
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="baseline"
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ minWidth: 160 }}
                          >
                            {formatEventTimestamp(ev.ts)}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ fontWeight: 500 }}
                          >
                            {ev.event}
                          </Typography>
                          {ev.data && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: "monospace" }}
                            >
                              {formatEventData(ev.data)}
                            </Typography>
                          )}
                        </Stack>
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        </Stack>
      )}
    </Box>
  );
}
