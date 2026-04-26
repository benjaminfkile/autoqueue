import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeleteRepoDialog from "../../pages/repos/DeleteRepoDialog";
import type { Repo } from "../../api/types";

function makeRepo(): Repo {
  return {
    id: 5,
    owner: "alice",
    repo_name: "alpha",
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: true,
    github_token: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_subtree",
    max_retries: 0,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    created_at: new Date().toISOString(),
  };
}

describe("DeleteRepoDialog", () => {
  it("calls onConfirm with the repo when Delete is clicked", async () => {
    const repo = makeRepo();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <DeleteRepoDialog
        open
        repo={repo}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByText(/alice\/alpha/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(repo));
  });

  it("displays an error and does not crash when onConfirm rejects", async () => {
    const repo = makeRepo();
    const onConfirm = vi.fn().mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(
      <DeleteRepoDialog
        open
        repo={repo}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(screen.getByText(/nope/i)).toBeInTheDocument()
    );
  });

  it("invokes onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteRepoDialog
        open
        repo={makeRepo()}
        onClose={onClose}
        onConfirm={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
