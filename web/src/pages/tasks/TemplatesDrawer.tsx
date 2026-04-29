import { useEffect, useState } from "react";
import Drawer from "@mui/material/Drawer";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { reposApi, templatesApi } from "../../api/client";
import type { ProposedTaskNode, Repo, TaskTemplate } from "../../api/types";

export interface TemplatesDrawerProps {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

function repoLabel(repo: Repo): string {
  if (repo.owner && repo.repo_name) return `${repo.owner}/${repo.repo_name}`;
  if (repo.local_path) return repo.local_path;
  return `Repo #${repo.id}`;
}

function ProposalTreePreview({
  nodes,
  depth = 0,
}: {
  nodes: ProposedTaskNode[];
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node, i) => (
        <Box key={i} sx={{ pl: depth * 2, py: 0.25 }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: depth === 0 ? 500 : 400 }}
          >
            {node.title || <em>(untitled)</em>}
          </Typography>
          {node.description && (
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
            >
              {node.description}
            </Typography>
          )}
          {node.children && node.children.length > 0 && (
            <ProposalTreePreview nodes={node.children} depth={depth + 1} />
          )}
        </Box>
      ))}
    </>
  );
}

export default function TemplatesDrawer({
  open,
  onClose,
  onApplied,
}: TemplatesDrawerProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] =
    useState<TaskTemplate | null>(null);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyRepoId, setApplyRepoId] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedTemplate(null);
      setDeleteConfirmId(null);
      setApplyConfirmOpen(false);
      setDeleteError(null);
      setApplyError(null);
      return;
    }

    setLoading(true);
    setError(null);
    templatesApi
      .list()
      .then((list) => {
        setTemplates(list);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Failed to load templates"
        );
      })
      .finally(() => setLoading(false));

    setReposLoading(true);
    reposApi
      .list()
      .then((list) => {
        setRepos(list);
        if (list.length > 0) setApplyRepoId(list[0].id);
      })
      .catch(() => {
        // repos load failure is non-fatal; the apply dialog will show empty
      })
      .finally(() => setReposLoading(false));
  }, [open]);

  async function handleDelete(id: number) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await templatesApi.delete(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setDeleteConfirmId(null);
      if (selectedTemplate?.id === id) setSelectedTemplate(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete template"
      );
    } finally {
      setDeleting(false);
    }
  }

  async function handleApply() {
    if (!selectedTemplate || applyRepoId === null) return;
    setApplying(true);
    setApplyError(null);
    try {
      await reposApi.instantiateTemplate(applyRepoId, selectedTemplate.id);
      setApplyConfirmOpen(false);
      onApplied?.();
    } catch (err) {
      setApplyError(
        err instanceof Error ? err.message : "Failed to apply template"
      );
    } finally {
      setApplying(false);
    }
  }

  const rootCount = selectedTemplate
    ? selectedTemplate.tree.parents.length
    : 0;

  return (
    <>
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        PaperProps={{ sx: { width: 480 } }}
        aria-label="Templates drawer"
      >
        <Box sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column" }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            {selectedTemplate && (
              <IconButton
                size="small"
                onClick={() => setSelectedTemplate(null)}
                aria-label="Back to templates list"
              >
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            )}
            <Typography variant="h6" sx={{ flex: 1 }}>
              {selectedTemplate ? selectedTemplate.name : "Templates"}
            </Typography>
            <IconButton
              size="small"
              onClick={onClose}
              aria-label="Close templates drawer"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>

          {!selectedTemplate && (
            <Box sx={{ flex: 1, overflow: "auto" }}>
              {loading && (
                <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                  <CircularProgress aria-label="Loading templates" />
                </Box>
              )}
              {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {error}
                </Alert>
              )}
              {!loading && templates.length === 0 && !error && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ py: 3, textAlign: "center" }}
                  role="status"
                >
                  No templates yet. Save a task tree as a template to get
                  started.
                </Typography>
              )}
              {templates.map((template) => {
                const count = template.tree.parents.length;
                return (
                  <Box key={template.id}>
                    <Stack
                      direction="row"
                      alignItems="flex-start"
                      spacing={1}
                      sx={{
                        py: 1.5,
                        px: 1,
                        cursor: "pointer",
                        borderRadius: 1,
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                      onClick={() => setSelectedTemplate(template)}
                      data-testid={`template-item-${template.id}`}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body1" fontWeight={500} noWrap>
                          {template.name}
                        </Typography>
                        {template.description && (
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {template.description}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.secondary">
                          {count} root task{count !== 1 ? "s" : ""}
                        </Typography>
                      </Box>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteError(null);
                          setDeleteConfirmId(template.id);
                        }}
                        aria-label={`Delete template ${template.name}`}
                        data-testid={`template-delete-${template.id}`}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                    <Divider />
                  </Box>
                );
              })}
            </Box>
          )}

          {selectedTemplate && (
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column" }}>
              {selectedTemplate.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {selectedTemplate.description}
                </Typography>
              )}
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Task tree ({rootCount} root task{rootCount !== 1 ? "s" : ""})
              </Typography>
              <Box
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 1.5,
                  mb: 2,
                  flex: 1,
                  overflow: "auto",
                }}
                data-testid="template-preview"
              >
                <ProposalTreePreview nodes={selectedTemplate.tree.parents} />
              </Box>
              <Button
                variant="contained"
                onClick={() => {
                  setApplyError(null);
                  setApplyConfirmOpen(true);
                }}
                data-testid="template-apply-button"
                fullWidth
              >
                Apply to this repo
              </Button>
            </Box>
          )}
        </Box>
      </Drawer>

      <Dialog
        open={deleteConfirmId !== null}
        onClose={() => !deleting && setDeleteConfirmId(null)}
        aria-labelledby="template-delete-dialog-title"
        data-testid="template-delete-dialog"
      >
        <DialogTitle id="template-delete-dialog-title">
          Delete template?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete this template. This action cannot be
            undone.
          </DialogContentText>
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteConfirmId(null)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleting}
            onClick={() =>
              deleteConfirmId !== null &&
              void handleDelete(deleteConfirmId)
            }
            startIcon={
              deleting ? (
                <CircularProgress color="inherit" size={16} />
              ) : null
            }
            data-testid="template-delete-confirm"
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={applyConfirmOpen}
        onClose={() => !applying && setApplyConfirmOpen(false)}
        aria-labelledby="template-apply-dialog-title"
        data-testid="template-apply-dialog"
      >
        <DialogTitle id="template-apply-dialog-title">
          Apply template?
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            New tasks will be created in the selected repository based on this
            template. Existing tasks will not be modified.
          </DialogContentText>
          <TextField
            select
            label="Repository"
            value={applyRepoId ?? ""}
            onChange={(e) =>
              setApplyRepoId(e.target.value === "" ? null : Number(e.target.value))
            }
            fullWidth
            disabled={applying || reposLoading}
            size="small"
            SelectProps={{ native: false }}
          >
            {reposLoading ? (
              <MenuItem value="">Loading…</MenuItem>
            ) : repos.length === 0 ? (
              <MenuItem value="">No repos available</MenuItem>
            ) : (
              repos.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {repoLabel(r)}
                </MenuItem>
              ))
            )}
          </TextField>
          {applyError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {applyError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setApplyConfirmOpen(false)}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={applying || applyRepoId === null}
            onClick={() => void handleApply()}
            startIcon={
              applying ? (
                <CircularProgress color="inherit" size={16} />
              ) : null
            }
            data-testid="template-apply-confirm"
          >
            {applying ? "Applying…" : "Apply"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
