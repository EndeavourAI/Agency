import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";

/** Bun does not compile Solid JSX by itself: import this before any .tsx view, then `await import` the view. */
ensureSolidTransformPlugin();
