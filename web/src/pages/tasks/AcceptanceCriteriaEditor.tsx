import { Box, Button, IconButton, List, ListItem, TextField } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteIcon from "@mui/icons-material/Delete";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

export function AcceptanceCriteriaEditor({ value, onChange }: Props) {
  const update = (index: number, text: string) => {
    const next = [...value];
    next[index] = text;
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
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
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    onChange(next);
  };

  return (
    <Box>
      <List disablePadding>
        {value.map((criterion, index) => (
          <ListItem key={index} disablePadding sx={{ gap: 1, mb: 1 }}>
            <TextField
              value={criterion}
              onChange={(e) => update(index, e.target.value)}
              fullWidth
              size="small"
              multiline
            />
            <IconButton
              size="small"
              onClick={() => moveUp(index)}
              disabled={index === 0}
              aria-label="move up"
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => moveDown(index)}
              disabled={index === value.length - 1}
              aria-label="move down"
            >
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => remove(index)}
              aria-label="remove"
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </ListItem>
        ))}
      </List>
      <Button
        startIcon={<AddIcon />}
        onClick={() => onChange([...value, ""])}
        size="small"
      >
        Add criterion
      </Button>
    </Box>
  );
}
