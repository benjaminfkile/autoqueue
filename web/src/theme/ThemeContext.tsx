import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import CssBaseline from "@mui/material/CssBaseline";
import {
  ThemeProvider as MuiThemeProvider,
  createTheme,
} from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedMode: ResolvedThemeMode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

export interface ThemeProviderProps {
  children: ReactNode;
  initialMode?: ThemeMode;
}

export function ThemeProvider({
  children,
  initialMode = "system",
}: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    getSystemPrefersDark()
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  const resolvedMode: ResolvedThemeMode =
    mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  const contextValue = useMemo<ThemeContextValue>(
    () => ({ mode, setMode, resolvedMode }),
    [mode, setMode, resolvedMode]
  );

  const muiTheme = useMemo(
    () => createTheme({ palette: { mode: resolvedMode } }),
    [resolvedMode]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <MuiThemeProvider theme={muiTheme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useThemeMode(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useThemeMode must be used within a ThemeProvider");
  }
  return value;
}
