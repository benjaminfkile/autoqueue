jest.mock("../src/db/repoWebhooks", () => ({
  getWebhooksByRepoId: jest.fn(),
}));

import {
  deliverWebhook,
  fireWebhooksForRepo,
  triggerWebhooks,
  MAX_DELIVERY_ATTEMPTS,
  WebhookPayload,
} from "../src/services/webhookDelivery";
import { getWebhooksByRepoId } from "../src/db/repoWebhooks";
import { Repo, RepoWebhook, Task, WebhookEvent } from "../src/interfaces";

const getWebhooksMock = getWebhooksByRepoId as jest.Mock;

const baseRepo: Repo = {
  id: 7,
  owner: "octocat",
  repo_name: "widgets",
  active: true,
  base_branch: "main",
  base_branch_parent: "main",
  require_pr: false,
  github_token: null,
  is_local_folder: false,
  local_path: null,
  on_failure: "halt_repo",
  max_retries: 3,
  on_parent_child_fail: "mark_partial",
  ordering_mode: "sequential",
  clone_status: "ready",
  clone_error: null,
  created_at: new Date(),
};

const baseTask: Task = {
  id: 42,
  repo_id: 7,
  parent_id: null,
  title: "Add login",
  description: "",
  order_position: 0,
  status: "active",
  retry_count: 0,
  pr_url: null,
  worker_id: null,
  leased_until: null,
  ordering_mode: null,
  log_path: null,
  requires_approval: false,
  created_at: new Date(),
};

function makeWebhook(overrides: Partial<RepoWebhook> = {}): RepoWebhook {
  return {
    id: 1,
    repo_id: 7,
    url: "https://hooks.example.com/h1",
    events: ["done", "failed", "halted"],
    active: true,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// deliverWebhook — HTTP retry contract.
// ---------------------------------------------------------------------------
describe("deliverWebhook", () => {
  it("returns ok=true after a single 200 response without retrying", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "done", text: "t" } as unknown as WebhookPayload,
      { backoffMs: 0 }
    );

    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://x.example.com/h");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({ event: "done", text: "t" });
  });

  it("retries on 5xx and succeeds when a later attempt returns 200", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 503 } as any)
      .mockResolvedValueOnce({ status: 502 } as any)
      .mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "failed", text: "t" } as unknown as WebhookPayload,
      { backoffMs: 0 }
    );

    expect(result).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("drops after MAX_DELIVERY_ATTEMPTS when every attempt returns 5xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 500 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "halted", text: "t" } as unknown as WebhookPayload,
      { backoffMs: 0 }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
  });

  it("does NOT retry on 4xx (permanent client error — extra requests would just hammer the misconfigured target)", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ status: 404 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "done", text: "t" } as unknown as WebhookPayload,
      { backoffMs: 0 }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on transient network errors (TypeError/ECONNRESET) just like 5xx", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ status: 200 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "done", text: "t" } as unknown as WebhookPayload,
      { backoffMs: 0 }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("respects a custom maxAttempts override (allows callers to tune retry budget)", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 500 } as any);
    (global as any).fetch = fetchMock;

    const result = await deliverWebhook(
      "https://x.example.com/h",
      { event: "done", text: "t" } as unknown as WebhookPayload,
      { maxAttempts: 5, backoffMs: 0 }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// fireWebhooksForRepo — DB lookup, event filtering, payload composition.
// ---------------------------------------------------------------------------
describe("fireWebhooksForRepo", () => {
  it("posts to every active webhook subscribed to the event", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 } as any);
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ id: 1, url: "https://a/", events: ["done"] }),
      makeWebhook({ id: 2, url: "https://b/", events: ["done", "failed"] }),
    ]);

    await fireWebhooksForRepo(
      {} as any,
      baseRepo,
      { ...baseTask, status: "done" },
      "done"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(expect.arrayContaining(["https://a/", "https://b/"]));
  });

  it("filters out webhooks not subscribed to the fired event", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 } as any);
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ id: 1, url: "https://a/", events: ["halted"] }),
      makeWebhook({ id: 2, url: "https://b/", events: ["done"] }),
    ]);

    await fireWebhooksForRepo(
      {} as any,
      baseRepo,
      { ...baseTask, status: "done" },
      "done"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://b/");
  });

  it("filters out inactive webhooks even when they're subscribed to the event", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 } as any);
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ id: 1, url: "https://a/", events: ["done"], active: false }),
      makeWebhook({ id: 2, url: "https://b/", events: ["done"], active: true }),
    ]);

    await fireWebhooksForRepo(
      {} as any,
      baseRepo,
      { ...baseTask, status: "done" },
      "done"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://b/");
  });

  it("does not call fetch at all when no webhooks match the event", async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ events: ["halted"] }),
    ]);

    await fireWebhooksForRepo({} as any, baseRepo, baseTask, "done");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a Slack-compatible payload with `text`, `event`, `repo`, and `task` fields", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 } as any);
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ url: "https://hooks.slack.com/services/X" }),
    ]);

    await fireWebhooksForRepo(
      {} as any,
      baseRepo,
      { ...baseTask, status: "done" },
      "done"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("Add login");
    expect(body.event).toBe("done");
    expect(body.repo).toMatchObject({
      id: 7,
      owner: "octocat",
      repo_name: "widgets",
    });
    expect(body.task).toMatchObject({
      id: 42,
      title: "Add login",
      status: "done",
    });
  });

  it("uses the local_path for the repo label when is_local_folder is true (no owner/repo_name available)", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 } as any);
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([makeWebhook()]);

    const localRepo: Repo = {
      ...baseRepo,
      owner: null,
      repo_name: null,
      is_local_folder: true,
      local_path: "/tmp/myproj",
    };

    await fireWebhooksForRepo({} as any, localRepo, baseTask, "done");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("/tmp/myproj");
  });

  it("does not throw when getWebhooksByRepoId rejects (DB outage must not break the task pipeline)", async () => {
    getWebhooksMock.mockRejectedValue(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        fireWebhooksForRepo({} as any, baseRepo, baseTask, "done")
      ).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a failure delivering one webhook does not block delivery to the others (parallel, isolated)", async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === "https://a/") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ status: 200 } as any);
    });
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([
      makeWebhook({ id: 1, url: "https://a/" }),
      makeWebhook({ id: 2, url: "https://b/" }),
    ]);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // Patch setTimeout used for retry backoff so the test does not pay for
    // wallclock waits — we still want the retry code path to execute, just
    // not the sleeps.
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };

    try {
      await fireWebhooksForRepo({} as any, baseRepo, baseTask, "done");
      const callsToA = fetchMock.mock.calls.filter(
        (c) => c[0] === "https://a/"
      );
      const callsToB = fetchMock.mock.calls.filter(
        (c) => c[0] === "https://b/"
      );
      expect(callsToB).toHaveLength(1);
      // Webhook A retried up to MAX_DELIVERY_ATTEMPTS (3) before being dropped.
      expect(callsToA.length).toBe(3);
    } finally {
      errSpy.mockRestore();
      (global as any).setTimeout = realSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// triggerWebhooks — fire-and-forget wrapper.
// ---------------------------------------------------------------------------
describe("triggerWebhooks (fire-and-forget)", () => {
  it("returns synchronously (void) without awaiting delivery", () => {
    const fetchMock = jest.fn(
      () => new Promise(() => {}) // never resolves
    );
    (global as any).fetch = fetchMock;
    getWebhooksMock.mockResolvedValue([makeWebhook()]);

    const ret = triggerWebhooks({} as any, baseRepo, baseTask, "done");
    expect(ret).toBeUndefined();
  });

  it("swallows rejections from the underlying delivery so callers see no error", async () => {
    getWebhooksMock.mockRejectedValue(new Error("totally broken"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        triggerWebhooks({} as any, baseRepo, baseTask, "done")
      ).not.toThrow();
      // Wait one microtask cycle for the inner promise to settle.
      await new Promise((r) => setImmediate(r));
    } finally {
      errSpy.mockRestore();
    }
  });
});
