import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";

interface AcceptanceCriteriaEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export default function AcceptanceCriteriaEditor({
  value,
  onChange,
}: AcceptanceCriteriaEditorProps) {
  const add = () => onChange([...value, ""]);

  const remove = (index: number) => {
    const next = [...value];
    next.splice(index, 1);
    onChange(next);
  };

  const update = (index: number, text: string) => {
    const next = [...value];
    next[index] = text;
    onChange(next);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const next = [...value];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  };

  const moveDown = (index: number) => {
    if (index === value.length - 1) return;
    const next = [...value];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {value.map((criterion, index) => (
        <Box
          key={index}
          sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}
        >
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            <IconButton
              size="small"
              onClick={() => moveUp(index)}
              disabled={index === 0}
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => moveDown(index)}
              disabled={index === value.length - 1}
            >
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </Box>
          <TextField
            value={criterion}
            onChange={(e) => update(index, e.target.value)}
            size="small"
            fullWidth
            multiline
          />
          <IconButton size="small" onClick={() => remove(index)}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Button
        startIcon={<AddIcon />}
        onClick={add}
        size="small"
        variant="outlined"
        sx={{ alignSelf: "flex-start" }}
      >
        Add criterion
      </Button>
    </Box>
  );
}
