import { useEffect, useState } from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import ChatIcon from "@mui/icons-material/Chat";
import LogoutIcon from "@mui/icons-material/Logout";
import ReposPage from "./pages/ReposPage";
import ChatDrawer from "./pages/chat/ChatDrawer";
import {
  ActiveWorkersPanel,
  WorkerModeChip,
  useWorkerStatus,
} from "./pages/WorkerStatusBar";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import LoginPage from "./auth/LoginPage";
import CognitoCallback from "./auth/CognitoCallback";

function usePathname(): string {
  // Tracks SPA path without pulling in react-router. Listens for popstate
  // (which the callback page dispatches after exchanging the code) so the
  // shell remounts ReposPage once auth completes.
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname
  );
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

function AuthedShell() {
  const { status, error } = useWorkerStatus();
  const auth = useAuth();
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            grunt
          </Typography>
          <WorkerModeChip status={status} error={error} />
          <Tooltip title="Open planning chat">
            <IconButton
              aria-label="Open planning chat"
              onClick={() => setChatOpen(true)}
              sx={{ ml: 1 }}
            >
              <ChatIcon />
            </IconButton>
          </Tooltip>
          {auth.identity ? (
            <Typography
              variant="body2"
              sx={{ ml: 2, mr: 1 }}
              data-testid="auth-identity"
            >
              {auth.identity}
            </Typography>
          ) : null}
          <Tooltip title="Sign out">
            <Button
              startIcon={<LogoutIcon />}
              onClick={auth.logout}
              size="small"
              aria-label="Sign out"
            >
              Sign out
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <ActiveWorkersPanel status={status} />
        <ReposPage />
      </Container>
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  );
}

function AppGate() {
  const auth = useAuth();
  const pathname = usePathname();

  if (pathname === "/auth/callback") {
    return <CognitoCallback />;
  }

  if (auth.status === "loading") {
    return (
      <Box
        sx={{
          minHeight: "70vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <CircularProgress size={20} />
        <Typography variant="body2">Loading…</Typography>
      </Box>
    );
  }

  if (auth.status === "error") {
    return (
      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Alert severity="error">
          {auth.error ?? "Could not load auth configuration"}
        </Alert>
      </Container>
    );
  }

  if (auth.status === "logged-out") {
    return <LoginPage />;
  }

  return <AuthedShell />;
}

export default function App() {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AuthProvider>
        <AppGate />
      </AuthProvider>
    </Box>
  );
}
