import type { RGBA } from "@opentui/core";
import { type Accessor, createMemo, Index, Match, Show, Switch } from "solid-js";
import { activeContexts } from "../controller/keys.ts";
import {
  canRetry,
  current,
  detailsShown,
  newerLabel,
  queuedRows,
  runningTurn,
  scrolledBlocks,
  showAsk,
  showLogo,
} from "../state/derive.ts";
import type { AppState, Block } from "../state/types.ts";
import type { Palette } from "../term/themes.ts";
import { footerRow, hintRow, topBar } from "./chrome.ts";
import { completionBox, composerBox, imageChipsBox, noteBox } from "./composer.ts";
import { DETAILS_W, detailsRows } from "./details.ts";
import { HOME_W, logoRows, recentRows, wordmarkRow } from "./home.ts";
import {
  approvalRows,
  boxRows,
  eventRows,
  type LedgerCtx,
  queuedRow,
  SPIN,
  scrollRow,
  shellRows,
  turnRows,
} from "./ledger.ts";
import { modelRows, paletteRows } from "./overlays.ts";
import { commitBox, reviewBody } from "./review.ts";
import { clip, type Row, segsWidth } from "./rows.ts";
import { settingsView } from "./settings.ts";
import { Rows, ThemeCtx } from "./ui.tsx";

export interface AppProps {
  state: Accessor<AppState>;
  palette: Accessor<Palette>;
  /** One step per 140 ms while anything animates. */
  tick: Accessor<number>;
  /** Wall clock in ms, for the running time of a turn and the ages in lists. */
  now: Accessor<number>;
  version: string;
}

const MAX_COLUMN = 120;
/** gap 1 + border 1 + padding 2 around the details pane. */
const DETAILS_CHROME = 5;

export function App(props: AppProps) {
  const s = props.state;
  const c = props.palette;
  const top = createMemo(() => [topBar(s(), c(), props.tick())]);
  return (
    <ThemeCtx.Provider value={c}>
      <box flexDirection="column" width={s().cols} height={s().rows} backgroundColor={c().bg}>
        <Rows rows={top()} w={s().cols} />
        <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" position="relative">
          <Switch>
            <Match when={s().view === "home"}>
              <Home {...props} />
            </Match>
            <Match when={s().view === "session"}>
              <Session {...props} />
            </Match>
            <Match when={s().view === "settings"}>
              <Settings {...props} />
            </Match>
          </Switch>
          <Show when={s().palette.open}>
            <Overlay {...props} kind="palette" />
          </Show>
          <Show when={s().model.open}>
            <Overlay {...props} kind="model" />
          </Show>
        </box>
        <Show when={s().view === "home"}>
          <Rows rows={[footerRow(s(), c())]} w={s().cols} />
        </Show>
      </box>
    </ThemeCtx.Provider>
  );
}

function Overlay(props: AppProps & { kind: "palette" | "model" }) {
  const s = props.state;
  const rows = createMemo(() => {
    const room = Math.max(6, s().rows - 1 - 3 - 1);
    return props.kind === "palette"
      ? paletteRows(s(), props.palette(), s().cols, room, props.tick(), props.now())
      : modelRows(s(), props.palette(), s().cols, room);
  });
  const w = () => segsWidth(rows()[0] ?? []);
  const scrim = () => props.palette().scrim;
  return (
    <>
      <Show when={scrim()}>
        <box
          position="absolute"
          top={0}
          left={0}
          width={s().cols}
          height={s().rows - 1}
          zIndex={9}
          backgroundColor={scrim() as RGBA}
        />
      </Show>
      <box
        position="absolute"
        top={3}
        left={Math.max(0, Math.floor((s().cols - w()) / 2))}
        zIndex={10}
        width={w()}
      >
        <Rows rows={rows()} w={w()} bg={props.palette().panel} />
      </box>
    </>
  );
}

/** What is typed in the box right now: mode colour on the border while the composer owns the keys. */
function useFocused(s: Accessor<AppState>): Accessor<boolean> {
  return () => {
    const first = activeContexts(s())[0];
    return first === "composer" || first === "completion";
  };
}

function composerRegion(
  state: AppState,
  c: Palette,
  w: number,
  focused: boolean,
  placeholder: string,
): Row[] {
  const rows: Row[] = [];
  const ac = completionBox(state, c, w);
  const chips = imageChipsBox(state, c, w);
  rows.push(...ac, ...chips);
  if (state.conn === "offline")
    rows.push(...noteBox(c, w, "Waiting for the daemon. Messages send when it is back."));
  else if (state.view === "session" && showAsk(state))
    rows.push(...noteBox(c, w, "Answer the request above: y, a or n."));
  else rows.push(...composerBox(state, c, w, { focused, placeholder, joined: ac.length + chips.length > 0 }));
  return rows;
}

function Home(props: AppProps) {
  const s = props.state;
  const c = props.palette;
  const w = () => Math.min(HOME_W, s().cols - 4);
  const tight = () => s().rows < 34;
  const gap = () => (tight() ? 1 : 2);
  const focused = useFocused(s);
  const region = createMemo(() => {
    const st = s();
    if (st.conn === "offline")
      return boxRows(
        w(),
        [
          clip(
            [
              { t: "Waiting for the daemon. Start it with ", fg: c().muted },
              { t: "agency daemon start", fg: c().text },
              { t: ".", fg: c().muted },
            ],
            w() - 4,
          ),
        ],
        c().dim,
      );
    return composerRegion(st, c(), w(), focused(), "What should Agency work on? @ for files, / for commands");
  });
  const hint = createMemo(() => [hintRow(s(), c(), w())]);
  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" paddingBottom={1}>
      <Show when={showLogo(s())}>
        <Rows rows={logoRows(props.tick(), c())} w={44} />
      </Show>
      <box marginTop={showLogo(s()) ? 1 : 0}>
        <Rows
          rows={[wordmarkRow(s(), c(), props.version)]}
          w={segsWidth(wordmarkRow(s(), c(), props.version))}
        />
      </box>
      <box marginTop={gap()}>
        <Rows rows={region()} w={w()} />
      </box>
      <Rows rows={hint()} w={w()} />
      <box marginTop={gap()}>
        <Rows rows={recentRows(s(), c(), w(), props.tick(), props.now())} w={w()} />
      </box>
    </box>
  );
}

function BlockView(props: {
  b: Block;
  index: number;
  state: Accessor<AppState>;
  palette: Accessor<Palette>;
  tick: Accessor<number>;
  now: Accessor<number>;
  w: number;
}) {
  const rows = createMemo((): Row[] => {
    const st = props.state();
    const x: LedgerCtx = {
      c: props.palette(),
      w: props.w,
      tick: props.tick(),
      now: props.now(),
      offline: st.conn === "offline",
    };
    const b = props.b;
    if (b.kind === "event") return eventRows(b, x);
    if (b.kind === "shell") return shellRows(b, x);
    const sess = current(st);
    const last = sess?.blocks.findLast((y) => y.kind === "turn");
    return turnRows(b, x, {
      picked: sess?.pickAt === props.index,
      copied: st.copied,
      canRetry: canRetry(st) && last === b,
    });
  });
  return <Rows rows={rows()} w={props.w} />;
}

function Session(props: AppProps) {
  const s = props.state;
  const c = props.palette;
  const details = () => detailsShown(s());
  const mainW = () =>
    details() ? s().cols - 4 - DETAILS_W - DETAILS_CHROME : Math.min(s().cols - 4, MAX_COLUMN);
  const sess = () => current(s());
  const blocks = createMemo(() => {
    const x = sess();
    return x ? scrolledBlocks(x) : [];
  });
  const focused = useFocused(s);
  const region = createMemo(() =>
    s().review.open
      ? commitBox(s(), c(), mainW())
      : composerRegion(s(), c(), mainW(), focused(), "Message Agency. @ for files, / for commands"),
  );
  const hint = createMemo(() => [hintRow(s(), c(), mainW())]);
  // The rows between the top bar (1), the gap under it (1), the box with its hint row: set by hand, so the transcript clips instead of pushing the box off the screen.
  const transcriptH = () => Math.max(1, s().rows - 2 - region().length - hint().length);
  const ctx = (): LedgerCtx => ({
    c: c(),
    w: mainW(),
    tick: props.tick(),
    now: props.now(),
    offline: s().conn === "offline",
  });
  const tail = createMemo((): Row[] => {
    const x = sess();
    const rows: Row[] = [];
    if (x && x.scroll > 0) rows.push(scrollRow(newerLabel(x), ctx()));
    for (const q of queuedRows(s())) rows.push(queuedRow(q.text, q.note, ctx()));
    return rows;
  });
  const ask = createMemo((): Row[] => {
    const t = runningTurn(sess());
    return showAsk(s()) && t?.approval ? approvalRows(t.approval, ctx()) : [];
  });
  return (
    <box flexGrow={1} minHeight={0} flexDirection="row" paddingTop={1} paddingLeft={2} paddingRight={2}>
      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" alignItems="center">
        <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" width={mainW()}>
          <Show
            when={!s().review.open}
            fallback={
              <box
                height={transcriptH()}
                flexShrink={0}
                flexDirection="column"
                paddingBottom={1}
                overflow="hidden"
              >
                <Rows rows={reviewBody(s(), c(), mainW(), transcriptH() - 1)} w={mainW()} />
              </box>
            }
          >
            <box
              height={transcriptH()}
              flexShrink={0}
              flexDirection="column"
              justifyContent="flex-end"
              overflow="hidden"
              paddingBottom={1}
            >
              <box flexDirection="column" flexShrink={0} gap={1}>
                <Show when={sess()?.loading && blocks().length === 0}>
                  <Rows
                    rows={[
                      [
                        {
                          t: `${SPIN[props.tick() % SPIN.length]} Loading ${sess()?.title ?? ""}`,
                          fg: c().muted,
                        },
                      ],
                    ]}
                    w={mainW()}
                  />
                </Show>
                <Index each={blocks()}>
                  {(b, i) => (
                    <BlockView
                      b={b()}
                      index={i}
                      state={s}
                      palette={c}
                      tick={props.tick}
                      now={props.now}
                      w={mainW()}
                    />
                  )}
                </Index>
                <Show when={tail().length > 0}>
                  <Rows rows={tail()} w={mainW()} />
                </Show>
                <Show when={ask().length > 0}>
                  <Rows rows={ask()} w={mainW()} />
                </Show>
              </box>
            </box>
          </Show>
          <box flexShrink={0} flexDirection="column">
            <Rows rows={region()} w={mainW()} />
            <Rows rows={hint()} w={mainW()} />
          </box>
        </box>
      </box>
      <Show when={details()}>
        <box
          flexShrink={0}
          width={DETAILS_W + 3}
          marginLeft={2}
          paddingLeft={2}
          border={["left"]}
          borderColor={c().line}
          flexDirection="column"
        >
          <Rows rows={detailsRows(s(), c())} w={DETAILS_W} />
        </box>
      </Show>
    </box>
  );
}

function Settings(props: AppProps) {
  const s = props.state;
  const c = props.palette;
  const view = createMemo(() => settingsView(s(), c(), s().cols));
  return (
    <box flexGrow={1} flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
      <box flexGrow={1} flexDirection="column">
        <Rows rows={view().body} w={s().cols - 4} />
      </box>
      <Rows rows={[view().keys]} w={s().cols - 4} />
    </box>
  );
}
