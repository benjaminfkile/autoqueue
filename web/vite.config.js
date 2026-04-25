/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Default Express dev port from .env.example is 8000.
var API_TARGET = process.env.GRUNT_API_URL || "http://localhost:8000";
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: API_TARGET,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: true,
    },
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: ["./src/test/setup.ts"],
        css: false,
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
});
