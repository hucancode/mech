// @ts-check
// The character editor: a model, its rig and its animation, edited in the browser and shown by the
// game's own code in wasm (see viewer.js). This file lays out the page and wires the shortcuts:
//   Cmd/Ctrl-S save    Cmd/Ctrl-Z undo    Shift-Cmd/Ctrl-Z redo    1 2 3 tabs
//   Esc back to the character's settings (model and rig tabs)    H isolate the selected part (model tab)    I show/hide the inspector
//   space play/pause   Delete delete keys  Cmd/Ctrl-C/V/D copy, paste, duplicate keys   F frame
import { btn, h, ui } from "./dom.js";
import { icon } from "./icons.js";
import { inspectorButton, refit, toggleInspector } from "./layout.js";
import { editor } from "./editor.js";
import { animInspector, animSidebar } from "./panels/animation.js";
import { modelInspector, modelSidebar } from "./panels/model.js";
import { poseTest } from "./panels/poseTest.js";
import { rigInspector, rigSidebar } from "./panels/rig.js";
import { Timeline } from "./panels/timeline.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const header = $("header");
const sidebar = $("sidebar");
const inspector = $("inspector");
const dock = $("dock");
const status = $("status");
const timeline = new Timeline();
const TABS = /** @type {const} */ ([
  ["model", "Model"],
  ["rig", "Rig"],
  ["animation", "Animation"],
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
  const keep = [sidebar.scrollTop, inspector.scrollTop];
  const lists = listScrolls();
  if (editor.tab === "model") {
    sidebar.replaceChildren(...[modelSidebar()].flat());
    inspector.replaceChildren(...[modelInspector()].flat().filter(Boolean));
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
  if (editor.tab === "model") return;
  if (editor.tab === "animation") {
    if (dockTab !== "animation") dock.replaceChildren(resizer(), ...timeline.el);
    timeline.refresh();
  } else {
    // the pose test's sliders hold their own state: rebuild them only when the model changes
    const stamp = `${editor.tab}:${JSON.stringify(editor.model.channels ?? [])}:${JSON.stringify(editor.model.drivers ?? [])}:${Object.keys(editor.test).length}`;
    if (dockTab !== stamp) dock.replaceChildren(resizer(), ...poseTest());
    dockTab = stamp;
    return;
  }
  dockTab = "animation";
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

// a handle on the dock's top edge to resize it
function resizer() {
  const el = h("div", { class: "resize" });
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = dock.getBoundingClientRect().height;
    const move = (/** @type {PointerEvent} */ m) => {
      document.body.style.setProperty("--dock", `${Math.max(120, Math.min(window.innerHeight - 200, h0 - (m.clientY - y0)))}px`);
      refit();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", () => el.removeEventListener("pointermove", move), { once: true });
  });
  return el;
}

editor.on((what) => {
  if (what === "time") return timeline.tick();
  if (what === "status") {
    status.textContent = editor.status;
    return renderHeader();
  }
  render();
});

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
  } else if (key === "escape" && editor.tab !== "animation") {
    editor.select(() => {
      editor.part = editor.shape = -1;
      editor.inspect = "character";
    });
  } else if (!cmd && key === "i") {
    toggleInspector();
    viewportTools();
  } else if (!cmd && key === "h" && editor.tab === "model") {
    editor.toggleIsolate();
  } else if (!cmd && key === "f") {
    editor.viewer?.frame();
  } else if (editor.tab === "animation") {
    if (key === " ") {
      e.preventDefault();
      editor.togglePlay();
    } else if (key === "delete" || key === "backspace") {
      timeline.deleteSelected();
    } else if (cmd && key === "c") {
      timeline.copyKeys();
    } else if (cmd && key === "v") {
      timeline.pasteKeys();
    } else if (cmd && key === "d") {
      e.preventDefault();
      timeline.duplicateSelected();
    }
  }
});

window.addEventListener("beforeunload", (e) => {
  if (editor.dirty) e.preventDefault();
});

status.textContent = editor.status;
// explodeSlider pushes the isolated part's shapes apart; it talks to the viewer directly so a drag
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

function viewportTools() {
  $("viewport-tools").replaceChildren(
    h("div", { style: { display: "contents" } }, editor.tab === "model" && [
      editor.isolate && explodeSlider(),
      btn(icon("isolate"), () => editor.toggleIsolate(), {
        on: editor.isolate,
        title: editor.isolate ? "Show the whole character (H)" : "Show only the selected part (H)",
      }),
    ]),
    btn(icon("frame"), () => editor.viewer?.frame(), { title: "Frame the character (F)" }),
    inspectorButton(viewportTools),
  );
}
viewportTools();
render();
editor.start();
// for the browser console: editor.viewer.query({q: "info"}) and so on
/** @type {any} */ (window).editor = editor;
