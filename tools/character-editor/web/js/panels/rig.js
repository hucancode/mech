// @ts-check
// The Rig tab. Every axis of every joint is a channel clips key by itself (`l_forearm.elbow`), so
// rigging is only what moves several joints at once: drivers (a curl closing nine knuckles), each
// with its slider range and its moves (joints' channels turning per unit of it, each move starting
// once the driver passes its delay); and IK targets (a chain reaching for a point, its point,
// weight and pole channels named after it). Selecting an instance lists its joints' channels and
// the drivers moving them. The pose test in the dock tries them, and saves the rest pose clips
// start from. Motions are the Animate tab's.
import { btn, check, h, list, num, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { addIk, driverChannels, exposedJoints, flatValues, IK_SUFFIXES, instanceIndex, jointAxes, jointChannel, jointRange, newDriver, packValues, POLE_SUFFIXES, renameDriver, renameIk } from "../model.js";
import { partTree } from "./partTree.js";

/** @param {any} kind @param {number} i */
const pick = (kind, i) =>
  editor.select(() => {
    editor.inspect = kind;
    /** @type {any} */ (editor)[kind] = i;
  });

export function rigSidebar() {
  const m = editor.model;
  const addDriver = () =>
    editor.edit("model", () => {
      const i = editor.part;
      const j = exposedJoints(m, i)[0];
      const d = newDriver(m, "driver", j && jointRange(j, jointAxes(j)[0] ?? "X"));
      if (j && m.assembly[i]) /** @type {any} */ (d).moves = [{ by: { [jointChannel(m.assembly[i].name, j, jointAxes(j)[0] ?? "X")]: 1 } }];
      editor.inspect = "driver";
      editor.driver = m.drivers.length - 1;
    });
  return [
    partTree("Assembly"),
    section(
      "Drivers",
      list(
        m.drivers ?? [],
        (d) => {
          const chs = driverChannels(d);
          return [h("span", { class: "name", style: { flex: "1" } }, d.name), h("span", { class: "tag" }, chs.length === 0 ? "moves nothing" : chs.length > 1 ? `${chs.length} joints` : chs[0])];
        },
        (i) => editor.inspect === "driver" && editor.driver === i,
        (i) => pick("driver", i),
      ),
      { actions: [btn(icon("plus"), addDriver, { kind: "icon", title: "Add a driver, to move several joints with one value (it starts on the selected instance's first joint)" })] },
    ),
    section(
      "IK targets",
      list(
        m.iks ?? [],
        (ik) => [h("span", { class: "prim" }, icon("leg", 14)), h("span", { class: "name", style: { flex: "1" } }, ik.name), h("span", { class: "tag" }, `${ik.root || "?"} → ${ik.tip || "?"}`)],
        (i) => editor.inspect === "ik" && editor.ik === i,
        (i) => pick("ik", i),
      ),
      { actions: [btn(icon("plus"), newIk, { kind: "icon", title: "Add an IK target: the selected instance reaches, turning the chain from two above it" })] },
    ),
  ];
}

/** where instance `name`'s frame is now, in model units (the "parts" query) @param {string} name */
function frameNow(name) {
  const f = editor.ask({ q: "parts", parts: [name] })?.[name];
  const s = editor.model.scale ?? 1;
  return f ? f.position.map((/** @type {number} */ c) => c / s) : [0, 0, 0];
}

// newIk adds an IK target for the selected instance (the tip), its chain from two instances above
function newIk() {
  const m = editor.model;
  const tip = m.assembly?.[editor.part];
  if (!tip) return editor.flash("Select the instance that should reach (the tip) first");
  let root = tip;
  for (let k = 0; k < 2 && root.parent; k++) root = m.assembly[instanceIndex(m, root.parent)];
  editor.edit("model", () => {
    editor.ik = addIk(m, `${tip.name}_ik`, root.name, tip.name);
    editor.inspect = "ik";
  });
}

export function rigInspector() {
  const m = editor.model;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  if (editor.inspect === "part" && m.assembly?.[editor.part]) {
    const inst = m.assembly[editor.part];
    const joints = exposedJoints(m, editor.part);
    const driving = (/** @type {string} */ ch) => (m.drivers ?? []).map((/** @type {any} */ d, /** @type {number} */ k) => ({ d, k })).filter(({ d }) => driverChannels(d).includes(ch));
    const NEW = "(a new driver)";
    /** @param {string} joint @param {string} axis @param {string} v */
    const drive = (joint, axis, v) =>
      edit(() => {
        const jj = joints.find((/** @type {any} */ j) => j.name === joint);
        const d = v === NEW ? newDriver(m, `${inst.name}_${joint}${jointAxes(jj).length > 1 ? `_${axis.toLowerCase()}` : ""}`, jointRange(jj, axis)) : m.drivers.find((/** @type {any} */ x) => x.name === v);
        if (!d) return;
        const mv = ((d.moves ??= [])[0] ??= { by: {} });
        mv.by = packValues({ ...flatValues(mv.by), [jointChannel(inst.name, jj, axis)]: 1 });
        editor.inspect = "driver";
        editor.driver = m.drivers.indexOf(d);
      });
    return section(`Joints: ${inst.name}`, [
      joints.length === 0 && h("div", { class: "muted", style: { padding: "4px 10px" } }, `Its part has no joints: it is bolted rigid. Give it joints in the Model tab.`),
      joints.flatMap((/** @type {any} */ j) =>
        jointAxes(j).map((axis) =>
          row(`${j.name} ${axis.toLowerCase()}`, [
            h("span", { class: "tag", title: "its own channel: clips key it by this name" }, jointChannel(inst.name, j, axis)),
            ...driving(jointChannel(inst.name, j, axis)).map(({ d, k }) => btn(d.name, () => pick("driver", k), { title: `Driven by ${d.name}: click to edit it` })),
            select({
              value: "",
              none: "+ driver",
              options: [["drivers", (m.drivers ?? []).map((/** @type {any} */ d) => d.name)], ["", [NEW]]],
              onchange: (v) => v && drive(j.name, axis, v),
            }),
          ]),
        ),
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
        ["_x", "_y", "_z"].forEach((x, i) => (editor.test[ik.name + x] = ik.aim ? 0 : Math.round((at[i] - rest[i] / s) * 1e4) / 1e4));
        editor.test[`${ik.name}_weight`] = 1;
      });
    };
    return section(
      "IK target",
      [
        row("name", text({ value: ik.name, onchange: (v) => editor.edit("both", () => renameIk(m, editor.anim, ik, v)) }), "its channels are renamed with it, through the rest pose and the open animation"),
        row("root", select({ value: ik.root, options: names, onchange: (v) => edit(() => (ik.root = v)) }), "the top of the chain: every joint from its slot down to the tip turns"),
        row("tip", select({ value: ik.tip, options: names, onchange: (v) => edit(() => (ik.tip = v)) }), "the instance whose frame reaches the target"),
        row("", check({ value: ik.aim, label: "aim: look at the target", onchange: (v) => edit(() => (v ? ((ik.aim = true), delete ik.hold) : delete ik.aim)) }), "the chain, the tip's own joints too (a neck), turns the tip to face the target instead of reaching it: a head looking, a gun aiming. Its target is then an offset from a point ahead of the tip at rest"),
        !ik.aim && row("", check({ value: ik.hold, label: "hold its facing", onchange: (v) => edit(() => (v ? (ik.hold = true) : delete ik.hold)) }), "the tip's own joints (an ankle) keep it facing as the clip has it in the model's space, however the chain bends: a planted foot"),
        row("channels", h("span", { class: "tag" }, IK_SUFFIXES.map((x) => ik.name + x).join(", ")), "x, y, z: the target, in the model's space, as an offset from where the tip is at rest (0: where it stands); weight: 0 as the joints' channels put it, 1 reaching"),
        !ik.aim && row("pole", h("span", { class: "tag" }, POLE_SUFFIXES.map((x) => ik.name + x).join(", ")), "moves the point the chain bends toward (the knee, the elbow) from where it is by default: in front of its middle joint, the way its stops let it bend. The chain bends in the plane through it, so the knee points at it and never flips"),
        row("", btn("Try it at the tip", toTip, { title: "Put the pose test's target on the tip as it is now, at full weight; then drag x, y, z in the dock" })),
      ],
      { actions: [btn(icon("trash"), () => edit(() => (m.iks.splice(editor.ik, 1), (editor.inspect = "character"))), { kind: "icon", title: "Delete this IK target" })] },
    );
  }

  if (editor.inspect === "driver" && m.drivers?.[editor.driver]) {
    const d = m.drivers[editor.driver];
    const moves = d.moves ?? [];
    const deg = moves.length > 0;
    // every joint's channel, the engine's names, for adding one to a move
    const joints = editor.channels().filter((c) => c.kind === "joint").map((c) => c.name);
    /** @param {number} k @param {(mv: any) => void} change @param {string} [key] */
    const set = (k, change, key) => edit(() => change(moves[k]), key);
    /** @param {any} mv @param {(flat: Record<string, number>) => void} change */
    const by = (mv, change) => {
      const flat = flatValues(mv.by);
      change(flat);
      mv.by = packValues(flat);
    };
    const addMove = () =>
      edit(() => {
        const last = moves.at(-1);
        (d.moves ??= []).push({ ...(last ? { delay: Math.round(((last.delay ?? 0) + 0.2) * 100) / 100 } : {}), by: {} });
      });
    const blocks = moves.map((/** @type {any} */ mv, /** @type {number} */ k) => {
      const flat = flatValues(mv.by);
      const has = Object.keys(flat);
      return h(
        "div",
        { class: "joint-item" },
        row(`move ${k + 1}`, [
          num({ value: mv.delay ?? 0, step: 0.05, digits: 3, onchange: (v) => set(k, (x) => (v ? (x.delay = v) : delete x.delay), `delay${k}`) }),
          btn(icon("x"), () => edit(() => (moves.splice(k, 1), moves.length || delete d.moves)), { kind: "icon", title: "Remove this move" }),
        ], "its delay: it starts once the driver passes this, in the driver's units"),
        ...has.map((ch) =>
          row(ch, [
            num({ value: flat[ch], step: 5, digits: 4, deg: true, onchange: (v) => set(k, (x) => by(x, (f) => (f[ch] = v)), `turn${k}-${ch}`) }),
            btn(icon("x"), () => set(k, (x) => by(x, (f) => delete f[ch])), { kind: "icon", title: "Take this joint out of the move" }),
          ], joints.includes(ch) ? "degrees it turns per unit of the driver, past the delay" : "not a joint's channel in the model: the engine skips it"),
        ),
        row("", select({ value: "", none: "+ joint", options: joints.filter((c) => !has.includes(c)), onchange: (c) => c && set(k, (x) => by(x, (f) => (f[c] = 1))) })),
      );
    });
    return section(
      "Driver",
      [
        row("name", text({ value: d.name, onchange: (v) => editor.edit("both", () => (renameDriver(m, editor.anim, d.name, v), (d.name = v))) }), "renames carry through the rest pose and the open animation"),
        row(
          "slider range",
          [num({ value: d.min ?? 0, step: deg ? 5 : 0.05, digits: 4, deg, onchange: (v) => edit(() => (d.min = v), "min") }), num({ value: d.max ?? 0, step: deg ? 5 : 0.05, digits: 4, deg, onchange: (v) => edit(() => (d.max = v), "max") })],
          "its own units",
        ),
        row("moves", btn(icon("plus"), addMove, { kind: "icon", title: "Add a move: joints that start turning once the driver passes its delay (a finger's tip after its base)" }), moves.length ? "each turns its joints per unit of the driver once the driver passes its delay, adding onto the joints' own channels; the joints' ranges stop them" : "none yet: + adds one"),
        blocks,
      ],
      { actions: [btn(icon("trash"), () => edit(() => (m.drivers.splice(editor.driver, 1), (editor.inspect = "character"))), { kind: "icon", title: "Delete this driver" })] },
    );
  }

  return section("Rig", h("div", { class: "muted", style: { padding: "4px 10px" } }, "Select an instance to see its joints' channels, or a driver or an IK target to edit it."));
}
