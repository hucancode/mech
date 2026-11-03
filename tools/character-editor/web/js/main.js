// @ts-check
// The character editor: a model (its parts, and the assembly placing them), its rig and its
// animation, edited in the browser and shown by the game's own code in wasm (see viewer.js). This
// file lays out the page and wires the shortcuts:
//   Cmd/Ctrl-S save    Cmd/Ctrl-Z undo    Shift-Cmd/Ctrl-Z redo    1 2 3 4 tabs
//   Esc back to the character's settings (assemble and rig tabs), out of an arc's edit mode (animate)    I show/hide the inspector
//   W E R T move, rotate, scale a shape, place slots (model tab; see gizmo.js)    click the view to pick
//   space play/pause   Delete remove the arc point picked in the view, else the shape's point (animate tab)   F frame
import { btn, h, segmented, ui } from "./dom.js";
import { icon } from "./icons.js";
import { inspectorButton, refit, toggleInspector } from "./layout.js";
import { editor } from "./editor.js";
import { gizmo, install as installGizmo, removePickedArcPoint, setMode } from "./gizmo.js";
import { install as installViewGizmo } from "./viewGizmo.js";
import { animInspector, animSidebar } from "./panels/animation.js";
import { assembleInspector, assembleSidebar } from "./panels/assemble.js";
import { modelInspector, modelSidebar } from "./panels/model.js";
import { poseTest } from "./panels/poseTest.js";
import { rigInspector, rigSidebar } from "./panels/rig.js";
import { Curves } from "./panels/curves.js";
import { renderPlayer, tickPlayer } from "./player.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const header = $("header");
const sidebar = $("sidebar");
const inspector = $("inspector");
const dock = $("dock");
const status = $("status");
const curves = new Curves();
const TABS = /** @type {const} */ ([
  ["model", "Model"],
  ["assemble", "Assemble"],
  ["rig", "Rig"],
  ["animation", "Animate"],
]);

let pending = false;
// render rebuilds the panels; while a field is in use it waits until the field is let go
function render() {
  if (ui.busy > 0) {
    pending = true;
    return;
  }
  pending = false;
  renderHeader();
  viewportTools();
  renderPlayer();
  const keep = [sidebar.scrollTop, inspector.scrollTop];
  const lists = listScrolls();
  if (editor.tab === "model") {
    sidebar.replaceChildren(...[modelSidebar()].flat());
    inspector.replaceChildren(...[modelInspector()].flat().filter(Boolean));
  } else if (editor.tab === "assemble") {
    sidebar.replaceChildren(...[assembleSidebar()].flat());
    inspector.replaceChildren(...[assembleInspector()].flat().filter(Boolean));
  } else if (editor.tab === "rig") {
    sidebar.replaceChildren(...[rigSidebar()].flat());
    inspector.replaceChildren(...[rigInspector()].flat().filter(Boolean));
  } else {
    sidebar.replaceChildren(...[animSidebar()].flat());
    inspector.replaceChildren(...[animInspector()].flat().filter(Boolean));
  }
  [sidebar.scrollTop, inspector.scrollTop] = keep;
  for (const [key, top] of lists) {
    const el = document.querySelector(`#${key.panel} section[data-section="${CSS.escape(key.section)}"] .list`);
    if (el) el.scrollTop = top;
  }
  renderDock();
}
ui.onIdle = () => pending && render();

// listScrolls is where each list in the panels is scrolled to (the part tree, shapes, clips...),
// by panel and section, to put back after a rebuild.
function listScrolls() {
  /** @type {[{panel: string, section: string}, number][]} */
  const out = [];
  for (const el of document.querySelectorAll("#sidebar section[data-section] .list, #inspector section[data-section] .list")) {
    const section = /** @type {HTMLElement} */ (el.closest("section")).dataset.section ?? "";
    const panel = /** @type {HTMLElement} */ (el.closest("aside")).id;
    if (el.scrollTop > 0) out.push([{ panel, section }, el.scrollTop]);
  }
  return out;
}

let dockTab = "";
function renderDock() {
  if (document.body.dataset.tab !== editor.tab) {
    document.body.dataset.tab = editor.tab;
    refit();
  }
  if (editor.tab === "model" || editor.tab === "assemble") return; // no dock: nothing to pose here
  if (editor.tab === "animation") {
    // the clip's motions as curves
    if (dockTab !== "animation") dock.replaceChildren(...curves.el);
    dockTab = "animation";
    curves.refresh();
  } else {
    // the pose test (rig tab) keeps its sliders' state: rebuild it only when the model changes
    const stamp = `pose:${JSON.stringify([editor.model.iks ?? [], editor.model.assembly ?? []])}:${Object.keys(editor.test).length}`;
    if (dockTab !== stamp) dock.replaceChildren(...poseTest());
    dockTab = stamp;
  }
}

function renderHeader() {
  const group = (/** @type {string} */ label, /** @type {boolean} */ local) => {
    const list = editor.characters.filter((c) => c.local === local);
    return list.length > 0 && h("optgroup", { label }, list.map((c) => h("option", { value: c.name }, c.name)));
  };
  const picker = /** @type {HTMLSelectElement} */ (h("select", { style: { flex: "0 0 auto" }, title: "Open a character" }, group("Saved in this browser", true), group("assets/characters/", false)));
  picker.value = editor.current;
  picker.addEventListener("change", () => editor.open(picker.value).then(() => (picker.value = editor.current)));
  const dirty = [editor.modelDirty && "model", editor.animDirty && "animation"].filter(Boolean).join(" and ");
  header.replaceChildren(
    h("div", { class: "side" }, h("span", { class: "brand", title: "Character editor" }, icon("logo", 20)), picker),
    h(
      "div",
      { class: "tabs" },
      TABS.map(([id, label], i) => h("button", { class: editor.tab === id ? "on" : "", title: `${label} (${i + 1})`, "aria-label": label, onclick: () => editor.setTab(id) }, icon(id), label)),
    ),
    h(
      "div",
      { class: "side end" },
      editor.toast && h("span", { class: "muted" }, editor.toast),
      editor.messages.length > 0 && h("span", { class: "messages badge", title: editor.messages.join("\n") }, icon("warning"), editor.messages.length),
      btn(icon("new"), () => editor.newCharacter(), { kind: "icon", title: "New character" }),
      btn(icon("import"), () => editor.importFile(), { kind: "icon", title: "Import a character file (.json)" }),
      btn(icon("export"), () => editor.exportFile(), { kind: "icon", title: "Export as <name>.json, for assets/characters/" }),
      h("span", { class: "sep" }),
      btn(icon("undo"), () => editor.undo(), { kind: "icon", title: "Undo (Cmd-Z)", disabled: !editor.undoStack.length }),
      btn(icon("redo"), () => editor.redo(), { kind: "icon", title: "Redo (Shift-Cmd-Z)", disabled: !editor.redoStack.length }),
      dirty && h("span", { class: "dirty", title: `Unsaved ${dirty}` }, icon("dot", 12)),
      btn(icon("save"), () => editor.save(), { kind: "primary", title: dirty ? `Save the ${dirty} in this browser (Cmd-S)` : "Saved in this browser", disabled: !editor.dirty }),
    ),
  );
}

editor.on((what) => {
  if (what === "time") {
    tickPlayer();
    return curves.tick();
  }
  if (what === "status") {
    status.textContent = editor.status;
    return renderHeader();
  }
  render();
});

/** @type {Record<string, import("./gizmo.js").Mode>} */
const GIZMO_KEYS = { w: "move", e: "rotate", r: "scale", t: "slot", j: "joint" };
const GIZMO_TOOLS = /** @type {[import("./gizmo.js").Mode, string, string][]} */ ([
  ["move", "move", "Move the shape (W)"],
  ["rotate", "rotate", "Turn the shape (E)"],
  ["scale", "scale", "Size the shape (R)"],
  ["slot", "snap", "Place the part's slots on its shapes' faces (T)"],
  ["joint", "rig", "Try the joints the part hangs by: drag a ring (J)"],
]);

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  const cmd = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (cmd && key === "s") {
    e.preventDefault();
    editor.save();
    return;
  }
  if (typing) return;
  if (cmd && key === "z") {
    e.preventDefault();
    e.shiftKey ? editor.redo() : editor.undo();
  } else if (cmd && key === "y") {
    e.preventDefault();
    editor.redo();
  } else if (!cmd && ["1", "2", "3", "4"].includes(key)) {
    editor.setTab(TABS[Number(key) - 1][0]);
  } else if (key === "escape" && editor.tab === "animation") {
    // out of an arc's edit mode
    if (editor.arc) editor.select(() => ((editor.arc = ""), (editor.handle = ""), editor.inspect === "arc" && (editor.inspect = "character")));
  } else if (key === "escape") {
    editor.select(() => {
      if (editor.tab === "model") (editor.shape = editor.slot = -1), (editor.also = []);
      else editor.part = -1;
      editor.inspect = editor.tab === "model" ? "part" : "character";
    });
  } else if (!cmd && key === "i") {
    toggleInspector();
    viewportTools();
  } else if (!cmd && editor.tab === "model" && GIZMO_KEYS[key]) {
    setMode(GIZMO_KEYS[key]);
    viewportTools();
  } else if (!cmd && key === "f") {
    editor.viewer?.frame();
  } else if (editor.tab === "model" && cmd && key === "a") {
    e.preventDefault();
    editor.selectAllShapes();
  } else if (editor.tab === "model" && cmd && key === "c") {
    editor.copyShapes();
  } else if (editor.tab === "model" && cmd && key === "v") {
    editor.pasteShapes();
  } else if (editor.tab === "animation") {
    if (key === " ") {
      e.preventDefault();
      editor.togglePlay();
    } else if (key === "delete" || key === "backspace") {
      // the arc point picked in the view, else the shape's point
      if (!removePickedArcPoint()) curves.deletePoint();
    }
  }
});

window.addEventListener("beforeunload", (e) => {
  if (editor.dirty) e.preventDefault();
});

status.textContent = editor.status;
// explodeSlider pushes the part's shapes apart (the model tab); it talks to the viewer directly so a drag
// doesn't redraw the panels
function explodeSlider() {
  const range = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: 0, max: 1, step: 0.01, value: editor.explode }));
  range.addEventListener("input", () => {
    editor.explode = parseFloat(range.value);
    editor.viewer?.explode(editor.explode);
  });
  range.addEventListener("dblclick", () => {
    editor.explode = 0;
    range.value = "0";
    editor.viewer?.explode(0);
  });
  return h("label", { class: "explode", title: "Explode the part's shapes apart (double-click to put them back)" }, icon("explode"), range);
}

/** @type {["hidden" | "point" | "label", string, string][]} how IK targets and poles show in the view */
const IK_SHOW = [
  ["hidden", "targetHidden", "Hide IK targets and poles"],
  ["point", "targetPoint", "Show IK targets and poles as points"],
  ["label", "targetLabel", "Show IK targets and poles as points with their names"],
];

function viewportTools() {
  // replaceChildren would print a bare `false` as text, so the tab-dependent tools are filtered
  $("viewport-tools").replaceChildren(
    ...[
    h("div", { style: { display: "contents" } }, editor.tab === "model" && [
      segmented({
        value: gizmo.mode,
        options: GIZMO_TOOLS.map(([mode, ic, title]) => ({ value: mode, label: icon(ic), title })),
        onchange: (mode) => (setMode(mode), viewportTools()),
      }),
      explodeSlider(),
      btn(icon("mirror"), () => (editor.setMirrored(!editor.mirrored), viewportTools()), {
        on: editor.mirrored,
        title: editor.mirrored ? "Back to the part as modelled (the left side)" : "Preview the part mirrored, as the right side shows it (gizmos hide)",
      }),
    ]),
    (editor.tab === "rig" || editor.tab === "animation") &&
      segmented({
        value: editor.ikShow,
        options: IK_SHOW.map(([show, ic, title]) => ({ value: show, label: icon(ic), title })),
        onchange: (show) => {
          editor.ikShow = show;
          localStorage.setItem("ikShow", show);
          // a hidden target can't stay selected
          if (show === "hidden" && editor.handle !== "root") editor.handle = "";
          viewportTools();
        },
      }),
    btn(icon("frame"), () => editor.viewer?.frame(), { title: editor.tab === "model" ? "Frame the part (F)" : "Frame the character (F)" }),
    inspectorButton(viewportTools),
    ].filter(Boolean),
  );
}
viewportTools();
render();
installGizmo();
installViewGizmo();
editor.start();
// for the browser console: editor.viewer.query({q: "info"}) and so on
/** @type {any} */ (window).editor = editor;
