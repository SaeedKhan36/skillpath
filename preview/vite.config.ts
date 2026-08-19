import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath, URL } from "node:url"

// The component is authored for Framer, so `framer` is aliased to a local stub
// and the real file is pulled in from the repo root untouched.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            framer: fileURLToPath(new URL("./src/framer-stub.ts", import.meta.url)),
            "@component": fileURLToPath(new URL("../CourseGrid.tsx", import.meta.url)),
        },
    },
    server: {
        port: 5183,
        fs: { allow: [".."] },
    },
})
