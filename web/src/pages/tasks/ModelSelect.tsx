import { MenuItem, TextField } from "@mui/material";
import { CLAUDE_MODELS } from "../../api/claudeModels";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
}

export function ModelSelect({ value, onChange, label = "Model" }: Props) {
  return (
    <TextField
      select
      label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      fullWidth
    >
      <MenuItem value="">Inherit / use default</MenuItem>
      {CLAUDE_MODELS.map((m) => (
        <MenuItem key={m.id} value={m.id}>
          {m.label}
        </MenuItem>
      ))}
    </TextField>
  );
}
