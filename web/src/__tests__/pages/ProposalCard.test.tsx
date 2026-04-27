import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProposalCard, {
  countNodes,
  removeAtPath,
  updateAtPath,
} from "../../pages/chat/ProposalCard";
import type {
  MaterializedTaskTree,
  ProposedTaskNode,
  Repo,
  TaskTreeProposal,
} from "../../api/types";

function makeRepo(id: number, owner = "alice", name = "alpha"): Repo {
  return {
    id,
    owner,
    repo_name: name,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
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

const sampleProposal: TaskTreeProposal = {
  parents: [
    {
      title: "Parent A",
      description: "A description",
      acceptance_criteria: ["does X"],
      children: [
        { title: "Child A1", description: "child desc" },
      ],
    },
    {
      title: "Parent B",
    },
  ],
};

describe("countNodes", () => {
  it("counts nested nodes", () => {
    expect(countNodes(sampleProposal.parents)).toBe(3);
  });

  it("returns 0 for undefined or empty", () => {
    expect(countNodes(undefined)).toBe(0);
    expect(countNodes([])).toBe(0);
  });
});

describe("updateAtPath", () => {
  it("updates a top-level node immutably", () => {
    const updated = updateAtPath(sampleProposal.parents, [1], (n) => ({
      ...n,
      title: "Renamed B",
    }));
    expect(updated[1].title).toBe("Renamed B");
    expect(sampleProposal.parents[1].title).toBe("Parent B");
  });

  it("updates a nested child by path", () => {
    const updated = updateAtPath(sampleProposal.parents, [0, 0], (n) => ({
      ...n,
      title: "New Child Title",
    }));
    const child = updated[0].children?.[0];
    expect(child?.title).toBe("New Child Title");
    expect(sampleProposal.parents[0].children?.[0].title).toBe("Child A1");
  });
});

describe("removeAtPath", () => {
  it("removes a top-level node", () => {
    const updated = removeAtPath(sampleProposal.parents, [0]);
    expect(updated).toHaveLength(1);
    expect(updated[0].title).toBe("Parent B");
  });

  it("removes a nested child", () => {
    const updated = removeAtPath(sampleProposal.parents, [0, 0]);
    expect(updated[0].children).toEqual([]);
  });
});

describe("ProposalCard", () => {
  it("renders editable fields for each node", () => {
    render(
      <ProposalCard
        proposal={sampleProposal}
        repos={[makeRepo(1)]}
        defaultRepoId={1}
        onSave={vi.fn(async () => ({ parents: [] }))}
        onDismiss={vi.fn()}
      />
    );
    const titles = screen.getAllByLabelText(/title for/i);
    expect(titles.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByDisplayValue("Parent A")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Child A1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("does X")).toBeInTheDocument();
  });

  it("calls onSave with the edited proposal and selected repo", async () => {
    const repos = [makeRepo(2, "me", "x"), makeRepo(3, "me", "y")];
    const result: MaterializedTaskTree = {
      parents: [
        {
          id: 100,
          title: "Renamed",
          parent_id: null,
          order_position: 0,
          repo_id: 3,
          acceptance_criteria_ids: [],
          children: [],
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(result);
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={{ parents: [{ title: "Original" }] }}
        repos={repos}
        defaultRepoId={3}
        onSave={onSave}
        onDismiss={vi.fn()}
      />
    );

    const titleInput = screen.getByLabelText(/^title for 1$/i);
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [repoId, edited] = onSave.mock.calls[0];
    expect(repoId).toBe(3);
    expect((edited as TaskTreeProposal).parents[0].title).toBe("Renamed");

    await waitFor(() =>
      expect(screen.getByText(/saved 1 task/i)).toBeInTheDocument()
    );
  });

  it("disables save when no repos exist", () => {
    render(
      <ProposalCard
        proposal={{ parents: [{ title: "T" }] }}
        repos={[]}
        defaultRepoId={null}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("removes a parent node when its delete button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={{
          parents: [
            { title: "Keep" },
            { title: "Drop" },
          ],
        }}
        repos={[makeRepo(1)]}
        defaultRepoId={1}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("Drop")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/^remove 2$/i));
    expect(screen.queryByDisplayValue("Drop")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Keep")).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss is clicked", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={{ parents: [{ title: "T" } as ProposedTaskNode] }}
        repos={[makeRepo(1)]}
        defaultRepoId={1}
        onSave={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
