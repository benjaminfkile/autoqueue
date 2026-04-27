import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import RunnerImageBanner from "../../pages/RunnerImageBanner";
import type { RunnerImageState } from "../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(state: RunnerImageState) {
  const fetchMock = vi.fn(async () => jsonResponse(state));
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunnerImageBanner", () => {
  it("does not render anything when the runner image is ready", async () => {
    installFetch({
      image: "grunt/runner",
      status: "ready",
      hash: "abc",
      started_at: null,
      finished_at: null,
      error: null,
    });

    const { container } = render(<RunnerImageBanner />);

    // Wait one tick for the initial fetch to resolve.
    await waitFor(() => {
      expect(screen.queryByTestId("runner-image-banner")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a 'building' info banner with the long-build message while status=building", async () => {
    installFetch({
      image: "grunt/runner",
      status: "building",
      hash: "deadbeef",
      started_at: "2026-04-26T10:00:00.000Z",
      finished_at: null,
      error: null,
    });

    render(<RunnerImageBanner />);

    const banner = await screen.findByTestId("runner-image-banner");
    expect(banner).toHaveTextContent(/preparing runner image/i);
    expect(banner).toHaveTextContent(/may take a few minutes/i);
  });

  it("shows a checking message while status=checking (pre-build digest probe)", async () => {
    installFetch({
      image: "grunt/runner",
      status: "checking",
      hash: null,
      started_at: "2026-04-26T10:00:00.000Z",
      finished_at: null,
      error: null,
    });

    render(<RunnerImageBanner />);

    const banner = await screen.findByTestId("runner-image-banner");
    expect(banner).toHaveTextContent(/checking runner image/i);
  });

  it("shows an error banner with the captured docker error when status=error", async () => {
    installFetch({
      image: "grunt/runner",
      status: "error",
      hash: "deadbeef",
      started_at: "2026-04-26T10:00:00.000Z",
      finished_at: "2026-04-26T10:01:00.000Z",
      error: "docker build exited with code 1",
    });

    render(<RunnerImageBanner />);

    const banner = await screen.findByTestId("runner-image-banner");
    expect(banner).toHaveTextContent(/runner image build failed/i);
    expect(banner).toHaveTextContent(/docker build exited with code 1/i);
  });
});
