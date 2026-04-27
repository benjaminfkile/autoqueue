import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Link from "@mui/material/Link";
import { systemApi } from "../api/client";
import type { DockerStatus } from "../api/types";

const POLL_MS = 5000;

interface DockerStatusBannerProps {
  pollIntervalMs?: number;
}

export default function DockerStatusBanner({
  pollIntervalMs = POLL_MS,
}: DockerStatusBannerProps) {
  const [state, setState] = useState<DockerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await systemApi.docker();
        if (!cancelled) setState(next);
      } catch {
        // Silent — the runner-image banner already surfaces general API
        // failures and we don't want to fail-open by hiding the warning.
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
  if (state.available) return null;

  return (
    <Alert severity="error" sx={{ mb: 3 }} data-testid="docker-status-banner">
      <AlertTitle>Docker is not available</AlertTitle>
      Tasks need Docker Desktop to run. The worker is paused until Docker is
      reachable; it will resume automatically once the daemon is back.{" "}
      <Link
        href={state.install_url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="docker-install-link"
      >
        Install Docker Desktop
      </Link>
      {state.error ? ` (${state.error})` : null}
    </Alert>
  );
}
