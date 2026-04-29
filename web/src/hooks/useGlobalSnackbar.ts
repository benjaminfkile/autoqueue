import { createContext, useContext } from "react";

export interface SnackbarMessage {
  message: string;
  severity: "success" | "error" | "info" | "warning";
}

export const GlobalSnackbarContext = createContext<
  (msg: SnackbarMessage) => void
>(() => {});

export function useGlobalSnackbar() {
  return useContext(GlobalSnackbarContext);
}
