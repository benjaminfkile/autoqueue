import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import { reposApi } from "../../api/client";
import type { ProposedTaskNode, Repo, RepoLink, TaskTreeProposal } from "../../api/types";
import AcceptanceCriteriaEditor from "./AcceptanceCriteriaEditor";
import { updateAtPath, removeAtPath } from "../chat/ProposalCard";

export interface NewPhaseDialogProps {
  open: boolean;
  repos: Repo[];
  repoId: number | null;
  onClose: () => void;
  onCreated: () => void;
}

function makeEmptyNode(): ProposedTaskNode {
  return { title: "" };
}

function repoLabel(repo: Repo): string {
  if (repo.owner && repo.repo_name) return `${repo.owner}/${repo.repo_name}`;
  if (repo.local_path) return repo.local_path;
  return `Repo #${repo.id}`;
}

function addChildAtPath(
  nodes: ProposedTaskNode[],
  path: number[]
): ProposedTaskNode[] {
  const emptyNode = makeEmptyNode();
  if (path.length === 0) {
    return [...nodes, emptyNode];
  }
  const [head, ...rest] = path;
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) {
      return { ...node, children: [...(node.children ?? []), emptyNode] };
    }
    return {
      ...node,
      children: addChildAtPath(node.children ?? [], rest),
    };
  });
}

export default function NewPhaseDialog({
  open,
  repos,
  repoId,
  onClose,
  onCreated,
}: NewPhaseDialogProps) {
  const [proposal, setProposal] = useState<TaskTreeProposal>({
    parents: [makeEmptyNode()],
  });
  const [activeTab, setActiveTab] = useState<"visual" | "json">("visual");
  const [jsonText, setJsonText] = useState("");
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);
  const [allowedRepos, setAllowedRepos] = useState<Repo[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProposal({ parents: [makeEmptyNode()] });
    setActiveTab("visual");
    setJsonText("");
    setJsonParseError(null);
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (repoId == null) {
      setAllowedRepos(repos);
      return;
    }
    let cancelled = false;
    setLoadingLinks(true);
    reposApi
      .listLinks(repoId)
      .then((links: RepoLink[]) => {
        if (cancelled) return;
        const linkedIds = links.map((l) =>
          l.repo_a_id === repoId ? l.repo_b_id : l.repo_a_id
        );
        const active = repos.find((r) => r.id === repoId);
        const linked = repos.filter((r) => linkedIds.includes(r.id));
        setAllowedRepos(active ? [active, ...linked] : linked);
      })
      .catch(() => {
        if (cancelled) return;
        const active = repos.find((r) => r.id === repoId);
        setAllowedRepos(active ? [active] : []);
      })
      .finally(() => {
        if (!cancelled) setLoadingLinks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoId, repos]);

  function handleTabChange(_: React.SyntheticEvent, newTab: "visual" | "json") {
    if (newTab === "json") {
      setJsonText(JSON.stringify(proposal, null, 2));
      setJsonParseError(null);
      setActiveTab("json");
    } else {
      try {
        const parsed = JSON.parse(jsonText) as TaskTreeProposal;
        if (!parsed || !Array.isArray(parsed.parents)) {
          throw new Error("Root must be an object with a 'parents' array");
        }
        setProposal(parsed);
        setJsonParseError(null);
        setActiveTab("visual");
      } catch (err) {
        setJsonParseError(err instanceof Error ? err.message : "Invalid JSON");
      }
    }
  }

  function updateNode(
    path: number[],
    updater: (n: ProposedTaskNode) => ProposedTaskNode
  ) {
    setProposal((prev) => ({
      parents: updateAtPath(prev.parents, path, updater),
    }));
  }

  function removeNode(path: number[]) {
    setProposal((prev) => ({
      parents: removeAtPath(prev.parents, path),
    }));
  }

  function addChild(path: number[]) {
    setProposal((prev) => ({
      parents: addChildAtPath(prev.parents, path),
    }));
  }

  function addTopLevel() {
    setProposal((prev) => ({
      parents: [...prev.parents, makeEmptyNode()],
    }));
  }

  async function handleSubmit() {
    let current = proposal;

    if (activeTab === "json") {
      try {
        const parsed = JSON.parse(jsonText) as TaskTreeProposal;
        if (!parsed || !Array.isArray(parsed.parents)) {
          throw new Error("Root must be an object with a 'parents' array");
        }
        current = parsed;
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }

    if (repoId == null) {
      setSubmitError("No repository selected.");
      return;
    }

    if (current.parents.length === 0) {
      setSubmitError("Add at least one task before creating the phase.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await reposApi.materializeTree(repoId, current);
      onCreated();
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create phase"
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !submitting &&
    (activeTab === "visual"
      ? proposal.parents.length > 0
      : jsonText.trim().length > 0);

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="new-phase-dialog-title"
    >
      <DialogTitle id="new-phase-dialog-title">Add phase</DialogTitle>
      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        sx={{ px: 3, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label="Visual" value="visual" />
        <Tab label="JSON" value="json" />
      </Tabs>
      <DialogContent>
        {activeTab === "visual" && (
          <Box sx={{ mt: 1 }}>
            {submitError && (
              <Alert
                severity="error"
                sx={{ mb: 2 }}
                onClose={() => setSubmitError(null)}
              >
                {submitError}
              </Alert>
            )}
            {proposal.parents.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 2 }}
              >
                No tasks yet. Add a top-level task to get started.
              </Typography>
            ) : (
              <Stack spacing={3}>
                {proposal.parents.map((node, i) => (
                  <Box key={i}>
                    {i > 0 && <Divider sx={{ mb: 2 }} />}
                    <PhaseNodeEditor
                      node={node}
                      path={[i]}
                      depth={0}
                      disabled={submitting}
                      allowedRepos={allowedRepos}
                      loadingRepos={loadingLinks}
                      onChange={updateNode}
                      onRemove={removeNode}
                      onAddChild={addChild}
                    />
                  </Box>
                ))}
              </Stack>
            )}
            <Button
              startIcon={<AddIcon />}
              onClick={addTopLevel}
              disabled={submitting}
              variant="outlined"
              size="small"
              sx={{ mt: 2 }}
            >
              Add top-level task
            </Button>
          </Box>
        )}
        {activeTab === "json" && (
          <Box sx={{ mt: 1 }}>
            {submitError && (
              <Alert
                severity="error"
                sx={{ mb: 2 }}
                onClose={() => setSubmitError(null)}
              >
                {submitError}
              </Alert>
            )}
            {jsonParseError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {jsonParseError}
              </Alert>
            )}
            <TextField
              multiline
              fullWidth
              minRows={14}
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonParseError(null);
              }}
              disabled={submitting}
              placeholder='{"parents": [{"title": "My task", "description": "..."}]}'
              inputProps={{
                style: { fontFamily: "monospace", fontSize: "0.85rem" },
                "aria-label": "Task tree JSON",
              }}
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit}
          startIcon={
            submitting ? <CircularProgress color="inherit" size={16} /> : null
          }
        >
          {submitting ? "Creating…" : "Create phase"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface PhaseNodeEditorProps {
  node: ProposedTaskNode;
  path: number[];
  depth: number;
  disabled: boolean;
  allowedRepos: Repo[];
  loadingRepos: boolean;
  onChange: (
    path: number[],
    updater: (n: ProposedTaskNode) => ProposedTaskNode
  ) => void;
  onRemove: (path: number[]) => void;
  onAddChild: (path: number[]) => void;
}

function PhaseNodeEditor({
  node,
  path,
  depth,
  disabled,
  allowedRepos,
  loadingRepos,
  onChange,
  onRemove,
  onAddChild,
}: PhaseNodeEditorProps) {
  const isTopLevel = depth === 0;
  const showRepoSelector = isTopLevel && (allowedRepos.length > 1 || loadingRepos);
  const pathLabel = path.map((p) => p + 1).join(".");

  return (
    <Box
      sx={{
        pl: depth === 0 ? 0 : 2,
        borderLeft: depth === 0 ? "none" : "2px solid",
        borderColor: "divider",
      }}
      data-testid={`phase-node-${path.join("-")}`}
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Box sx={{ flex: 1 }}>
          {showRepoSelector && (
            <TextField
              select
              label="Repo for this task"
              size="small"
              value={node.repo_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onChange(path, (n) => ({
                  ...n,
                  repo_id: v === "" ? undefined : Number(v),
                }));
              }}
              disabled={disabled || loadingRepos}
              sx={{ mb: 1, minWidth: 220 }}
              SelectProps={{ native: false }}
            >
              <MenuItem value="">
                <em>{loadingRepos ? "Loading repos…" : "Default repo"}</em>
              </MenuItem>
              {allowedRepos.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {repoLabel(r)}
                </MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label={depth === 0 ? "Task title" : "Subtask title"}
            size="small"
            fullWidth
            value={node.title}
            disabled={disabled}
            onChange={(e) =>
              onChange(path, (n) => ({ ...n, title: e.target.value }))
            }
            inputProps={{
              "aria-label": `Title for task ${pathLabel}`,
            }}
          />

          <TextField
            label="Description"
            size="small"
            fullWidth
            multiline
            minRows={2}
            value={node.description ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onChange(path, (n) => ({ ...n, description: e.target.value }))
            }
            sx={{ mt: 1 }}
            inputProps={{
              "aria-label": `Description for task ${pathLabel}`,
            }}
          />

          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Acceptance criteria
            </Typography>
            <AcceptanceCriteriaEditor
              value={node.acceptance_criteria ?? []}
              onChange={(criteria) =>
                onChange(path, (n) => ({
                  ...n,
                  acceptance_criteria:
                    criteria.length > 0 ? criteria : undefined,
                }))
              }
            />
          </Box>

          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onAddChild(path)}
            disabled={disabled}
            sx={{ mt: 1 }}
          >
            Add subtask
          </Button>
        </Box>

        <IconButton
          size="small"
          onClick={() => onRemove(path)}
          disabled={disabled}
          aria-label={`Remove task ${pathLabel}`}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Stack>

      {node.children && node.children.length > 0 && (
        <Stack spacing={2} sx={{ mt: 2 }}>
          {node.children.map((child, i) => (
            <PhaseNodeEditor
              key={i}
              node={child}
              path={[...path, i]}
              depth={depth + 1}
              disabled={disabled}
              allowedRepos={allowedRepos}
              loadingRepos={loadingRepos}
              onChange={onChange}
              onRemove={onRemove}
              onAddChild={onAddChild}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
