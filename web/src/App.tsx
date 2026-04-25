import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import ReposPage from "./pages/ReposPage";
import {
  ActiveWorkersPanel,
  WorkerModeChip,
  useWorkerStatus,
} from "./pages/WorkerStatusBar";

export default function App() {
  const { status, error } = useWorkerStatus();

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            grunt
          </Typography>
          <WorkerModeChip status={status} error={error} />
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <ActiveWorkersPanel status={status} />
        <ReposPage />
      </Container>
    </Box>
  );
}
