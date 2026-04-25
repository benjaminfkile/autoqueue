import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";

export default function App() {
  return (
    <Container maxWidth="md">
      <Box sx={{ py: 6 }}>
        <Typography variant="h3" component="h1" gutterBottom>
          grunt
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Phase 3 GUI scaffold. Pages will be added in subsequent tasks.
        </Typography>
      </Box>
    </Container>
  );
}
