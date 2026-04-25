import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import SettingsIcon from "@mui/icons-material/Settings";
import { reposApi, tasksApi } from "../api/client";
import type { Repo, RepoInput } from "../api/types";
import RepoFormDialog from "./repos/RepoFormDialog";
import DeleteRepoDialog from "./repos/DeleteRepoDialog";
import RepoSettingsPanel from "./repos/RepoSettingsPanel";
import TaskTreeView from "./repos/TaskTreeView";
import TaskDetailPage from "./repos/TaskDetailPage";
import {
  countTasksByStatus,
  emptyCounts,
  formatLastActivity,
  lastActivityIso,
  repoDisplayName,
  RepoStatusCounts,
  TASK_STATUS_CHIP_COLOR,
  TASK_STATUSES,
} from "./repos/repoDisplay";

interface RepoRowState {
  counts: RepoStatusCounts;
  lastActivity: string | null;
  loading: boolean;
  error: string | null;
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoStats, setRepoStats] = useState<Record<number, RepoRowState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formRepo, setFormRepo] = useState<Repo | null>(null);
  const [deleteRepo, setDeleteRepo] = useState<Repo | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [settingsRepoId, setSettingsRepoId] = useState<number | null>(null);

  const loadStatsForRepo = useCallback(async (repoId: number) => {
    setRepoStats((prev) => ({
      ...prev,
      [repoId]: {
        counts: prev[repoId]?.counts ?? emptyCounts(),
        lastActivity: prev[repoId]?.lastActivity ?? null,
        loading: true,
        error: null,
      },
    }));
    try {
      const tasks = await tasksApi.listByRepo(repoId);
      setRepoStats((prev) => ({
        ...prev,
        [repoId]: {
          counts: countTasksByStatus(tasks),
          lastActivity: lastActivityIso(tasks),
          loading: false,
          error: null,
        },
      }));
    } catch (err) {
      setRepoStats((prev) => ({
        ...prev,
        [repoId]: {
          counts: prev[repoId]?.counts ?? emptyCounts(),
          lastActivity: prev[repoId]?.lastActivity ?? null,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load tasks",
        },
      }));
    }
  }, []);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await reposApi.list();
      setRepos(list);
      setLoading(false);
      await Promise.all(list.map((r) => loadStatsForRepo(r.id)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load repos");
      setLoading(false);
    }
  }, [loadStatsForRepo]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const sortedRepos = useMemo(
    () =>
      [...repos].sort((a, b) =>
        repoDisplayName(a).localeCompare(repoDisplayName(b))
      ),
    [repos]
  );

  function openCreate() {
    setFormMode("create");
    setFormRepo(null);
    setFormOpen(true);
  }

  function openEdit(repo: Repo) {
    setFormMode("edit");
    setFormRepo(repo);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
  }

  async function handleFormSubmit(input: RepoInput) {
    setActionError(null);
    if (formMode === "create") {
      const created = await reposApi.create(input);
      setRepos((prev) => [...prev, created]);
      void loadStatsForRepo(created.id);
    } else if (formRepo) {
      const updated = await reposApi.update(formRepo.id, input);
      setRepos((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    }
    setFormOpen(false);
  }

  async function handleToggleActive(repo: Repo, nextActive: boolean) {
    setActionError(null);
    setPendingToggleId(repo.id);
    const previous = repos;
    setRepos((prev) =>
      prev.map((r) => (r.id === repo.id ? { ...r, active: nextActive } : r))
    );
    try {
      const updated = await reposApi.update(repo.id, { active: nextActive });
      setRepos((prev) =>
        prev.map((r) => (r.id === repo.id ? { ...r, ...updated } : r))
      );
    } catch (err) {
      setRepos(previous);
      setActionError(
        err instanceof Error ? err.message : "Failed to update repo"
      );
    } finally {
      setPendingToggleId(null);
    }
  }

  async function handleDeleteConfirm(repo: Repo) {
    await reposApi.delete(repo.id);
    setRepos((prev) => prev.filter((r) => r.id !== repo.id));
    setRepoStats((prev) => {
      const next = { ...prev };
      delete next[repo.id];
      return next;
    });
    setDeleteRepo(null);
  }

  return (
    <Box>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" component="h1">
            Repos
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage repositories that grunt watches and works on.
          </Typography>
        </Box>
        {repos.length > 0 && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            Add repo
          </Button>
        )}
      </Stack>

      {actionError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      )}

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void loadRepos()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {loading && (
        <Box
          sx={{ display: "flex", justifyContent: "center", py: 6 }}
          aria-label="Loading repos"
        >
          <CircularProgress />
        </Box>
      )}

      {!loading && !loadError && repos.length === 0 && (
        <Paper
          variant="outlined"
          sx={{
            p: 6,
            textAlign: "center",
          }}
          role="status"
        >
          <Typography variant="h6" gutterBottom>
            No repos yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Connect a GitHub repo or a local folder to start scheduling tasks.
          </Typography>
          <Button
            variant="contained"
            size="large"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            Connect a repo
          </Button>
        </Paper>
      )}

      {!loading && repos.length > 0 && (
        <>
        <TableContainer component={Paper} variant="outlined">
          <Table aria-label="Repos">
            <TableHead>
              <TableRow>
                <TableCell>Repo</TableCell>
                <TableCell>Base branch</TableCell>
                <TableCell>Active</TableCell>
                <TableCell>Tasks</TableCell>
                <TableCell>Last activity</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedRepos.map((repo) => {
                const stats = repoStats[repo.id];
                const counts = stats?.counts ?? emptyCounts();
                return (
                  <TableRow key={repo.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {repoDisplayName(repo)}
                      </Typography>
                      {repo.is_local_folder && (
                        <Typography variant="caption" color="text.secondary">
                          local folder
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <code>{repo.base_branch}</code>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={repo.active}
                        disabled={pendingToggleId === repo.id}
                        onChange={(e) =>
                          void handleToggleActive(repo, e.target.checked)
                        }
                        inputProps={{
                          "aria-label": `Toggle active for ${repoDisplayName(repo)}`,
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        {TASK_STATUSES.map((status) => (
                          <Tooltip key={status} title={status}>
                            <Chip
                              size="small"
                              label={`${status}: ${counts[status]}`}
                              color={TASK_STATUS_CHIP_COLOR[status]}
                              variant={
                                counts[status] === 0 ? "outlined" : "filled"
                              }
                              aria-label={`${status} count for ${repoDisplayName(repo)}`}
                            />
                          </Tooltip>
                        ))}
                      </Stack>
                      {stats?.error && (
                        <Typography
                          variant="caption"
                          color="error"
                          display="block"
                          sx={{ mt: 0.5 }}
                        >
                          {stats.error}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {formatLastActivity(stats?.lastActivity ?? null)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={`View tasks for ${repoDisplayName(repo)}`}
                        onClick={() =>
                          setSelectedRepoId((curr) =>
                            curr === repo.id ? null : repo.id
                          )
                        }
                        color={
                          selectedRepoId === repo.id ? "primary" : "default"
                        }
                      >
                        <AccountTreeIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        aria-label={`Settings for ${repoDisplayName(repo)}`}
                        onClick={() =>
                          setSettingsRepoId((curr) =>
                            curr === repo.id ? null : repo.id
                          )
                        }
                        color={
                          settingsRepoId === repo.id ? "primary" : "default"
                        }
                      >
                        <SettingsIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        aria-label={`Edit ${repoDisplayName(repo)}`}
                        onClick={() => openEdit(repo)}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        aria-label={`Delete ${repoDisplayName(repo)}`}
                        onClick={() => setDeleteRepo(repo)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        {settingsRepoId !== null && (() => {
          const settingsRepo = repos.find((r) => r.id === settingsRepoId);
          if (!settingsRepo) return null;
          return (
            <Paper variant="outlined" sx={{ mt: 3, p: 2 }} data-testid="repo-settings-panel">
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: 2 }}
              >
                <Typography variant="h6" component="h2">
                  Settings · {repoDisplayName(settingsRepo)}
                </Typography>
                <Button
                  size="small"
                  onClick={() => setSettingsRepoId(null)}
                  aria-label="Close settings"
                >
                  Close
                </Button>
              </Stack>
              <RepoSettingsPanel
                repo={settingsRepo}
                onChange={(updated) =>
                  setRepos((prev) =>
                    prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r))
                  )
                }
              />
            </Paper>
          );
        })()}
        {selectedRepoId !== null && (() => {
          const selectedRepo = repos.find((r) => r.id === selectedRepoId);
          if (!selectedRepo) return null;
          return (
            <Paper variant="outlined" sx={{ mt: 3, p: 2 }}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: 1 }}
              >
                <Typography variant="h6" component="h2">
                  Tasks · {repoDisplayName(selectedRepo)}
                </Typography>
                <Button
                  size="small"
                  onClick={() => setSelectedRepoId(null)}
                  aria-label="Close task tree"
                >
                  Close
                </Button>
              </Stack>
              <TaskTreeView
                repoId={selectedRepoId}
                onViewDetail={(task) => setSelectedTaskId(task.id)}
              />
            </Paper>
          );
        })()}
        {selectedTaskId !== null && (
          <Paper variant="outlined" sx={{ mt: 3, p: 2 }}>
            <TaskDetailPage
              taskId={selectedTaskId}
              onClose={() => setSelectedTaskId(null)}
            />
          </Paper>
        )}
        </>
      )}

      <RepoFormDialog
        open={formOpen}
        mode={formMode}
        repo={formRepo}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
      />
      <DeleteRepoDialog
        open={deleteRepo !== null}
        repo={deleteRepo}
        onClose={() => setDeleteRepo(null)}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
}
