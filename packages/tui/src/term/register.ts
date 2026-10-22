/** Bun does not compile Solid JSX by itself: import this before any .tsx view, then `await import` the view. */
// The release build compiles the views ahead of time (AGENCY_BUNDLED), which keeps babel out of the binary.
if (process.env.AGENCY_BUNDLED !== "1")
  (await import("@opentui/solid/bun-plugin")).ensureSolidTransformPlugin();
