import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import {
  ActiveWorkersPanel,
  WorkerModeChip,
  formatLeaseExpiry,
  useWorkerStatus,
} from "../../pages/WorkerStatusBar";
import type { WorkerStatus } from "../../api/types";

interface FetchCall {
  url: string;
}

const calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installWorkerStatusFetch(
  responder: (call: number) => Response | Promise<Response>
) {
  let n = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    n += 1;
    return responder(n);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkerModeChip", () => {
  it("renders a Worker chip when mode is worker", () => {
    const status: WorkerStatus = {
      mode: "worker",
      this_worker_id: "host:1234",
      active_workers: [],
    };
    render(<WorkerModeChip status={status} error={null} />);
    const chip = screen.getByTestId("worker-mode-chip");
    expect(chip).toHaveTextContent(/worker/i);
    expect(chip).toHaveAttribute("aria-label", "Worker mode: worker");
  });

  it("renders an Orchestrator chip when mode is orchestrator", () => {
    const status: WorkerStatus = {
      mode: "orchestrator",
      this_worker_id: null,
      active_workers: [],
    };
    render(<WorkerModeChip status={status} error={null} />);
    const chip = screen.getByTestId("worker-mode-chip");
    expect(chip).toHaveTextContent(/orchestrator/i);
    expect(chip).toHaveAttribute("aria-label", "Worker mode: orchestrator");
  });

  it("renders a loading chip while status is null and no error", () => {
    render(<WorkerModeChip status={null} error={null} />);
    expect(screen.getByTestId("worker-mode-chip")).toHaveAttribute(
      "aria-label",
      "Worker mode loading"
    );
  });

  it("renders an unknown chip when an error is present", () => {
    render(<WorkerModeChip status={null} error="boom" />);
    const chip = screen.getByTestId("worker-mode-chip");
    expect(chip).toHaveTextContent(/mode unknown/i);
    expect(chip).toHaveAttribute("aria-label", "Worker mode unknown");
  });
});

describe("ActiveWorkersPanel", () => {
  it("does not render when there are no active workers", () => {
    render(
      <ActiveWorkersPanel
        status={{
          mode: "worker",
          this_worker_id: "host:1",
          active_workers: [],
        }}
      />
    );
    expect(screen.queryByTestId("active-workers-panel")).toBeNull();
  });

  it("does not render when status is null", () => {
    render(<ActiveWorkersPanel status={null} />);
    expect(screen.queryByTestId("active-workers-panel")).toBeNull();
  });

  it("lists each active worker with task and lease expiry", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const status: WorkerStatus = {
      mode: "worker",
      this_worker_id: "host:1",
      active_workers: [
        {
          worker_id: "host:1",
          task_id: 42,
          task_title: "Build the thing",
          repo_id: 7,
          leased_until: future,
          is_self: true,
        },
        {
          worker_id: "host2:99",
          task_id: 43,
          task_title: "Other thing",
          repo_id: 8,
          leased_until: future,
          is_self: false,
        },
      ],
    };
    render(<ActiveWorkersPanel status={status} />);
    expect(screen.getByTestId("active-workers-panel")).toBeInTheDocument();
    const rows = screen.getAllByTestId("active-worker-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("host:1");
    expect(rows[0]).toHaveTextContent("Build the thing");
    expect(rows[0]).toHaveTextContent("this instance");
    expect(rows[1]).toHaveTextContent("host2:99");
    expect(rows[1]).toHaveTextContent("Other thing");
    expect(rows[1]).not.toHaveTextContent("this instance");
  });
});

describe("formatLeaseExpiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
  });

  it("returns 'expired' for past timestamps", () => {
    expect(formatLeaseExpiry("2026-04-25T11:59:00Z")).toBe("expired");
  });

  it("returns seconds for under a minute", () => {
    expect(formatLeaseExpiry("2026-04-25T12:00:30Z")).toBe("in 30s");
  });

  it("returns minutes for under an hour", () => {
    expect(formatLeaseExpiry("2026-04-25T12:05:00Z")).toBe("in 5m");
  });

  it("returns hours for over an hour", () => {
    expect(formatLeaseExpiry("2026-04-25T15:00:00Z")).toBe("in 3h");
  });

  it("falls back to the input string when unparseable", () => {
    expect(formatLeaseExpiry("not a date")).toBe("not a date");
  });
});

describe("useWorkerStatus", () => {
  function HookProbe({ refreshIntervalMs }: { refreshIntervalMs?: number }) {
    const { status, error } = useWorkerStatus(refreshIntervalMs ?? 60_000);
    return (
      <div>
        <span data-testid="probe-mode">{status?.mode ?? "none"}</span>
        <span data-testid="probe-error">{error ?? "none"}</span>
        <span data-testid="probe-count">
          {status ? status.active_workers.length : -1}
        </span>
      </div>
    );
  }

  it("loads worker status on mount", async () => {
    installWorkerStatusFetch(() =>
      jsonResponse({
        mode: "worker",
        this_worker_id: "host:1",
        active_workers: [],
      })
    );
    render(<HookProbe />);
    await waitFor(() =>
      expect(screen.getByTestId("probe-mode")).toHaveTextContent("worker")
    );
    expect(calls[0].url).toBe("/api/system/worker-status");
  });

  it("surfaces errors when the fetch fails", async () => {
    installWorkerStatusFetch(() => jsonResponse({ error: "nope" }, 500));
    render(<HookProbe />);
    await waitFor(() =>
      expect(screen.getByTestId("probe-error")).toHaveTextContent("nope")
    );
  });

  it("clears the error after a subsequent successful load", async () => {
    let call = 0;
    installWorkerStatusFetch(() => {
      call += 1;
      if (call === 1) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({
        mode: "orchestrator",
        this_worker_id: null,
        active_workers: [],
      });
    });

    await act(async () => {
      render(<HookProbe refreshIntervalMs={50} />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("probe-error")).toHaveTextContent("boom")
    );

    await waitFor(() =>
      expect(screen.getByTestId("probe-mode")).toHaveTextContent("orchestrator")
    );
    expect(screen.getByTestId("probe-error")).toHaveTextContent("none");
  });
});
