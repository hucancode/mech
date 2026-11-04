// @ts-check
// The Model tab: the parts library. The selected part shows alone, standing as it does in the
// character (the explode slider pushes its shapes apart); edit its shapes, its length (it hangs
// that far above its origin, where the next link of a chain is matched) and its named slots, the
// faces its branches are matched on. Each joint is edited where it sits: its kind and
// parameters live on the part, so every instance of the part shares them. Materials are here too.
// The dock lists the part's shapes, slots and joints; the inspector edits the one picked.
// Which slots are matched is the Assemble tab's.
import { btn, check, color, face, h, list, num, row, section, segmented, select, slider, text, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { dockSpanButtons } from "../layout.js";
import { editor } from "../editor.js";
import { addSlot, clone, dropPartJoint, faceCentre, FACE_NAMES, fitJoint, HINGE_AXES, isTurntable, JOINT_KINDS, jointAxes, jointKind, jointSize, jointSizeFor, newPart, partUsers, PRIMITIVES, renameMaterial, renamePart, renamePartJoint, renameSlot, restretch, setJointAxis, setJointKind, setJointRange, shapeFrame, slotUsers, snapSocket, socketFace, tidyPart, turn90, uniqueName } from "../model.js";

/** @param {number[] | undefined} c */
export const swatch = (c) => `rgb(${(c ?? [0, 0, 0]).map((x) => Math.round(x * 255)).join(",")})`;

/** the primitives sized by a diameter (x and z) and a height (y) */
const ROUND = ["CYLINDER", "HALF_CYLINDER", "QUARTER_CYLINDER", "CONE"];

/** the inset of the last snap, 0 (on the face) to 1 (at the shape's centre) */
let snapInset = 0;

export function modelSidebar() {
  const m = editor.model;
  const parts = m.parts ?? [];
  const def = parts[editor.def];
  const addMaterial = () =>
    editor.edit("model", () => {
      m.materials ??= [];
      m.materials.push({ name: uniqueName("paint", (n) => m.materials.some((/** @type {any} */ x) => x.name === n)), color: [0.7, 0.7, 0.7], roughness: 0.5 });
      editor.material = m.materials.length - 1;
      editor.inspect = "material";
    });
  /** @param {any} part */
  const addPart = (part) => {
    editor.edit("model", () => {
      (m.parts ??= []).push(part);
    });
    editor.pickPart(m.parts.length - 1);
  };
  const removePart = () => {
    editor.edit("model", () => parts.splice(editor.def, 1));
    editor.pickPart(Math.max(0, Math.min(editor.def, parts.length - 1)));
  };
  const used = def ? partUsers(m, def.name).length : 0;
  return [
    section(
      "Parts",
      list(
        parts,
        (p) => {
          const n = partUsers(m, p.name).length;
          return [h("span", { class: "name", style: { flex: "1" } }, p.name), h("span", { class: "tag" }, n === 0 ? "unused" : n > 1 ? `×${n}` : "")];
        },
        (i) => editor.inspect === "part" && editor.def === i,
        (i) => editor.pickPart(i),
      ),
      {
        actions: [
          btn(icon("plus"), () => addPart(newPart(m)), { kind: "icon", title: "Add a part: a small box" }),
          btn(icon("copy"), () => def && addPart({ ...clone(def), name: uniqueName(def.name, (n) => parts.some((/** @type {any} */ x) => x.name === n)) }), { kind: "icon", title: "Duplicate the selected part", disabled: !def }),
          btn(icon("trash"), removePart, { kind: "icon", title: used ? `Placed ${used} times in the assembly: remove those first` : "Delete the selected part", disabled: !def || used > 0 }),
        ],
      },
    ),
    section(
      "Materials",
      list(
        m.materials ?? [],
        (mat) => [h("span", { class: "swatch", style: { background: swatch(mat.color) } }), h("span", { class: "name", style: { flex: "1" } }, mat.name)],
        (i) => editor.inspect === "material" && editor.material === i,
        (i) => editor.select(() => ((editor.material = i), (editor.inspect = "material"))),
      ),
      { actions: [btn(icon("plus"), addMaterial, { kind: "icon", title: "Add a material" })] },
    ),
  ];
}

export function modelInspector() {
  const m = editor.model;
  const names = (m.materials ?? []).map((/** @type {any} */ x) => x.name);
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  if (editor.inspect === "material" && m.materials?.[editor.material]) {
    const mat = m.materials[editor.material];
    return section("Material", [
      row("name", text({ value: mat.name, onchange: (v) => edit(() => (renameMaterial(m, mat.name, v), (mat.name = v))) })),
      row("colour", color({ value: mat.color, onchange: (v) => edit(() => (mat.color = v), "color") })),
      row("metallic", slider({ value: mat.metallic, min: 0, max: 1, onchange: (v) => edit(() => (mat.metallic = v), "metallic") })),
      row("roughness", slider({ value: mat.roughness, min: 0, max: 1, onchange: (v) => edit(() => (mat.roughness = v), "roughness") })),
      row("emissive", slider({ value: mat.emissive, min: 0, max: 2, onchange: (v) => edit(() => (mat.emissive = v), "emissive") })),
    ]);
  }

  const part = m.parts?.[editor.def];
  if (!part) return section("Parts", h("div", { class: "muted", style: { padding: "4px 10px" } }, "No parts yet: add one in the list."));
  const out = /** @type {HTMLElement[]} */ ([shapeSection(part), slotSection(part), jointSection(part)].filter(Boolean));
  if (out.length) return out;
  return section("Part", h("div", { class: "muted", style: { padding: "4px 10px" } }, "Pick a shape, a slot or a joint in the dock below (shapes and slots in the view too) to edit it."));
}

/**
 * modelDock is the bottom panel of the model tab: the part's name, and its shapes, slots and
 * joints, a list each side by side; the inspector edits the one picked.
 */
export function modelDock() {
  const m = editor.model;
  const part = m.parts?.[editor.def];
  const bar = h("div", { class: "dock-bar" });
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  const items = () => [
    h("span", { class: "dock-title" }, "Part"),
    part && h("div", { style: { width: "180px", display: "flex" } }, text({ value: part.name, onchange: (v) => edit(() => (renamePart(m, part.name, v), (part.name = v))) })),
    part &&
      h(
        "div",
        { style: { width: "130px", display: "flex" }, title: "How far above its origin the part hangs: its origin is the far end of the link, where the next one is matched, and stretched shapes run this length" },
        num({ label: "length", value: part.length ?? 0, min: 0, step: 0.01, onchange: (v) => edit(() => (v ? (part.length = v) : delete part.length), "part-length") }),
      ),
    h("span", { class: "grow" }),
    part && btn("tidy", () => edit(() => tidyPart(part)), { title: "Show quarter turns as sizes where the shapes look the same, and round the part's numbers to 0.001" }),
    dockSpanButtons(() => bar.replaceChildren(...items().flat().filter(Boolean))),
  ];
  bar.replaceChildren(...items().flat().filter(Boolean));
  if (!part) return [bar, h("div", { class: "muted", style: { padding: "8px 12px" } }, "No parts yet: add one in the list.")];
  return [bar, h("div", { class: "part-columns" }, shapesList(part), slotsList(part), jointsList(part))];
}

/** shapesList: the part's shapes (shift-click picks several), to add, duplicate and delete @param {any} part */
function shapesList(part) {
  const m = editor.model;
  const names = (m.materials ?? []).map((/** @type {any} */ x) => x.name);
  const shapes = part.shapes ?? [];
  const picked = editor.selectedShapes();
  /** @param {() => void} change */
  const edit = (change) => editor.edit("model", change);
  /** @param {boolean} copy */
  const addShape = (copy) =>
    edit(() => {
      part.shapes ??= [];
      const from = copy ? picked.map((k) => clone(shapes[k])) : [{ material: names[0], size: [0.2, 0.2, 0.2] }];
      part.shapes.push(...from);
      editor.shape = part.shapes.length - from.length;
      editor.also = from.map((_, i) => editor.shape + i).slice(1);
      editor.inspect = "part";
    });
  const removeShape = () =>
    edit(() => {
      for (const k of [...picked].sort((a, b) => b - a)) shapes.splice(k, 1);
      editor.shape = Math.min(Math.min(...picked), shapes.length - 1);
      editor.also = [];
    });
  return section(
    "Shapes",
    list(
      shapes,
      (s) => {
        const mat = (m.materials ?? []).find((/** @type {any} */ x) => x.name === s.material) ?? m.materials?.[0];
        return [
          h("span", { class: "prim", title: (s.primitive ?? "BOX").toLowerCase().replace("_", " ") }, icon(s.primitive ?? "BOX")),
          h("span", { class: "tag", style: { flex: "1" } }, (s.size ?? [0, 0, 0]).map((/** @type {number} */ v) => +v.toFixed(2)).join(" × ")),
          h("span", { class: "swatch", title: s.material, style: { background: swatch(mat?.color) } }),
        ];
      },
      (k) => picked.includes(k),
      (k, e) => editor.pickShape(k, e.shiftKey),
    ),
    {
      actions: [
        btn(icon("plus"), () => addShape(false), { kind: "icon", title: "Add a shape" }),
        btn(icon("copy"), () => addShape(true), { kind: "icon", title: "Duplicate the selected shapes (Cmd-C, Cmd-V copies them to another part)", disabled: !picked.length }),
        btn(icon("trash"), removeShape, { kind: "icon", title: "Delete the selected shapes", disabled: !picked.length }),
      ],
    },
  );
}

/** shapeSection edits the picked shapes: what applies to all of them, and the first one's place and size @param {any} part */
function shapeSection(part) {
  const m = editor.model;
  const names = (m.materials ?? []).map((/** @type {any} */ x) => x.name);
  const shapes = part.shapes ?? [];
  const shape = shapes[editor.shape];
  if (!shape) return null;
  const picked = editor.selectedShapes();
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  /** @param {(s: any) => void} change @param {string} [key] */
  const setShape = (change, key) => edit(() => change(shape), key);
  /** a change to every selected shape (material, primitive, turns) @param {(s: any, k: number) => void} change */
  const setAll = (change) => edit(() => picked.forEach((k) => change(shapes[k], k)));
  const spanned = !!shape?.stretch;
  return section(picked.length > 1 ? `Shapes (${picked.length})` : "Shape", [
    picked.length > 1 && h("div", { class: "muted", style: { padding: "0 0 4px" } }, `${picked.length} shapes: primitive, material, turns and moving apply to all; the rest to this one`),
    row("primitive", select({ value: shape.primitive ?? "BOX", options: PRIMITIVES, onchange: (v) => setAll((s) => (s.primitive = v)) })),
    (shape.primitive === "WEDGE" || shape.primitive === "CONE") &&
      row(shape.primitive === "WEDGE" ? "taper" : "top radius", slider({ value: shape.param, min: 0, max: 1, onchange: (v) => setShape((s) => (s.param = v), "param") })),
    row("material", select({ value: shape.material, options: names, onchange: (v) => setAll((s) => (s.material = v)) })),
    row(
      "stretch",
      check({
        value: spanned,
        label: "run the part's length",
        onchange: (on) => editor.edit("model", () => restretch(shape, on, shapeFrame(part, shape), shapeFrame(part, { stretch: on }))),
      }),
      "a link's body: from the origin up to where the part hangs, growing with its length; changing it keeps the shape where it is",
    ),
    row("position", vec3({ value: shape.position, onchange: (v) => setShape((s) => (s.position = v), "position") }), spanned ? "from halfway up the part's length" : undefined),
    row(
      "turn",
      h(
        "div",
        { class: "snap" },
        ["X", "Y", "Z"].map((a, i) =>
          btn(`${a} 90°`, () => {
            const spans = picked.map((k) => shapeFrame(part, shapes[k]));
            setAll((s, k) => turn90(s, i, spans[picked.indexOf(k)]));
          }, { title: `A quarter turn about the part's ${a}; shown as its size where the shape looks the same` }),
        ),
      ),
      "quarter turns about the part's axes",
    ),
    shape.rotation && row("rotation", vec3({ value: shape.rotation, step: 1, deg: true, onchange: (v) => setShape((s) => (s.rotation = v), "rotation") }), "degrees: x, then y, then z"),
    ROUND.includes(shape.primitive)
      ? row(
          "size",
          h(
            "div",
            { class: "vec3" },
            num({ label: "⌀", value: shape.size?.[0], onchange: (v) => setShape((s) => (s.size = [v, s.size?.[1] ?? 0, v]), "size") }),
            num({ label: "h", color: "#7fc35b", value: shape.size?.[1], onchange: (v) => setShape((s) => (s.size = [s.size?.[0] ?? 0, v, s.size?.[2] ?? 0]), "size") }),
          ),
          spanned ? "diameter, and height past the ends (the part's length is added)" : "diameter and height",
        )
      : row("size", vec3({ value: shape.size, lock: true, onchange: (v) => setShape((s) => (s.size = v), "size") }), spanned ? "y: past the ends (the part's length is added)" : "full extent"),
  ]);
}

/**
 * slotsList lists where other parts are matched on this one: its origin first, the default slot
 * (facing -y, the next link of a chain), then its named slots, faces for its branches. In the view
 * (T), rings are the named slots and dots the shapes' faces.
 * @param {any} part
 */
function slotsList(part) {
  const m = editor.model;
  const slots = part.slots ?? [];
  const slot = slots[editor.slot];
  /** @param {() => void} change */
  const edit = (change) => editor.edit("model", change);
  const add = () =>
    edit(() => {
      addSlot(part, "slot");
      editor.slot = part.slots.length - 1;
      editor.inspect = "part";
    });
  const users = slot ? slotUsers(m, part.name, slot.name).map((/** @type {any} */ x) => x.name) : [];
  const remove = () =>
    edit(() => {
      slots.splice(editor.slot, 1);
      editor.slot = Math.min(editor.slot, slots.length - 1);
    });
  const on = (/** @type {string} */ name) => h("span", { class: "tag" }, slotUsers(m, part.name, name).map((/** @type {any} */ x) => x.name).join(", "));
  // the origin, unnamed: it has nothing to edit, so it is listed, not picked
  const origin = h("div", { class: "item", title: "The origin: the default slot, facing -y, where the next link of a chain is matched (set the part's length so it is the link's far end)" }, h("span", { class: "name muted", style: { flex: "1" } }, "origin"), on(""));
  const named = list(
    slots,
    (s) => [h("span", { class: "name", style: { flex: "1" } }, s.name), on(s.name)],
    (k) => k === editor.slot,
    (k) => editor.select(() => ((editor.slot = k === editor.slot ? -1 : k), (editor.inspect = "part"))),
  );
  named.prepend(origin);
  return section(
    "Slots",
    named,
    {
      actions: [
        btn(icon("plus"), add, { kind: "icon", title: "Add a slot (or click a face in the view, T)" }),
        btn(icon("trash"), remove, {
          kind: "icon",
          title: users.length ? `${users.join(", ")} are matched on it: move them first` : "Delete the selected slot",
          disabled: !slot || users.length > 0,
        }),
      ],
    },
  );
}

/**
 * slotSection edits the picked slot: its name, and where it sits, snapped to a face of one of the
 * part's shapes ("inset" moves it in toward the shape's centre) or set by hand.
 * @param {any} part
 */
function slotSection(part) {
  const m = editor.model;
  const slot = part.slots?.[editor.slot];
  if (!slot) return null;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  return section("Slot", [
    row("name", text({ value: slot.name, onchange: (v) => edit(() => (renameSlot(m, part.name, slot.name, v), (slot.name = v))) }), "renames carry to the instances matched on it"),
    ...(snapRow(part, slot) ?? []),
    ...face({ value: slot, onchange: (f) => edit(() => Object.assign(slot, f), "slot") }),
  ]);
}

/**
 * jointsList lists the joints a part moves by, from its parent's slot to where it hangs, each on
 * the one before. Each is named (its channel, `<instance>.<joint>`, moves it), has a kind (a spin
 * servo, a hinge, a ball, a linear actuator), its range and its hardware; a turntable is a spin
 * before or after a hinge, whose plate on it is round. They live on the part, so every instance of
 * it shares them; they are straight here, and each instance sets them at rest (twist, bend: the
 * Assemble tab). None: the part bolts on rigid.
 * @param {any} part
 */
function jointsList(part) {
  const joints = part.joints ?? [];
  const k = editor.joint >= 0 && editor.joint < joints.length ? editor.joint : -1;
  /** @param {() => void} change */
  const edit = (change) => editor.edit("model", change);
  const taken = (/** @type {string} */ n) => joints.some((/** @type {any} */ j) => j.name === n);
  const add = () => {
    const size = fitFor(part, "HINGE");
    edit(() => {
      (part.joints ??= []).push(setJointKind({ name: uniqueName("hinge", taken) }, "HINGE", size));
      editor.joint = part.joints.length - 1;
      editor.inspect = "part";
    });
  };
  /** @param {number} d */
  const move = (d) => edit(() => (joints.splice(k + d, 0, ...joints.splice(k, 1)), (editor.joint = k + d)));
  const stack = list(
    joints,
    (j, i) => [
      h("span", { class: "tag" }, `${i + 1}`),
      h("span", { class: "name", style: { flex: "1" } }, j.name),
      h("span", { class: "tag" }, `${isTurntable(j) ? "turntable" : jointKind(j).toLowerCase()} ${jointAxes(j).join("·").toLowerCase()}`),
    ],
    (i) => i === k,
    (i) => editor.select(() => ((editor.joint = i === k ? -1 : i), (editor.inspect = "part"))),
      );
  stack.title = "From the parent's side to where the part hangs, each on the one before and its own channel (a shoulder: a turntable next to a pin)";
  return section(
    "Joints",
    [
      stack,
      !joints.length && h("div", { class: "muted", style: { padding: "4px 0", fontSize: "12px" } }, "none: bolted rigid"),
    ],
    {
      actions: [
        btn(icon("plus"), add, { kind: "icon", title: "Add a joint on the end of the stack" }),
        btn("↑", () => move(-1), { kind: "icon", title: "Earlier in the stack (nearer the parent)", disabled: k <= 0 }),
        btn("↓", () => move(1), { kind: "icon", title: "Later in the stack (nearer the origin)", disabled: k < 0 || k >= joints.length - 1 }),
        btn(icon("trash"), () => removeJoint(part, k), { kind: "icon", title: "Remove the selected joint", disabled: k < 0 }),
        joints.length > 0 && btn(icon("reset"), () => editor.resetTries(), { kind: "icon", title: "Put the tried joints back at rest" }),
      ],
    },
  );
}

/** a joint size that suits the face the part's joints sit on (the members they join), else its first shape @param {any} part @param {string} kind */
const fitFor = (part, kind) => fitJoint(part, kind, editor.faces(part.name)) || jointSizeFor(part);

/** removeJoint takes joint k off the part, and its channel out of the clips @param {any} part @param {number} k */
function removeJoint(part, k) {
  const m = editor.model;
  const joints = part.joints ?? [];
  const j = joints[k];
  if (!j) return;
  editor.edit("model", () => {
    joints.splice(k, 1);
    if (!joints.length) delete part.joints;
    dropPartJoint(m, part.name, j.name);
    editor.joint = Math.min(k, joints.length - 1);
  });
}

/** jointSection edits the picked joint: its name, kind, range and hardware @param {any} part */
function jointSection(part) {
  const m = editor.model;
  const k = editor.joint;
  const j = part.joints?.[k];
  if (!j) return null;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  const size = jointSize(j);
  const kind = jointKind(j);
  const pin = kind === "HINGE" && !isTurntable(j);
  // the engine says when a hinge is too close for lugs (a bare pin)
  const bare = pin ? editor.viewer?.query({ q: "dofs", joint: j })?.bare : false;
  return section(
    "Joint",
    [
      row("name", text({ value: j.name, onchange: (v) => editor.edit("both", () => (renamePartJoint(m, editor.anim, part.name, j.name, v), (j.name = v))) }), "renames carry to its channels in the rest pose and the open animation"),
      row("kind", [
        select({ value: kind, options: JOINT_KINDS, onchange: (v) => edit(() => setJointKind(j, v, size || fitFor(part, v))) }),
        kind === "HINGE" && select({ value: j.axis ?? "X", options: HINGE_AXES, onchange: (v) => edit(() => setJointAxis(j, v)) }),
      ]),
      ...rangeRows(j, edit),
      row(
        "size",
        [
          num({ value: size, min: 0, step: 0.01, onchange: (v) => edit(() => (v ? (j.size = v) : delete j.size), "joint-size") }),
          btn("fit", () => {
            const to = fitFor(part, kind);
            if (to) edit(() => (j.size = to));
          }, { title: "Size it to the face it sits on, as a clevis is sized by its link" }),
        ],
        `about ${pin ? "the lugs' diameter" : { BALL: "the ball's diameter", HINGE: "the discs' diameter", LINEAR: "the barrel's diameter" }[kind]}; the hardware scales with it (0: none, the joint pivoting on its slot)`,
      ),
      pin &&
        size > 0 &&
        row(
          "reach",
          slider({ value: j.reach ?? 0, min: 0, max: 3, onchange: (v) => edit(() => (v ? (j.reach = v) : delete j.reach), "joint-reach") }),
          bare ? "too close for lugs: a bare pin on the slot (knuckles); more reach builds lugs" : "how far out from the slot it pivots, times the size; the lugs and base plates fit in it",
        ),
    ],
    { actions: [btn(icon("trash"), () => removeJoint(part, k), { kind: "icon", title: "Remove this joint" })] },
  );
}

/**
 * rangeRows edit a joint's stops, one row per axis it moves about (along): from its rest, degrees
 * (a linear actuator's, model units out); equal ends leave it free. Drives and IK stay inside them.
 * @param {any} j @param {(change: () => void, key?: string) => void} edit
 */
function rangeRows(j, edit) {
  const slides = jointKind(j) === "LINEAR";
  return jointAxes(j).map((a) => {
    const k = "XYZ".indexOf(a);
    const end = (/** @type {number} */ e) =>
      num({ value: (e ? j.max : j.min)?.[k] ?? 0, deg: !slides, step: slides ? 0.05 : 5, onchange: (v) => edit(() => setJointRange(j, k, e, v), `range-${k}-${e}`) });
    return row(slides ? "stroke" : `range ${a.toLowerCase()}`, [end(0), end(1)], slides ? "how far it slides out, from rest, in model units; equal ends: free" : `its stops about ${a}, from rest, in degrees; equal ends: free`);
  });
}

/**
 * snapRow puts the slot on a face of one of the part's shapes: pick the shape, then the face;
 * "inset" moves it in toward the shape's centre. The face it sits on now is lit.
 * @param {any} part @param {any} slot
 */
function snapRow(part, slot) {
  const all = editor.faces(part.name);
  if (!all.length) return null;
  let at = all.findIndex((faces) => socketFace(slot, faces) >= 0);
  const shape = { k: Math.max(0, at) };
  const pick = (/** @type {number} */ f) =>
    editor.edit("model", () => {
      Object.assign(slot, snapSocket(slot, all[shape.k][f], faceCentre(all[shape.k]), snapInset));
    });
  const faces = h("div", { style: { display: "flex", flex: 1 } });
  const fill = () =>
    faces.replaceChildren(
      segmented({
        value: at === shape.k ? socketFace(slot, all[shape.k]) : -1,
        options: FACE_NAMES.map((name, f) => ({ value: f, label: name, title: `Put the slot on the ${name} face of shape ${shape.k + 1}` })),
        onchange: pick,
        fill: true,
      }),
    );
  fill();
  return [
    row(
      "snap to",
      [
        all.length > 1 &&
          select({
            value: String(shape.k + 1),
            options: all.map((_, k) => String(k + 1)),
            onchange: (v) => ((shape.k = +v - 1), fill()),
          }),
        faces,
      ],
      `a face of the part's shape${all.length > 1 ? " (pick which)" : ""}`,
    ),
    row("inset", slider({ value: snapInset, min: 0, max: 1, onchange: (v) => (snapInset = v) }), "used by the next snap: 0 on the face, 1 at the shape's centre"),
  ];
}
