// @ts-check
// The Assemble tab: the assembly, a tree of instances, each placing a part of the library (the
// Model tab, where parts get their shapes, slots and the joints those expose) by matching one of
// its slots with a slot of its parent's part; the character's settings; and its rig. Assembling
// only matches slots: both parts name and place theirs, and the child's slot brings its joints.
// Every joint is a channel clips key by itself, shaped as it moves (a hinge's turn
// `l_forearm.elbow`, a linear actuator's slide, a ball's rotation), so rigging is only IK targets:
// a chain reaching for a point, its channels named after it (`<ik>` the point, `<ik>.swivel`,
// `<ik>.weight`); the engine finds its chain and the pole it bends toward. The pose test in the
// dock tries the channels, and saves the rest pose clips start from. Motions are the Animate tab's.
import { btn, check, h, list, num, row, section, segmented, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { addIk, instanceIndex, instanceJoints, instanceRest, isTurntable, jointAxes, jointChannel, jointKind, newPart, partOf, renameIk, renameInstance, setInstanceRest } from "../model.js";
import { partTree } from "./partTree.js";

const NEW_PART = "(a new part)";

/** @param {any} kind @param {number} i */
const pick = (kind, i) =>
  editor.select(() => {
    editor.inspect = kind;
    /** @type {any} */ (editor)[kind] = i;
  });

/** the instance IK target `name`'s chain starts from, as the engine finds it (mech.ik_root) @param {string} name */
const ikRoot = (name) => editor.ask({ q: "handles" })?.iks?.find((/** @type {any} */ x) => x.name === name)?.root ?? "?";

export function assembleSidebar() {
  const m = editor.model;
  return [
    partTree("Assembly"),
    section(
      "IK targets",
      list(
        m.iks ?? [],
        (ik) => [h("span", { class: "prim" }, icon("leg", 14)), h("span", { class: "name", style: { flex: "1" } }, ik.name), h("span", { class: "tag" }, `${ikRoot(ik.name)} → ${ik.tip || "?"}`)],
        (i) => editor.inspect === "ik" && editor.ik === i,
        (i) => pick("ik", i),
      ),
      { actions: [btn(icon("plus"), newIk, { kind: "icon", title: "Add an IK target: the selected instance reaches, turning the chain up to the nearest branch above it" })] },
    ),
  ];
}

/** where instance `name`'s frame is now, in model units (the "parts" query) @param {string} name */
function frameNow(name) {
  const f = editor.ask({ q: "parts", parts: [name] })?.[name];
  const s = editor.model.scale ?? 1;
  return f ? f.position.map((/** @type {number} */ c) => c / s) : [0, 0, 0];
}

// newIk adds an IK target for the selected instance (the tip); the engine finds its chain
function newIk() {
  const m = editor.model;
  const tip = editor.inspect === "part" ? m.assembly?.[editor.part] : undefined;
  if (!tip) return editor.flash("Select the instance that should reach (the tip) first");
  editor.edit("model", () => {
    editor.ik = addIk(m, `${tip.name}_ik`, tip.name);
    editor.inspect = "ik";
  });
}

export function assembleInspector() {
  const m = editor.model;
  const names = (m.materials ?? []).map((/** @type {any} */ x) => x.name);
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  if (editor.inspect === "ik" && m.iks?.[editor.ik]) {
    const ik = m.iks[editor.ik];
    const names = (m.assembly ?? []).map((/** @type {any} */ x) => x.name);
    // the target where the tip is now: its channels are offsets from where the tip is at rest
    const toTip = () => {
      const at = frameNow(ik.tip);
      const s = m.scale ?? 1;
      const rest = editor.ask({ q: "handles" })?.iks?.find((/** @type {any} */ x) => x.name === ik.name)?.rest ?? [0, 0, 0];
      editor.select(() => {
        // an aim's target starts where it looks at rest: straight ahead
        editor.test[ik.name] = [0, 1, 2].map((i) => (ik.aim ? 0 : Math.round((at[i] - rest[i] / s) * 1e4) / 1e4));
        editor.test[`${ik.name}.weight`] = 1;
      });
    };
    return section(
      "IK target",
      [
        row("name", text({ value: ik.name, onchange: (v) => editor.edit("both", () => renameIk(m, editor.anim, ik, v)) }), "its channels are renamed with it, through the rest pose and the open animation"),
        row("root", h("span", { class: "tag" }, ikRoot(ik.name)), "the top of the chain, found from the assembly: below the nearest branch above the tip (a pelvis, a torso). Every joint from it down to the tip turns"),
        row("tip", select({ value: ik.tip, options: names, onchange: (v) => edit(() => (ik.tip = v)) }), "the instance whose frame reaches the target"),
        row("", check({ value: ik.aim, label: "aim: look at the target", onchange: (v) => edit(() => (v ? (ik.aim = true) : delete ik.aim)) }), "the chain, the tip's own joints too (a neck), turns the tip to face the target instead of reaching it: a head looking, a gun aiming. Its target is then an offset from a point ahead of the tip at rest"),
        row("channels", h("span", { class: "tag" }, editor.channels().filter((c) => c.ik === ik.name).map((c) => c.name).join(", ")), "the target (a position), in the model's space, as an offset from where the tip is at rest (0: where it stands); swivel: radians turning the way the chain bends about the line from the limb's root to the target (0: worked out; drag the pole in the view), unused when it aims; weight: 0 as the joints' channels put it, 1 reaching"),
        row("", btn("Try it at the tip", toTip, { title: "Put the pose test's target on the tip as it is now, at full weight; then drag x, y, z in the dock" })),
      ],
      { actions: [btn(icon("trash"), () => edit(() => (m.iks.splice(editor.ik, 1), (editor.inspect = "character"))), { kind: "icon", title: "Delete this IK target" })] },
    );
  }

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
  const kinds = Object.fromEntries(editor.channels().map((c) => [c.name, c.kind]));
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
      row("joints", joints.length ? "" : h("span", { class: "tag" }, "none: bolted rigid"), "its part's (the Model tab makes them): how this instance sets them at rest; its channels (clips key them by these names; try them in the pose test) move them from there"),
      joints.map((/** @type {any} */ j) => restRows(inst, j, kinds, edit)),
      inst.mirror && joints.length > 0 && h("div", { class: "muted", style: { padding: "4px 10px" } }, "Mirrored: the engine turns over the turns the reflection needs, so keep the other side's signs."),
    ]),
  ];
}

/**
 * restRows: how instance `inst` sets its part's joint `j` at rest. Its twist turns the joint on its
 * socket (a wrist's second hinge across the first), its bend turns its first axis (a shoulder
 * holding the arm down from a sideways socket); the joint's range is from there. Degrees.
 * @param {any} inst @param {any} j @param {Record<string, string>} kinds the channels' kinds, by name
 * @param {(change: () => void, key?: string) => void} edit
 */
function restRows(inst, j, kinds, edit) {
  const rest = instanceRest(inst, j.name);
  const set = (/** @type {"twist" | "bend"} */ key, /** @type {number} */ v) => edit(() => setInstanceRest(inst, j.name, key, v), `${key}-${j.name}`);
  const angle = (/** @type {"twist" | "bend"} */ key) => [num({ value: rest[key], deg: true, step: 15, onchange: (v) => set(key, v) }), quarters(rest[key], (v) => set(key, v), key)];
  return h(
    "div",
    { class: "joint-item" },
    row(j.name, h("span", { class: "tag", title: "what it moves about (along, for a linear actuator)" }, `${isTurntable(j) ? "turntable" : jointKind(j).toLowerCase()} ${jointAxes(j).join(" · ").toLowerCase()}`)),
    row("channel", [
      h("span", { class: "tag", title: "its channel: clips key it by this name" }, jointChannel(inst.name, j)),
      h("span", { class: "muted" }, (kinds[jointChannel(inst.name, j)] ?? "fixed").toLowerCase()),
    ]),
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
