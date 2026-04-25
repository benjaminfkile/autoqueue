import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import DeleteIcon from "@mui/icons-material/Delete";
import type {
  MaterializedTaskTree,
  ProposedTaskNode,
  Repo,
  TaskTreeProposal,
} from "../../api/types";

interface ProposalCardProps {
  proposal: TaskTreeProposal;
  repos: Repo[];
  defaultRepoId: number | null;
  onSave: (
    repoId: number,
    edited: TaskTreeProposal
  ) => Promise<MaterializedTaskTree>;
  onDismiss: () => void;
}

export default function ProposalCard({
  proposal,
  repos,
  defaultRepoId,
  onSave,
  onDismiss,
}: ProposalCardProps) {
  const [edited, setEdited] = useState<TaskTreeProposal>(proposal);
  const [repoId, setRepoId] = useState<number | "">(
    defaultRepoId ?? (repos[0]?.id ?? "")
  );
  const [saving, setSaving] = useState(false);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEdited(proposal);
    setSavedSummary(null);
    setError(null);
  }, [proposal]);

  function updateNode(path: number[], updater: (n: ProposedTaskNode) => ProposedTaskNode) {
    setEdited((prev) => ({
      parents: updateAtPath(prev.parents, path, updater),
    }));
  }

  function removeNode(path: number[]) {
    setEdited((prev) => ({
      parents: removeAtPath(prev.parents, path),
    }));
  }

  async function handleSave() {
    if (typeof repoId !== "number") {
      setError("Choose a repo to materialize into.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await onSave(repoId, edited);
      const total = countNodes(result.parents);
      setSavedSummary(
        `Saved ${total} task${total === 1 ? "" : "s"} into the repo.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const totalNodes = countNodes(edited.parents);
  const canEdit = !saving && savedSummary === null;
  const canSave =
    canEdit && edited.parents.length > 0 && typeof repoId === "number";

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, my: 1, bgcolor: "background.default" }}
      data-testid="proposal-card"
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle2">
          Proposed tree · {totalNodes} task{totalNodes === 1 ? "" : "s"}
        </Typography>
        <Button size="small" onClick={onDismiss} disabled={saving}>
          Dismiss
        </Button>
      </Stack>

      <Stack spacing={1.5} sx={{ mt: 1.5 }}>
        {edited.parents.map((node, i) => (
          <NodeEditor
            key={`p-${i}`}
            node={node}
            path={[i]}
            depth={0}
            disabled={!canEdit}
            onChange={updateNode}
            onRemove={removeNode}
          />
        ))}
      </Stack>

      <TextField
        select
        label="Repo"
        size="small"
        value={repoId}
        onChange={(e) => {
          const v = e.target.value;
          setRepoId(v === "" ? "" : Number(v));
        }}
        disabled={!canEdit}
        sx={{ mt: 2, minWidth: 220 }}
        SelectProps={{ native: false }}
      >
        {repos.length === 0 && (
          <MenuItem value="" disabled>
            No repos available
          </MenuItem>
        )}
        {repos.map((r) => (
          <MenuItem key={r.id} value={r.id}>
            {repoLabel(r)}
          </MenuItem>
        ))}
      </TextField>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {savedSummary && (
        <Alert severity="success" sx={{ mt: 1.5 }}>
          {savedSummary}
        </Alert>
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!canSave}
          startIcon={
            saving ? <CircularProgress color="inherit" size={16} /> : null
          }
        >
          {saving ? "Saving..." : savedSummary ? "Saved" : "Save"}
        </Button>
      </Stack>
    </Paper>
  );
}

interface NodeEditorProps {
  node: ProposedTaskNode;
  path: number[];
  depth: number;
  disabled: boolean;
  onChange: (path: number[], updater: (n: ProposedTaskNode) => ProposedTaskNode) => void;
  onRemove: (path: number[]) => void;
}

function NodeEditor({
  node,
  path,
  depth,
  disabled,
  onChange,
  onRemove,
}: NodeEditorProps) {
  const titleLabel = depth === 0 ? "Title" : `Subtask title`;
  return (
    <Box
      sx={{
        pl: depth === 0 ? 0 : 2,
        borderLeft: depth === 0 ? "none" : "2px solid",
        borderColor: "divider",
      }}
      data-testid={`proposal-node-${path.join("-")}`}
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Box sx={{ flex: 1 }}>
          <TextField
            label={titleLabel}
            size="small"
            fullWidth
            value={node.title}
            disabled={disabled}
            onChange={(e) =>
              onChange(path, (n) => ({ ...n, title: e.target.value }))
            }
            inputProps={{
              "aria-label": `Title for ${pathLabel(path)}`,
            }}
          />
          <TextField
            label="Description"
            size="small"
            fullWidth
            multiline
            minRows={1}
            value={node.description ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onChange(path, (n) => ({ ...n, description: e.target.value }))
            }
            sx={{ mt: 1 }}
            inputProps={{
              "aria-label": `Description for ${pathLabel(path)}`,
            }}
          />
          {node.acceptance_criteria && node.acceptance_criteria.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                Acceptance criteria
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {node.acceptance_criteria.map((c, i) => (
                  <TextField
                    key={i}
                    size="small"
                    fullWidth
                    value={c}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(path, (n) => ({
                        ...n,
                        acceptance_criteria: (n.acceptance_criteria ?? []).map(
                          (item, j) => (j === i ? e.target.value : item)
                        ),
                      }))
                    }
                    inputProps={{
                      "aria-label": `Acceptance criterion ${i + 1} for ${pathLabel(path)}`,
                    }}
                  />
                ))}
              </Stack>
            </Box>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={() => onRemove(path)}
          disabled={disabled}
          aria-label={`Remove ${pathLabel(path)}`}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Stack>
      {node.children && node.children.length > 0 && (
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {node.children.map((child, i) => (
            <NodeEditor
              key={`c-${i}`}
              node={child}
              path={[...path, i]}
              depth={depth + 1}
              disabled={disabled}
              onChange={onChange}
              onRemove={onRemove}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function pathLabel(path: number[]): string {
  return path.map((p) => p + 1).join(".");
}

function repoLabel(repo: Repo): string {
  if (repo.owner && repo.repo_name) return `${repo.owner}/${repo.repo_name}`;
  if (repo.local_path) return repo.local_path;
  return `repo #${repo.id}`;
}

export function countNodes(nodes: ProposedTaskNode[] | undefined): number {
  if (!nodes) return 0;
  let total = 0;
  for (const node of nodes) {
    total += 1;
    total += countNodes(node.children);
  }
  return total;
}

export function updateAtPath(
  nodes: ProposedTaskNode[],
  path: number[],
  updater: (n: ProposedTaskNode) => ProposedTaskNode
): ProposedTaskNode[] {
  if (path.length === 0) return nodes;
  const [head, ...rest] = path;
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return updater(node);
    return {
      ...node,
      children: updateAtPath(node.children ?? [], rest, updater),
    };
  });
}

export function removeAtPath(
  nodes: ProposedTaskNode[],
  path: number[]
): ProposedTaskNode[] {
  if (path.length === 0) return nodes;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return nodes.filter((_, i) => i !== head);
  }
  return nodes.map((node, i) => {
    if (i !== head) return node;
    return {
      ...node,
      children: removeAtPath(node.children ?? [], rest),
    };
  });
}
