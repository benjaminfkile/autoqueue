import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import DeleteIcon from "@mui/icons-material/Delete";
import { reposApi } from "../../api/client";
import type { Repo, RepoLink, RepoLinkPermission } from "../../api/types";
import { repoDisplayName } from "./repoDisplay";

const PERMISSION_OPTIONS: RepoLinkPermission[] = ["read", "write"];

export interface LinkedReposSectionProps {
  repo: Repo;
  allRepos: Repo[];
}

export default function LinkedReposSection({
  repo,
  allRepos,
}: LinkedReposSectionProps) {
  const [links, setLinks] = useState<RepoLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pickerRepoId, setPickerRepoId] = useState<number | "">("");
  const [pickerRole, setPickerRole] = useState("");
  const [pickerPermission, setPickerPermission] =
    useState<RepoLinkPermission>("read");
  const [adding, setAdding] = useState(false);

  const [pendingLinkId, setPendingLinkId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await reposApi.listLinks(repo.id);
      setLinks(list);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load linked repos"
      );
    } finally {
      setLoading(false);
    }
  }, [repo.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset the picker selection whenever we switch which repo we're editing,
  // otherwise a stale `other_repo_id` could carry across panels and produce a
  // confusing default.
  useEffect(() => {
    setPickerRepoId("");
    setPickerRole("");
    setPickerPermission("read");
    setActionError(null);
  }, [repo.id]);

  function otherRepoId(link: RepoLink): number {
    return link.repo_a_id === repo.id ? link.repo_b_id : link.repo_a_id;
  }

  function repoLabel(id: number): string {
    const found = allRepos.find((r) => r.id === id);
    return found ? repoDisplayName(found) : `Repo #${id}`;
  }

  const linkedIds = new Set(links.map((l) => otherRepoId(l)));
  const candidateRepos = allRepos
    .filter((r) => r.id !== repo.id && !linkedIds.has(r.id))
    .sort((a, b) => repoDisplayName(a).localeCompare(repoDisplayName(b)));

  async function handleAdd() {
    if (typeof pickerRepoId !== "number") {
      setActionError("Pick a repo to link.");
      return;
    }
    setAdding(true);
    setActionError(null);
    try {
      const created = await reposApi.createLink(repo.id, {
        other_repo_id: pickerRepoId,
        role: pickerRole.trim() ? pickerRole.trim() : null,
        permission: pickerPermission,
      });
      setLinks((prev) => [...prev, created]);
      setPickerRepoId("");
      setPickerRole("");
      setPickerPermission("read");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add link");
    } finally {
      setAdding(false);
    }
  }

  async function handlePermissionChange(
    link: RepoLink,
    permission: RepoLinkPermission
  ) {
    if (permission === link.permission) return;
    setPendingLinkId(link.id);
    setActionError(null);
    try {
      const updated = await reposApi.updateLinkPermission(
        repo.id,
        link.id,
        permission
      );
      setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to update permission"
      );
    } finally {
      setPendingLinkId(null);
    }
  }

  async function handleRemove(link: RepoLink) {
    setPendingLinkId(link.id);
    setActionError(null);
    try {
      await reposApi.deleteLink(repo.id, link.id);
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to remove link"
      );
    } finally {
      setPendingLinkId(null);
    }
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div">
        Linked repos
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => setLoadError(null)}>
          {loadError}
        </Alert>
      )}
      {actionError && (
        <Alert
          severity="error"
          sx={{ mt: 1 }}
          onClose={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ mt: 1, display: "flex", alignItems: "center" }} aria-label="Loading linked repos">
          <CircularProgress size={18} />
        </Box>
      ) : links.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No linked repos yet.
        </Typography>
      ) : (
        <Table
          size="small"
          aria-label="Linked repos"
          data-testid="linked-repos-table"
          sx={{ mt: 1 }}
        >
          <TableHead>
            <TableRow>
              <TableCell>Repo</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Permission</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {links.map((link) => {
              const otherId = otherRepoId(link);
              const otherName = repoLabel(otherId);
              return (
                <TableRow key={link.id}>
                  <TableCell>{otherName}</TableCell>
                  <TableCell>
                    {link.role ? (
                      link.role
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <TextField
                      select
                      size="small"
                      value={link.permission}
                      onChange={(e) =>
                        void handlePermissionChange(
                          link,
                          e.target.value as RepoLinkPermission
                        )
                      }
                      disabled={pendingLinkId === link.id}
                      inputProps={{
                        "aria-label": `Permission for ${otherName}`,
                      }}
                      sx={{ minWidth: 110 }}
                    >
                      {PERMISSION_OPTIONS.map((opt) => (
                        <MenuItem key={opt} value={opt}>
                          {opt}
                        </MenuItem>
                      ))}
                    </TextField>
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      aria-label={`Remove link to ${otherName}`}
                      onClick={() => void handleRemove(link)}
                      disabled={pendingLinkId === link.id}
                      size="small"
                    >
                      {pendingLinkId === link.id ? (
                        <CircularProgress size={16} />
                      ) : (
                        <DeleteIcon fontSize="small" />
                      )}
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{ mt: 2, alignItems: { xs: "stretch", sm: "center" } }}
      >
        <TextField
          select
          label="Add link"
          value={pickerRepoId === "" ? "" : String(pickerRepoId)}
          onChange={(e) =>
            setPickerRepoId(e.target.value === "" ? "" : Number(e.target.value))
          }
          disabled={adding || candidateRepos.length === 0}
          size="small"
          sx={{ minWidth: 200 }}
          SelectProps={{ inputProps: { "aria-label": "Pick a repo to link" } }}
          helperText={
            candidateRepos.length === 0 ? "No other repos available" : undefined
          }
        >
          <MenuItem value="">
            <em>— Select a repo —</em>
          </MenuItem>
          {candidateRepos.map((r) => (
            <MenuItem key={r.id} value={String(r.id)}>
              {repoDisplayName(r)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Role (optional)"
          value={pickerRole}
          onChange={(e) => setPickerRole(e.target.value)}
          disabled={adding}
          size="small"
          sx={{ minWidth: 160 }}
          inputProps={{ "aria-label": "Link role" }}
        />
        <TextField
          select
          label="Permission"
          value={pickerPermission}
          onChange={(e) =>
            setPickerPermission(e.target.value as RepoLinkPermission)
          }
          disabled={adding}
          size="small"
          sx={{ minWidth: 120 }}
          SelectProps={{ inputProps: { "aria-label": "Link permission" } }}
        >
          {PERMISSION_OPTIONS.map((opt) => (
            <MenuItem key={opt} value={opt}>
              {opt}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          onClick={() => void handleAdd()}
          disabled={adding || pickerRepoId === ""}
          aria-label="Add linked repo"
        >
          {adding ? <CircularProgress size={18} /> : "Add link"}
        </Button>
      </Stack>
    </Box>
  );
}
