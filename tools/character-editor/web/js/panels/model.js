// @ts-check
// The Model tab: the parts library. The selected part shows alone, at the origin (the explode
// slider pushes its shapes apart); edit its shapes and its named slots, the faces it is matched
// with other parts by, each with the joints the part moves by when it hangs by that slot (the
// part hangs by the selected slot, so they show). Each joint is edited where it sits: its kind and
// parameters live on the part, so every instance of the part shares them. Materials are here too.
// Which slots are matched is the Assemble tab's.
import { btn, check, color, face, h, list, num, row, section, segmented, select, slider, text, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { addSlot, clone, faceCentre, FACE_NAMES, fitJoint, JOINT_KINDS, jointAxes, jointHasHardware, jointSize, jointSizeFor, newPart, partUsers, PRIMITIVES, renameMaterial, renamePart, renamePartJoint, renameSlot, respan, setJointKind, setJointRange, slotSpanners, slotUsers, snapSocket, socketFace, tidyPart, turn90, uniqueName } from "../model.js";

/** @param {number[] | undefined} c */
export const swatch = (c) => `rgb(${(c ?? [0, 0, 0]).map((x) => Math.round(x * 255)).join(",")})`;

// a joint's proportions: each is times its size
const HINGE_FIELDS = [
  ["jaw", "gap between the female lugs"],
  ["lug_t", "lug thickness; 0: no lugs"],
  ["lug_d", "lug diameter"],
  ["shank", "the lug's straight length; with flange_t, how far out the pivot is (both 0: on the slot)"],
  ["flange_t", "base plate thickness; 0: no base plate"],
  ["pin_r", "pin radius"],
  ["clr", "clearance"],
  ["pin_out", "how far the pin sticks out"],
];
const BALL_FIELDS = [
  ["ball_r", "ball radius"],
  ["socket_t", "socket wall"],
  ["stud_len", "stud length"],
  ["flange_w", "flange width"],
  ["flange_t", "flange thickness"],
];

const SPIN_FIELDS = [
  ["flange_w", "the discs' diameter"],
  ["flange_t", "both discs' thickness; they meet on the pivot"],
];
const FIELDS = { HINGE: HINGE_FIELDS, BALL: BALL_FIELDS, SPIN: SPIN_FIELDS };

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
  const shapes = part.shapes ?? [];
  const shape = shapes[editor.shape];
  const picked = editor.selectedShapes();
  /** @param {(s: any) => void} change @param {string} [key] */
  const setShape = (change, key) => edit(() => change(shape), key);
  /** a change to every selected shape (material, primitive, turns) @param {(s: any, k: number) => void} change */
  const setAll = (change) => edit(() => picked.forEach((k) => change(shapes[k], k)));
  /** @param {boolean} copy */
  const addShape = (copy) =>
    edit(() => {
      part.shapes ??= [];
      const from = copy ? picked.map((k) => clone(shapes[k])) : [{ material: names[0], size: [0.2, 0.2, 0.2] }];
      part.shapes.push(...from);
      editor.shape = part.shapes.length - from.length;
      editor.also = from.map((_, i) => editor.shape + i).slice(1);
    });
  const removeShape = () =>
    edit(() => {
      for (const k of [...picked].sort((a, b) => b - a)) shapes.splice(k, 1);
      editor.shape = Math.min(Math.min(...picked), shapes.length - 1);
      editor.also = [];
    });
  const out = [
    section("Part", [
      row("name", text({ value: part.name, onchange: (v) => edit(() => (renamePart(m, part.name, v), (part.name = v))) })),
      jointsRows(part, part),
    ]),
    slotsSection(part),
  ];
  const spanned = !!(shape?.span?.[0] || shape?.span?.[1]);
  const fields = shape
    ? h(
        "div",
        { style: { borderTop: "1px solid var(--line)", paddingTop: "6px" } },
        picked.length > 1 && h("div", { class: "muted", style: { padding: "0 0 4px" } }, `${picked.length} shapes: primitive, material, turns and moving apply to all; the rest to this one`),
        row("primitive", select({ value: shape.primitive ?? "BOX", options: PRIMITIVES, onchange: (v) => setAll((s) => (s.primitive = v)) })),
        (shape.primitive === "WEDGE" || shape.primitive === "CONE") &&
          row(shape.primitive === "WEDGE" ? "taper" : "top radius", slider({ value: shape.param, min: 0, max: 1, onchange: (v) => setShape((s) => (s.param = v), "param") })),
        row("material", select({ value: shape.material, options: names, onchange: (v) => setAll((s) => (s.material = v)) })),
        spanRow(part, shape),
        row("position", vec3({ value: shape.position, onchange: (v) => setShape((s) => (s.position = v), "position") }), spanned ? "from the middle of the span, along it" : undefined),
        row(
          "turn",
          h(
            "div",
            { class: "snap" },
            ["X", "Y", "Z"].map((a, i) =>
              btn(`${a} 90°`, () => {
                const spans = picked.map((k) => editor.spanFrame(part.name, shapes[k].span));
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
              spanned ? "diameter, and height past the span's ends (its length is added)" : "diameter and height",
            )
          : row("size", vec3({ value: shape.size, lock: true, onchange: (v) => setShape((s) => (s.size = v), "size") }), spanned ? "y: past the span's ends (its length is added)" : "full extent"),
      )
    : null;
  out.push(
    section(
      "Shapes",
      [
        list(
          shapes,
          (s, k) => {
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
        fields,
      ],
      {
        actions: [
          btn(icon("plus"), () => addShape(false), { kind: "icon", title: "Add a shape" }),
          btn(icon("copy"), () => addShape(true), { kind: "icon", title: "Duplicate the selected shapes (Cmd-C, Cmd-V copies them to another part)", disabled: !shape }),
          btn(icon("trash"), removeShape, { kind: "icon", title: "Delete the selected shapes", disabled: !shape }),
          btn("tidy", () => edit(() => tidyPart(part)), { title: "Show quarter turns as sizes where the shapes look the same, and round the part's numbers to 0.001" }),
        ],
      },
    ),
  );
  return out;
}

/**
 * slotsSection lists the part's slots, the named faces it is matched with other parts by, and
 * the joints each exposes. The selected one is
 * snapped to a face of one of the part's shapes ("inset" moves it in toward the shape's centre),
 * or set by hand. In the view (T), rings are the slots and dots the shapes' faces.
 * @param {any} part
 */
function slotsSection(part) {
  const m = editor.model;
  const slots = part.slots ?? [];
  const slot = slots[editor.slot];
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  const add = () =>
    edit(() => {
      addSlot(part, "slot");
      editor.slot = part.slots.length - 1;
    });
  const users = slot ? slotUsers(m, part.name, slot.name).map((/** @type {any} */ x) => x.name) : [];
  const spanners = slot ? slotSpanners(part, slot.name).length : 0;
  const remove = () =>
    edit(() => {
      slots.splice(editor.slot, 1);
      editor.slot = Math.min(editor.slot, slots.length - 1);
    });
  return section(
    "Slots",
    [
      list(
        slots,
        (s) => [
          h("span", { class: "name", style: { flex: "1" } }, s.name),
          s.joints?.length > 0 && h("span", { class: "tag", title: "joints it exposes" }, s.joints.map((/** @type {any} */ j) => j.name).join(" · ")),
        ],
        (k) => k === editor.slot,
        (k) => editor.select(() => (editor.slot = k === editor.slot ? -1 : k)),
      ),
      slot &&
        h(
          "div",
          { style: { borderTop: "1px solid var(--line)", paddingTop: "6px" } },
          row("name", text({ value: slot.name, onchange: (v) => edit(() => (renameSlot(m, part.name, slot.name, v), (slot.name = v))) }), "renames carry to the instances matched on it"),
          snapRow(part, slot),
          face({ value: slot, onchange: (f) => edit(() => Object.assign(slot, f), "slot") }),
          jointsRows(part, slot),
        ),
    ],
    {
      actions: [
        btn(icon("plus"), add, { kind: "icon", title: "Add a slot (or click a face in the view, T)" }),
        btn(icon("trash"), remove, {
          kind: "icon",
          title: users.length ? `${users.join(", ")} are matched on it: move them first` : spanners ? `${spanners} shape${spanners > 1 ? "s span" : " spans"} it: change their span first` : "Delete the selected slot",
          disabled: !slot || users.length > 0 || spanners > 0,
        }),
      ],
    },
  );
}

/**
 * jointsRows edits the joints a slot exposes (`slot` the part itself: its default slot, the
 * origin): what the part moves by when it hangs by the slot, listed from the parent's side, each
 * on the one before. Each is named (drivers move it by name), has a kind and its parameters, and
 * may twist about the slot's normal first. They live on the part, so every instance of it shares
 * them. None: the part bolts on rigid.
 * @param {any} part @param {any} slot
 */
function jointsRows(part, slot) {
  const m = editor.model;
  const joints = slot.joints ?? [];
  // the view hangs the part by these joints, so they can be tried
  const shown = joints.length > 0 && editor.hangJoints() === joints;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  const taken = (/** @type {string} */ n) => [part, ...(part.slots ?? [])].some((/** @type {any} */ s) => (s.joints ?? []).some((/** @type {any} */ j) => j.name === n));
  // a size that suits the face the joints sit on (the members they join), else the first shape
  const fit = (/** @type {string} */ kind) => fitJoint(part, slot, kind, editor.faces(part.name)) || jointSizeFor(part);
  const add = () => {
    const size = fit("HINGE");
    edit(() => (slot.joints ??= []).push(setJointKind({ name: uniqueName("hinge", taken) }, "HINGE", size)));
  };
  /** @param {number} k @param {number} d */
  const move = (k, d) => edit(() => joints.splice(k + d, 0, ...joints.splice(k, 1)));
  return h(
    "div",
    { class: "joint-stack" },
    row(
      "joints",
      [
        btn(icon("plus"), add, { kind: "icon", title: "Add a joint on the end of the stack" }),
        shown && btn(icon("reset"), () => editor.resetTries(), { kind: "icon", title: "Put the tried joints back at rest" }),
      ],
      `${slot === part ? "at its origin, the default slot; " : ""}${joints.length ? "from the parent's side; drivers move them by name (Rig tab)" : "none: bolted rigid when it hangs by this slot"}`,
    ),
    joints.map((/** @type {any} */ j, /** @type {number} */ k) => {
      const size = jointSize(j);
      const fields = FIELDS[/** @type {keyof typeof FIELDS} */ (j.kind)] ?? [];
      return h(
        "div",
        { class: shown && editor.joint === k ? "joint-item on" : "joint-item" },
        row(`${k + 1}`, [
          text({ value: j.name, onchange: (v) => edit(() => (renamePartJoint(m, part.name, j.name, v), (j.name = v))) }),
          select({
            value: j.kind ?? "HINGE",
            options: JOINT_KINDS,
            onchange: (v) => {
              const to = size || fit(v);
              edit(() => setJointKind(j, v, to));
            },
          }),
          btn("↑", () => move(k, -1), { kind: "icon", title: "Earlier in the stack (nearer the parent)", disabled: k === 0 }),
          btn(icon("x"), () => edit(() => (joints.splice(k, 1), joints.length || delete slot.joints)), { kind: "icon", title: "Remove this joint" }),
        ]),
        row(
          "twist",
          [
            num({ value: j.twist ?? 0, deg: true, step: 15, onchange: (v) => edit(() => (v ? (j.twist = v) : delete j.twist), "twist") }),
            quarters(j, "twist", edit),
            h("span", { class: "tag", title: "the axes it turns about" }, jointAxes(j).join(" ")),
          ],
          "degrees about the slot's normal before the joint",
        ),
        row("bend", [num({ value: j.bend ?? 0, deg: true, step: 15, onchange: (v) => edit(() => (v ? (j.bend = v) : delete j.bend), "bend") }), quarters(j, "bend", edit)], "turns the first axis at rest, in degrees"),
        rangeRows(j, edit),
        jointHasHardware(j.kind) &&
          row(
            "size",
            [
              num({ value: size, min: 0, step: 0.01, onchange: (v) => edit(() => (v ? (j.size = v) : delete j.size), "joint-size") }),
              btn("fit", () => {
                const to = fit(j.kind);
                if (to) edit(() => (j.size = to));
              }, { title: "Size it to the face it sits on, as a clevis is sized by its link" }),
            ],
            `about ${{ BALL: "the ball's diameter", HINGE: "the width across the lugs", SPIN: "the discs' diameter" }[/** @type {string} */ (j.kind)] ?? "its width"}; the hardware scales with it (0: none)`,
          ),
        fields.length > 0 &&
          section("Proportions", [
            fields.map(([key, hint]) => row(key, num({ value: j[key] ?? 0, min: 0, step: key === "clr" || key === "pin_out" ? 0.005 : 0.02, onchange: (v) => edit(() => (j[key] = v), key) }), `${hint}; times the size`)),
            j.kind === "HINGE" && [
              row("", check({ value: j.tang, label: "solid male lug (tang)", onchange: (v) => edit(() => (v ? (j.tang = true) : delete j.tang)) })),
              row("", check({ value: j.disc_f, label: "round female base", onchange: (v) => edit(() => (v ? (j.disc_f = true) : delete j.disc_f)) })),
              row("", check({ value: j.disc_m, label: "round male base", onchange: (v) => edit(() => (v ? (j.disc_m = true) : delete j.disc_m)) })),
            ],
          ], { open: false }),
      );
    }),
  );
}

/**
 * quarters: buttons setting a joint's angle `key` (twist, bend) to a quarter turn
 * @param {any} j @param {string} key @param {(change: () => void, key?: string) => void} edit
 */
function quarters(j, key, edit) {
  const quarter = [0, 90, 180, -90].map((d) => ({ value: Math.round(((d * Math.PI) / 180) * 1e7) / 1e7, label: `${d}`, title: `${key} ${d}°` }));
  return segmented({
    value: quarter.find((q) => Math.abs((j[key] ?? 0) - q.value) < 1e-4)?.value,
    options: quarter,
    onchange: (v) => edit(() => (v ? (j[key] = v) : delete j[key])),
    fill: true,
  });
}

/**
 * rangeRows edit a joint's stops, one row per axis it has: from its rest, degrees (model units
 * equal ends leave it free. Drives and IK stay inside them.
 * @param {any} j @param {(change: () => void, key?: string) => void} edit
 */
function rangeRows(j, edit) {
  return jointAxes(j).map((a) => {
    const k = "XYZ".indexOf(a);
    const end = (/** @type {number} */ e) =>
      num({ value: (e ? j.max : j.min)?.[k] ?? 0, deg: true, step: 5, onchange: (v) => edit(() => setJointRange(j, k, e, v), `range-${k}-${e}`) });
    return row(`range ${a.toLowerCase()}`, [end(0), end(1)], `its stops about ${a}, from rest, in degrees; equal ends: free`);
  });
}

/**
 * spanRow makes a shape a link's body: spanning two of the part's slots (the origin is one), it
 * sits between them and its length follows them. Changing the span keeps it where it is.
 * @param {any} part @param {any} shape
 */
function spanRow(part, shape) {
  const ends = ["origin", ...(part.slots ?? []).map((/** @type {any} */ x) => x.name)];
  const span = shape.span ?? ["", ""];
  /** @param {number} k @param {string} v */
  const set = (k, v) => {
    const next = [...span];
    next[k] = v === "origin" ? "" : v;
    const from = editor.spanFrame(part.name, shape.span);
    const to = editor.spanFrame(part.name, next);
    editor.edit("model", () => respan(shape, next, from, to));
  };
  return row(
    "span",
    [0, 1].map((k) => select({ value: span[k] || "origin", options: ends, onchange: (v) => set(k, v) })),
    "between two slots: a link's body, lengthening as they move; origin to origin is none",
  );
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
