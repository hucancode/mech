// @ts-check
// The Assemble tab: the assembly, a tree of instances, each placing a part of the library (the
// Model tab, where parts get their shapes, slots and the joints those expose) by matching one of
// its slots with a slot of its parent's part; and the character's settings. Assembling only
// matches slots: both parts name and place theirs, and the child's slot brings its joints.
import { check, h, row, section, select, text } from "../dom.js";
import { editor } from "../editor.js";
import { exposedJoints, instanceIndex, jointAxes, newPart, partOf, renameInstance } from "../model.js";
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
  const own = (part?.slots ?? []).map((/** @type {any} */ s) => s.name);
  /** the options of a slot select, keeping a name the part lacks so it shows @param {string[]} names @param {string | undefined} v */
  const keep = (names, v) => (!v || names.includes(v) ? names : [...names, v]);
  const joints = exposedJoints(m, i);
  return [
    section("Instance", [
      row(
        "name",
        text({
          value: inst.name,
          placeholder: inst.part,
          empty: true, // empty: the part's name
          onchange: (v) => edit(() => ((v ||= inst.part), renameInstance(m, inst.name, v), (inst.name = v))),
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
              // keep the slot it hangs by when the new part has one of that name, else its origin
              if (!(partOf(m, i)?.slots ?? []).some((/** @type {any} */ s) => s.name === inst.slot)) delete inst.slot;
            }),
        }),
        "edit parts in the Model tab",
      ),
      row(
        "slot",
        select({ value: inst.slot, none: "(its origin)", options: keep(own, inst.slot), onchange: (v) => edit(() => (v ? (inst.slot = v) : delete inst.slot)) }),
        part ? `the slot of ${part.name} it hangs by, with the joints that slot exposes; its origin brings the part's own joints` : "the instance places no part",
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
      row("", check({ value: inst.mirror, label: "mirrored", onchange: (v) => edit(() => (v ? (inst.mirror = true) : delete inst.mirror)) })),
      row(
        "joints",
        h("span", { class: "tag" }, joints.map((/** @type {any} */ j) => `${j.name} (${jointAxes(j).join("") || "fixed"})`).join(" · ") || "none: bolted rigid"),
        "what its slot exposes, set in the Model tab; drivers move them (Rig tab)",
      ),
    ]),
  ];
}
