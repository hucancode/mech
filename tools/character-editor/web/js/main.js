// @ts-check
// The character editor: a model (its parts, and the assembly placing them), its rig and its
// animation, edited in the browser and shown by the game's own code in wasm (see viewer.js). This
// file lays out the page and wires the shortcuts:
//   Cmd/Ctrl-S save    Cmd/Ctrl-Z undo    Shift-Cmd/Ctrl-Z redo    1 2 3 tabs
//   Esc back to the character's settings (assemble tab), out of an arc's edit mode (animate)    I show/hide the inspector
//   W E R T move, rotate, scale a shape, place slots (model tab; see gizmo.js)    click the view to pick
//   space play/pause   Delete remove the arc point picked in the view, else the shape's point (animate tab)   F frame
import { btn, h, segmented } from "./dom.js";
import { render as draw } from "./ui/vdom.js";
import { effect, frame } from "./ui/signal.js";
import { icon } from "./icons.js";
import { inspectorButton, refit, toggleInspector } from "./layout.js";
import { editor } from "./editor.js";
import { gizmo, install as installGizmo, removePickedArcPoint, setMode } from "./gizmo.js";
import { install as installViewGizmo } from "./viewGizmo.js";
import { animInspector, animSidebar } from "./panels/animation.js";
import { assembleInspector, assembleSidebar } from "./panels/assemble.js";
import { modelDock, modelInspector, modelSidebar } from "./panels/model.js";
import { poseTest } from "./panels/poseTest.js";
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
  ["animation", "Animate"],
]);

/** redraw draws the panels again (on the next frame): for what changes no data (a tool, a layout toggle) */
const redraw = () => editor.emit("select");

// render draws every panel from the data; the renderer keeps what is shown where it can (a field
// being typed in, a list's scroll), so it can run whenever anything changed
function render() {
  status.textContent = editor.status;
  draw(headerView(), header);
  draw(viewportTools(), $("viewport-tools"));
  renderPlayer();
  if (editor.tab === "model") {
    draw(modelSidebar(), sidebar);
    draw(modelInspector(), inspector);
  } else if (editor.tab === "assemble") {
    draw(assembleSidebar(), sidebar);
    draw(assembleInspector(), inspector);
  } else {
    draw(animSidebar(), sidebar);
    draw(animInspector(), inspector);
  }
  renderDock();
}

function renderDock() {
  if (document.body.dataset.tab !== editor.tab) {
    document.body.dataset.tab = editor.tab;
    refit();
  }
  if (editor.tab === "model") draw(modelDock(), dock); // the part's shapes, slots and joints
  else if (editor.tab === "animation") {
    // the clip's motions as curves: the curve editor's own canvas and bar
    draw(curves.el, dock);
    curves.refresh();
  } else draw(poseTest(), dock);
}

/** whether the issues list is open (the header's issues button) */
let issuesOpen = false;

/**
 * issuesButton: how many things are wrong with the character (mech.character_check, ERROR and
 * BUDGET), and what the engine logged; open, the list, each issue going to where it is.
 */
function issuesButton() {
  const issues = editor.issues();
  const errors = issues.filter((x) => x.severity === "ERROR");
  const budget = issues.filter((x) => x.severity === "BUDGET");
  const logged = editor.messages;
  if (!issues.length && !logged.length) return null;
  const count = (/** @type {string} */ cls, /** @type {number} */ n) => n > 0 && h("span", { class: cls }, n);
  const group = (/** @type {string} */ title, /** @type {typeof issues} */ list, /** @type {string} */ cls) =>
    list.length > 0 && [
      h("div", { class: "issues-group" }, title),
      list.map((x) =>
        h(
          "button",
          { class: `item ${cls}`, title: "Go there", onclick: () => ((issuesOpen = false), editor.goto(x.at)) },
          h("span", { class: "name" }, x.text),
        ),
      ),
    ];
  return h(
    "span",
    { class: "issues-anchor" },
    h(
      "button",
      {
        class: `btn issues-button ${issuesOpen ? "on" : ""}`,
        title: `${errors.length} errors, ${budget.length} budget issues${logged.length ? `, ${logged.length} logged` : ""}: click to list them`,
        onclick: () => ((issuesOpen = !issuesOpen), redraw()),
      },
      icon("warning"),
      count("error", errors.length),
      count("warn", budget.length),
      logged.length > 0 && h("span", { class: "muted" }, logged.length),
    ),
    issuesOpen &&
      h(
        "div",
        { class: "issues" },
        group("Errors: the engine skips these", errors, "error"),
        group("Budget: fighting the machine", budget, "warn"),
        logged.length > 0 && [
          h("div", { class: "issues-group" }, "Logged", h("span", { class: "grow" }), btn("clear", () => ((editor.messages = []), redraw()), { kind: "icon", title: "Clear the log" })),
          logged.map((x) => h("div", { class: "item muted" }, h("span", { class: "name" }, x))),
        ],
      ),
  );
}

function headerView() {
  const group = (/** @type {string} */ label, /** @type {boolean} */ local) => {
    const list = editor.characters.filter((c) => c.local === local);
    return list.length > 0 && h("optgroup", { label }, list.map((c) => h("option", { value: c.name }, c.name)));
  };
  const dirty = [editor.modelDirty && "model", editor.animDirty && "animation"].filter(Boolean).join(" and ");
  return [
    h(
      "div",
      { class: "side" },
      h("span", { class: "brand", title: "Character editor" }, icon("logo", 20)),
      h(
        "select",
        {
          style: { flex: "0 0 auto" },
          title: "Open a character",
          value: editor.current,
          onchange: (/** @type {Event} */ e) => {
            const picker = /** @type {HTMLSelectElement} */ (e.currentTarget);
            editor.open(picker.value).then(() => ((picker.value = editor.current), redraw()));
          },
        },
        group("Saved in this browser", true),
        group("assets/characters/", false),
      ),
    ),
    h(
      "div",
      { class: "tabs" },
      TABS.map(([id, label], i) => h("button", { class: editor.tab === id ? "on" : "", title: `${label} (${i + 1})`, "aria-label": label, onclick: () => editor.setTab(id) }, icon(id), label)),
    ),
    h(
      "div",
      { class: "side end" },
      editor.toast && h("span", { class: "muted" }, editor.toast),
      issuesButton(),
      btn(icon("new"), () => editor.newCharacter(), { kind: "icon", title: "New character" }),
      btn(icon("import"), () => editor.importFile(), { kind: "icon", title: "Import a character file (.json)" }),
      btn(icon("export"), () => editor.exportFile(), { kind: "icon", title: "Export as <name>.json, for assets/characters/" }),
      h("span", { class: "sep" }),
      btn(icon("undo"), () => editor.undo(), { kind: "icon", title: "Undo (Cmd-Z)", disabled: !editor.undoStack.length }),
      btn(icon("redo"), () => editor.redo(), { kind: "icon", title: "Redo (Shift-Cmd-Z)", disabled: !editor.redoStack.length }),
      dirty && h("span", { class: "dirty", title: `Unsaved ${dirty}` }, icon("dot", 12)),
      btn(icon("save"), () => editor.save(), { kind: "primary", title: dirty ? `Save the ${dirty} in this browser (Cmd-S)` : "Saved in this browser", disabled: !editor.dirty }),
    ),
  ];
}

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
  } else if (!cmd && ["1", "2", "3"].includes(key)) {
    editor.setTab(TABS[Number(key) - 1][0]);
  } else if (key === "escape" && editor.tab === "animation") {
    // out of an arc's edit mode
    if (editor.arc) editor.select(() => ((editor.arc = ""), (editor.handle = ""), editor.inspect === "arc" && (editor.inspect = "character")));
  } else if (key === "escape") {
    editor.select(() => {
      if (editor.tab === "model") (editor.shape = editor.slot = editor.joint = -1), (editor.also = []);
      else editor.part = -1;
      editor.inspect = editor.tab === "model" ? "part" : "character";
    });
  } else if (!cmd && key === "i") {
    toggleInspector();
    redraw();
  } else if (!cmd && editor.tab === "model" && GIZMO_KEYS[key]) {
    setMode(GIZMO_KEYS[key]);
    redraw();
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

// explodeSlider pushes the part's shapes apart (the model tab); it talks to the viewer directly so a drag
// doesn't redraw the panels
function explodeSlider() {
  return h(
    "label",
    { class: "explode", title: "Explode the part's shapes apart (double-click to put them back)" },
    icon("explode"),
    h("input", {
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      value: editor.explode,
      oninput: (/** @type {Event} */ e) => {
        editor.explode = parseFloat(/** @type {HTMLInputElement} */ (e.currentTarget).value);
        editor.viewer?.explode(editor.explode);
      },
      ondblclick: (/** @type {Event} */ e) => {
        editor.explode = 0;
        /** @type {HTMLInputElement} */ (e.currentTarget).value = "0";
        editor.viewer?.explode(0);
      },
    }),
  );
}

/** @type {["hidden" | "point" | "label", string, string][]} how IK targets and poles show in the view */
const IK_SHOW = [
  ["hidden", "targetHidden", "Hide IK targets and poles"],
  ["point", "targetPoint", "Show IK targets and poles as points"],
  ["label", "targetLabel", "Show IK targets and poles as points with their names"],
];

function viewportTools() {
  return [
    editor.tab === "model" && [
      segmented({
        value: gizmo.mode,
        options: GIZMO_TOOLS.map(([mode, ic, title]) => ({ value: mode, label: icon(ic), title })),
        onchange: (mode) => (setMode(mode), redraw()),
      }),
      explodeSlider(),
    ],
    (editor.tab === "assemble" || editor.tab === "animation") &&
      segmented({
        value: editor.ikShow,
        options: IK_SHOW.map(([show, ic, title]) => ({ value: show, label: icon(ic), title })),
        onchange: (show) => {
          editor.ikShow = show;
          localStorage.setItem("ikShow", show);
          // a hidden target can't stay selected
          if (show === "hidden" && editor.handle !== "root") editor.handle = "";
          redraw();
        },
      }),
    btn(icon("grid"), () => (editor.setGrid(!editor.grid), redraw()), {
      on: editor.grid,
      title: `${editor.grid ? "Hide" : "Show"} the grid: flat through ${editor.tab === "model" ? "the part's origin" : "the model's origin, on the floor"}, its x (red), y (green) and z (blue) axes through it`,
    }),
    btn(icon("frame"), () => editor.viewer?.frame(), { title: editor.tab === "model" ? "Frame the part (F)" : "Frame the character (F)" }),
    inspectorButton(redraw),
  ];
}
// the panels follow the data, the selection and the status, once a frame however often they change
// (after everything above is defined: an effect runs once at once)
effect(() => {
  editor.rev.value;
  render();
}, frame);
// the player and the curves follow the playhead
effect(() => {
  editor.clock.value;
  tickPlayer();
  curves.tick();
});
installGizmo();
installViewGizmo();
editor.start();
// for the browser console: editor.viewer.query({q: "info"}) and so on
/** @type {any} */ (window).editor = editor;
