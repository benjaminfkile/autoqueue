import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../App";

describe("App", () => {
  it("renders the grunt heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: /grunt/i })
    ).toBeInTheDocument();
  });

  it("renders the scaffold tagline", () => {
    render(<App />);
    expect(screen.getByText(/Phase 3 GUI scaffold/i)).toBeInTheDocument();
  });
});
