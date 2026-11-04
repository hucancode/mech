// @ts-check
// Kits: any instance of any character, with what hangs from it, copied into the open one. They
// bring the parts they place, with the joints and materials those use, and the IK targets on them; all can be scaled on the way in.
// The copy is matched with the selected instance's slot of the same name, else its first free
// slot, else its origin.
import { readFile } from "./api.js";
import { btn, h, num, row } from "./dom.js";
import { editor } from "./editor.js";
import { addIk, clone, freeSlot, instanceIndex, partOf, scalePart, subtreeEnd, treeOrder, uniqueName } from "./model.js";
import { loadLocal } from "./store.js";

/** the same data but for its name @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify({ ...a, name: "" }) === JSON.stringify({ ...b, name: "" });

/**
 * insertKit copies instance i of model `src` and everything under it into model m, under instance
 * `parent` (-1 for a root), scaled by `scale`. A part the same as one of ours (joints and all) is shared,
 * else copied (renamed on a clash). Returns the copy's index.
 * @param {any} m @param {any} src @param {number} i @param {number} parent @param {number} scale
 */
export function insertKit(m, src, i, parent, scale = 1) {
  const block = clone(src.assembly.slice(i, subtreeEnd(src, i)));
  const root = block[0];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const p of block) names.set(p.name, uniqueName(p.name, (x) => instanceIndex(m, x) >= 0 || [...names.values()].includes(x)));

  /**
   * bring shares or copies a part
   * @param {"parts"} key @param {string} name @param {(x: any) => void} adapt
   */
  const bring = (key, name, adapt) => {
    m[key] ??= [];
    const x = clone((src[key] ?? []).find((/** @type {any} */ y) => y.name === name) ?? { name });
    adapt(x);
    const ours = m[key].find((/** @type {any} */ y) => same(y, x));
    if (ours) return ours.name;
    x.name = uniqueName(x.name, (n) => m[key].some((/** @type {any} */ y) => y.name === n));
    m[key].push(x);
    return x.name;
  };
  /** @param {string} key @param {string | undefined} name */
  const named = (key, name) => {
    m[key] ??= [];
    if (!name || m[key].some((/** @type {any} */ x) => x.name === name)) return;
    m[key].push(clone((src[key] ?? []).find((/** @type {any} */ x) => x.name === name) ?? { name }));
  };
  /** @type {Map<string, string>} */
  const parts = new Map();
  for (const p of block) {
    p.name = names.get(p.name);
    if (p !== root) p.parent = names.get(p.parent) ?? p.parent;
    if (p.part && !parts.has(p.part))
      parts.set(
        p.part,
        bring("parts", p.part, (part) => {
          if (scale !== 1) scalePart(part, scale, true);
          for (const s of part.shapes ?? []) named("materials", s.material);
        }),
      );
    if (p.part) p.part = parts.get(p.part);
  }
  for (const ik of src.iks ?? []) {
    if (!names.has(ik.tip)) continue;
    const k = addIk(m, ik.name, /** @type {string} */ (names.get(ik.tip)));
    if (ik.aim) m.iks[k].aim = true;
  }

  m.assembly ??= [];
  const host = m.assembly[parent];
  if (host) {
    root.parent = host.name;
    const slot = partOf(m, parent)?.slots?.some((/** @type {any} */ x) => x.name === root.parent_slot) ? root.parent_slot : freeSlot(m, parent);
    if (slot) root.parent_slot = slot;
    else delete root.parent_slot;
  } else {
    delete root.parent;
    delete root.parent_slot;
  }
  const at = host ? subtreeEnd(m, parent) : m.assembly.length;
  m.assembly.splice(at, 0, ...block);
  return at;
}

/** the models of every character the editor knows, the open one as it is now @returns {Promise<{name: string, model: any}[]>} */
async function sources() {
  const out = [{ name: editor.current, model: editor.model }];
  for (const c of editor.characters) {
    if (c.name === editor.current) continue;
    try {
      const text = c.local ? loadLocal(c.name) : c.files ? await readFile(c.files.file) : null;
      if (!text) continue;
      const data = JSON.parse(text);
      const model = data.model;
      if (model?.assembly?.length) out.push({ name: c.name, model });
    } catch (e) {
      console.warn("kit", c.name, e);
    }
  }
  return out;
}

/** @type {HTMLDialogElement | null} */
let open = null;

/** openKit shows the kit picker; the pick goes under the selected instance (or in as a root). */
export async function openKit() {
  open?.close();
  const list = await sources();
  /** @type {{src: any, i: number} | null} */
  let picked = null;
  let scale = 1;
  let filter = "";
  const host = editor.part >= 0 ? editor.model.assembly?.[editor.part] : undefined;
  const dialog = /** @type {HTMLDialogElement} */ (h("dialog", { class: "kit" }));
  const body = h("div", { class: "kit-list" });
  const insert = btn(host ? `Add under ${host.name}` : "Add as a root", () => {
    if (!picked) return;
    const { src, i } = picked;
    const parent = editor.part;
    editor.edit("model", () => {
      editor.part = insertKit(editor.model, src, i, parent, scale);
      editor.inspect = "part";
    });
    dialog.close();
  }, { kind: "primary", disabled: true });
  const fill = () =>
    body.replaceChildren(
      ...list.map(({ name, model }) => {
        const rows = treeOrder(model)
          .map(({ i, depth }) => ({ p: model.assembly[i], i, depth }))
          .filter(({ p }) => !filter || p.name.includes(filter))
          .map(({ p, i, depth }) => {
            const n = subtreeEnd(model, i) - i;
            const on = picked?.src === model && picked.i === i;
            return h(
              "button",
              {
                class: `item ${on ? "on" : ""}`,
                style: { paddingLeft: `${10 + (filter ? 0 : depth * 14)}px` },
                onclick: () => {
                  picked = { src: model, i };
                  /** @type {HTMLButtonElement} */ (insert).disabled = false;
                  fill();
                },
                ondblclick: () => insert.click(),
              },
              h("span", { class: "name" }, p.name),
              h("span", { class: "tag" }, n > 1 ? `${n} instances` : p.part ?? ""),
            );
          });
        return rows.length ? h("div", null, h("div", { class: "kit-group" }, name === editor.current ? `${name} (open)` : name), rows) : null;
      }),
    );
  const search = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "filter instances", autofocus: true }));
  search.addEventListener("input", () => ((filter = search.value.trim()), fill()));
  fill();
  dialog.append(
    h("header", null, h("strong", null, "Add from a kit"), h("span", { class: "muted" }, "an instance and everything under it, with their parts, joints, materials and IK targets")),
    search,
    body,
    h(
      "footer",
      null,
      row("scale", num({ value: 1, step: 0.05, min: 0.05, onchange: (v) => (scale = v) }), "sizes, places and joints, all by one factor"),
      h("span", { class: "grow" }),
      btn("Cancel", () => dialog.close()),
      insert,
    ),
  );
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (open === dialog) open = null;
  });
  document.body.append(dialog);
  open = dialog;
  dialog.showModal();
}
