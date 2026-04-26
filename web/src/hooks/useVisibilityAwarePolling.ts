import { useEffect, useRef } from "react";

export type PollFetcher = () => void | Promise<void>;

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Polls `fetcher` every `intervalMs` while the document is visible.
 *
 * - Pauses on `visibilitychange` when the tab becomes hidden and resumes
 *   when it becomes visible again (firing an immediate fetch on resume so
 *   stale data is refreshed without waiting for the next tick).
 * - Will not stack overlapping requests: if a fetch is still pending when
 *   the next tick fires, that tick is skipped.
 * - The fetcher reference is read from a ref, so consumers do not need to
 *   memoize it for the polling cadence to remain stable.
 */
export function useVisibilityAwarePolling(
  fetcher: PollFetcher,
  intervalMs: number = DEFAULT_INTERVAL_MS
): void {
  const fetcherRef = useRef(fetcher);
  const inFlightRef = useRef(false);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const runFetch = async () => {
      if (cancelled) return;
      if (inFlightRef.current) return;
      if (document.visibilityState !== "visible") return;
      inFlightRef.current = true;
      try {
        await fetcherRef.current();
      } finally {
        inFlightRef.current = false;
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runFetch();
      }, intervalMs);
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runFetch();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs]);
}
