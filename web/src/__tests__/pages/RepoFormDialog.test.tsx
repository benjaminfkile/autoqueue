import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RepoFormDialog from "../../pages/repos/RepoFormDialog";
import type { Repo } from "../../api/types";

function makeRepo(): Repo {
  return {
    id: 1,
    owner: "alice",
    repo_name: "alpha",
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: true,
    github_token: "secret",
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_subtree",
    max_retries: 3,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    created_at: new Date().toISOString(),
  };
}

describe("RepoFormDialog", () => {
  it("requires owner and repo name when not a local folder", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RepoFormDialog
        open
        mode="create"
        repo={null}
        onClose={() => {}}
        onSubmit={onSubmit}
      />
    );
    await user.click(screen.getByRole("button", { name: /connect/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText(/owner and repo name are required/i)
    ).toBeInTheDocument();
  });

  it("submits a payload with owner and repo name", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <RepoFormDialog
        open
        mode="create"
        repo={null}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/owner/i), "alice");
    await user.type(within(dialog).getByLabelText(/repo name/i), "alpha");
    await user.click(within(dialog).getByRole("button", { name: /connect/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.owner).toBe("alice");
    expect(payload.repo_name).toBe("alpha");
    expect(payload.is_local_folder).toBe(false);
    expect(payload.base_branch).toBe("main");
    expect(payload.max_retries).toBe(0);
    expect(payload.active).toBe(true);
  });

  it("requires local path when local folder is enabled", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <RepoFormDialog
        open
        mode="create"
        repo={null}
        onClose={() => {}}
        onSubmit={onSubmit}
      />
    );
    await user.click(screen.getByRole("checkbox", { name: /local folder/i }));
    await user.click(screen.getByRole("button", { name: /connect/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText(/local path is required for local folder repos/i)
    ).toBeInTheDocument();
  });

  it("pre-fills fields when editing an existing repo", () => {
    render(
      <RepoFormDialog
        open
        mode="edit"
        repo={makeRepo()}
        onClose={() => {}}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox", { name: /^owner$/i })).toHaveValue(
      "alice"
    );
    expect(screen.getByRole("textbox", { name: /^repo name$/i })).toHaveValue(
      "alpha"
    );
    expect(
      screen.getByRole("textbox", { name: /^base branch$/i })
    ).toHaveValue("main");
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("rejects negative max retries", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <RepoFormDialog
        open
        mode="create"
        repo={null}
        onClose={() => {}}
        onSubmit={onSubmit}
      />
    );
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/owner/i), "alice");
    await user.type(within(dialog).getByLabelText(/repo name/i), "alpha");
    const retries = within(dialog).getByLabelText(/max retries/i);
    await user.clear(retries);
    await user.type(retries, "-2");
    await user.click(within(dialog).getByRole("button", { name: /connect/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText(/max retries must be a non-negative integer/i)
    ).toBeInTheDocument();
  });
});
