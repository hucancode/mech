// @ts-check
// The assembly tree: click to select, drag an instance onto another to hang it there, or onto
// "make root"; the caret folds a subtree (alt-click: everything under it too). Instances stay
// listed parents first.
import { btn, CARET, h, section } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, instanceIndex, newInstance, partOf, placedNames, reparent, subtreeEnd, treeOrder, uniqueName } from "../model.js";
import { openKit } from "../kit.js";

/** names of the folded parts; kept across redraws, not saved */
const folded = new Set();
/** the part last revealed: selecting a part unfolds its ancestors once, so they can fold again */
let revealed = -1;
/** the instance being dragged onto another, -1 for none */
let dragging = -1;

/** @param {string} title */
export function partTree(title) {
  const m = editor.model;
  const parts = m.assembly ?? [];

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
  /** the props that make a row a drop target for instance `target` (-1: make a root) @param {number} target */
  const droppable = (target) => ({
    ondragover: (/** @type {DragEvent} */ e) => {
      e.preventDefault();
      /** @type {HTMLElement} */ (e.currentTarget).classList.add("over");
    },
    ondragleave: (/** @type {DragEvent} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.remove("over"),
    ondrop: (/** @type {DragEvent} */ e) => {
      /** @type {HTMLElement} */ (e.currentTarget).classList.remove("over");
      drop(target);
    },
  });

  // shown while an instance is dragged (drawn on the next frame, not during the drag's start)
  const rootRow = dragging >= 0 && h("div", { class: "item tag", key: "(root)", style: { fontStyle: "italic" }, ...droppable(-1) }, "drop here to make a root");
  if (editor.part !== revealed) {
    revealed = editor.part;
    for (let p = instanceIndex(m, parts[editor.part]?.parent), n = 0; p >= 0 && n < 64; p = instanceIndex(m, parts[p].parent), n++) folded.delete(parts[p].name);
  }
  const order = treeOrder(m);
  // the instances hung from a mirrored slot (or from one that is): placed on both sides
  const places = editor.places();
  /** both sides' names, when instance i is placed on each side of the body @param {number} i */
  const sides = (i) => {
    const names = placedNames(places, m, i);
    return names.length > 1 ? names.join(", ") : "";
  };
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
      {
        class: `item tree ${i === editor.part ? "on" : ""}`,
        key: p.name,
        draggable: "true",
        onclick: () => pick(i),
        ondragstart: () => ((dragging = i), editor.emit("select")),
        ondragend: () => ((dragging = -1), editor.emit("select")),
        ...droppable(i),
      },
      Array.from({ length: depth }, () => h("span", { class: "guide" })),
      caret,
      h("span", { class: "name" }, p.name),
      sides(i) && h("span", { class: "tag", title: `on both sides of the body: ${sides(i)}` }, "l · r"),
      shut && h("span", { class: "tag" }, `+${n}`),
    );
    if (shut) k += n;
    rows.push(el);
  }
  return section(title, h("div", { class: "list" }, rootRow, rows), {
    actions: [
      btn(icon("child"), () => add(true), { kind: "icon", title: "Add a new part under the selection, matched with its part's first free slot", disabled: editor.part < 0 }),
      btn(icon("plus"), () => add(false), { kind: "icon", title: "Add a new part as a root" }),
      btn(icon("kit"), () => openKit(), { kind: "icon", title: "Add from a kit: any instance of any character, with what hangs from it and the parts they place" }),
      btn(icon("copy"), duplicate, { kind: "icon", title: "Duplicate the selected instance (not what hangs from it)", disabled: editor.part < 0 }),
      btn(icon("trash"), remove, { kind: "icon", title: "Delete the selected instance and what hangs from it (the parts stay in the library)", disabled: editor.part < 0 || parts.length <= 1 }),
    ],
  });
}
