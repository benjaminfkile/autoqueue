import { FormEvent, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { setupApi } from "../api/client";
import type { SetupStatus } from "../api/types";

interface SetupPanelProps {
  onComplete: (status: SetupStatus) => void;
}

export default function SetupPanel({ onComplete }: SetupPanelProps) {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [ghPat, setGhPat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (anthropicKey.trim().length === 0 || ghPat.trim().length === 0) {
      setError("Both fields are required.");
      return;
    }
    setSubmitting(true);
    try {
      const status = await setupApi.save({
        ANTHROPIC_API_KEY: anthropicKey.trim(),
        GH_PAT: ghPat.trim(),
      });
      onComplete(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secrets");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Paper
        variant="outlined"
        sx={{ p: 4 }}
        component="section"
        aria-labelledby="setup-heading"
        data-testid="setup-panel"
      >
        <Stack spacing={2}>
          <Typography id="setup-heading" variant="h5" component="h1">
            Welcome to grunt
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Before you can use grunt, paste your Anthropic API key and a GitHub
            personal access token. They are stored encrypted in the local
            secrets file and never leave this machine.
          </Typography>
          <Box
            component="form"
            onSubmit={handleSubmit}
            noValidate
            data-testid="setup-form"
          >
            <Stack spacing={2}>
              <TextField
                label="Anthropic API key"
                type="password"
                autoComplete="off"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                inputProps={{ "data-testid": "setup-anthropic-key" }}
                required
                fullWidth
              />
              <TextField
                label="GitHub personal access token"
                type="password"
                autoComplete="off"
                value={ghPat}
                onChange={(e) => setGhPat(e.target.value)}
                inputProps={{ "data-testid": "setup-gh-pat" }}
                required
                fullWidth
              />
              {error && (
                <Alert severity="error" data-testid="setup-error">
                  {error}
                </Alert>
              )}
              <Button
                type="submit"
                variant="contained"
                disabled={submitting}
                data-testid="setup-submit"
              >
                {submitting ? "Saving…" : "Save and continue"}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>
    </Container>
  );
}
