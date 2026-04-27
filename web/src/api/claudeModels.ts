// Curated list of Claude models exposed in the SPA model picker. This is the
// single source of truth for the dropdown — adding a new model only requires
// editing this array. The `id` is the literal model string passed to the
// Anthropic SDK and the `claude --model` CLI flag, so it must match the
// upstream model identifier exactly. `label` is the human-readable name shown
// in the dropdown.
export interface ClaudeModelOption {
  id: string;
  label: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];
