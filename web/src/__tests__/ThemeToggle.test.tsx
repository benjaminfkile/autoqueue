import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, useThemeMode } from "../theme/ThemeContext";
import ThemeToggle from "../theme/ThemeToggle";

function installMatchMediaMock(initialDark: boolean): void {
  const mql = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
}

function ModeProbe() {
  const { mode } = useThemeMode();
  return <span data-testid="probe-mode">{mode}</span>;
}

beforeEach(() => {
  window.localStorage.clear();
  installMatchMediaMock(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ThemeToggle", () => {
  it("renders an icon button labeled with the current mode", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const button = screen.getByTestId("theme-toggle-button");
    expect(button).toHaveAttribute("aria-label", "Theme: System");
  });

  it("opens a menu with three options when clicked", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    await user.click(screen.getByTestId("theme-toggle-button"));
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-dark")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-system")).toBeInTheDocument();
  });

  it("updates mode and the button label when an option is selected", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
        <ModeProbe />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId("theme-toggle-button"));
    await user.click(screen.getByTestId("theme-option-dark"));

    expect(screen.getByTestId("probe-mode")).toHaveTextContent("dark");
    expect(screen.getByTestId("theme-toggle-button")).toHaveAttribute(
      "aria-label",
      "Theme: Dark"
    );

    await user.click(screen.getByTestId("theme-toggle-button"));
    await user.click(screen.getByTestId("theme-option-light"));

    expect(screen.getByTestId("probe-mode")).toHaveTextContent("light");
    expect(screen.getByTestId("theme-toggle-button")).toHaveAttribute(
      "aria-label",
      "Theme: Light"
    );
  });

  it("marks the active mode as selected in the menu", async () => {
    window.localStorage.setItem("grunt_theme_mode", "dark");
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    await user.click(screen.getByTestId("theme-toggle-button"));
    expect(screen.getByTestId("theme-option-dark").className).toMatch(
      /Mui-selected/
    );
    expect(screen.getByTestId("theme-option-light").className).not.toMatch(
      /Mui-selected/
    );
  });
});
