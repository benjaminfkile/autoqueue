import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import type { Repo } from "../../api/types";
import { repoDisplayName } from "./repoDisplay";

export interface DeleteRepoDialogProps {
  open: boolean;
  repo: Repo | null;
  onClose: () => void;
  onConfirm: (repo: Repo) => Promise<void>;
}

export default function DeleteRepoDialog({
  open,
  repo,
  onClose,
  onConfirm,
}: DeleteRepoDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  async function handleConfirm() {
    if (!repo) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(repo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      aria-labelledby="delete-repo-dialog-title"
    >
      <DialogTitle id="delete-repo-dialog-title">Delete repo</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <DialogContentText>
          Delete <strong>{repo ? repoDisplayName(repo) : ""}</strong>? This
          removes the repo and all of its tasks. This action cannot be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleConfirm}
          disabled={submitting}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
