import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import CourseGrid from "@component"

// courseLinkBase is set here so the harness exercises the linked-card path.
// It is empty by default in the component, and in Framer.
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <CourseGrid courseLinkBase="https://example.com/courses/" />
    </StrictMode>
)
