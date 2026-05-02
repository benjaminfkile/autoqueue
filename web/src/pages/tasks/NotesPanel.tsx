import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Alert from "@mui/material/Alert";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import SaveIcon from "@mui/icons-material/Save";
import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import { notesApi } from "../../api/client";
import type { NoteVisibility, TaskNote } from "../../api/types";
import { useVisibilityAwarePolling } from "../../hooks/useVisibilityAwarePolling";

const POLL_INTERVAL_MS = 5000;

const NOTE_VISIBILITY_OPTIONS: NoteVisibility[] = [
  "self",
  "siblings",
  "descendants",
  "ancestors",
  "all",
];

function parseNoteTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export interface NotesPanelProps {
  taskId: number;
}

export default function NotesPanel({ taskId }: NotesPanelProps) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftVisibility, setDraftVisibility] = useState<NoteVisibility>("all");
  const [draftTags, setDraftTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchNotes = useCallback(async () => {
    try {
      const list = await notesApi.list(taskId);
      setNotes(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes");
    }
  }, [taskId]);

  useEffect(() => {
    void fetchNotes();
  }, [fetchNotes]);

  useVisibilityAwarePolling(fetchNotes, POLL_INTERVAL_MS);

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

  const handleSubmit = useCallback(async () => {
    const content = draftContent.trim();
    if (content === "") return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = parseNoteTags(draftTags);
      const created = await notesApi.create(taskId, {
        author: "user",
        visibility: draftVisibility,
        content,
        tags: tags.length > 0 ? tags : undefined,
      });
      setNotes((prev) => [...prev, created]);
      setDraftContent("");
      setDraftTags("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setSubmitting(false);
    }
  }, [draftContent, draftTags, draftVisibility, taskId]);

  const handleDelete = useCallback(
    async (noteId: number) => {
      if (!window.confirm("Delete this note?")) return;
      setDeletingId(noteId);
      setError(null);
      try {
        await notesApi.delete(taskId, noteId);
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete note");
      } finally {
        setDeletingId(null);
      }
    },
    [taskId]
  );

  return (
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
            onClick={() => void fetchNotes()}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack
        spacing={1}
        sx={{ mb: 2 }}
        data-testid="task-detail-note-form"
      >
        <TextField
          size="small"
          multiline
          minRows={2}
          fullWidth
          label="Add a note"
          value={draftContent}
          onChange={(e) => setDraftContent(e.target.value)}
          inputProps={{ "aria-label": "Note content" }}
          disabled={submitting}
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
            value={draftVisibility}
            onChange={(e) =>
              setDraftVisibility(e.target.value as NoteVisibility)
            }
            disabled={submitting}
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
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            inputProps={{ "aria-label": "Note tags" }}
            disabled={submitting}
            sx={{ minWidth: 220, flexGrow: 1 }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={submitting || draftContent.trim().length === 0}
            onClick={() => void handleSubmit()}
          >
            Add note
          </Button>
        </Stack>
      </Stack>

      <Divider sx={{ mb: 1 }} />

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
          onClose={() => setError(null)}
        >
          {error}
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
              secondaryAction={
                <Tooltip title="Delete note">
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label={`Delete note ${n.id}`}
                    data-testid={`note-${n.id}-delete`}
                    disabled={deletingId === n.id}
                    onClick={() => void handleDelete(n.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
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
                      {formatTimestamp(n.created_at)}
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
    </Box>
  );
}
