import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";

describe("App", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/repos")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/system/worker-status")) {
        return new Response(
          JSON.stringify({
            mode: "orchestrator",
            this_worker_id: null,
            active_workers: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  it("renders the grunt app bar heading", async () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: /grunt/i })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/no repos yet/i)).toBeInTheDocument()
    );
  });

  it("renders the Repos page", async () => {
    render(<App />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /repos/i })
      ).toBeInTheDocument();
    });
  });

  it("renders the worker mode chip in the header", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("worker-mode-chip")).toHaveTextContent(
        /orchestrator/i
      );
    });
  });

  it("opens the planning chat drawer from the header button", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      screen.getByRole("button", { name: /open planning chat/i })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /planning chat/i })
      ).toBeInTheDocument()
    );
  });
});
