// The editor's shell drawn without a browser: main.js over the small DOM of fakedom.js, with no
// viewer (no WebGPU in Node, so nothing the engine answers). It opens assets' mech, and draws every
// tab with things picked in each, so a panel that throws, or a field that loses what is typed, shows
// here before it shows in the browser. `node --test tools/character-editor/web/js/test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { frames, install } from "./fakedom.js";

const { byId } = install(["header", "sidebar", "inspector", "dock", "stage", "canvas", "status", "viewport-tools"]);
await import("../main.js");
const { editor } = await import("../editor.js");
// editor.start fails without WebGPU: it says so and leaves the editor empty
await new Promise((r) => setTimeout(r, 0));
const mech = JSON.parse(readFileSync(new URL("../../../../../assets/characters/mech.json", import.meta.url), "utf8"));

/** settle lets edits reach the views (they sync on a microtask) and draws the frames that asks for */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  frames();
  await new Promise((r) => setTimeout(r, 0));
}

/** the text the region `id` shows */
const shown = (/** @type {string} */ id) => byId.get(id).textContent;
/** the first element under region `id` that `pred` holds for */
const find = (/** @type {string} */ id, /** @type {(e: any) => boolean} */ pred) => [...byId.get(id).all()].find(pred);

test("without a viewer the editor says why", () => {
  assert.match(editor.status, /WebGPU/);
});

test("every tab draws mech, with things picked in it", () => {
  editor.load("mech", structuredClone(mech.model), structuredClone(mech.animation));
  frames();
  for (const tab of ["model", "assemble", "animation"]) {
    editor.setTab(/** @type {any} */ (tab));
    frames();
    assert.ok(shown("sidebar").length > 0, `${tab}: the sidebar shows something`);
    assert.ok(shown("header").includes("Model"), `${tab}: the header shows the tabs`);
  }
  editor.setTab("model");
  editor.pickPart(1);
  editor.pickShape(0);
  editor.select(() => ((editor.slot = 0), (editor.joint = 0)));
  frames();
  assert.ok(shown("dock").includes("Shapes") && shown("dock").includes("Joints"), "the model dock lists the part");
  assert.ok(shown("inspector").includes("Shape"), "the inspector edits the shape picked");

  editor.setTab("assemble");
  editor.select(() => ((editor.part = 2), (editor.inspect = "part")));
  frames();
  assert.ok(shown("inspector").includes("Instance"));
  editor.select(() => ((editor.ik = 0), (editor.inspect = "ik")));
  frames();
  assert.ok(shown("inspector").includes("IK target"));
  editor.select(() => (editor.inspect = "character"));
  frames();
  assert.ok(shown("inspector").includes("Character"));

  editor.setTab("animation");
  editor.pickClip(2);
  editor.pickMotion(1);
  editor.toggleMove(0);
  frames();
  assert.ok(shown("inspector").includes("Motion"));
  editor.select(() => (editor.arc = mech.animation.arcs[0].name));
  frames();
  assert.ok(shown("inspector").includes(`Arc ${mech.animation.arcs[0].name}`));
});

test("a field keeps what is typed while the panels draw again, and an edit commits it", async () => {
  editor.setTab("animation");
  editor.pickClip(0);
  await settle();
  const name = find("inspector", (e) => e.tagName === "INPUT" && e.value === mech.animation.clips[0].name);
  assert.ok(name, "the clip's name field");
  name.focus();
  name.value = "idle_typed";
  // something else changes meanwhile: the panels draw again
  editor.emit("select");
  await settle();
  assert.equal(find("inspector", (e) => e === name), name, "the same field");
  assert.equal(name.value, "idle_typed", "what is typed is kept");
  name.fire("change");
  name.blur();
  await settle();
  assert.equal(editor.anim.clips[0].name, "idle_typed", "the change commits it");
  editor.undo();
  await settle();
  assert.equal(editor.anim.clips[0].name, mech.animation.clips[0].name, "undo puts it back");
  assert.equal(name.value, mech.animation.clips[0].name, "and the field shows it");
});

test("a section folds and stays folded across draws", async () => {
  editor.setTab("animation");
  await settle();
  const header = find("sidebar", (e) => e.tagName === "BUTTON" && e.textContent.endsWith("Arcs"));
  assert.ok(header);
  header.click();
  editor.emit("select");
  await settle();
  const section = header.parentNode.parentNode;
  assert.equal(section.children.length, 1, "folded: no body");
  header.click();
  await settle();
  assert.equal(section.children.length, 2, "unfolded again");
});
