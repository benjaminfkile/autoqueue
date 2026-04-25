import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import type { TokenUsageTotals } from "../../api/types";

export interface UsagePanelProps {
  totals: TokenUsageTotals;
  loading?: boolean;
  // Optional secondary text shown beneath the totals (e.g. "across 3 runs").
  caption?: string;
  // Affects padding/typography density. Defaults to "comfortable".
  density?: "compact" | "comfortable";
  testId?: string;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Render a compact summary of token usage. Designed to be embedded in a task
// detail page and the repos list — same shape, same labels, so users can
// reason across scopes without remapping fields.
export default function UsagePanel({
  totals,
  loading,
  caption,
  density = "comfortable",
  testId,
}: UsagePanelProps) {
  const compact = density === "compact";
  return (
    <Box data-testid={testId}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ flexWrap: "wrap", alignItems: "center" }}
      >
        <Chip
          size="small"
          label={`input: ${formatTokenCount(totals.input_tokens)}`}
          variant="outlined"
          data-testid={testId ? `${testId}-input` : undefined}
          aria-label={`Input tokens: ${totals.input_tokens}`}
        />
        <Chip
          size="small"
          label={`output: ${formatTokenCount(totals.output_tokens)}`}
          variant="outlined"
          data-testid={testId ? `${testId}-output` : undefined}
          aria-label={`Output tokens: ${totals.output_tokens}`}
        />
        <Chip
          size="small"
          label={`cache read: ${formatTokenCount(totals.cache_read_input_tokens)}`}
          variant="outlined"
          data-testid={testId ? `${testId}-cache-read` : undefined}
          aria-label={`Cache read tokens: ${totals.cache_read_input_tokens}`}
        />
        <Chip
          size="small"
          label={`cache write: ${formatTokenCount(totals.cache_creation_input_tokens)}`}
          variant="outlined"
          data-testid={testId ? `${testId}-cache-write` : undefined}
          aria-label={`Cache creation tokens: ${totals.cache_creation_input_tokens}`}
        />
      </Stack>
      {(caption || loading) && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: compact ? 0.25 : 0.5 }}
        >
          {loading ? "Loading…" : caption}
        </Typography>
      )}
    </Box>
  );
}
