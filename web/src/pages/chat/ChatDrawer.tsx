import { useEffect, useMemo, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import { chatApi, reposApi } from "../../api/client";
import type {
  ChatMessage,
  Repo,
  TaskTreeProposal,
} from "../../api/types";
import ProposalCard from "./ProposalCard";

interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface UiMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  proposal?: TaskTreeProposal;
  proposalDismissed?: boolean;
  proposalError?: string;
  errored?: boolean;
}

let nextMessageId = 1;

export default function ChatDrawer({ open, onClose }: ChatDrawerProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<number | "">("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!open) return;
    reposApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        setReposError(null);
        setSelectedRepoId((curr) => {
          if (curr !== "" && list.some((r) => r.id === curr)) return curr;
          return "";
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setReposError(
          err instanceof Error ? err.message : "Failed to load repos"
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const wireMessages: ChatMessage[] = useMemo(
    () =>
      messages
        .filter((m) => !m.errored)
        .map((m) => ({ role: m.role, content: m.content })),
    [messages]
  );

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    const userMsg: UiMessage = {
      id: nextMessageId++,
      role: "user",
      content: trimmed,
    };
    const assistantId = nextMessageId++;
    const assistantMsg: UiMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await chatApi.stream({
        messages: [...wireMessages, { role: "user", content: trimmed }],
        repoId: typeof selectedRepoId === "number" ? selectedRepoId : null,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "delta") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + event.text }
                  : m
              )
            );
          } else if (event.type === "proposal") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, proposal: event.proposal } : m
              )
            );
          } else if (event.type === "proposal_error") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, proposalError: event.error }
                  : m
              )
            );
          } else if (event.type === "error") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content:
                        m.content + (m.content ? "\n\n" : "") + event.error,
                      errored: true,
                    }
                  : m
              )
            );
          }
        },
      });
    } catch (err) {
      const aborted =
        err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        const message =
          err instanceof Error ? err.message : "Chat request failed";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: m.content
                    ? `${m.content}\n\n${message}`
                    : message,
                  errored: true,
                }
              : m
          )
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: { width: { xs: "100%", sm: 480 }, display: "flex" },
      }}
      ModalProps={{ keepMounted: true }}
      data-testid="chat-drawer"
    >
      <Stack sx={{ height: "100%" }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}
        >
          <Typography variant="h6" component="h2">
            Planning chat
          </Typography>
          <IconButton aria-label="Close chat drawer" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>

        <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
          <TextField
            select
            size="small"
            label="Repo (optional)"
            value={selectedRepoId}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedRepoId(v === "" ? "" : Number(v));
            }}
            fullWidth
            SelectProps={{ native: false }}
            inputProps={{ "aria-label": "Repo context" }}
          >
            <MenuItem value="">No repo context</MenuItem>
            {repos.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {repoLabel(r)}
              </MenuItem>
            ))}
          </TextField>
          {reposError && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {reposError}
            </Alert>
          )}
        </Box>

        <Box
          sx={{ flex: 1, overflowY: "auto", px: 2, py: 1.5 }}
          data-testid="chat-messages"
        >
          {messages.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Describe a project, feature, or bug. When the assistant has a
              concrete plan it will propose a task tree you can review and save.
            </Typography>
          )}
          <Stack spacing={1.5}>
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                repos={repos}
                defaultRepoId={
                  typeof selectedRepoId === "number" ? selectedRepoId : null
                }
                onSaveProposal={async (repoId, edited) => {
                  const result = await chatApi.materialize(repoId, edited);
                  return result;
                }}
                onDismissProposal={(id) =>
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === id
                        ? { ...msg, proposalDismissed: true }
                        : msg
                    )
                  )
                }
              />
            ))}
          </Stack>
          <div ref={messagesEndRef} />
        </Box>

        <Box
          sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}
        >
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              fullWidth
              size="small"
              multiline
              maxRows={5}
              placeholder="Type a message..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              inputProps={{ "aria-label": "Chat message" }}
              disabled={streaming}
            />
            {streaming ? (
              <Button
                variant="outlined"
                onClick={handleStop}
                aria-label="Stop streaming"
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="contained"
                onClick={() => void handleSend()}
                disabled={input.trim().length === 0}
                aria-label="Send message"
                endIcon={<SendIcon />}
              >
                Send
              </Button>
            )}
          </Stack>
          {streaming && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ mt: 1 }}
            >
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">
                Streaming...
              </Typography>
            </Stack>
          )}
        </Box>
      </Stack>
    </Drawer>
  );
}

interface MessageBubbleProps {
  message: UiMessage;
  repos: Repo[];
  defaultRepoId: number | null;
  onSaveProposal: ProposalCardSaveHandler;
  onDismissProposal: (messageId: number) => void;
}

type ProposalCardSaveHandler = (
  repoId: number,
  proposal: TaskTreeProposal
) => Promise<import("../../api/types").MaterializedTaskTree>;

function MessageBubble({
  message,
  repos,
  defaultRepoId,
  onSaveProposal,
  onDismissProposal,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
      data-testid={`chat-message-${message.role}`}
    >
      <Box sx={{ maxWidth: "92%", width: isUser ? "auto" : "100%" }}>
        <Paper
          variant="outlined"
          sx={{
            px: 1.25,
            py: 1,
            bgcolor: isUser ? "primary.main" : "background.paper",
            color: isUser ? "primary.contrastText" : "text.primary",
            borderColor: message.errored ? "error.main" : undefined,
            display: message.content || isUser ? "block" : "none",
          }}
        >
          <Typography
            variant="body2"
            sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {message.content ||
              (isUser ? "" : message.errored ? "" : "...")}
          </Typography>
        </Paper>
        {message.proposalError && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            Proposal could not be parsed: {message.proposalError}
          </Alert>
        )}
        {message.proposal && !message.proposalDismissed && (
          <ProposalCard
            proposal={message.proposal}
            repos={repos}
            defaultRepoId={defaultRepoId}
            onSave={onSaveProposal}
            onDismiss={() => onDismissProposal(message.id)}
          />
        )}
      </Box>
    </Box>
  );
}

function repoLabel(repo: Repo): string {
  if (repo.owner && repo.repo_name) return `${repo.owner}/${repo.repo_name}`;
  if (repo.local_path) return repo.local_path;
  return `repo #${repo.id}`;
}
