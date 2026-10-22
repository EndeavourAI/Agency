import { RGBA, StyledText, TextAttributes, type TextChunk, type TextRenderable } from "@opentui/core";
import { type Accessor, createContext, createEffect, Index, useContext } from "solid-js";
import type { Palette } from "../term/themes.ts";
import type { Color, Row } from "./rows.ts";

export const ThemeCtx = createContext<Accessor<Palette>>();

export function useC(): Accessor<Palette> {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("no theme: wrap the view in ThemeCtx.Provider");
  return c;
}

const rgba = new Map<string, RGBA>();
function toRgba(c: Color): RGBA {
  if (typeof c !== "string") return c;
  let v = rgba.get(c);
  if (!v) {
    v = RGBA.fromHex(c);
    rgba.set(c, v);
  }
  return v;
}

/** One row of styled segments as the renderer's text chunks. */
export function styled(row: Row): StyledText {
  const chunks: TextChunk[] = row.map((s) => ({
    __isChunk: true,
    text: s.t,
    ...(s.fg === undefined ? {} : { fg: toRgba(s.fg) }),
    ...(s.bg === undefined ? {} : { bg: toRgba(s.bg) }),
    attributes: (s.b ? TextAttributes.BOLD : 0) | (s.i ? TextAttributes.ITALIC : 0),
  }));
  return new StyledText(chunks);
}

/** One terminal row, `w` cells wide; `bg` paints the cells the segments leave. */
export function Line(props: { row: Row; w: number; bg?: Color }) {
  const c = useC();
  let el: TextRenderable | undefined;
  // The solid reconciler turns a `content` prop into a string, so styled text goes in by hand.
  createEffect(() => {
    if (el) el.content = styled(props.row);
  });
  return (
    <text
      ref={(r) => {
        el = r;
      }}
      width={props.w}
      height={1}
      flexShrink={0}
      wrapMode="none"
      fg={c().text}
      {...(props.bg === undefined ? {} : { bg: props.bg })}
    />
  );
}

/** A stack of rows. `Index` keeps each row's renderable and swaps its content, so a streaming turn redraws only what changed. */
export function Rows(props: { rows: Row[]; w: number; bg?: Color }) {
  return (
    <box flexDirection="column" flexShrink={0} width={props.w}>
      <Index each={props.rows}>{(r) => <Line row={r()} w={props.w} bg={props.bg} />}</Index>
    </box>
  );
}
