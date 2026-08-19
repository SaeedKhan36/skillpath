/**
 * Minimal stand-in for the `framer` package so the component can run outside
 * Framer. Property controls are metadata only, so recording them is enough.
 */
export const ControlType = {
    String: "string",
    Number: "number",
    Boolean: "boolean",
    Color: "color",
    Enum: "enum",
    Image: "image",
    File: "file",
    Object: "object",
    Array: "array",
    ComponentInstance: "componentinstance",
} as const

export function addPropertyControls(component: unknown, controls: unknown) {
    ;(component as any).propertyControls = controls
}
