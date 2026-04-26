import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useVisibilityAwarePolling } from "../../hooks/useVisibilityAwarePolling";

type VisibilityState = "visible" | "hidden";

function setVisibilityState(state: VisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function PollingProbe({
  fetcher,
  intervalMs,
}: {
  fetcher: () => void | Promise<void>;
  intervalMs?: number;
}) {
  useVisibilityAwarePolling(fetcher, intervalMs);
  return null;
}

describe("useVisibilityAwarePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at the given interval while the tab is visible", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    render(<PollingProbe fetcher={fetcher} intervalMs={1000} />);

    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("defaults to a 5s interval when none is provided", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    render(<PollingProbe fetcher={fetcher} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while the tab is hidden and resumes when visible", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    render(<PollingProbe fetcher={fetcher} intervalMs={1000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibilityState("hidden");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibilityState("visible");
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not start polling on mount when the tab is already hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    const fetcher = vi.fn().mockResolvedValue(undefined);
    render(<PollingProbe fetcher={fetcher} intervalMs={1000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      setVisibilityState("visible");
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not stack in-flight requests when the fetcher is slower than the interval", async () => {
    let resolveFetch: (() => void) | null = null;
    const fetcher = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<PollingProbe fetcher={fetcher} intervalMs={1000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops polling and removes the visibility listener on unmount", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <PollingProbe fetcher={fetcher} intervalMs={1000} />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    expect(
      removeSpy.mock.calls.some(([type]) => type === "visibilitychange")
    ).toBe(true);
    removeSpy.mockRestore();
  });

  it("uses the latest fetcher on each tick without restarting the interval", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <PollingProbe fetcher={first} intervalMs={1000} />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    rerender(<PollingProbe fetcher={second} intervalMs={1000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
