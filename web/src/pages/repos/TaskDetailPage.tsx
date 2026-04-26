import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import MenuItem from "@mui/material/MenuItem";
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
import { criteriaApi, notesApi, tasksApi } from "../../api/client";
import type {
  AcceptanceCriterion,
  NoteVisibility,
  OrderingMode,
  TaskDetail,
  TaskEvent,
  TaskNote,
  TaskSummary,
  TaskUsageResponse,
} from "../../api/types";
import { useVisibilityAwarePolling } from "../../hooks/useVisibilityAwarePolling";
import { TASK_STATUS_CHIP_COLOR } from "./repoDisplay";
import UsagePanel from "./UsagePanel";

const ACTIVE_POLL_INTERVAL_MS = 2000;
const IDLE_POLL_INTERVAL_MS = 5000;

export interface TaskDetailPageProps {
  taskId: number;
  onClose?: () => void;
}

export function taskBranchName(taskId: number): string {
  return `grunt-task-${taskId}`;
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

export function parseNoteTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const NOTE_VISIBILITY_OPTIONS: NoteVisibility[] = [
  "self",
  "siblings",
  "descendants",
  "ancestors",
  "all",
];

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

  const [usage, setUsage] = useState<TaskUsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [noteDraftContent, setNoteDraftContent] = useState("");
  const [noteDraftVisibility, setNoteDraftVisibility] =
    useState<NoteVisibility>("all");
  const [noteDraftTags, setNoteDraftTags] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);

  const loadNotes = useCallback(async () => {
    setNotesError(null);
    try {
      const list = await notesApi.list(taskId);
      setNotes(list);
    } catch (err) {
      setNotesError(
        err instanceof Error ? err.message : "Failed to load notes"
      );
    }
  }, [taskId]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const data = await tasksApi.usage(taskId);
      setUsage(data);
    } catch (err) {
      setUsageError(
        err instanceof Error ? err.message : "Failed to load usage"
      );
    } finally {
      setUsageLoading(false);
    }
  }, [taskId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, evs, noteList] = await Promise.all([
        tasksApi.get(taskId),
        tasksApi.events(taskId),
        notesApi.list(taskId).catch((err) => {
          setNotesError(
            err instanceof Error ? err.message : "Failed to load notes"
          );
          return [] as TaskNote[];
        }),
      ]);
      setTask(detail);
      setEvents(evs);
      setNotes(noteList);
      void loadUsage();
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
  }, [taskId, loadUsage]);

  useEffect(() => {
    void load();
  }, [load]);

  const pollFetcher = useCallback(async () => {
    try {
      const [detail, evs, noteList] = await Promise.all([
        tasksApi.get(taskId),
        tasksApi.events(taskId),
        notesApi.list(taskId).catch(() => null),
      ]);
      setTask(detail);
      setEvents(evs);
      if (noteList !== null) setNotes(noteList);
    } catch {
      // Silent: a transient polling failure is intentionally swallowed so it
      // doesn't replace stable on-screen data with an error banner. The next
      // tick will retry.
    }
  }, [taskId]);

  const pollIntervalMs =
    task?.status === "active"
      ? ACTIVE_POLL_INTERVAL_MS
      : IDLE_POLL_INTERVAL_MS;
  useVisibilityAwarePolling(pollFetcher, pollIntervalMs);

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

  const sortedNotes = useMemo(
    () =>
      [...notes].sort((a, b) => {
        const ta = Date.parse(a.created_at);
        const tb = Date.parse(b.created_at);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb)
          return ta - tb;
        return a.id - b.id;
      }),
    [notes]
  );

  const submitNote = useCallback(async () => {
    const content = noteDraftContent.trim();
    if (content === "") return;
    setSubmittingNote(true);
    setNotesError(null);
    try {
      const tags = parseNoteTags(noteDraftTags);
      const created = await notesApi.create(taskId, {
        author: "user",
        visibility: noteDraftVisibility,
        content,
        tags: tags.length > 0 ? tags : undefined,
      });
      setNotes((prev) => [...prev, created]);
      setNoteDraftContent("");
      setNoteDraftTags("");
    } catch (err) {
      setNotesError(
        err instanceof Error ? err.message : "Failed to save note"
      );
    } finally {
      setSubmittingNote(false);
    }
  }, [noteDraftContent, noteDraftTags, noteDraftVisibility, taskId]);

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

  const setOrderingMode = (value: OrderingMode | "inherit") =>
    persist("ordering_mode", async () => {
      if (!task) return;
      const next: OrderingMode | null = value === "inherit" ? null : value;
      await tasksApi.update(task.id, { ordering_mode: next });
      setTask((prev) => (prev ? { ...prev, ordering_mode: next } : prev));
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
                  <>
                  <Box sx={{ mb: 1, mt: 0.5 }} data-testid="task-detail-ordering-mode">
                    <TextField
                      select
                      size="small"
                      label="Ordering mode"
                      value={task.ordering_mode ?? "inherit"}
                      onChange={(e) =>
                        void setOrderingMode(
                          e.target.value as OrderingMode | "inherit"
                        )
                      }
                      disabled={savingField === "ordering_mode"}
                      sx={{ minWidth: 200 }}
                      helperText="Controls how child tasks run."
                      SelectProps={{
                        inputProps: { "aria-label": "Ordering mode" },
                      }}
                    >
                      <MenuItem value="inherit">inherit (repo default)</MenuItem>
                      <MenuItem value="sequential">sequential</MenuItem>
                      <MenuItem value="parallel">parallel</MenuItem>
                    </TextField>
                  </Box>
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
                  </>
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
                Token usage
              </Typography>
              <Tooltip title="Refresh usage">
                <IconButton
                  size="small"
                  aria-label="Refresh usage"
                  onClick={() => void loadUsage()}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            {usageError && (
              <Alert
                severity="error"
                sx={{ mb: 1 }}
                onClose={() => setUsageError(null)}
              >
                {usageError}
              </Alert>
            )}
            <UsagePanel
              testId="task-detail-usage"
              loading={usageLoading && !usage}
              totals={
                usage?.totals ?? {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  run_count: 0,
                }
              }
              caption={
                usage
                  ? usage.totals.run_count === 0
                    ? "No agent runs recorded yet."
                    : `Across ${usage.totals.run_count} agent run${
                        usage.totals.run_count === 1 ? "" : "s"
                      }.`
                  : undefined
              }
            />
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
                bgcolor: (theme) =>
                  theme.palette.mode === "dark" ? "grey.900" : "grey.50",
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
                Notes
              </Typography>
              <Tooltip title="Refresh notes">
                <IconButton
                  size="small"
                  aria-label="Refresh notes"
                  onClick={() => void loadNotes()}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            {notesError && (
              <Alert
                severity="error"
                sx={{ mb: 1 }}
                onClose={() => setNotesError(null)}
              >
                {notesError}
              </Alert>
            )}
            {sortedNotes.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No notes yet.
              </Typography>
            ) : (
              <List
                dense
                disablePadding
                aria-label="Notes thread"
                data-testid="task-detail-notes"
              >
                {sortedNotes.map((n) => (
                  <ListItem
                    key={n.id}
                    disablePadding
                    data-testid={`note-${n.id}`}
                    sx={{ alignItems: "flex-start", py: 0.5 }}
                  >
                    <ListItemText
                      primary={
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          sx={{ flexWrap: "wrap" }}
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ minWidth: 160 }}
                          >
                            {formatEventTimestamp(n.created_at)}
                          </Typography>
                          <Chip
                            size="small"
                            label={n.author}
                            color={n.author === "user" ? "primary" : "default"}
                            data-testid={`note-${n.id}-author`}
                          />
                          <Chip
                            size="small"
                            label={n.visibility}
                            variant="outlined"
                            data-testid={`note-${n.id}-visibility`}
                          />
                          {n.tags.map((tag) => (
                            <Chip
                              key={tag}
                              size="small"
                              label={`#${tag}`}
                              variant="outlined"
                              data-testid={`note-${n.id}-tag-${tag}`}
                            />
                          ))}
                        </Stack>
                      }
                      secondary={
                        <Typography
                          variant="body2"
                          color="text.primary"
                          sx={{ whiteSpace: "pre-wrap", mt: 0.5 }}
                          data-testid={`note-${n.id}-content`}
                        >
                          {n.content}
                        </Typography>
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}
            <Stack
              spacing={1}
              sx={{ mt: 2 }}
              data-testid="task-detail-note-form"
            >
              <TextField
                size="small"
                multiline
                minRows={2}
                fullWidth
                label="Add a note"
                value={noteDraftContent}
                onChange={(e) => setNoteDraftContent(e.target.value)}
                inputProps={{ "aria-label": "Note content" }}
                disabled={submittingNote}
              />
              <Stack
                direction="row"
                spacing={1}
                sx={{ flexWrap: "wrap" }}
                alignItems="center"
              >
                <TextField
                  select
                  size="small"
                  label="Visibility"
                  value={noteDraftVisibility}
                  onChange={(e) =>
                    setNoteDraftVisibility(e.target.value as NoteVisibility)
                  }
                  disabled={submittingNote}
                  sx={{ minWidth: 160 }}
                  SelectProps={{
                    inputProps: { "aria-label": "Note visibility" },
                  }}
                >
                  {NOTE_VISIBILITY_OPTIONS.map((v) => (
                    <MenuItem key={v} value={v}>
                      {v}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label="Tags (comma-separated)"
                  value={noteDraftTags}
                  onChange={(e) => setNoteDraftTags(e.target.value)}
                  inputProps={{ "aria-label": "Note tags" }}
                  disabled={submittingNote}
                  sx={{ minWidth: 220, flexGrow: 1 }}
                />
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<SaveIcon />}
                  disabled={
                    submittingNote || noteDraftContent.trim().length === 0
                  }
                  onClick={() => void submitNote()}
                >
                  Add note
                </Button>
              </Stack>
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
