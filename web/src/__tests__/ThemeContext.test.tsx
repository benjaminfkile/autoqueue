import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "@mui/material/styles";
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  useThemeMode,
} from "../theme/ThemeContext";

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  addEventListener: (
    type: "change",
    listener: (event: MediaQueryListEvent) => void
  ) => void;
  removeEventListener: (
    type: "change",
    listener: (event: MediaQueryListEvent) => void
  ) => void;
  dispatch: (matches: boolean) => void;
  addListener: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener: (listener: (event: MediaQueryListEvent) => void) => void;
}

function installMatchMediaMock(initialDark: boolean): MockMediaQueryList {
  const mql: MockMediaQueryList = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    listeners: new Set(),
    addEventListener(_type, listener) {
      this.listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      this.listeners.delete(listener);
    },
    addListener(listener) {
      this.listeners.add(listener);
    },
    removeListener(listener) {
      this.listeners.delete(listener);
    },
    dispatch(matches: boolean) {
      this.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      for (const listener of this.listeners) {
        listener(event);
      }
    },
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
  return mql;
}

function ThemeProbe() {
  const { mode, resolvedMode, setMode } = useThemeMode();
  const muiTheme = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolvedMode}</span>
      <span data-testid="mui-mode">{muiTheme.palette.mode}</span>
      <button onClick={() => setMode("dark")}>set-dark</button>
      <button onClick={() => setMode("light")}>set-light</button>
      <button onClick={() => setMode("system")}>set-system</button>
    </div>
  );
}

describe("ThemeContext", () => {
  let mql: MockMediaQueryList;

  beforeEach(() => {
    window.localStorage.clear();
    mql = installMatchMediaMock(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("exposes mode, setMode, and resolvedMode and defaults to system mode", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("light");
  });

  it("updates the MUI theme without a reload when setMode is called", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByTestId("mui-mode")).toHaveTextContent("light");

    await user.click(screen.getByRole("button", { name: "set-dark" }));

    expect(screen.getByTestId("mode")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("dark");

    await user.click(screen.getByRole("button", { name: "set-light" }));

    expect(screen.getByTestId("mode")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("light");
  });

  it("reflects OS preference when in system mode and updates live on OS change", () => {
    mql = installMatchMediaMock(true);
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByTestId("mode")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("dark");

    act(() => {
      mql.dispatch(false);
    });

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("light");

    act(() => {
      mql.dispatch(true);
    });

    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("dark");
  });

  it("defaults to 'system' on first visit when no value is stored", () => {
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("system");
  });

  it("persists mode changes to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    await user.click(screen.getByRole("button", { name: "set-dark" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "set-light" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await user.click(screen.getByRole("button", { name: "set-system" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("reads the stored mode on mount so the choice survives reloads", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(screen.getByTestId("mui-mode")).toHaveTextContent("dark");
  });

  it("uses the correct mode on the very first render to avoid a flash", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    let firstRenderMode: string | null = null;
    function CaptureFirstRender() {
      const { resolvedMode } = useThemeMode();
      if (firstRenderMode === null) {
        firstRenderMode = resolvedMode;
      }
      return null;
    }
    render(
      <ThemeProvider>
        <CaptureFirstRender />
      </ThemeProvider>
    );
    expect(firstRenderMode).toBe("dark");
  });

  it("ignores invalid values in localStorage and falls back to 'system'", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("system");
  });
});
