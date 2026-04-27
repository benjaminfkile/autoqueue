import { useEffect, useMemo, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { reposApi, usageApi } from "../api/client";
import type {
  DailyUsageBucket,
  Repo,
  TokenUsageTotals,
  WeeklyUsageResponse,
} from "../api/types";
import { repoDisplayName } from "./repos/repoDisplay";
import { formatTokenCount } from "./repos/UsagePanel";

interface UsageDashboardProps {
  open: boolean;
  onClose: () => void;
}

interface RepoUsageRow {
  repo: Repo;
  totals: TokenUsageTotals | null;
  error: string | null;
}

// Formats the cap or "Unlimited" — null cap means there's no ceiling and the
// dashboard shouldn't imply one by rendering 0 / Infinity / etc.
function formatCap(cap: number | null): string {
  if (cap === null) return "Unlimited";
  return formatTokenCount(cap);
}

function formatPercent(used: number, cap: number | null): string {
  if (cap === null || cap <= 0) return "—";
  const pct = (used / cap) * 100;
  if (pct >= 100) return "100%";
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

// Render a fixed-height SVG bar chart for the trailing-30-day daily totals.
// Self-contained (no charting library) so the dashboard stays a thin layer
// over data already shaped by the API. Bars share a y-axis scaled to the max
// value in the window; if every day is zero we still draw the axis baseline
// so the user sees "30 days, all zero" rather than an empty box.
function DailyChart({
  daily,
  weeklyCap,
}: {
  daily: DailyUsageBucket[];
  weeklyCap: number | null;
}) {
  const width = 720;
  const height = 180;
  const padTop = 12;
  const padBottom = 24;
  const padLeft = 8;
  const padRight = 8;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const maxDayTotal = daily.reduce((m, d) => Math.max(m, d.total), 0);
  // The cap-rate guideline (cap / 7) marks the daily rate that would consume
  // the weekly cap exactly over 7 days. Useful for seeing whether yesterday's
  // burn is sustainable. Skip when the cap is null or 0 (unlimited / disabled).
  const dailyCapRate =
    weeklyCap !== null && weeklyCap > 0 ? weeklyCap / 7 : null;
  const yMax = Math.max(maxDayTotal, dailyCapRate ?? 0, 1);

  const barCount = daily.length;
  const barGap = 2;
  const barWidth = Math.max(
    1,
    (innerWidth - barGap * (barCount - 1)) / barCount
  );
  const guidelineY =
    dailyCapRate !== null
      ? padTop + innerHeight * (1 - dailyCapRate / yMax)
      : null;

  return (
    <Box
      sx={{ width: "100%", overflowX: "auto" }}
      data-testid="usage-daily-chart"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Daily token usage for the trailing ${daily.length} days`}
        style={{ width: "100%", height: "auto" }}
      >
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={height - padBottom}
          y2={height - padBottom}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        {daily.map((d, i) => {
          const x = padLeft + i * (barWidth + barGap);
          const h = (d.total / yMax) * innerHeight;
          const y = height - padBottom - h;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${formatTokenCount(d.total)} tokens`}</title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(0, h)}
                fill="currentColor"
                fillOpacity={d.total === 0 ? 0.15 : 0.7}
                data-testid={`usage-day-${d.date}`}
                data-total={d.total}
              />
            </g>
          );
        })}
        {guidelineY !== null && (
          <line
            x1={padLeft}
            x2={width - padRight}
            y1={guidelineY}
            y2={guidelineY}
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeDasharray="4 4"
            data-testid="usage-cap-rate-line"
          />
        )}
        {/* x-axis end labels — first and last day so the user can orient
            without needing one tick per bar. */}
        <text
          x={padLeft}
          y={height - 6}
          fontSize={10}
          fill="currentColor"
          fillOpacity={0.6}
        >
          {daily[0]?.date ?? ""}
        </text>
        <text
          x={width - padRight}
          y={height - 6}
          fontSize={10}
          textAnchor="end"
          fill="currentColor"
          fillOpacity={0.6}
        >
          {daily[daily.length - 1]?.date ?? ""}
        </text>
      </svg>
    </Box>
  );
}

export default function UsageDashboard({ open, onClose }: UsageDashboardProps) {
  const [weekly, setWeekly] = useState<WeeklyUsageResponse | null>(null);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [repoRows, setRepoRows] = useState<RepoUsageRow[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    cancelRef.current = false;
    setWeekly(null);
    setWeeklyError(null);
    setRepoRows([]);
    setReposError(null);
    setWeeklyLoading(true);
    setReposLoading(true);

    void usageApi
      .weekly()
      .then((next) => {
        if (cancelRef.current) return;
        setWeekly(next);
      })
      .catch((err) => {
        if (cancelRef.current) return;
        setWeeklyError(
          err instanceof Error ? err.message : "Failed to load usage"
        );
      })
      .finally(() => {
        if (!cancelRef.current) setWeeklyLoading(false);
      });

    void (async () => {
      try {
        const repos = await reposApi.list();
        if (cancelRef.current) return;
        const sorted = [...repos].sort((a, b) =>
          repoDisplayName(a).localeCompare(repoDisplayName(b))
        );
        // Initialize rows immediately so the table renders skeletons while
        // per-repo usage requests resolve in parallel.
        setRepoRows(
          sorted.map((repo) => ({ repo, totals: null, error: null }))
        );
        const settled = await Promise.allSettled(
          sorted.map((repo) => reposApi.usage(repo.id))
        );
        if (cancelRef.current) return;
        setRepoRows(
          sorted.map((repo, i) => {
            const result = settled[i];
            if (result.status === "fulfilled") {
              return { repo, totals: result.value.totals, error: null };
            }
            const reason = result.reason;
            return {
              repo,
              totals: null,
              error:
                reason instanceof Error
                  ? reason.message
                  : "Failed to load usage",
            };
          })
        );
      } catch (err) {
        if (cancelRef.current) return;
        setReposError(
          err instanceof Error ? err.message : "Failed to load repos"
        );
      } finally {
        if (!cancelRef.current) setReposLoading(false);
      }
    })();

    return () => {
      cancelRef.current = true;
    };
  }, [open]);

  const sortedRepoRows = useMemo(() => {
    return [...repoRows].sort((a, b) => {
      const aTotal = a.totals
        ? a.totals.input_tokens +
          a.totals.output_tokens +
          a.totals.cache_creation_input_tokens +
          a.totals.cache_read_input_tokens
        : -1;
      const bTotal = b.totals
        ? b.totals.input_tokens +
          b.totals.output_tokens +
          b.totals.cache_creation_input_tokens +
          b.totals.cache_read_input_tokens
        : -1;
      if (aTotal !== bTotal) return bTotal - aTotal;
      return repoDisplayName(a.repo).localeCompare(repoDisplayName(b.repo));
    });
  }, [repoRows]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      aria-labelledby="usage-dashboard-title"
      data-testid="usage-dashboard"
    >
      <DialogTitle id="usage-dashboard-title">Usage</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Box data-testid="usage-weekly-section">
            <Typography variant="subtitle1" gutterBottom>
              Weekly usage
            </Typography>
            {weeklyError && (
              <Alert severity="error" data-testid="usage-weekly-error">
                {weeklyError}
              </Alert>
            )}
            {weeklyLoading && !weekly && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <CircularProgress size={18} aria-label="Loading weekly usage" />
                <Typography variant="body2" color="text.secondary">
                  Loading…
                </Typography>
              </Box>
            )}
            {weekly && (
              <Paper
                variant="outlined"
                sx={{ p: 2 }}
                data-testid="usage-weekly-card"
              >
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={3}
                  divider={<Divider orientation="vertical" flexItem />}
                >
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Trailing 7 days
                    </Typography>
                    <Typography
                      variant="h5"
                      data-testid="usage-weekly-total"
                      data-total={weekly.weekly_total}
                    >
                      {formatTokenCount(weekly.weekly_total)}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Cap
                    </Typography>
                    <Typography
                      variant="h5"
                      data-testid="usage-weekly-cap"
                      data-cap={weekly.weekly_cap ?? "null"}
                    >
                      {formatCap(weekly.weekly_cap)}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Used of cap
                    </Typography>
                    <Typography
                      variant="h5"
                      color={
                        weekly.weekly_cap !== null &&
                        weekly.weekly_total >= weekly.weekly_cap
                          ? "error.main"
                          : "text.primary"
                      }
                      data-testid="usage-weekly-pct"
                    >
                      {formatPercent(
                        weekly.weekly_total,
                        weekly.weekly_cap
                      )}
                    </Typography>
                  </Box>
                </Stack>
                <Stack
                  direction="row"
                  spacing={2}
                  sx={{ mt: 2, flexWrap: "wrap" }}
                >
                  <Typography variant="body2" color="text.secondary">
                    input: {formatTokenCount(weekly.weekly_breakdown.input)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    output: {formatTokenCount(weekly.weekly_breakdown.output)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    cache read:{" "}
                    {formatTokenCount(weekly.weekly_breakdown.cache_read)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    cache write:{" "}
                    {formatTokenCount(weekly.weekly_breakdown.cache_creation)}
                  </Typography>
                </Stack>
              </Paper>
            )}
          </Box>

          <Box data-testid="usage-daily-section">
            <Typography variant="subtitle1" gutterBottom>
              Daily usage — trailing 30 days
            </Typography>
            {weekly && weekly.daily.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <DailyChart
                  daily={weekly.daily}
                  weeklyCap={weekly.weekly_cap}
                />
                {weekly.weekly_cap !== null && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 1 }}
                  >
                    Dashed line = daily rate that would consume the weekly cap
                    in 7 days ({formatTokenCount(weekly.weekly_cap / 7)}{" "}
                    tokens/day).
                  </Typography>
                )}
              </Paper>
            ) : (
              !weeklyLoading && (
                <Typography variant="body2" color="text.secondary">
                  No daily usage data yet.
                </Typography>
              )
            )}
          </Box>

          <Box data-testid="usage-per-repo-section">
            <Typography variant="subtitle1" gutterBottom>
              Per-repo usage (all time)
            </Typography>
            {reposError && (
              <Alert severity="error" data-testid="usage-per-repo-error">
                {reposError}
              </Alert>
            )}
            {reposLoading && repoRows.length === 0 && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <CircularProgress size={18} aria-label="Loading per-repo usage" />
                <Typography variant="body2" color="text.secondary">
                  Loading…
                </Typography>
              </Box>
            )}
            {!reposLoading && repoRows.length === 0 && !reposError && (
              <Typography variant="body2" color="text.secondary">
                No repos yet.
              </Typography>
            )}
            {repoRows.length > 0 && (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label="Per-repo token usage">
                  <TableHead>
                    <TableRow>
                      <TableCell>Repo</TableCell>
                      <TableCell align="right">Total</TableCell>
                      <TableCell align="right">Input</TableCell>
                      <TableCell align="right">Output</TableCell>
                      <TableCell align="right">Cache read</TableCell>
                      <TableCell align="right">Cache write</TableCell>
                      <TableCell align="right">Runs</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sortedRepoRows.map(({ repo, totals, error }) => {
                      const total = totals
                        ? totals.input_tokens +
                          totals.output_tokens +
                          totals.cache_creation_input_tokens +
                          totals.cache_read_input_tokens
                        : 0;
                      return (
                        <TableRow
                          key={repo.id}
                          data-testid={`usage-repo-row-${repo.id}`}
                        >
                          <TableCell>
                            <Typography
                              variant="body2"
                              sx={{ fontWeight: 500 }}
                            >
                              {repoDisplayName(repo)}
                            </Typography>
                            {error && (
                              <Tooltip title={error}>
                                <Typography
                                  variant="caption"
                                  color="error"
                                  data-testid={`usage-repo-error-${repo.id}`}
                                >
                                  Failed to load
                                </Typography>
                              </Tooltip>
                            )}
                          </TableCell>
                          <TableCell
                            align="right"
                            data-testid={`usage-repo-total-${repo.id}`}
                            data-total={total}
                          >
                            {totals ? formatTokenCount(total) : "—"}
                          </TableCell>
                          <TableCell align="right">
                            {totals
                              ? formatTokenCount(totals.input_tokens)
                              : "—"}
                          </TableCell>
                          <TableCell align="right">
                            {totals
                              ? formatTokenCount(totals.output_tokens)
                              : "—"}
                          </TableCell>
                          <TableCell align="right">
                            {totals
                              ? formatTokenCount(
                                  totals.cache_read_input_tokens
                                )
                              : "—"}
                          </TableCell>
                          <TableCell align="right">
                            {totals
                              ? formatTokenCount(
                                  totals.cache_creation_input_tokens
                                )
                              : "—"}
                          </TableCell>
                          <TableCell align="right">
                            {totals ? totals.run_count : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="usage-dashboard-close">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
