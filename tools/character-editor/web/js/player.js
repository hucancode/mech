// @ts-check
// The animation player: to the start, play/pause, loop, the time and the speed, floating at the
// bottom of the view while animating.
import { btn, h } from "./dom.js";
import { icon } from "./icons.js";
import { editor } from "./editor.js";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

const bar = h("div", { id: "player" });
const timeLabel = h("span", { class: "time" });
/** the play state the bar was built for; it rebuilds when that changes */
let built = /** @type {boolean | null} */ (null);

/** render rebuilds the player (hidden outside the animate tab) */
export function renderPlayer() {
  const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
  if (bar.parentElement !== stage) stage.append(bar);
  bar.hidden = editor.tab !== "animation";
  built = editor.playing;
  const speed = /** @type {HTMLSelectElement} */ (h("select", { title: "Playback speed" }, SPEEDS.map((s) => h("option", { value: String(s) }, `${s}×`))));
  speed.value = String(editor.speed);
  speed.addEventListener("change", () => ((editor.speed = parseFloat(speed.value)), editor.show()));
  updateTime();
  bar.replaceChildren(
    btn(icon("start"), () => editor.seek(0), { kind: "icon", title: "To the start" }),
    btn(icon(editor.playing ? "pause" : "play"), () => editor.togglePlay(), { kind: "primary", title: editor.playing ? "Pause (space)" : "Play (space)" }),
    btn(icon("loop"), () => ((editor.loop = !editor.loop), editor.show(), renderPlayer()), { on: editor.loop, title: editor.loop ? "Looping: click to play once" : "Playing once: click to loop" }),
    timeLabel,
    speed,
  );
}

/** tick follows the clock: the time, and the play button when playing starts or stops */
export function tickPlayer() {
  if (built !== editor.playing) return renderPlayer();
  updateTime();
}

function updateTime() {
  const d = Math.max(editor.clipData?.duration ?? 1, 0.01);
  timeLabel.innerHTML = `${editor.time.toFixed(2)} <span class="muted">/ ${d.toFixed(2)} s</span>`;
}
