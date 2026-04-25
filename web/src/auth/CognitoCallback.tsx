import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { authApi } from "../api/auth";
import { identityFromToken, useAuth } from "./AuthContext";

/**
 * Renders the OAuth callback handler that completes the hosted-UI flow.
 *
 * The hosted UI redirects back to /auth/callback?code=...&state=... after a
 * successful sign-in. We swap the code for a token at the Cognito /oauth2/token
 * endpoint, hand the access token to AuthContext.finalizeLogin, and navigate
 * back to the SPA root. On error we render the message inline so the user can
 * retry from the login page.
 */
export default function CognitoCallback() {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  // Guard against the effect re-running after AuthContext state transitions
  // (status flip on finalizeLogin) — we only want to exchange the code once.
  const exchangedRef = useRef(false);
  const finalizeLogin = auth.finalizeLogin;
  const config = auth.config;

  useEffect(() => {
    if (!config) return;
    if (exchangedRef.current) return;
    if (config.mode !== "cognito" || !config.cognito) {
      exchangedRef.current = true;
      setError("This deployment is not configured for Cognito.");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const errorParam = params.get("error_description") || params.get("error");
    if (errorParam) {
      exchangedRef.current = true;
      setError(errorParam);
      return;
    }
    if (!code) {
      exchangedRef.current = true;
      setError("Missing authorization code in callback URL.");
      return;
    }
    exchangedRef.current = true;
    let cancelled = false;
    const redirectUri = `${window.location.origin}/auth/callback`;
    authApi
      .exchangeHostedCode(config.cognito, code, redirectUri)
      .then((result) => {
        if (cancelled) return;
        const identityToken = result.idToken ?? result.accessToken;
        const identity = identityToken ? identityFromToken(identityToken) : null;
        finalizeLogin(result.accessToken, identity);
        window.history.replaceState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || "Could not complete sign-in");
      });
    return () => {
      cancelled = true;
    };
  }, [config, finalizeLogin]);

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
      <Paper sx={{ p: 4, width: "100%", maxWidth: 420 }}>
        <Typography variant="h5" component="h2" gutterBottom>
          Completing sign-in…
        </Typography>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <CircularProgress size={20} />
            <Typography variant="body2">
              Exchanging authorization code…
            </Typography>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
