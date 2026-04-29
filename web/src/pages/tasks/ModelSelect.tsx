import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { CLAUDE_MODELS } from "../../api/claudeModels";

interface ModelSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
}

export default function ModelSelect({
  value,
  onChange,
  label = "Model",
}: ModelSelectProps) {
  return (
    <TextField
      select
      label={label}
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value === "" ? null : e.target.value)
      }
      fullWidth
    >
      <MenuItem value="">
        <em>Inherit / use default</em>
      </MenuItem>
      {CLAUDE_MODELS.map((model) => (
        <MenuItem key={model.id} value={model.id}>
          {model.label}
        </MenuItem>
      ))}
    </TextField>
  );
}
