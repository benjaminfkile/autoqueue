#!/usr/bin/env node
// Seeds the grunt repo with the task tree for "build a real task-creation
// interface in the SPA". POSTs to /api/repos/<id>/materialize-tree.
//
// Run with:  node scripts/seed-tasks.js
//   env:     GRUNT_API_URL (default http://localhost:3006)
//            GRUNT_REPO_ID (default 2 — the grunt repo)
//
// The materialize-tree endpoint validates the proposal against the chat
// planner's schema, so per-node knobs like model override / ordering_mode /
// requires_approval are NOT supported here — those need to be set via PATCH
// /api/tasks/:id afterward if desired. Each leaf includes acceptance_criteria
// so the runner has a concrete done-when signal.

const http = require("http");
const { URL } = require("url");

const API_URL = process.env.GRUNT_API_URL || "http://localhost:3006";
const REPO_ID = parseInt(process.env.GRUNT_REPO_ID || "2", 10);

// Each top-level entry is a "phase" (parent task with children). The runner
// processes phases sequentially per the repo's ordering_mode, and within each
// phase children run in the order listed.
const tree = {
  parents: [
    {
      title: "Phase 1 — Foundation: shared API client + reusable form components",
      description:
        "Lay groundwork that every later phase depends on. Extend the SPA's API client and shared types to cover task creation/editing, then extract two reusable form pieces (model picker and acceptance-criteria editor) so the New Task / Edit Task / New Phase dialogs can share them. No user-visible UI yet — this phase only adds modules and types.",
      acceptance_criteria: [
        "web/src/api/types.ts defines TaskCreateInput matching the POST /api/tasks body (repo_id, parent_id?, title, description?, order_position?, ordering_mode?, model?, acceptanceCriteria?[]) and is exported.",
        "web/src/api/client.ts exposes tasksApi.create(input), tasksApi.update(id, patch), tasksApi.delete(id), tasksApi.criteria.{list,create,update,delete}, tasksApi.notes.{list,create,delete}, tasksApi.effectiveModel(id).",
        "web/src/api/client.ts exposes templatesApi.{list,get,save,delete} and reposApi.materializeTree(id, proposal) and reposApi.instantiateTemplate(id, templateId).",
        "A new component web/src/pages/tasks/ModelSelect.tsx renders a TextField select pre-populated from CLAUDE_MODELS with an 'inherit / use default' option that maps to null, and accepts value/onChange props.",
        "A new component web/src/pages/tasks/AcceptanceCriteriaEditor.tsx renders an add/remove/reorder list of criterion strings, controlled via value: string[] and onChange: (next: string[]) => void.",
        "tsc -b in web/ passes; no new files import from web/src/__tests__.",
      ],
      children: [],
    },
    {
      title: "Phase 2 — NewTaskDialog: create a single task from anywhere",
      description:
        "Add a single-task creation flow surfaced from three entry points: a top-level button on ReposPage, a per-row button on each repo, and a per-node 'Add child' button in TaskTreeView. Form covers every field POST /api/tasks accepts, including acceptance criteria.",
      acceptance_criteria: [
        "web/src/pages/tasks/NewTaskDialog.tsx renders a MUI Dialog with: title (required), description, parent task selector (existing tasks for the repo, plus 'no parent' option), order_position (numeric, optional), ordering_mode select (sequential/parallel/inherit), ModelSelect, requires_approval Switch, AcceptanceCriteriaEditor.",
        "Submit POSTs to /api/tasks via tasksApi.create with the active repo_id; on 201 the dialog closes and the parent component receives the created task via onCreated callback.",
        "Server-side validation errors render in an Alert inside the dialog without dismissing the form state.",
        "ReposPage.tsx renders an 'Add task' button next to the existing 'Add repo' button (only when at least one repo exists). Clicking it opens NewTaskDialog scoped to a repo selected via a dropdown inside the dialog.",
        "Each row in the repos table has a new 'Add task' icon button (test id repo-add-task-<id>) that opens NewTaskDialog pre-scoped to that repo.",
        "TaskTreeNode renders a new 'Add child' icon button (test id task-add-child-<id>) that opens NewTaskDialog pre-scoped to that repo and pre-selecting the current node as the parent.",
        "Empty-state TaskTreeView ('No tasks yet') gains a primary 'Add task' CTA that opens NewTaskDialog for that repo with parent_id=null.",
      ],
      children: [],
    },
    {
      title: "Phase 3 — EditTaskDialog: full-fidelity task editing",
      description:
        "Add an editing surface that exposes every PATCH-able field plus criteria CRUD inline. Reuse NewTaskDialog's form pieces. Show the effective-model resolution so the user can see whether their override is winning.",
      acceptance_criteria: [
        "web/src/pages/tasks/EditTaskDialog.tsx renders the same fields as NewTaskDialog (minus parent selector and repo selector) plus a status select (pending/active/done/failed/interrupted).",
        "On open, the dialog fetches GET /api/tasks/:id and GET /api/tasks/:id/effective-model and renders an 'Effective model: <id> (source: override|parent|default)' chip near the ModelSelect.",
        "AcceptanceCriteriaEditor inside the edit dialog is wired to the live criteria endpoints — adding a row POSTs to /api/tasks/:id/criteria, deleting PATCHes via DELETE, editing description PATCHes the row, and a 'met' checkbox PATCHes met=true|false. Optimistic UI with rollback on failure.",
        "Submit PATCHes the task with whatever scalar fields changed (title, description, status, ordering_mode, model, requires_approval) and closes on 200.",
        "TaskTreeNode renders an Edit icon button (test id task-edit-<id>) that opens EditTaskDialog for that task.",
        "Deleting a task is exposed via a Delete icon button in EditTaskDialog footer with a confirm step that mentions cascade-on-children; on confirm calls DELETE /api/tasks/:id and closes the dialog.",
      ],
      children: [],
    },
    {
      title: "Phase 4 — Task notes UI",
      description:
        "Surface task notes (visible-to-this-task list + author/visibility/tags) inside TaskDetailPage so users can leave context for sibling/ancestor/descendant tasks and read what agents have left behind.",
      acceptance_criteria: [
        "web/src/pages/tasks/NotesPanel.tsx renders the list returned by GET /api/tasks/:id/notes with author chip, visibility chip, tags as small chips, and the content body.",
        "An 'Add note' form at the top of NotesPanel posts to /api/tasks/:id/notes with author='user', a visibility select (self/siblings/descendants/ancestors/all), an optional comma-separated tags input, and a content textarea.",
        "Each note row has a delete icon that calls DELETE /api/tasks/:taskId/notes/:noteId after a confirm.",
        "TaskDetailPage embeds NotesPanel as a section beneath the existing detail content.",
        "TaskTreeNode shows a small badge with the visible-note count when > 0 (uses the same notes endpoint via a lightweight cached fetch; do not poll faster than the existing tree poll).",
      ],
      children: [],
    },
    {
      title: "Phase 5 — NewPhaseDialog: bulk authoring via materialize-tree",
      description:
        "Build the bulk-authoring path. A visual tree editor lets the user assemble a multi-parent / multi-child phase in one go and POSTs it through /api/repos/:id/materialize-tree. Includes a JSON-paste escape hatch and a per-top-level repo selector for linked-repo scenarios.",
      acceptance_criteria: [
        "web/src/pages/tasks/NewPhaseDialog.tsx renders an editable tree of nodes. Each node has title, description, AcceptanceCriteriaEditor, plus add-child / delete-node controls. Top-level nodes additionally render a repo selector limited to the active repo plus its directly-linked repos.",
        "A 'JSON' tab in the dialog lets the user paste/edit raw TaskTreeProposal JSON; switching tabs round-trips between the visual tree and the JSON without losing state.",
        "Submit calls reposApi.materializeTree(activeRepoId, proposal); 400 responses surface inline with the validator's error message.",
        "ReposPage row gains an 'Add phase' icon button (test id repo-add-phase-<id>) that opens NewPhaseDialog pre-scoped to that repo.",
        "TaskTreeView header gains an 'Add phase' button (test id tasktree-add-phase) — only visible when a repo is selected.",
        "After successful materialization the parent component refreshes the task list so the new phase appears immediately.",
      ],
      children: [],
    },
    {
      title: "Phase 6 — Templates: save & reuse phase trees",
      description:
        "Wire the existing template endpoints into the SPA. Users can save the current task tree (or a NewPhaseDialog draft) as a named template, list templates, instantiate a template into any repo, and delete templates.",
      acceptance_criteria: [
        "web/src/pages/tasks/TemplatesDrawer.tsx renders the list returned by GET /api/templates with name, description, and the count of root proposals; clicking a template shows a read-only preview of the proposal tree.",
        "TemplatesDrawer has 'Apply to this repo' button that POSTs to /api/repos/:id/instantiate-template/:templateId after a confirm dialog explaining new tasks will be created.",
        "TemplatesDrawer has a delete action per template that calls DELETE /api/templates/:id with confirm.",
        "TaskTreeView header gains a 'Save as template' button: opens a small dialog asking for name + description, then POSTs the current tree (assembled from the existing tasks list) to /api/templates.",
        "NewPhaseDialog gains a 'Save as template' secondary action that posts the in-progress tree without materializing it.",
        "TemplatesDrawer is reachable from a Templates icon in the App AppBar.",
      ],
      children: [],
    },
    {
      title: "Phase 7 — Polish: per-node chips, shortcuts, and empty-state CTAs",
      description:
        "Round-trip improvements that make the new authoring surface feel finished — visible criteria progress, per-node effective-model + requires_approval chips, keyboard shortcuts in dialogs, and consolidated empty-state messaging.",
      acceptance_criteria: [
        "TaskTreeNode renders a small 'N/M criteria met' indicator when the task has acceptance criteria; computed from a single batched fetch (do not call /criteria per node on every poll).",
        "TaskTreeNode renders a 'requires approval' chip when task.requires_approval === true.",
        "TaskTreeNode renders a small effective-model chip when the resolved model differs from the repo default; click opens EditTaskDialog focused on the model field.",
        "NewTaskDialog / EditTaskDialog / NewPhaseDialog support Cmd/Ctrl+Enter to submit and Esc to cancel without losing draft state via a confirm.",
        "Snackbar feedback on every successful create/update/delete across the new dialogs (use existing MUI Snackbar; one global instance in App.tsx).",
        "ReposPage empty state is updated to mention the new authoring options ('Connect a repo, then add a task or paste a phase tree').",
      ],
      children: [],
    },
    {
      title: "Phase 8 — Test repair + new test coverage",
      description:
        "Fix unit tests broken by the ANTHROPIC_API_KEY removal and chat disablement, then add coverage for the new authoring components. Server: 12 suites / 92 tests currently failing. Web: 3 files / 8 tests currently failing.",
      acceptance_criteria: [
        "Server: __tests__/setupRouter.test.ts is rewritten to assert REQUIRED_SETUP_KEYS is ['GH_PAT'] and exercises POST/PATCH/DELETE without ANTHROPIC_API_KEY references; all setupRouter tests pass.",
        "Server: __tests__/chatRouter.test.ts is deleted (the router is unmounted) and any imports of validateTaskTreeProposal still covered live in __tests__/chatService.test.ts; chatService tests still pass.",
        "Server: __tests__/claudeRunner.test.ts and __tests__/taskRunner.test.ts no longer reference anthropicApiKey; new test verifies prepareHostClaudeMount() returns the expected shape and calls cleanup().",
        "Server: __tests__/secrets.test.ts and any setup-related tests still pass; coverage gate phases (phase4/5/7/8) re-pass with the trimmed surface.",
        "Web: src/__tests__/pages/SetupPanel.test.tsx, SettingsPanel.test.tsx, App.test.tsx, UsageDashboard.test.tsx no longer reference ANTHROPIC_API_KEY and pass.",
        "Web: new test files for NewTaskDialog, EditTaskDialog, NewPhaseDialog, NotesPanel, TemplatesDrawer cover happy path + validation-error path for each.",
        "Web: web/tsconfig.json no longer excludes src/__tests__ once the suite compiles cleanly under strict mode (or, if the exclusion is kept intentionally, this AC is rewritten to say so explicitly).",
        "npm test from the repo root and npm test from web/ both exit 0.",
      ],
      children: [],
    },
  ],
};

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "application/json",
        },
      },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const url = `${API_URL}/api/repos/${REPO_ID}/materialize-tree`;
  console.log(`POST ${url}`);
  console.log(`  ${tree.parents.length} top-level phases`);
  const totalCriteria = tree.parents.reduce(
    (sum, p) => sum + (p.acceptance_criteria?.length || 0),
    0
  );
  console.log(`  ${totalCriteria} acceptance criteria across all phases`);

  const res = await postJson(url, tree);
  console.log(`HTTP ${res.status}`);
  if (res.status >= 200 && res.status < 300) {
    const created = res.body;
    const parents = (created && created.parents) || [];
    console.log(`Created ${parents.length} parent task(s):`);
    for (const p of parents) {
      console.log(`  #${p.id}  ${p.title || ""}`);
    }
  } else {
    console.error("Materialize failed:", JSON.stringify(res.body, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
