export interface Env {
  [key: string]: string | undefined;
}

const on = (v: string | undefined): boolean =>
  v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Nothing moves: no rocking logo, no spinner, no beads. */
export const reducedMotion = (env: Env = process.env, config?: Record<string, unknown>): boolean =>
  on(env.AGENCY_REDUCED_MOTION) || on(env.NO_MOTION) || config?.reducedMotion === true;

/** Repaint every cell on every frame: the way out of a terminal that draws the diff wrong. */
export const fullRepaint = (env: Env = process.env): boolean => on(env.AGENCY_FULL_REPAINT);
