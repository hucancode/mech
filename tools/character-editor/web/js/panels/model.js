// @ts-check
// The Model tab: the character's settings, parts and shapes, joints, materials.
import { btn, check, color, face, h, list, num, row, section, select, slider, text, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, DOFS, JOINT_KINDS, partIndex, PRIMITIVES, renameJoint, renameMaterial, renamePart, uniqueName } from "../model.js";
import { partTree } from "./partTree.js";

/** @param {number[] | undefined} c */
const swatch = (c) => `rgb(${(c ?? [0, 0, 0]).map((x) => Math.round(x * 255)).join(",")})`;

const HINGE_FIELDS = [
  ["jaw", "gap between the female lugs"],
  ["lug_t", "lug thickness"],
  ["lug_d", "lug diameter"],
  ["shank", "the lug's straight length"],
  ["flange_t", "base plate thickness"],
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

export function modelSidebar() {
  const m = editor.model;
  const addMaterial = () =>
    editor.edit("model", () => {
      m.materials ??= [];
      m.materials.push({ name: uniqueName("paint", (n) => m.materials.some((/** @type {any} */ x) => x.name === n)), color: [0.7, 0.7, 0.7], roughness: 0.5 });
      editor.material = m.materials.length - 1;
      editor.inspect = "material";
    });
  const addJoint = () =>
    editor.edit("model", () => {
      m.joints ??= [];
      const name = uniqueName("joint", (n) => m.joints.some((/** @type {any} */ x) => x.name === n));
      m.joints.push({ name, kind: "HINGE", jaw: 0.12, lug_t: 0.06, lug_d: 0.24, shank: 0.12, flange_t: 0.16, pin_r: 0.05, clr: 0.01 });
      editor.joint = m.joints.length - 1;
      editor.inspect = "joint";
    });
  return [
    partTree("Parts"),
    section(
      "Joints",
      list(
        m.joints ?? [],
        (j) => [h("span", { class: "name" }, j.name), h("span", { class: "tag" }, (j.kind ?? "FIXED").toLowerCase())],
        (i) => editor.inspect === "joint" && editor.joint === i,
        (i) => editor.select(() => ((editor.joint = i), (editor.inspect = "joint"))),
      ),
      { actions: [btn(icon("plus"), addJoint, { kind: "icon", title: "Add a joint" })] },
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

  if (editor.inspect === "joint" && m.joints?.[editor.joint]) {
    const j = m.joints[editor.joint];
    const fields = j.kind === "BALL" ? BALL_FIELDS : j.kind && j.kind !== "FIXED" && j.kind !== "SPIN" ? HINGE_FIELDS : [];
    return [
      section("Joint", [
        row("name", text({ value: j.name, onchange: (v) => edit(() => (renameJoint(m, j.name, v), (j.name = v))) })),
        row("kind", select({ value: j.kind ?? "FIXED", options: JOINT_KINDS, onchange: (v) => edit(() => (j.kind = v)) })),
        row("axes", h("span", null, DOFS[j.kind ?? "FIXED"].join(", ") || "none")),
      ]),
      fields.length > 0 &&
        section(j.kind === "BALL" ? "Ball" : "Hinge", [
          fields.map(([key, hint]) => row(key, num({ value: j[key] ?? 0, min: 0, step: key === "clr" || key === "pin_out" ? 0.002 : 0.01, onchange: (v) => edit(() => (j[key] = v), key) }), hint)),
          j.kind !== "BALL" && [
            row("", check({ value: j.tang, label: "solid male lug (tang)", onchange: (v) => edit(() => (j.tang = v)) })),
            row("", check({ value: j.disc_f, label: "round female base", onchange: (v) => edit(() => (j.disc_f = v)) })),
            row("", check({ value: j.disc_m, label: "round male base", onchange: (v) => edit(() => (j.disc_m = v)) })),
          ],
        ]),
    ];
  }

  const part = editor.inspect === "part" ? m.parts?.[editor.part] : undefined;
  if (!part) {
    return [
      section("Character", [
        row("name", text({ value: m.name, onchange: (v) => edit(() => (m.name = v)) })),
        row("", check({ value: m.ground, label: "stand on the ground", onchange: (v) => edit(() => (m.ground = v)) })),
      ]),
      section(
        "Joint hardware paint",
        ["female", "male", "metal"].map((k) => row(k, select({ value: m.hardware?.[k], options: names, onchange: (v) => edit(() => ((m.hardware ??= {})[k] = v)) }))),
      ),
    ];
  }

  const i = editor.part;
  const shapes = part.shapes ?? [];
  const shape = shapes[editor.shape];
  /** @param {(s: any) => void} change @param {string} [key] */
  const setShape = (change, key) => edit(() => change(shape), key);
  /** @param {boolean} copy */
  const addShape = (copy) =>
    edit(() => {
      part.shapes ??= [];
      part.shapes.push(copy && shape ? clone(shape) : { material: names[0], size: [0.2, 0.2, 0.2] });
      editor.shape = part.shapes.length - 1;
    });
  const removeShape = () =>
    edit(() => {
      shapes.splice(editor.shape, 1);
      editor.shape = Math.min(editor.shape, shapes.length - 1);
    });

  const out = [
    section("Part", [
      row("name", text({ value: part.name, onchange: (v) => edit(() => (renamePart(m, part.name, v), (part.name = v))) })),
      row(
        "parent",
        select({ value: part.parent, none: "(root)", options: m.parts.slice(0, i).map((/** @type {any} */ p) => p.name), onchange: (v) => edit(() => (v ? (part.parent = v) : delete part.parent)) }),
        "parts hang from earlier parts; drag in the tree to move a part anywhere",
      ),
    ]),
  ];
  out.push(
    section("Joint", [
      row("joint", select({ value: part.joint, none: "(fixed, no hardware)", options: (m.joints ?? []).map((/** @type {any} */ j) => j.name), onchange: (v) => edit(() => (v ? (part.joint = v) : delete part.joint)) })),
      partIndex(m, part.parent) >= 0 && row("", check({ value: part.centered, label: "pivot on the socket", onchange: (v) => edit(() => (part.centered = v)) })),
    ]),
  );
  if (partIndex(m, part.parent) >= 0) {
    out.push(section("Socket (on the parent)", face({ value: part.socket, onchange: (f) => edit(() => (part.socket = f), "socket") })));
    out.push(section("Mount (this part's face)", face({ value: part.mount, onchange: (f) => edit(() => (part.mount = f), "mount") })));
  }
  const fields = shape
    ? h(
        "div",
        { style: { borderTop: "1px solid var(--line)", paddingTop: "6px" } },
        row("primitive", select({ value: shape.primitive ?? "BOX", options: PRIMITIVES, onchange: (v) => setShape((s) => (s.primitive = v)) })),
        (shape.primitive === "WEDGE" || shape.primitive === "CONE") &&
          row(shape.primitive === "WEDGE" ? "taper" : "top radius", slider({ value: shape.param, min: 0, max: 1, onchange: (v) => setShape((s) => (s.param = v), "param") })),
        row("material", select({ value: shape.material, options: names, onchange: (v) => setShape((s) => (s.material = v)) })),
        row("position", vec3({ value: shape.position, onchange: (v) => setShape((s) => (s.position = v), "position") })),
        row("rotation", vec3({ value: shape.rotation, step: 0.05, digits: 4, onchange: (v) => setShape((s) => (s.rotation = v), "rotation") }), "radians: x, then y, then z"),
        row("size", vec3({ value: shape.size, onchange: (v) => setShape((s) => (s.size = v), "size") }), "full extent; round shapes: x and z are the diameter"),
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
          (k) => k === editor.shape,
          (k) => editor.select(() => (editor.shape = k)),
        ),
        fields,
      ],
      {
        actions: [
          btn(icon("plus"), () => addShape(false), { kind: "icon", title: "Add a shape" }),
          btn(icon("copy"), () => addShape(true), { kind: "icon", title: "Duplicate the selected shape", disabled: !shape }),
          btn(icon("trash"), removeShape, { kind: "icon", title: "Delete the selected shape", disabled: !shape }),
        ],
      },
    ),
  );
  return out;
}
