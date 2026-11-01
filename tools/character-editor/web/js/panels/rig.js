// @ts-check
// The Rig tab: drivers, the values clips key, each with its slider range and its drives
// (moving one joint an instance exposes, about or along one of the joint's axes, mapped from the
// driver's value); and IK targets (a chain reaching for a point, with the point and the weight as
// drivers of their own). Selecting an instance lists the joints it exposes and what drives them.
// The pose test in the dock tries them. Keys and timing are the Animate tab's.
import { btn, check, h, list, num, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { addIk, addPole, angularDrivers, exposedJoints, hasPole, IK_SUFFIXES, ikOf, instanceIndex, jointAxes, jointRange, newDriver, POLE_SUFFIXES, removeIk, removePole, renameDriver, renameIk } from "../model.js";
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
      if (j && m.assembly[i]) d.drives = [{ part: m.assembly[i].name, joint: j.name, axis: jointAxes(j)[0] ?? "X", from: [0, 1], to: [0, 1] }];
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
          const n = d.drives?.length ?? 0;
          const ik = ikOf(m, d.name);
          return [h("span", { class: "name", style: { flex: "1" } }, d.name), h("span", { class: "tag" }, ik ? `IK ${ik.name}` : n === 0 ? "moves nothing" : n > 1 ? `${n} joints` : `${d.drives[0].part}.${d.drives[0].joint}`)];
        },
        (i) => editor.inspect === "driver" && editor.driver === i,
        (i) => pick("driver", i),
      ),
      { actions: [btn(icon("plus"), addDriver, { kind: "icon", title: "Add a driver (moving the selected instance's first joint)" })] },
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
  const at = frameNow(tip.name);
  const reach = Math.hypot(...at.map((c, i) => c - frameNow(root.name)[i])) || 1;
  editor.edit("model", () => {
    editor.ik = addIk(m, `${tip.name}_ik`, root.name, tip.name, at, reach);
    editor.inspect = "ik";
  });
}

/** a drive's mapping drawn over a little past its driver range @param {any} d */
function driveCurve(d) {
  const [f0, f1] = d.from ?? [0, 0];
  const [t0, t1] = d.to ?? [0, 0];
  const lo = Math.min(t0, t1);
  const span = Math.abs(t1 - t0) || 1;
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    const s = f0 - (f1 - f0) * 0.25 + (f1 - f0) * 1.5 * x;
    let t = f1 !== f0 ? (s - f0) / (f1 - f0) : 0;
    if (d.clamp) t = Math.min(1, Math.max(0, t));
    pts.push(`${x * 200},${56 - ((t0 + (t1 - t0) * t - lo) / span) * 48}`);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 60");
  svg.setAttribute("class", "curve");
  svg.innerHTML = `<line x1="40" x2="40" y1="0" y2="60"/><line x1="160" x2="160" y1="0" y2="60"/><polyline points="${pts.join(" ")}"/>`;
  return svg;
}

export function rigInspector() {
  const m = editor.model;
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);
  const angular = angularDrivers(m);

  if (editor.inspect === "part" && m.assembly?.[editor.part]) {
    const inst = m.assembly[editor.part];
    const joints = exposedJoints(m, editor.part);
    const driving = (/** @type {string} */ joint, /** @type {string} */ axis) =>
      (m.drivers ?? []).map((/** @type {any} */ d, /** @type {number} */ k) => ({ d, k })).filter(({ d }) => (d.drives ?? []).some((/** @type {any} */ x) => x.part === inst.name && x.joint === joint && (x.axis ?? "X") === axis));
    const NEW = "(a new driver)";
    /** @param {string} joint @param {string} axis @param {string} v */
    const drive = (joint, axis, v) =>
      edit(() => {
        const jj = joints.find((/** @type {any} */ j) => j.name === joint);
        const d = v === NEW ? newDriver(m, `${inst.name}_${joint}${jointAxes(jj).length > 1 ? `_${axis.toLowerCase()}` : ""}`, jointRange(jj, axis)) : m.drivers.find((/** @type {any} */ x) => x.name === v);
        if (!d) return;
        (d.drives ??= []).push({ part: inst.name, joint, axis, from: [0, 1], to: [0, 1] });
        editor.inspect = "driver";
        editor.driver = m.drivers.indexOf(d);
      });
    return section(`Joints: ${inst.name}`, [
      joints.length === 0 && h("div", { class: "muted", style: { padding: "4px 10px" } }, `${inst.slot ? `Its slot ${inst.slot}` : "Its part's origin"} exposes no joints: it is bolted rigid. Give it joints in the Model tab.`),
      joints.flatMap((/** @type {any} */ j) =>
        jointAxes(j).map((axis) =>
          row(`${j.name} ${axis.toLowerCase()}`, [
            ...driving(j.name, axis).map(({ d, k }) => btn(d.name, () => pick("driver", k), { title: `Driven by ${d.name}: click to edit it` })),
            select({
              value: "",
              none: "+ driver",
              options: [["drivers", (m.drivers ?? []).filter((/** @type {any} */ d) => !ikOf(m, d.name)).map((/** @type {any} */ d) => d.name)], ["", [NEW]]],
              onchange: (v) => v && drive(j.name, axis, v),
            }),
          ]),
        ),
      ),
      inst.mirror && h("div", { class: "muted", style: { padding: "4px 10px" } }, "Mirrored: the engine turns over the drives the reflection needs, so keep the other side's signs."),
    ]);
  }

  if (editor.inspect === "ik" && m.iks?.[editor.ik]) {
    const ik = m.iks[editor.ik];
    const names = (m.assembly ?? []).map((/** @type {any} */ x) => x.name);
    // a pole in front of the chain (characters face +z), half the chain's length out
    const addPoleNow = () => {
      const a = frameNow(ik.root);
      const b = frameNow(ik.tip);
      const reach = Math.hypot(...a.map((c, i) => c - b[i])) || 1;
      const at = a.map((c, i) => (c + b[i]) / 2 + (i === 2 ? reach / 2 : 0));
      edit(() => addPole(m, ik, at, reach));
      editor.select(() => POLE_SUFFIXES.forEach((x, i) => (editor.test[ik.name + x] = at[i])));
    };
    const toTip = () => {
      const at = frameNow(ik.tip);
      editor.select(() => {
        ["_x", "_y", "_z"].forEach((x, i) => (editor.test[ik.name + x] = at[i]));
        editor.test[`${ik.name}_weight`] = 1;
      });
    };
    return section(
      "IK target",
      [
        row("name", text({ value: ik.name, onchange: (v) => editor.edit("both", () => renameIk(m, editor.anim, ik, v)) }), "its drivers are renamed with it"),
        row("root", select({ value: ik.root, options: names, onchange: (v) => edit(() => (ik.root = v)) }), "the top of the chain: every joint from its slot down to the tip turns"),
        row("tip", select({ value: ik.tip, options: names, onchange: (v) => edit(() => (ik.tip = v)) }), "the instance whose frame reaches the target"),
        row("", check({ value: ik.hold, label: "hold its facing", onchange: (v) => edit(() => (v ? (ik.hold = true) : delete ik.hold)) }), "the tip's own joints (an ankle) keep it facing as the clip has it in the model's space, however the chain bends: a planted foot"),
        row("drivers", h("span", { class: "tag" }, IK_SUFFIXES.map((x) => ik.name + x).join(", ")), "x, y, z: the target in the model's space; weight: 0 as driven, 1 reaching"),
        row(
          "pole",
          hasPole(m, ik)
            ? [h("span", { class: "tag" }, `${ik.name}_pole_x, _y, _z`), btn(icon("x"), () => edit(() => removePole(m, ik)), { kind: "icon", title: "Take the pole away" })]
            : btn("+ pole", addPoleNow, { title: "A point the chain bends toward (the knee, the elbow): it starts in front of the chain's middle" }),
          "the chain bends in the plane through it, so the knee points at it and never flips",
        ),
        row("", btn("Try it at the tip", toTip, { title: "Put the pose test's target on the tip as it is now, at full weight; then drag x, y, z in the dock" })),
      ],
      { actions: [btn(icon("trash"), () => edit(() => (removeIk(m, editor.ik), (editor.inspect = "character"))), { kind: "icon", title: "Delete this IK target and its drivers" })] },
    );
  }

  if (editor.inspect === "driver" && m.drivers?.[editor.driver]) {
    const d = m.drivers[editor.driver];
    const deg = angular.has(d.name);
    const owner = ikOf(m, d.name);
    const drives = d.drives ?? [];
    const movable = (m.assembly ?? []).filter((/** @type {any} */ x, /** @type {number} */ i) => exposedJoints(m, i).length > 0).map((/** @type {any} */ x) => x.name);
    /** @param {number} k @param {(x: any) => void} change @param {string} [key] */
    const set = (k, change, key) => edit(() => change(drives[k]), key);
    const add = () =>
      edit(() => {
        const i = editor.part >= 0 && exposedJoints(m, editor.part).length ? editor.part : instanceIndex(m, movable[0]);
        const j = exposedJoints(m, i)[0];
        if (!j) return;
        (d.drives ??= []).push({ part: m.assembly[i].name, joint: j.name, axis: jointAxes(j)[0] ?? "X", from: [0, 1], to: [0, 1] });
      });
    const blocks = drives.map((/** @type {any} */ x, /** @type {number} */ k) => {
      const joints = exposedJoints(m, instanceIndex(m, x.part));
      const joint = joints.find((/** @type {any} */ j) => j.name === x.joint);
      const axes = jointAxes(joint);
      /** @param {"from" | "to"} key @param {number} n @param {number} v */
      const pair = (key, n, v) => set(k, (y) => ((y[key] ??= [0, 0]), (y[key][n] = v)), `${key}${k}`);
      const fix = (/** @type {any} */ y) => {
        // keep the joint and axis ones the instance exposes
        const js = exposedJoints(m, instanceIndex(m, y.part));
        if (!js.some((/** @type {any} */ j) => j.name === y.joint)) y.joint = js[0]?.name;
        const as = jointAxes(js.find((/** @type {any} */ j) => j.name === y.joint));
        if (!as.includes(y.axis ?? "X")) y.axis = as[0] ?? "X";
      };
      return h(
        "div",
        { class: "joint-item" },
        row(`${k + 1}`, [
          select({ value: x.part, options: movable.includes(x.part) ? movable : [...movable, x.part], onchange: (v) => set(k, (y) => ((y.part = v), fix(y))) }),
          btn(icon("x"), () => edit(() => (drives.splice(k, 1), drives.length || delete d.drives)), { kind: "icon", title: "Remove this drive" }),
        ]),
        row("joint", [
          select({ value: x.joint, options: joints.some((/** @type {any} */ j) => j.name === x.joint) ? joints.map((/** @type {any} */ j) => j.name) : [...joints.map((/** @type {any} */ j) => j.name), x.joint], onchange: (v) => set(k, (y) => ((y.joint = v), fix(y))) }),
          select({ value: x.axis ?? "X", options: axes.length ? axes : [x.axis ?? "X"], onchange: (v) => set(k, (y) => (y.axis = v)) }),
        ], "an exposed joint of the instance, and the axis it turns about"),
        !joint && h("div", { class: "muted", style: { padding: "2px 0" } }, `${x.part} does not expose a joint ${x.joint}: the engine skips this drive`),
        row("from", [0, 1].map((n) => num({ value: x.from?.[n] ?? 0, step: deg ? 5 : 0.05, digits: 4, deg, onchange: (v) => pair("from", n, v) })), "the driver's values…"),
        row("to", [0, 1].map((n) => num({ value: x.to?.[n] ?? 0, step: 5, digits: 4, deg: true, onchange: (v) => pair("to", n, v) })), "…map onto these turns (degrees)"),
        row("", [check({ value: x.clamp, label: "clamp to the ends", onchange: (v) => set(k, (y) => (v ? (y.clamp = true) : delete y.clamp)) })]),
        x.clamp || (x.from?.[0] ?? 0) !== 0 || (x.from?.[1] ?? 0) !== 1 ? driveCurve(x) : null,
      );
    });
    return section(
      "Driver",
      [
        owner
          ? row("name", h("span", { class: "tag" }, d.name), `named after IK target ${owner.name}: rename that`)
          : row("name", text({ value: d.name, onchange: (v) => editor.edit("both", () => (renameDriver(editor.anim, d.name, v), (d.name = v))) }), "renames carry through the open animation"),
        row(
          "slider range",
          [num({ value: d.min ?? 0, step: deg ? 5 : 0.05, digits: 4, deg, onchange: (v) => edit(() => (d.min = v), "min") }), num({ value: d.max ?? 0, step: deg ? 5 : 0.05, digits: 4, deg, onchange: (v) => edit(() => (d.max = v), "max") })],
          deg ? "degrees (it turns a joint)" : owner ? "model units (an IK target's position) or a weight, 0 to 1" : "its own units",
        ),
        owner
          ? row("moves", h("span", { class: "tag" }, `IK target ${owner.name}`))
          : [
              row("drives", btn(icon("plus"), add, { kind: "icon", title: "Drive another joint (the selected instance's first, else any)", disabled: movable.length === 0 }), drives.length ? "each moves one exposed joint about one axis; they add up" : "none yet: + drives a joint"),
              blocks,
            ],
      ],
      { actions: [btn(icon("trash"), () => edit(() => (m.drivers.splice(editor.driver, 1), (editor.inspect = "character"))), { kind: "icon", title: owner ? "IK targets' drivers go with the target" : "Delete this driver", disabled: !!owner })] },
    );
  }

  return section("Rig", h("div", { class: "muted", style: { padding: "4px 10px" } }, "Select an instance to see the joints it exposes and drive them, or a driver or an IK target to edit it."));
}
