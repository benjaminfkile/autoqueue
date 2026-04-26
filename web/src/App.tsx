import { useState } from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ChatIcon from "@mui/icons-material/Chat";
import ReposPage from "./pages/ReposPage";
import ChatDrawer from "./pages/chat/ChatDrawer";
import {
  ActiveWorkersPanel,
  WorkerModeChip,
  useWorkerStatus,
} from "./pages/WorkerStatusBar";

export default function App() {
  const { status, error } = useWorkerStatus();
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            grunt
          </Typography>
          <WorkerModeChip status={status} error={error} />
          <Tooltip title="Open planning chat">
            <IconButton
              aria-label="Open planning chat"
              onClick={() => setChatOpen(true)}
              sx={{ ml: 1 }}
            >
              <ChatIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <ActiveWorkersPanel status={status} />
        <ReposPage />
      </Container>
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
    </Box>
  );
}
