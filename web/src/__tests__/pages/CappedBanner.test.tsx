import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CappedBanner, { pingCappedStatus } from "../../pages/CappedBanner";
import type { CapStatus } from "../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(getState: () => CapStatus): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => jsonResponse(getState()));
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

describe("CappedBanner", () => {
  it("renders nothing when not capped", async () => {
    installFetch(() => ({ capped: false, weekly_total: 1000, weekly_cap: 5000 }));

    const { container } = render(
      <CappedBanner onOpenUsage={() => {}} onOpenSettings={() => {}} />
    );

    await waitFor(() => {
      expect(screen.queryByTestId("capped-banner")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the banner when capped, with formatted totals and shortcut buttons", async () => {
    installFetch(() => ({
      capped: true,
      weekly_total: 12345,
      weekly_cap: 10000,
    }));

    const onOpenUsage = vi.fn();
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();

    render(
      <CappedBanner
        onOpenUsage={onOpenUsage}
        onOpenSettings={onOpenSettings}
      />
    );

    const banner = await screen.findByTestId("capped-banner");
    expect(banner).toHaveTextContent(/weekly token cap reached/i);
    expect(banner).toHaveTextContent(/12,345/);
    expect(banner).toHaveTextContent(/10,000/);

    await user.click(screen.getByTestId("capped-banner-usage-link"));
    expect(onOpenUsage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("capped-banner-settings-link"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("hides the banner once the cap is lifted on the next poll", async () => {
    let current: CapStatus = {
      capped: true,
      weekly_total: 12345,
      weekly_cap: 10000,
    };
    installFetch(() => current);

    render(
      <CappedBanner
        onOpenUsage={() => {}}
        onOpenSettings={() => {}}
        pollIntervalMs={20}
      />
    );

    await screen.findByTestId("capped-banner");

    current = { capped: false, weekly_total: 12345, weekly_cap: 50000 };

    await waitFor(
      () => {
        expect(screen.queryByTestId("capped-banner")).toBeNull();
      },
      { timeout: 1000 }
    );
  });

  it("pingCappedStatus triggers an immediate refetch", async () => {
    let current: CapStatus = {
      capped: false,
      weekly_total: 0,
      weekly_cap: 5000,
    };
    const fetchMock = installFetch(() => current);

    render(
      <CappedBanner
        onOpenUsage={() => {}}
        onOpenSettings={() => {}}
        pollIntervalMs={60_000}
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    current = { capped: true, weekly_total: 6000, weekly_cap: 5000 };
    pingCappedStatus();

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
    await screen.findByTestId("capped-banner");
  });

  it("omits the usage detail when the cap is unlimited", async () => {
    installFetch(() => ({
      capped: true,
      weekly_total: 9001,
      weekly_cap: null,
    }));

    render(
      <CappedBanner onOpenUsage={() => {}} onOpenSettings={() => {}} />
    );

    const banner = await screen.findByTestId("capped-banner");
    expect(banner).toHaveTextContent(/weekly token cap reached/i);
    expect(banner).not.toHaveTextContent(/of /);
  });
});
