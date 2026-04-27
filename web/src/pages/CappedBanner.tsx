import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { systemApi } from "../api/client";
import type { CapStatus } from "../api/types";

const POLL_MS = 5000;

// Module-level pinger so a 429 from /api/chat (or any other cap-aware endpoint)
// can ask the mounted banner to re-poll immediately instead of waiting up to
// one poll interval. Cleared on unmount so a hot-reloaded mount doesn't keep
// firing into a stale closure.
let externalRefresh: (() => void) | null = null;

export function pingCappedStatus(): void {
  externalRefresh?.();
}

interface CappedBannerProps {
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  pollIntervalMs?: number;
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

export default function CappedBanner({
  onOpenUsage,
  onOpenSettings,
  pollIntervalMs = POLL_MS,
}: CappedBannerProps) {
  const [state, setState] = useState<CapStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await systemApi.capped();
        if (!cancelled) setState(next);
      } catch {
        // Silent — other system banners surface generic API failures, and
        // failing closed here would mean showing the cap banner whenever
        // the network blips, which would be more confusing than helpful.
      }
    }

    void load();
    externalRefresh = () => {
      void load();
    };
    const timer = setInterval(load, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (externalRefresh) externalRefresh = null;
    };
  }, [pollIntervalMs]);

  if (!state || !state.capped) return null;

  const cap = state.weekly_cap;
  const used = state.weekly_total;

  return (
    <Alert severity="warning" sx={{ mb: 3 }} data-testid="capped-banner">
      <AlertTitle>Weekly token cap reached</AlertTitle>
      Usage has hit the weekly cap
      {cap !== null
        ? ` (${formatTokens(used)} of ${formatTokens(cap)} tokens used)`
        : ""}
      . The worker is paused and new chat turns are blocked. Raise the cap in
      Settings to resume immediately, or wait for the rolling 7-day window to
      release older usage.
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={onOpenUsage}
          data-testid="capped-banner-usage-link"
        >
          Open usage
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={onOpenSettings}
          data-testid="capped-banner-settings-link"
        >
          Open settings
        </Button>
      </Stack>
    </Alert>
  );
}
