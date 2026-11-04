// @ts-check
// The animation player: to the start, play/pause, loop, the time and the speed, floating at the
// bottom of the view while animating. It is drawn with the panels and again on every tick of the
// clock (the renderer changes only the time, and the play button when playing starts or stops).
import { btn, el, h } from "./dom.js";
import { render } from "./ui/vdom.js";
import { icon } from "./icons.js";
import { editor } from "./editor.js";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

const bar = el("div", { id: "player" });

/** renderPlayer draws the player (hidden outside the animate tab) */
export function renderPlayer() {
  const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
  if (bar.parentElement !== stage) stage.append(bar);
  bar.hidden = editor.tab !== "animation";
  if (bar.hidden) return;
  const d = Math.max(editor.clipData?.duration ?? 1, 0.01);
  render(
    [
      btn(icon("start"), () => editor.seek(0), { kind: "icon", title: "To the start" }),
      btn(icon(editor.playing ? "pause" : "play"), () => editor.togglePlay(), { kind: "primary", title: editor.playing ? "Pause (space)" : "Play (space)" }),
      btn(icon("loop"), () => ((editor.loop = !editor.loop), editor.show(), renderPlayer()), { on: editor.loop, title: editor.loop ? "Looping: click to play once" : "Playing once: click to loop" }),
      h("span", { class: "time" }, editor.time.toFixed(2), " ", h("span", { class: "muted" }, `/ ${d.toFixed(2)} s`)),
      h(
        "select",
        { title: "Playback speed", value: String(editor.speed), onchange: (/** @type {Event} */ e) => ((editor.speed = parseFloat(/** @type {HTMLSelectElement} */ (e.currentTarget).value)), editor.show()) },
        SPEEDS.map((s) => h("option", { value: String(s) }, `${s}×`)),
      ),
    ],
    bar,
  );
}

/** tickPlayer follows the clock */
export const tickPlayer = renderPlayer;
