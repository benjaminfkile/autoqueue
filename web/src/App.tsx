import { useCallback, useEffect, useRef, useState } from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import ChatIcon from "@mui/icons-material/Chat";
import SettingsIcon from "@mui/icons-material/Settings";
import ReposPage from "./pages/ReposPage";
import ChatDrawer from "./pages/chat/ChatDrawer";
import SetupPanel from "./pages/SetupPanel";
import SettingsPanel from "./pages/SettingsPanel";
import ThemeToggle from "./theme/ThemeToggle";
import { setupApi } from "./api/client";
import type { SetupStatus } from "./api/types";
import {
  ActiveWorkersPanel,
  WorkerModeChip,
  useWorkerStatus,
} from "./pages/WorkerStatusBar";

export default function App() {
  const { status, error } = useWorkerStatus();
  const [chatOpen, setChatOpen] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);

  const refreshSetup = useCallback(async () => {
    try {
      const next = await setupApi.status();
      setSetupStatus(next);
      setSetupError(null);
      return next;
    } catch (err) {
      setSetupError(
        err instanceof Error ? err.message : "Failed to load setup status"
      );
      return null;
    } finally {
      setSetupLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshSetup();
  }, [refreshSetup]);

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    setResetError(null);
    try {
      const next = await setupApi.reset();
      setSetupStatus(next);
      setResetOpen(false);
    } catch (err) {
      setResetError(
        err instanceof Error ? err.message : "Failed to reset secrets"
      );
    } finally {
      setResetting(false);
    }
  }

  if (!setupLoaded) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        data-testid="setup-loading"
      >
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }

  if (setupError && !setupStatus) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refreshSetup()}>
              Retry
            </Button>
          }
          data-testid="setup-status-error"
        >
          {setupError}
        </Alert>
      </Container>
    );
  }

  if (setupStatus && !setupStatus.ready) {
    return <SetupPanel onComplete={(next) => setSetupStatus(next)} />;
  }

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            grunt
          </Typography>
          <WorkerModeChip status={status} error={error} />
          <ThemeToggle />
          <Tooltip title="Open planning chat">
            <IconButton
              aria-label="Open planning chat"
              onClick={() => setChatOpen(true)}
              sx={{ ml: 1 }}
            >
              <ChatIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton
              ref={settingsButtonRef}
              aria-label="Settings"
              aria-haspopup="menu"
              aria-controls={menuAnchor ? "settings-menu" : undefined}
              aria-expanded={menuAnchor ? "true" : undefined}
              onClick={() => setMenuAnchor(settingsButtonRef.current)}
              sx={{ ml: 1 }}
              data-testid="settings-button"
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
          <Menu
            id="settings-menu"
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                setSettingsOpen(true);
              }}
              data-testid="manage-secrets-menu-item"
            >
              Manage secrets…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                setResetError(null);
                setResetOpen(true);
              }}
              data-testid="reset-secrets-menu-item"
            >
              Reset secrets…
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <ActiveWorkersPanel status={status} />
        <ReposPage />
      </Container>
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
      {setupStatus && (
        <SettingsPanel
          open={settingsOpen}
          status={setupStatus}
          onClose={() => setSettingsOpen(false)}
          onStatusChange={(next) => setSetupStatus(next)}
        />
      )}
      <Dialog
        open={resetOpen}
        onClose={() => (resetting ? undefined : setResetOpen(false))}
        aria-labelledby="reset-secrets-title"
        data-testid="reset-secrets-dialog"
      >
        <DialogTitle id="reset-secrets-title">Reset secrets?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This clears the stored Anthropic API key and GitHub token. You'll be
            prompted to enter new values before grunt can run tasks again.
          </DialogContentText>
          {resetError && (
            <Alert severity="error" sx={{ mt: 2 }} data-testid="reset-secrets-error">
              {resetError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setResetOpen(false)}
            disabled={resetting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleReset()}
            color="error"
            variant="contained"
            disabled={resetting}
            data-testid="confirm-reset-secrets"
          >
            {resetting ? "Resetting…" : "Reset"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
