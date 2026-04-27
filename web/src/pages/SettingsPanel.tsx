import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AppSettings, SetupInput, SetupStatus } from "../api/types";
import { settingsApi, setupApi } from "../api/client";
import { CLAUDE_MODELS } from "../api/claudeModels";

type SecretKey = keyof SetupInput;

interface SecretRowConfig {
  key: SecretKey;
  label: string;
  testIdPrefix: string;
}

const SECRET_ROWS: SecretRowConfig[] = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    testIdPrefix: "settings-anthropic-key",
  },
  {
    key: "GH_PAT",
    label: "GitHub personal access token",
    testIdPrefix: "settings-gh-pat",
  },
];

const MASK = "••••••••••••";

interface SettingsPanelProps {
  open: boolean;
  status: SetupStatus;
  onClose: () => void;
  onStatusChange: (next: SetupStatus) => void;
}

export default function SettingsPanel({
  open,
  status,
  onClose,
  onStatusChange,
}: SettingsPanelProps) {
  const [drafts, setDrafts] = useState<Record<SecretKey, string>>({
    ANTHROPIC_API_KEY: "",
    GH_PAT: "",
  });
  const [busyKey, setBusyKey] = useState<SecretKey | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettingsLoading(true);
    setSettingsError(null);
    settingsApi
      .get()
      .then((next) => {
        if (cancelled) return;
        setAppSettings(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setSettingsError(
          err instanceof Error ? err.message : "Failed to load settings"
        );
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetState() {
    setDrafts({ ANTHROPIC_API_KEY: "", GH_PAT: "" });
    setBusyKey(null);
    setBusyAction(null);
    setError(null);
    setSettingsError(null);
  }

  function handleClose() {
    if (busyKey || modelSaving) return;
    resetState();
    onClose();
  }

  async function handleSave(key: SecretKey) {
    const value = drafts[key].trim();
    if (value.length === 0) {
      setError("Enter a value before saving.");
      return;
    }
    setError(null);
    setBusyKey(key);
    setBusyAction("save");
    try {
      const next = await setupApi.update({ [key]: value });
      onStatusChange(next);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secret");
    } finally {
      setBusyKey(null);
      setBusyAction(null);
    }
  }

  async function handleClear(key: SecretKey) {
    setError(null);
    setBusyKey(key);
    setBusyAction("clear");
    try {
      const next = await setupApi.clear(key);
      onStatusChange(next);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear secret");
    } finally {
      setBusyKey(null);
      setBusyAction(null);
    }
  }

  async function handleModelChange(nextModel: string) {
    if (!appSettings || nextModel === appSettings.default_model) return;
    setModelSaving(true);
    setSettingsError(null);
    try {
      const next = await settingsApi.update({ default_model: nextModel });
      setAppSettings(next);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to update model"
      );
    } finally {
      setModelSaving(false);
    }
  }

  // The dropdown shows the curated CLAUDE_MODELS plus the currently-saved
  // model if it isn't in the curated list (so an out-of-band value set via
  // the API doesn't disappear from the UI). The current value is selected
  // by id so the dropdown stays in sync with the persisted setting.
  const currentModel = appSettings?.default_model ?? "";
  const modelOptions = appSettings
    ? CLAUDE_MODELS.some((m) => m.id === currentModel)
      ? CLAUDE_MODELS
      : [
          ...CLAUDE_MODELS,
          { id: currentModel, label: `${currentModel} (current)` },
        ]
    : CLAUDE_MODELS;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="settings-panel-title"
      data-testid="settings-panel"
    >
      <DialogTitle id="settings-panel-title">Settings</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Box
            data-testid="settings-default-model-row"
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              p: 2,
            }}
          >
            <Stack spacing={1.5}>
              <Typography variant="subtitle1">Default Claude model</Typography>
              <Typography variant="body2" color="text.secondary">
                Used when a task has no per-task or inherited model override.
              </Typography>
              {settingsError && (
                <Alert severity="error" data-testid="settings-default-model-error">
                  {settingsError}
                </Alert>
              )}
              {settingsLoading && !appSettings ? (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <CircularProgress size={18} aria-label="Loading settings" />
                  <Typography variant="body2" color="text.secondary">
                    Loading…
                  </Typography>
                </Box>
              ) : (
                <TextField
                  select
                  label="Model"
                  value={currentModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  disabled={!appSettings || modelSaving}
                  fullWidth
                  size="small"
                  data-testid="settings-default-model-select"
                  SelectProps={{
                    inputProps: {
                      "aria-label": "Default Claude model",
                      "data-testid": "settings-default-model-input",
                    },
                  }}
                  helperText={modelSaving ? "Saving…" : undefined}
                >
                  {modelOptions.map((opt) => (
                    <MenuItem
                      key={opt.id}
                      value={opt.id}
                      data-testid={`settings-default-model-option-${opt.id}`}
                    >
                      {opt.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            </Stack>
          </Box>

          <Typography variant="body2" color="text.secondary">
            Stored secrets are encrypted on this machine. Update or clear each
            value below — values are never displayed in plaintext.
          </Typography>

          {error && (
            <Alert severity="error" data-testid="settings-error">
              {error}
            </Alert>
          )}

          {SECRET_ROWS.map((row) => {
            const configured = status.configured[row.key];
            const draft = drafts[row.key];
            const rowBusy = busyKey === row.key;
            const otherRowBusy = busyKey !== null && busyKey !== row.key;
            return (
              <Box
                key={row.key}
                data-testid={`${row.testIdPrefix}-row`}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 2,
                }}
              >
                <Stack spacing={1.5}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography variant="subtitle1">{row.label}</Typography>
                    <Typography
                      variant="body2"
                      color={configured ? "text.primary" : "text.secondary"}
                      data-testid={`${row.testIdPrefix}-status`}
                    >
                      {configured ? MASK : "Not set"}
                    </Typography>
                  </Stack>
                  <TextField
                    label={configured ? "New value" : "Value"}
                    type="password"
                    autoComplete="off"
                    value={draft}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [row.key]: e.target.value,
                      }))
                    }
                    inputProps={{ "data-testid": `${row.testIdPrefix}-input` }}
                    disabled={rowBusy || otherRowBusy}
                    fullWidth
                    size="small"
                  />
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={() => void handleClear(row.key)}
                      disabled={!configured || rowBusy || otherRowBusy}
                      data-testid={`${row.testIdPrefix}-clear`}
                    >
                      {rowBusy && busyAction === "clear" ? "Clearing…" : "Clear"}
                    </Button>
                    <Button
                      variant="contained"
                      onClick={() => void handleSave(row.key)}
                      disabled={
                        draft.trim().length === 0 || rowBusy || otherRowBusy
                      }
                      data-testid={`${row.testIdPrefix}-save`}
                    >
                      {rowBusy && busyAction === "save" ? "Saving…" : "Save"}
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={handleClose}
          disabled={busyKey !== null || modelSaving}
          data-testid="settings-close"
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
