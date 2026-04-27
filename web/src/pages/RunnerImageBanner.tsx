import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { systemApi } from "../api/client";
import type { RunnerImageState } from "../api/types";

const POLL_MS = 5000;

interface RunnerImageBannerProps {
  pollIntervalMs?: number;
}

export default function RunnerImageBanner({
  pollIntervalMs = POLL_MS,
}: RunnerImageBannerProps) {
  const [state, setState] = useState<RunnerImageState | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await systemApi.runnerImage();
        if (!cancelled) setState(next);
      } catch {
        // Silent — the banner isn't critical and the worker-status endpoint
        // already surfaces general API failures.
      }
    }

    void load();
    const timer = setInterval(load, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollIntervalMs]);

  if (!state) return null;
  if (state.status === "ready" || state.status === "idle") return null;

  if (state.status === "error") {
    return (
      <Alert
        severity="error"
        sx={{ mb: 3 }}
        data-testid="runner-image-banner"
      >
        <AlertTitle>Runner image build failed</AlertTitle>
        {state.error ?? "Unknown error"}
      </Alert>
    );
  }

  // checking | building
  const message =
    state.status === "building"
      ? "Building runner image — this may take a few minutes. Tasks will start once it's ready."
      : "Checking runner image…";

  return (
    <Alert
      severity="info"
      icon={
        <Box sx={{ display: "flex", alignItems: "center" }}>
          <CircularProgress size={20} aria-label="Building runner image" />
        </Box>
      }
      sx={{ mb: 3 }}
      data-testid="runner-image-banner"
    >
      <AlertTitle>Preparing runner image</AlertTitle>
      {message}
    </Alert>
  );
}
