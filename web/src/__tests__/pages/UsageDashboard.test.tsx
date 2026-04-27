import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import { ThemeProvider } from "../../theme/ThemeContext";

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockOptions {
  weekly?: {
    weekly_total: number;
    weekly_cap: number | null;
    weekly_breakdown?: {
      input: number;
      output: number;
      cache_creation: number;
      cache_read: number;
    };
    daily?: Array<{ date: string; total: number }>;
  };
  weeklyError?: boolean;
  repos?: Array<{
    id: number;
    owner: string;
    repo_name: string;
  }>;
  perRepoUsage?: Record<
    number,
    {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      run_count: number;
    } | "error"
  >;
}

const DEFAULT_DAILY = (() => {
  // 30 zero days; the dashboard test usually overrides this when it cares.
  const out: Array<{ date: string; total: number }> = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 2, 28 + i));
    out.push({
      date: d.toISOString().slice(0, 10),
      total: 0,
    });
  }
  return out;
})();

function installFetchMock(opts: MockOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("/api/setup")) {
      return jsonResponse({
        ready: true,
        configured: { ANTHROPIC_API_KEY: true, GH_PAT: true },
      });
    }
    if (url.startsWith("/api/system/worker-status")) {
      return jsonResponse({
        mode: "orchestrator",
        this_worker_id: null,
        active_workers: [],
      });
    }
    if (url.startsWith("/api/system/runner-image")) {
      return jsonResponse({
        image: "grunt/runner",
        status: "ready",
        hash: "abc123",
        started_at: null,
        finished_at: null,
        error: null,
      });
    }
    if (url.startsWith("/api/system/docker")) {
      return jsonResponse({
        available: true,
        error: null,
        last_checked_at: null,
        install_url: "https://www.docker.com/products/docker-desktop/",
      });
    }
    if (url === "/api/usage/weekly") {
      if (opts.weeklyError) {
        return jsonResponse({ error: "boom" }, 500);
      }
      const weekly = opts.weekly ?? {
        weekly_total: 0,
        weekly_cap: null,
      };
      return jsonResponse({
        weekly_total: weekly.weekly_total,
        weekly_cap: weekly.weekly_cap,
        weekly_breakdown:
          weekly.weekly_breakdown ?? {
            input: 0,
            output: 0,
            cache_creation: 0,
            cache_read: 0,
          },
        daily: weekly.daily ?? DEFAULT_DAILY,
      });
    }
    // Per-repo usage — match before the generic /api/repos handler.
    const repoUsageMatch = url.match(/^\/api\/repos\/(\d+)\/usage$/);
    if (repoUsageMatch) {
      const id = Number(repoUsageMatch[1]);
      const u = opts.perRepoUsage?.[id];
      if (u === "error") {
        return jsonResponse({ error: "repo usage failed" }, 500);
      }
      const totals =
        u ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          run_count: 0,
        };
      return jsonResponse({ totals });
    }
    if (url === "/api/repos") {
      return jsonResponse(
        (opts.repos ?? []).map((r) => ({
          id: r.id,
          owner: r.owner,
          repo_name: r.repo_name,
          active: true,
          base_branch: "main",
          base_branch_parent: "origin/main",
          require_pr: false,
          github_token: null,
          is_local_folder: false,
          local_path: null,
          on_failure: "halt_subtree",
          max_retries: 0,
          on_parent_child_fail: "cascade_fail",
          ordering_mode: "sequential",
          clone_status: "ready",
          clone_error: null,
          created_at: "2026-04-26T00:00:00.000Z",
        }))
      );
    }
    if (url.startsWith("/api/tasks?repo_id=")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openDashboard() {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(screen.getByTestId("usage-button")).toBeInTheDocument();
  });
  await user.click(screen.getByTestId("usage-button"));
  return user;
}

describe("UsageDashboard", () => {
  it("renders weekly usage, the cap, and the percent of cap consumed — the page's primary at-a-glance summary (acceptance #1164)", async () => {
    installFetchMock({
      weekly: {
        weekly_total: 250_000,
        weekly_cap: 1_000_000,
        weekly_breakdown: {
          input: 100_000,
          output: 50_000,
          cache_creation: 50_000,
          cache_read: 50_000,
        },
      },
    });

    renderApp();
    await openDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("usage-weekly-card")).toBeInTheDocument()
    );
    expect(screen.getByTestId("usage-weekly-total")).toHaveAttribute(
      "data-total",
      "250000"
    );
    expect(screen.getByTestId("usage-weekly-cap")).toHaveAttribute(
      "data-cap",
      "1000000"
    );
    // 250k / 1M = 25% — the dashboard surfaces this so the user can see how
    // close they are to being capped without doing the math.
    expect(screen.getByTestId("usage-weekly-pct")).toHaveTextContent("25%");
  });

  it("renders 'Unlimited' when weekly_cap is null so the dashboard never implies a ceiling that doesn't exist", async () => {
    installFetchMock({
      weekly: { weekly_total: 999, weekly_cap: null },
    });

    renderApp();
    await openDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("usage-weekly-cap")).toHaveTextContent(
        /unlimited/i
      )
    );
    // Percent has no meaning without a cap; the dashboard renders an em-dash
    // rather than a misleading number.
    expect(screen.getByTestId("usage-weekly-pct")).toHaveTextContent("—");
  });

  it("renders a contiguous trailing-30-day bar chart with one bar per day from the API payload (acceptance #1165)", async () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-03-${String(28 + i).padStart(2, "0")}`,
      total: i % 5 === 0 ? 1000 : 0,
    }));
    // The synthesizer above wraps to invalid March dates intentionally — the
    // SPA renders whatever the API hands back, so the chart length is what we
    // verify (not the exact date strings).
    installFetchMock({
      weekly: {
        weekly_total: 0,
        weekly_cap: null,
        daily,
      },
    });

    renderApp();
    await openDashboard();

    const chart = await screen.findByTestId("usage-daily-chart");
    const bars = within(chart).getAllByTestId(/^usage-day-/);
    expect(bars).toHaveLength(30);
  });

  it("renders one row per repo with all-time totals fetched from /api/repos/:id/usage (acceptance #1166)", async () => {
    installFetchMock({
      repos: [
        { id: 1, owner: "ben", repo_name: "alpha" },
        { id: 2, owner: "ben", repo_name: "beta" },
      ],
      perRepoUsage: {
        1: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 1000,
          run_count: 3,
        },
        2: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          run_count: 1,
        },
      },
    });

    renderApp();
    await openDashboard();

    // Wait for both repo rows to land (per-repo usage requests fire in parallel).
    await waitFor(() => {
      expect(screen.getByTestId("usage-repo-row-1")).toBeInTheDocument();
      expect(screen.getByTestId("usage-repo-row-2")).toBeInTheDocument();
    });

    // The total cell carries the precomputed sum so the test can pin the
    // numeric value rather than reverse-engineering the formatted "1.4k".
    expect(screen.getByTestId("usage-repo-total-1")).toHaveAttribute(
      "data-total",
      String(100 + 200 + 50 + 1000)
    );
    expect(screen.getByTestId("usage-repo-total-2")).toHaveAttribute(
      "data-total",
      String(1 + 2 + 3 + 4)
    );

    // Repo names are rendered so the user can correlate rows to repos in
    // the main repo list.
    const row1 = screen.getByTestId("usage-repo-row-1");
    expect(within(row1).getByText("ben/alpha")).toBeInTheDocument();
    const row2 = screen.getByTestId("usage-repo-row-2");
    expect(within(row2).getByText("ben/beta")).toBeInTheDocument();
  });

  it("falls back to a 'Failed to load' note on a per-repo usage error rather than dropping the row entirely — the user still sees that the repo exists", async () => {
    installFetchMock({
      repos: [{ id: 7, owner: "ben", repo_name: "broken" }],
      perRepoUsage: {
        7: "error",
      },
    });

    renderApp();
    await openDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("usage-repo-row-7")).toBeInTheDocument()
    );
    expect(screen.getByTestId("usage-repo-error-7")).toHaveTextContent(
      /failed to load/i
    );
  });

  it("surfaces an error banner when /api/usage/weekly fails so the user knows the dashboard isn't just blank", async () => {
    installFetchMock({ weeklyError: true });

    renderApp();
    await openDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("usage-weekly-error")).toBeInTheDocument()
    );
  });
});
