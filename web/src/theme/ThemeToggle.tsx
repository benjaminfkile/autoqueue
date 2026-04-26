import { useRef, useState } from "react";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import CheckIcon from "@mui/icons-material/Check";
import { useThemeMode, type ThemeMode } from "./ThemeContext";

const MODE_LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function ModeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") return <LightModeIcon fontSize="small" />;
  if (mode === "dark") return <DarkModeIcon fontSize="small" />;
  return <SettingsBrightnessIcon fontSize="small" />;
}

export default function ThemeToggle() {
  const { mode, setMode } = useThemeMode();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const tooltip = `Theme: ${MODE_LABELS[mode]}`;
  const modes: ThemeMode[] = ["light", "dark", "system"];

  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton
          ref={buttonRef}
          aria-label={`Theme: ${MODE_LABELS[mode]}`}
          aria-haspopup="menu"
          aria-controls={open ? "theme-menu" : undefined}
          aria-expanded={open ? "true" : undefined}
          onClick={() => setOpen(true)}
          sx={{ ml: 1 }}
          data-testid="theme-toggle-button"
        >
          <ModeIcon mode={mode} />
        </IconButton>
      </Tooltip>
      <Menu
        id="theme-menu"
        anchorEl={buttonRef.current}
        open={open}
        onClose={() => setOpen(false)}
      >
        {modes.map((option) => (
          <MenuItem
            key={option}
            selected={mode === option}
            onClick={() => {
              setMode(option);
              setOpen(false);
            }}
            data-testid={`theme-option-${option}`}
          >
            <ListItemIcon>
              {mode === option ? (
                <CheckIcon fontSize="small" />
              ) : (
                <ModeIcon mode={option} />
              )}
            </ListItemIcon>
            <ListItemText>{MODE_LABELS[option]}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
