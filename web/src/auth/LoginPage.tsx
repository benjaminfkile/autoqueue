import { useState, type FormEvent } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import { API_KEY_STORAGE_KEY } from "../api/client";
import { useAuth } from "./AuthContext";

/**
 * Renders the appropriate login UI for the configured auth mode:
 *
 *   - apikey         → field to paste an api key (stored in localStorage as
 *                       the legacy provider expects)
 *   - cognito/hosted → "Sign in with Cognito" button that redirects to the
 *                       hosted UI
 *   - cognito/inapp  → username/password form that POSTs /api/auth/login
 *
 * Errors from the backend are surfaced inline; on success the parent
 * AuthProvider flips its state to "logged-in" and the rest of the app
 * unmounts the login page.
 */
export default function LoginPage() {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleHosted = () => {
    setLocalError(null);
    try {
      auth.loginWithHostedUi();
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const handleCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      await auth.loginWithCredentials(username, password);
    } catch (err) {
      setLocalError((err as Error).message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApiKey = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!apiKey) {
      setLocalError("API key is required");
      return;
    }
    try {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    } catch (err) {
      setLocalError((err as Error).message);
      return;
    }
    // Reload so AuthProvider re-runs its boot sequence and observes the key.
    window.location.assign("/");
  };

  const cognito = auth.config?.cognito;
  const mode = auth.config?.mode;

  return (
    <Box
      sx={{
        minHeight: "70vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        py: 4,
      }}
    >
      <Paper sx={{ p: 4, width: "100%", maxWidth: 420 }} role="dialog">
        <Typography variant="h5" component="h2" gutterBottom>
          Sign in
        </Typography>

        {auth.error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {auth.error}
          </Alert>
        ) : null}
        {localError ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {localError}
          </Alert>
        ) : null}

        {mode === "cognito" && cognito?.loginMode === "hosted" ? (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              You will be redirected to Cognito to sign in.
            </Typography>
            <Button
              variant="contained"
              onClick={handleHosted}
              disabled={!cognito.domain || !cognito.clientId}
            >
              Sign in with Cognito
            </Button>
          </Stack>
        ) : null}

        {mode === "cognito" && cognito?.loginMode === "inapp" ? (
          <Stack
            component="form"
            spacing={2}
            onSubmit={handleCredentials}
            aria-label="cognito-credentials-form"
          >
            <TextField
              label="Username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </Stack>
        ) : null}

        {mode === "apikey" ? (
          <Stack
            component="form"
            spacing={2}
            onSubmit={handleApiKey}
            aria-label="api-key-form"
          >
            <Typography variant="body2" color="text.secondary">
              This deployment uses an API key. Paste your key to continue.
            </Typography>
            <TextField
              label="API key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
            <Button type="submit" variant="contained">
              Save and continue
            </Button>
          </Stack>
        ) : null}
      </Paper>
    </Box>
  );
}
