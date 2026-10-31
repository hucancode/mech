// @ts-check
// Layout choices, remembered across sessions: whether the dock (the timeline, the pose test)
// also spans under the left panel, the right panel or both, and whether the inspector (the right
// panel) is shown.
import { btn } from "./dom.js";
import { icon } from "./icons.js";

const KEY = "character-editor.layout";
const layout = { left: false, right: false, inspector: true };
try {
  Object.assign(layout, JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem("character-editor.dock") ?? "{}"));
} catch {}

function apply() {
  const b = document.body.dataset;
  b.dock = layout.left && layout.right ? "both" : layout.left ? "left" : layout.right ? "right" : "";
  b.inspector = layout.inspector ? "" : "hidden";
  localStorage.setItem(KEY, JSON.stringify(layout));
  refit();
}

// refit tells the viewer its canvas changed size: mjolnir's web platform refits it on window
// resizes only.
export function refit() {
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
apply();

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
