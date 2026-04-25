import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import { systemApi } from "../api/client";
import type { WorkerStatus } from "../api/types";

const REFRESH_MS = 15000;

interface WorkerStatusState {
  status: WorkerStatus | null;
  error: string | null;
}

export function useWorkerStatus(refreshIntervalMs: number = REFRESH_MS): WorkerStatusState {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await systemApi.workerStatus();
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load worker status");
        }
      }
    }

    void load();
    const timer = setInterval(load, refreshIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshIntervalMs]);

  return { status, error };
}

interface WorkerModeChipProps {
  status: WorkerStatus | null;
  error: string | null;
}

export function WorkerModeChip({ status, error }: WorkerModeChipProps) {
  if (error) {
    return (
      <Tooltip title={error}>
        <Chip
          size="small"
          label="Mode unknown"
          color="default"
          variant="outlined"
          aria-label="Worker mode unknown"
          data-testid="worker-mode-chip"
        />
      </Tooltip>
    );
  }

  if (!status) {
    return (
      <Chip
        size="small"
        label="Mode…"
        color="default"
        variant="outlined"
        aria-label="Worker mode loading"
        data-testid="worker-mode-chip"
      />
    );
  }

  const isWorker = status.mode === "worker";
  const tooltip = isWorker
    ? `Worker — polling enabled (id: ${status.this_worker_id ?? "unknown"})`
    : "Orchestrator only — task polling disabled on this instance";

  return (
    <Tooltip title={tooltip}>
      <Chip
        size="small"
        label={isWorker ? "Worker" : "Orchestrator"}
        color={isWorker ? "success" : "default"}
        variant={isWorker ? "filled" : "outlined"}
        aria-label={`Worker mode: ${isWorker ? "worker" : "orchestrator"}`}
        data-testid="worker-mode-chip"
      />
    </Tooltip>
  );
}

interface ActiveWorkersPanelProps {
  status: WorkerStatus | null;
}

export function ActiveWorkersPanel({ status }: ActiveWorkersPanelProps) {
  if (!status || status.active_workers.length === 0) return null;

  return (
    <Paper
      variant="outlined"
      sx={{ mb: 3, p: 2 }}
      data-testid="active-workers-panel"
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1 }}
      >
        <Typography variant="h6" component="h2">
          Active workers
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {status.active_workers.length} active
        </Typography>
      </Stack>
      <Table size="small" aria-label="Active workers">
        <TableHead>
          <TableRow>
            <TableCell>Worker</TableCell>
            <TableCell>Task</TableCell>
            <TableCell>Lease expires</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {status.active_workers.map((w) => (
            <TableRow
              key={`${w.worker_id}-${w.task_id}`}
              data-testid="active-worker-row"
            >
              <TableCell>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                    {w.worker_id}
                  </Typography>
                  {w.is_self && (
                    <Chip
                      size="small"
                      label="this instance"
                      color="primary"
                      variant="outlined"
                    />
                  )}
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2">
                  #{w.task_id} · {w.task_title}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" color="text.secondary">
                  {formatLeaseExpiry(w.leased_until)}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

export function formatLeaseExpiry(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffMs = ts - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec <= 0) return "expired";
  if (diffSec < 60) return `in ${diffSec}s`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  return `in ${hr}h`;
}
