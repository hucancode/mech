// @ts-check
// The assembly tree: click to select, drag an instance onto another to hang it there, or onto
// "make root"; the caret folds a subtree (alt-click: everything under it too). Instances stay
// listed parents first.
import { btn, CARET, h, section } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { apply, fromQuat, transpose } from "../math3.js";
import { clone, instanceIndex, mirrorName, mirrorRoot, mirrorSubtree, newInstance, partOf, reparent, subtreeEnd, treeOrder, uniqueName } from "../model.js";
import { openKit } from "../kit.js";

/** names of the folded parts; kept across redraws, not saved */
const folded = new Set();
/** the part last revealed: selecting a part unfolds its ancestors once, so they can fold again */
let revealed = -1;

/** @param {string} title */
export function partTree(title) {
  const m = editor.model;
  const parts = m.assembly ?? [];
  let dragging = -1;

  /** @param {number} i */
  const pick = (i) =>
    editor.select(() => {
      editor.part = i;
      editor.inspect = "part";
    });
  /** @param {boolean} child */
  const add = (child) => {
    const parent = child ? editor.part : -1;
    const on = partOf(m, parent);
    const faces = on ? editor.faces(on.name)[0] : undefined;
    editor.edit("model", () => {
      editor.part = newInstance(m, parent, faces);
      editor.inspect = "part";
    });
  };
  const root = editor.part >= 0 ? mirrorRoot(m, editor.part) : -1;
  const mirror = () => {
    const i = root;
    const other = mirrorName(parts[i].name);
    const there = other ? instanceIndex(m, other) : -1;
    if (there >= 0 && !confirm(`Replace ${other} and the ${subtreeEnd(m, there) - there - 1} instances under it with a mirror of ${parts[i].name}?`)) return;
    // the model's x in the parent's frame at rest: the plane the other side's slot is reflected across
    const parent = parts[instanceIndex(m, parts[i].parent)]?.name;
    const rest = parent ? editor.ask({ q: "parts", rest: true, parts: [parent] })?.[parent] : undefined;
    if (parent && !rest) return editor.flash(`Could not mirror ${parts[i].name}: the viewer has no model`);
    const lateral = rest ? apply(transpose(fromQuat(rest.rotation)), [1, 0, 0]) : [1, 0, 0];
    editor.edit("model", () => {
      editor.part = mirrorSubtree(m, i, lateral);
      editor.inspect = "part";
    });
    editor.flash(`Mirrored ${parts[i].name} to ${m.assembly[editor.part].name}`);
  };
  const duplicate = () =>
    editor.edit("model", () => {
      const i = editor.part;
      const copy = clone(m.assembly[i]);
      copy.name = uniqueName(copy.name, (n) => instanceIndex(m, n) >= 0);
      const at = subtreeEnd(m, i);
      m.assembly.splice(at, 0, copy);
      editor.part = at;
    });
  const remove = () => {
    const i = editor.part;
    const n = subtreeEnd(m, i) - i;
    if (n > 1 && !confirm(`Delete ${parts[i].name} and the ${n - 1} instances under it?`)) return;
    editor.edit("model", () => {
      m.assembly.splice(i, n);
      editor.part = Math.min(i, m.assembly.length - 1);
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
  if (editor.part !== revealed) {
    revealed = editor.part;
    for (let p = instanceIndex(m, parts[editor.part]?.parent), n = 0; p >= 0 && n < 64; p = instanceIndex(m, parts[p].parent), n++) folded.delete(parts[p].name);
  }
  const order = treeOrder(m);
  /** how many parts hang below the row at k in `order` @param {number} k */
  const below = (k) => {
    let n = 0;
    while (order[k + 1 + n] && order[k + 1 + n].depth > order[k].depth) n++;
    return n;
  };
  /** @param {number} k @param {boolean} all */
  const fold = (k, all) =>
    editor.select(() => {
      const shut = !folded.has(parts[order[k].i].name);
      for (let j = k; j <= k + (all ? below(k) : 0); j++) {
        if (below(j) === 0) continue;
        if (shut) folded.add(parts[order[j].i].name);
        else folded.delete(parts[order[j].i].name);
      }
    });
  /** @type {HTMLElement[]} */
  const rows = [];
  for (let k = 0; k < order.length; k++) {
    const row = k; // k skips folded rows below; the caret must keep its own row
    const { i, depth } = order[k];
    const p = parts[i];
    const n = below(k);
    const shut = n > 0 && folded.has(p.name);
    const caret =
      n > 0
        ? h("span", { class: `caret ${shut ? "" : "open"}`, title: shut ? "Unfold (alt: everything under it)" : "Fold (alt: everything under it)", onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), fold(row, e.altKey)) }, CARET)
        : h("span", { class: "caret" });
    const el = h(
      "div",
      { class: `item tree ${i === editor.part ? "on" : ""}`, draggable: "true", onclick: () => pick(i) },
      Array.from({ length: depth }, () => h("span", { class: "guide" })),
      caret,
      h("span", { class: "name" }, p.name),
      shut && h("span", { class: "tag" }, `+${n}`),
    );
    if (shut) k += n;
    el.addEventListener("dragstart", () => {
      dragging = i;
      rootRow.style.display = "";
    });
    el.addEventListener("dragend", () => (rootRow.style.display = "none"));
    rows.push(droppable(el, i));
  }
  return section(title, h("div", { class: "list" }, rootRow, rows), {
    actions: [
      btn(icon("child"), () => add(true), { kind: "icon", title: "Add a new part under the selection, matched with its part's first free slot", disabled: editor.part < 0 }),
      btn(icon("plus"), () => add(false), { kind: "icon", title: "Add a new part as a root" }),
      btn(icon("mirror"), mirror, {
        kind: "icon",
        title: root >= 0 ? `Mirror ${parts[root].name} and what hangs from it to the other side: the same parts, mirrored (replaces ${mirrorName(parts[root].name)})` : "Mirror to the other side: select an instance named l_… or r_… (left/right)",
        disabled: root < 0,
      }),
      btn(icon("kit"), () => openKit(), { kind: "icon", title: "Add from a kit: any instance of any character, with what hangs from it and the parts they place" }),
      btn(icon("copy"), duplicate, { kind: "icon", title: "Duplicate the selected instance (not what hangs from it)", disabled: editor.part < 0 }),
      btn(icon("trash"), remove, { kind: "icon", title: "Delete the selected instance and what hangs from it (the parts stay in the library)", disabled: editor.part < 0 || parts.length <= 1 }),
    ],
  });
}
