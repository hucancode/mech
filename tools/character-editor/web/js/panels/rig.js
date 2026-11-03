// @ts-check
// The Rig tab. Every joint is a channel clips key by itself, shaped as it moves (a hinge's turn
// `l_forearm.elbow`, a linear actuator's slide, a ball's rotation), so rigging is only
// IK targets: a chain reaching for a point, its channels named after it (`<ik>` the point,
// `<ik>.swivel`, `<ik>.weight`); the engine finds its chain and the pole it bends toward.
// Selecting an instance lists its joints' channels. The pose test in the dock tries them, and saves
// the rest pose clips start from. Motions are the Animate tab's.
import { btn, check, h, list, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { addIk, instanceJoints, jointChannel, renameIk } from "../model.js";
import { partTree } from "./partTree.js";

/** @param {any} kind @param {number} i */
const pick = (kind, i) =>
  editor.select(() => {
    editor.inspect = kind;
    /** @type {any} */ (editor)[kind] = i;
  });

/** the instance IK target `name`'s chain starts from, as the engine finds it (mech.ik_root) @param {string} name */
const ikRoot = (name) => editor.ask({ q: "handles" })?.iks?.find((/** @type {any} */ x) => x.name === name)?.root ?? "?";

export function rigSidebar() {
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
  const tip = m.assembly?.[editor.part];
  if (!tip) return editor.flash("Select the instance that should reach (the tip) first");
  editor.edit("model", () => {
    editor.ik = addIk(m, `${tip.name}_ik`, tip.name);
    editor.inspect = "ik";
  });
}

export function rigInspector() {
  const m = editor.model;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  if (editor.inspect === "part" && m.assembly?.[editor.part]) {
    const inst = m.assembly[editor.part];
    const joints = instanceJoints(m, editor.part);
    const kinds = Object.fromEntries(editor.channels().map((c) => [c.name, c.kind]));
    return section(`Joints: ${inst.name}`, [
      joints.length === 0 && h("div", { class: "muted", style: { padding: "4px 10px" } }, `Its part has no joints: it is bolted rigid. Give it joints in the Model tab.`),
      joints.map((/** @type {any} */ j) =>
        row(j.name, [
          h("span", { class: "tag", title: "its channel: clips key it by this name" }, jointChannel(inst.name, j)),
          h("span", { class: "muted" }, (kinds[jointChannel(inst.name, j)] ?? "fixed").toLowerCase()),
        ]),
      ),
      inst.mirror && h("div", { class: "muted", style: { padding: "4px 10px" } }, "Mirrored: the engine turns over the turns the reflection needs, so keep the other side's signs."),
    ]);
  }

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

  return section("Rig", h("div", { class: "muted", style: { padding: "4px 10px" } }, "Select an instance to see its joints' channels, or an IK target to edit it."));
}
