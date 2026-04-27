import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import DockerStatusBanner from "../../pages/DockerStatusBanner";
import type { DockerStatus } from "../../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(state: DockerStatus) {
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

describe("DockerStatusBanner", () => {
  it("renders nothing when Docker is available", async () => {
    installFetch({
      available: true,
      error: null,
      last_checked_at: "2026-04-26T10:00:00.000Z",
      install_url: "https://www.docker.com/products/docker-desktop/",
    });

    const { container } = render(<DockerStatusBanner />);

    await waitFor(() => {
      expect(screen.queryByTestId("docker-status-banner")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an error banner with an install link when Docker is unavailable", async () => {
    installFetch({
      available: false,
      error: "Docker is not installed or not on PATH",
      last_checked_at: "2026-04-26T10:00:00.000Z",
      install_url: "https://www.docker.com/products/docker-desktop/",
    });

    render(<DockerStatusBanner />);

    const banner = await screen.findByTestId("docker-status-banner");
    expect(banner).toHaveTextContent(/docker is not available/i);
    // Verifies the auto-resume promise the user is making decisions against.
    expect(banner).toHaveTextContent(/resume automatically/i);
    expect(banner).toHaveTextContent(/not installed/i);

    const link = screen.getByTestId("docker-install-link");
    expect(link).toHaveAttribute(
      "href",
      "https://www.docker.com/products/docker-desktop/"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("hides the banner once Docker recovers (poll-driven auto-resume)", async () => {
    let current: DockerStatus = {
      available: false,
      error: "Cannot connect to the Docker daemon",
      last_checked_at: "2026-04-26T10:00:00.000Z",
      install_url: "https://www.docker.com/products/docker-desktop/",
    };
    const fetchMock = vi.fn(async () => jsonResponse(current));
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    render(<DockerStatusBanner pollIntervalMs={20} />);

    await screen.findByTestId("docker-status-banner");

    current = {
      available: true,
      error: null,
      last_checked_at: "2026-04-26T10:00:01.000Z",
      install_url: "https://www.docker.com/products/docker-desktop/",
    };

    await waitFor(
      () => {
        expect(screen.queryByTestId("docker-status-banner")).toBeNull();
      },
      { timeout: 1000 }
    );
  });
});
