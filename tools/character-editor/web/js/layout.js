// @ts-check
// Layout choices, remembered across sessions: whether the dock (the timeline, the pose test)
// also spans under the left panel, the right panel or both, whether the inspector (the right
// panel) is shown, and the panels' sizes, set by dragging their inner edges.
import { btn, h } from "./dom.js";
import { icon } from "./icons.js";

const KEY = "character-editor.layout";
/** panel sizes in CSS pixels: the side panels' widths, the dock's height */
const SIZES = { sidebar: 280, inspector: 340, dock: 260 };
const layout = { left: false, right: false, inspector: true, sizes: { ...SIZES } };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem("character-editor.dock") ?? "{}");
  Object.assign(layout, saved, { sizes: { ...SIZES, ...saved.sizes } });
} catch {}

function apply() {
  const b = document.body.dataset;
  b.dock = layout.left && layout.right ? "both" : layout.left ? "left" : layout.right ? "right" : "";
  b.inspector = layout.inspector ? "" : "hidden";
  for (const [k, v] of Object.entries(layout.sizes)) document.body.style.setProperty(`--${k}`, `${v}px`);
  localStorage.setItem(KEY, JSON.stringify(layout));
  refit();
}

/** @typedef {keyof typeof SIZES} Panel */

// the least each panel and the 3D view keep, in CSS pixels
const MIN = { sidebar: 180, inspector: 240, dock: 120 };
const STAGE_W = 360;
const STAGE_H = 200;
const HEADER = 44;

/** a panel's size, kept so the 3D view keeps STAGE_W by STAGE_H beside the other panels @param {Panel} panel @param {number} v */
function clampSize(panel, v) {
  const s = layout.sizes;
  const other = panel === "sidebar" ? (layout.inspector ? s.inspector : 0) : s.sidebar;
  const room = panel === "dock" ? window.innerHeight - HEADER - STAGE_H : window.innerWidth - other - STAGE_W;
  return Math.round(Math.max(MIN[panel], Math.min(room, v)));
}

/**
 * grip is the handle on a panel's inner edge: drag it to resize the panel, double-click it for the
 * default size. It is a grid item of its own over the panel's edge, so redrawing the panel keeps it.
 * @param {Panel} panel
 */
function grip(panel) {
  const el = h("div", { class: "grip", "data-panel": panel, title: "Drag to resize; double-click to reset" });
  const vertical = panel === "dock";
  // dragging toward the stage grows the sidebar and shrinks the inspector and the dock
  const sign = panel === "sidebar" ? 1 : -1;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const at0 = vertical ? e.clientY : e.clientX;
    const size0 = layout.sizes[panel];
    document.body.dataset.resizing = vertical ? "y" : "x";
    const move = (/** @type {PointerEvent} */ m) => {
      layout.sizes[panel] = clampSize(panel, size0 + sign * ((vertical ? m.clientY : m.clientX) - at0));
      document.body.style.setProperty(`--${panel}`, `${layout.sizes[panel]}px`);
      refit();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      delete document.body.dataset.resizing;
      apply();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  });
  el.addEventListener("dblclick", () => ((layout.sizes[panel] = SIZES[panel]), apply()));
  return el;
}

// refit tells the viewer its canvas changed size: mjolnir's web platform refits it on window
// resizes only.
export function refit() {
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
document.body.append(grip("sidebar"), grip("inspector"), grip("dock"));
apply();
// a smaller window keeps every panel inside it
window.addEventListener("resize", () => {
  for (const k of /** @type {Panel[]} */ (Object.keys(SIZES))) document.body.style.setProperty(`--${k}`, `${clampSize(k, layout.sizes[k])}px`);
});

/** The two dock span toggles for a dock bar; `onchange` redraws the bar. @param {() => void} onchange */
export function dockSpanButtons(onchange) {
  /** @param {"left" | "right"} side */
  const toggle = (side) => {
    layout[side] = !layout[side];
    apply();
    onchange();
  };
  return [
    btn(icon("expandLeft"), () => toggle("left"), { kind: "icon", on: layout.left, title: layout.left ? "Stop spanning under the left panel" : "Span under the left panel" }),
    btn(icon("expandRight"), () => toggle("right"), { kind: "icon", on: layout.right, title: layout.right ? "Stop spanning under the right panel" : "Span under the right panel" }),
  ];
}

export function toggleInspector() {
  layout.inspector = !layout.inspector;
  apply();
}

/** The inspector toggle; `onchange` redraws the button. @param {() => void} onchange */
export function inspectorButton(onchange) {
  return btn(icon("panelRight"), () => (toggleInspector(), onchange()), { on: layout.inspector, title: layout.inspector ? "Hide the inspector (I)" : "Show the inspector (I)" });
}
