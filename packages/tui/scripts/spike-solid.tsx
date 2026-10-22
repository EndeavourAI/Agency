/** Solid variant of the M0 spike: proves JSX plus the Bun plugin survive `bun build --compile`. */
import { render } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";

function App() {
  const [n, setN] = createSignal(0);
  const t = setInterval(() => setN((x) => x + 1), 10);
  onCleanup(() => clearInterval(t));
  return (
    <box flexDirection="column" width="100%" height="100%">
      <text fg="#e0b46c"> agency solid spike</text>
      <text>{`tokens ${n()}`}</text>
      <box height={3} border borderColor="#6a6760">
        <text>&gt; solid ok</text>
      </box>
    </box>
  );
}

await render(() => <App />, { exitOnCtrlC: true, screenMode: "alternate-screen" });
