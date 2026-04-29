import { useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { tasksApi } from "../../api/client";
import type { AcceptanceCriterion } from "../../api/types";

interface CriterionRow extends AcceptanceCriterion {
  /** True while an API call is in-flight for this row */
  busy?: boolean;
  /** Per-row error message (shown inline) */
  rowError?: string | null;
}

interface LiveAcceptanceCriteriaEditorProps {
  taskId: number;
  initialCriteria: AcceptanceCriterion[];
}

export default function LiveAcceptanceCriteriaEditor({
  taskId,
  initialCriteria,
}: LiveAcceptanceCriteriaEditorProps) {
  const [rows, setRows] = useState<CriterionRow[]>(initialCriteria);
  const [adding, setAdding] = useState(false);

  function updateRow(id: number, patch: Partial<CriterionRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  }

  async function handleAdd() {
    setAdding(true);
    try {
      const created = await tasksApi.criteria.create(taskId, {
        description: "",
        order_position: rows.length,
      });
      setRows((prev) => [...prev, { ...created, busy: false, rowError: null }]);
    } catch (err) {
      // Surface as a noop; user can retry
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: CriterionRow) {
    const snapshot = rows;
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    try {
      await tasksApi.criteria.delete(taskId, row.id);
    } catch (err) {
      setRows(snapshot);
    }
  }

  async function handleDescriptionBlur(row: CriterionRow, description: string) {
    if (description === row.description) return;
    const previous = row.description;
    updateRow(row.id, { busy: true, rowError: null });
    try {
      const updated = await tasksApi.criteria.update(taskId, row.id, {
        description,
      });
      updateRow(row.id, { description: updated.description, busy: false });
    } catch (err) {
      updateRow(row.id, {
        description: previous,
        busy: false,
        rowError: err instanceof Error ? err.message : "Save failed",
      });
    }
  }

  async function handleMetToggle(row: CriterionRow) {
    const nextMet = !row.met;
    updateRow(row.id, { met: nextMet, busy: true, rowError: null });
    try {
      const updated = await tasksApi.criteria.update(taskId, row.id, {
        met: nextMet,
      });
      updateRow(row.id, { met: updated.met, busy: false });
    } catch (err) {
      updateRow(row.id, {
        met: row.met,
        busy: false,
        rowError: err instanceof Error ? err.message : "Save failed",
      });
    }
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        Acceptance criteria
      </Typography>
      {rows.map((row) => (
        <Box key={row.id} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={row.met}
                  onChange={() => void handleMetToggle(row)}
                  disabled={row.busy}
                  size="small"
                />
              }
              label=""
              sx={{ m: 0, mr: 0 }}
            />
            <TextField
              defaultValue={row.description}
              onBlur={(e) => void handleDescriptionBlur(row, e.target.value)}
              size="small"
              fullWidth
              multiline
              disabled={row.busy}
              placeholder="Criterion description"
            />
            {row.busy ? (
              <Box sx={{ display: "flex", alignItems: "center", px: 0.5 }}>
                <CircularProgress size={16} />
              </Box>
            ) : (
              <IconButton
                size="small"
                onClick={() => void handleDelete(row)}
                aria-label="Delete criterion"
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
          {row.rowError && (
            <Typography variant="caption" color="error" sx={{ pl: 5 }}>
              {row.rowError}
            </Typography>
          )}
        </Box>
      ))}
      <Button
        startIcon={adding ? <CircularProgress size={14} /> : <AddIcon />}
        onClick={() => void handleAdd()}
        size="small"
        variant="outlined"
        disabled={adding}
        sx={{ alignSelf: "flex-start" }}
      >
        Add criterion
      </Button>
    </Box>
  );
}
