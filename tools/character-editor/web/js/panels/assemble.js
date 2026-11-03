// @ts-check
// The Assemble tab: the assembly, a tree of instances, each placing a part of the library (the
// Model tab, where parts get their shapes, slots and the joints those expose) by matching one of
// its slots with a slot of its parent's part; and the character's settings. Assembling only
// matches slots: both parts name and place theirs, and the child's slot brings its joints.
import { check, h, num, row, section, segmented, select, text } from "../dom.js";
import { editor } from "../editor.js";
import { instanceIndex, instanceJoints, instanceRest, isTurntable, jointAxes, jointKind, newPart, partOf, renameInstance, setInstanceRest } from "../model.js";
import { partTree } from "./partTree.js";

const NEW_PART = "(a new part)";

export function assembleSidebar() {
  const m = editor.model;
  return [partTree("Assembly")];
}

export function assembleInspector() {
  const m = editor.model;
  const names = (m.materials ?? []).map((/** @type {any} */ x) => x.name);
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  const inst = editor.inspect === "part" ? m.assembly?.[editor.part] : undefined;
  if (!inst) {
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
  const parent = instanceIndex(m, inst.parent);
  const part = partOf(m, i);
  const on = partOf(m, parent);
  const slots = (on?.slots ?? []).map((/** @type {any} */ s) => s.name);
  /** the options of a slot select, keeping a name the part lacks so it shows @param {string[]} names @param {string | undefined} v */
  const keep = (names, v) => (!v || names.includes(v) ? names : [...names, v]);
  const joints = instanceJoints(m, i);
  return [
    section("Instance", [
      row(
        "name",
        text({
          value: inst.name,
          placeholder: inst.part,
          empty: true, // empty: the part's name
          onchange: (v) => editor.edit("both", () => ((v ||= inst.part), renameInstance(m, editor.anim, inst.name, v), (inst.name = v))),
        }),
      ),
      row(
        "part",
        select({
          value: inst.part,
          none: "(none)",
          options: [["library", (m.parts ?? []).map((/** @type {any} */ p) => p.name)], ["", [NEW_PART]]],
          onchange: (v) =>
            edit(() => {
              if (v === NEW_PART) {
                const p = newPart(m, inst.name);
                (m.parts ??= []).push(p);
                inst.part = p.name;
              } else if (v) inst.part = v;
              else delete inst.part;
            }),
        }),
        "edit parts in the Model tab",
      ),
      row(
        "parent",
        select({ value: inst.parent, none: "(root)", options: m.assembly.slice(0, i).map((/** @type {any} */ p) => p.name), onchange: (v) => edit(() => (v ? (inst.parent = v) : delete inst.parent, delete inst.parent_slot)) }),
        "instances hang from earlier ones; drag in the tree to move one anywhere",
      ),
      parent >= 0 &&
        row(
          "matched with",
          select({ value: inst.parent_slot, none: "(the parent's origin)", options: keep(slots, inst.parent_slot), onchange: (v) => edit(() => (v ? (inst.parent_slot = v) : delete inst.parent_slot)) }),
          on ? `a slot of ${on.name}; slots are made in the Model tab` : "the parent places no part: its origin",
        ),
      row(
        "mirror of",
        select({
          value: inst.mirror,
          none: "(none)",
          options: keep(m.assembly.filter((/** @type {any} */ p) => p !== inst && p.part === inst.part && !p.mirror).map((/** @type {any} */ p) => p.name), inst.mirror),
          onchange: (v) => edit(() => (v ? (inst.mirror = v) : delete inst.mirror)),
        }),
        "its twin on the other side of the body: this instance shows the twin's part reflected, and moves that name the twin's channels with a twin (Animate tab) move this one too",
      ),
      row("joints", joints.length ? "" : h("span", { class: "tag" }, "none: bolted rigid"), "its part's (the Model tab makes them): how this instance sets them at rest; its channels move them from there"),
      joints.map((/** @type {any} */ j) => restRows(inst, j, edit)),
    ]),
  ];
}

/**
 * restRows: how instance `inst` sets its part's joint `j` at rest. Its twist turns the joint on its
 * socket (a wrist's second hinge across the first), its bend turns its first axis (a shoulder
 * holding the arm down from a sideways socket); the joint's range is from there. Degrees.
 * @param {any} inst @param {any} j @param {(change: () => void, key?: string) => void} edit
 */
function restRows(inst, j, edit) {
  const rest = instanceRest(inst, j.name);
  const set = (/** @type {"twist" | "bend"} */ key, /** @type {number} */ v) => edit(() => setInstanceRest(inst, j.name, key, v), `${key}-${j.name}`);
  const angle = (/** @type {"twist" | "bend"} */ key) => [num({ value: rest[key], deg: true, step: 15, onchange: (v) => set(key, v) }), quarters(rest[key], (v) => set(key, v), key)];
  return h(
    "div",
    { class: "joint-item" },
    row(j.name, h("span", { class: "tag", title: "what it moves about (along, for a linear actuator)" }, `${isTurntable(j) ? "turntable" : jointKind(j).toLowerCase()} ${jointAxes(j).join(" · ").toLowerCase()}`)),
    jointAxes(j).length > 0 && [
      row("twist", angle("twist"), "turns it on its socket first, about the socket's normal"),
      row("bend", angle("bend"), "turns its first axis at rest"),
    ],
  );
}

/**
 * quarters: buttons setting an angle to a quarter turn
 * @param {number} value radians @param {(v: number) => void} onchange @param {string} what
 */
function quarters(value, onchange, what) {
  const quarter = [0, 90, 180, -90].map((d) => ({ value: Math.round(((d * Math.PI) / 180) * 1e7) / 1e7, label: `${d}`, title: `${what} ${d}°` }));
  return segmented({ value: quarter.find((q) => Math.abs(value - q.value) < 1e-4)?.value, options: quarter, onchange, fill: true });
}
