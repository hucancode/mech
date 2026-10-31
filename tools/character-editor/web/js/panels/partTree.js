// @ts-check
// The part tree: click to select, drag a part onto another to hang it there, or onto "make
// root". Parts stay listed parents first.
import { btn, h, section } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, depth, mirrorName, mirrorRoot, mirrorSubtree, newPart, partIndex, reparent, subtreeEnd, uniqueName } from "../model.js";
import { openKit } from "../kit.js";

/** @param {string} title */
export function partTree(title) {
  const m = editor.model;
  const parts = m.parts ?? [];
  let dragging = -1;

  /** @param {number} i */
  const pick = (i) =>
    editor.select(() => {
      editor.part = i;
      editor.shape = (parts[i]?.shapes?.length ?? 0) > 0 ? 0 : -1;
      editor.inspect = "part";
    });
  /** @param {boolean} child */
  const add = (child) => {
    const parent = child && editor.part >= 0 ? m.parts[editor.part] : undefined;
    const faces = parent ? editor.faces(parent.name)[0] : undefined;
    editor.edit("model", () => {
      m.parts ??= [];
      const at = parent ? subtreeEnd(m, editor.part) : m.parts.length;
      m.parts.splice(at, 0, newPart(m, parent, faces));
      editor.part = at;
      editor.shape = 0;
      editor.inspect = "part";
    });
  };
  const root = editor.part >= 0 ? mirrorRoot(m, editor.part) : -1;
  const mirror = () => {
    const i = root;
    const other = mirrorName(parts[i].name);
    const there = other ? partIndex(m, other) : -1;
    if (there >= 0 && !confirm(`Replace ${other} and the ${subtreeEnd(m, there) - there - 1} parts under it with a mirror of ${parts[i].name}?`)) return;
    const joints = editor.ask({ q: "joints" });
    if (!joints) return editor.flash(`Could not mirror ${parts[i].name}: the viewer has no model`);
    editor.edit("model", () => {
      editor.part = mirrorSubtree(m, i, joints);
      editor.inspect = "part";
    });
    editor.flash(`Mirrored ${parts[i].name} to ${m.parts[editor.part].name}`);
  };
  const duplicate = () =>
    editor.edit("model", () => {
      const i = editor.part;
      const copy = clone(m.parts[i]);
      copy.name = uniqueName(copy.name, (n) => partIndex(m, n) >= 0);
      const at = subtreeEnd(m, i);
      m.parts.splice(at, 0, copy);
      editor.part = at;
    });
  const remove = () => {
    const i = editor.part;
    const n = subtreeEnd(m, i) - i;
    if (n > 1 && !confirm(`Delete ${parts[i].name} and the ${n - 1} parts under it?`)) return;
    editor.edit("model", () => {
      m.parts.splice(i, n);
      editor.part = Math.min(i, m.parts.length - 1);
      editor.shape = -1;
    });
  };
  /** @param {number} target */
  const drop = (target) => {
    const from = dragging;
    dragging = -1;
    if (from < 0 || from === target) return;
    editor.edit("model", () => (editor.part = reparent(m, from, target)));
  };
  /** @param {HTMLElement} el @param {number} target */
  const droppable = (el, target) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", () => drop(target));
    return el;
  };

  const rootRow = droppable(h("div", { class: "item tag", style: { display: "none", fontStyle: "italic" } }, "drop here to make a root"), -1);
  const rows = parts.map((/** @type {any} */ p, /** @type {number} */ i) => {
    const el = h(
      "div",
      { class: `item ${i === editor.part ? "on" : ""}`, draggable: "true", style: { paddingLeft: `${10 + depth(m, i) * 14}px` }, onclick: () => pick(i) },
      h("span", { class: "name" }, p.name),
      p.joint && h("span", { class: "tag" }, p.joint),
    );
    el.addEventListener("dragstart", () => {
      dragging = i;
      rootRow.style.display = "";
    });
    el.addEventListener("dragend", () => (rootRow.style.display = "none"));
    return droppable(el, i);
  });
  return section(title, h("div", { class: "list" }, rootRow, rows), {
    actions: [
      btn(icon("child"), () => add(true), { kind: "icon", title: "Add a part under the selection" }),
      btn(icon("plus"), () => add(false), { kind: "icon", title: "Add a root part" }),
      btn(icon("mirror"), mirror, {
        kind: "icon",
        title: root >= 0 ? `Mirror ${parts[root].name} and what hangs from it to the other side (replaces ${mirrorName(parts[root].name)})` : "Mirror to the other side: select a part named l_… or r_… (left/right)",
        disabled: root < 0,
      }),
      btn(icon("kit"), () => openKit(), { kind: "icon", title: "Add parts from a kit: any part of any character, with what hangs from it" }),
      btn(icon("copy"), duplicate, { kind: "icon", title: "Duplicate the selected part", disabled: editor.part < 0 }),
      btn(icon("trash"), remove, { kind: "icon", title: "Delete the selected part and what hangs from it", disabled: editor.part < 0 || parts.length <= 1 }),
    ],
  });
}
