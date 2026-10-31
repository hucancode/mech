// @ts-check
// Kits: any part of any character, with what hangs from it, copied into the open one. The parts
// bring the joints, materials, channels, drivers and legs they use, and can be scaled on the way
// in; the copy bolts onto the selected part's face that best matches where it hung before.
import { readFile } from "./api.js";
import { btn, h, num, row } from "./dom.js";
import { editor } from "./editor.js";
import { clone, depth, faceToward, scaleJoint, snapSocket, subtreeEnd, uniqueName } from "./model.js";
import { loadLocal } from "./store.js";

/**
 * insertKit copies part i of model `src` and everything under it into model m, under part
 * `parent` (-1 for a root), scaled by `scale`. `faces` are the parent's first shape's faces (the
 * engine's "faces" query) to bolt the copy onto. Returns the copy's index.
 * @param {any} m @param {any} src @param {number} i @param {number} parent @param {number} scale
 * @param {import("./model.js").Face[]} [faces]
 */
export function insertKit(m, src, i, parent, scale = 1, faces) {
  const block = clone(src.parts.slice(i, subtreeEnd(src, i)));
  const root = block[0];
  const taken = new Set((m.parts ?? []).map((/** @type {any} */ p) => p.name));
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const p of block) {
    const n = uniqueName(p.name, (x) => taken.has(x));
    taken.add(n);
    names.set(p.name, n);
  }
  /** @param {number[] | undefined} v */
  const mul = (v) => v && v.map((c) => Math.round(c * scale * 1e5) / 1e5);

  // joints: one the same as ours is shared, else copied (renamed on a clash)
  /** @type {Map<string, string>} */
  const joints = new Map();
  m.joints ??= [];
  for (const p of block) {
    if (!p.joint || joints.has(p.joint)) continue;
    const j = clone((src.joints ?? []).find((/** @type {any} */ x) => x.name === p.joint) ?? { name: p.joint, kind: "FIXED" });
    if (scale !== 1) scaleJoint(j, scale);
    const same = m.joints.find((/** @type {any} */ x) => JSON.stringify({ ...x, name: "" }) === JSON.stringify({ ...j, name: "" }));
    if (same) joints.set(p.joint, same.name);
    else {
      j.name = uniqueName(j.name, (n) => m.joints.some((/** @type {any} */ x) => x.name === n));
      m.joints.push(j);
      joints.set(p.joint, j.name);
    }
  }
  // materials and channels: ours when we have one by that name, else copied
  m.materials ??= [];
  m.channels ??= [];
  /** @param {string} key @param {string | undefined} name */
  const bring = (key, name) => {
    if (!name || m[key].some((/** @type {any} */ x) => x.name === name)) return;
    m[key].push(clone((src[key] ?? []).find((/** @type {any} */ x) => x.name === name) ?? { name }));
  };
  /** @type {Set<string>} */
  const channels = new Set();
  for (const p of block) {
    p.name = names.get(p.name);
    if (p !== root) p.parent = names.get(p.parent) ?? p.parent;
    if (p.joint) p.joint = joints.get(p.joint);
    for (const s of p.shapes ?? []) {
      bring("materials", s.material);
      s.position = mul(s.position);
      s.size = mul(s.size);
    }
    for (const b of p.binds ?? []) if (b.channel) (bring("channels", b.channel), channels.add(b.channel));
    if (p.mount?.position) p.mount.position = mul(p.mount.position);
    if (p !== root && p.socket?.position) p.socket.position = mul(p.socket.position);
  }
  for (const d of src.drivers ?? []) {
    if (!channels.has(d.target) || (m.drivers ?? []).some((/** @type {any} */ x) => x.target === d.target)) continue;
    bring("channels", d.source);
    (m.drivers ??= []).push(clone(d));
  }
  for (const l of src.legs ?? []) {
    if (![l.hip, l.knee, l.ankle].every((c) => channels.has(c)) || (m.legs ?? []).some((/** @type {any} */ x) => x.hip === l.hip)) continue;
    (m.legs ??= []).push(clone(l));
  }

  m.parts ??= [];
  const host = m.parts[parent];
  if (host) {
    root.parent = host.name;
    const shape = host.shapes?.[0];
    if (faces?.length && shape) root.socket = snapSocket(root.socket, faces[faceToward(faces, root.socket?.normal ?? [0, -1, 0])], shape.position ?? [0, 0, 0]);
    else if (root.socket?.position) root.socket.position = mul(root.socket.position);
  } else delete root.parent;
  const at = host ? subtreeEnd(m, parent) : m.parts.length;
  m.parts.splice(at, 0, ...block);
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
      const model = typeof data.model === "string" ? JSON.parse(data.model) : data.model;
      if (model?.parts?.length) out.push({ name: c.name, model });
    } catch (e) {
      console.warn("kit", c.name, e);
    }
  }
  return out;
}

/** @type {HTMLDialogElement | null} */
let open = null;

/** openKit shows the kit picker; the pick goes under the selected part (or in as a root). */
export async function openKit() {
  open?.close();
  const list = await sources();
  /** @type {{src: any, i: number} | null} */
  let picked = null;
  let scale = 1;
  let filter = "";
  const host = editor.part >= 0 ? editor.model.parts?.[editor.part] : undefined;
  const dialog = /** @type {HTMLDialogElement} */ (h("dialog", { class: "kit" }));
  const body = h("div", { class: "kit-list" });
  const insert = btn(host ? `Add under ${host.name}` : "Add as a root", () => {
    if (!picked) return;
    const { src, i } = picked;
    const parent = editor.part;
    const faces = host ? editor.faces(host.name)[0] : undefined;
    editor.edit("model", () => {
      editor.part = insertKit(editor.model, src, i, parent, scale, faces);
      editor.shape = editor.model.parts[editor.part].shapes?.length ? 0 : -1;
      editor.inspect = "part";
    });
    dialog.close();
  }, { kind: "primary", disabled: true });
  const fill = () =>
    body.replaceChildren(
      ...list.map(({ name, model }) => {
        const rows = model.parts
          .map((/** @type {any} */ p, /** @type {number} */ i) => ({ p, i }))
          .filter(({ p }) => !filter || p.name.includes(filter))
          .map(({ p, i }) => {
            const n = subtreeEnd(model, i) - i;
            const on = picked?.src === model && picked.i === i;
            return h(
              "button",
              {
                class: `item ${on ? "on" : ""}`,
                style: { paddingLeft: `${10 + (filter ? 0 : depth(model, i) * 14)}px` },
                onclick: () => {
                  picked = { src: model, i };
                  /** @type {HTMLButtonElement} */ (insert).disabled = false;
                  fill();
                },
                ondblclick: () => insert.click(),
              },
              h("span", { class: "name" }, p.name),
              h("span", { class: "tag" }, n > 1 ? `${n} parts` : (p.shapes?.length ?? 0) + " shapes"),
            );
          });
        return rows.length ? h("div", null, h("div", { class: "kit-group" }, name === editor.current ? `${name} (open)` : name), rows) : null;
      }),
    );
  const search = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "filter parts", autofocus: true }));
  search.addEventListener("input", () => ((filter = search.value.trim()), fill()));
  fill();
  dialog.append(
    h("header", null, h("strong", null, "Add from a kit"), h("span", { class: "muted" }, "a part and everything under it, with its joints, materials and channels")),
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
