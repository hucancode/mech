// @ts-check
// The Rig tab: each part's binds (its joint's axes to channels), channels, drivers, legs. The pose
// test in the dock tries them. Joints are part of the model (the Model tab).
import { btn, check, h, list, num, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { DOFS, renameChannel, uniqueName } from "../model.js";
import { partTree } from "./partTree.js";

/** @param {any} kind @param {number} i */
const pick = (kind, i) =>
  editor.select(() => {
    editor.inspect = kind;
    /** @type {any} */ (editor)[kind] = i;
  });

export function rigSidebar() {
  const m = editor.model;
  /** @param {string} key @param {any} item @param {"channel" | "driver" | "leg"} kind */
  const add = (key, item, kind) =>
    editor.edit("model", () => {
      m[key] ??= [];
      m[key].push(item);
      editor.inspect = kind;
      /** @type {any} */ (editor)[kind] = m[key].length - 1;
    });
  /** @param {string} key @param {string} base */
  const fresh = (key, base) => uniqueName(base, (n) => (m[key] ?? []).some((/** @type {any} */ x) => x.name === n));
  return [
    partTree("Parts"),
    section(
      "Channels",
      list(
        m.channels ?? [],
        (c) => [h("span", { class: "name" }, c.name)],
        (i) => editor.inspect === "channel" && editor.channel === i,
        (i) => pick("channel", i),
      ),
      { open: false, actions: [btn(icon("plus"), () => add("channels", { name: fresh("channels", "channel"), min: -1.5708, max: 1.5708 }, "channel"), { kind: "icon", title: "Add a channel" })] },
    ),
    section(
      "Drivers & legs",
      [
        list(
          m.drivers ?? [],
          (d) => [h("span", { class: "prim" }, icon("link", 14)), h("span", { class: "name", style: { flex: "1" } }, d.target || "?"), h("span", { class: "tag" }, `← ${d.source || "?"}`)],
          (i) => editor.inspect === "driver" && editor.driver === i,
          (i) => pick("driver", i),
        ),
        list(
          m.legs ?? [],
          (l) => [h("span", { class: "prim" }, icon("leg", 14)), h("span", { class: "tag", style: { flex: "1" } }, `${l.hip || "?"} · ${l.knee || "?"} · ${l.ankle || "?"}`)],
          (i) => editor.inspect === "leg" && editor.leg === i,
          (i) => pick("leg", i),
        ),
      ],
      {
        open: false,
        actions: [
          btn(icon("link"), () => add("drivers", { from: [0, 1], to: [0, 1], clamp: true }, "driver"), { kind: "icon", title: "Add a driver: a channel set from another" }),
          btn(icon("leg"), () => add("legs", {}, "leg"), { kind: "icon", title: "Add a leg (two-link IK)" }),
        ],
      },
    ),
  ];
}

/** the driver's mapping drawn over a little past its source range, for the preview @param {any} d */
function driverCurve(d) {
  const [f0, f1] = d.from ?? [0, 1];
  const [t0, t1] = d.to ?? [0, 1];
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
  const channels = (m.channels ?? []).map((/** @type {any} */ c) => c.name);
  /** @param {() => void} change @param {string} [key] */
  const edit = (change, key) => editor.edit("model", change, key);

  if (editor.inspect === "part" && m.parts?.[editor.part]) {
    const part = m.parts[editor.part];
    const spec = (m.joints ?? []).find((/** @type {any} */ j) => j.name === part.joint);
    const dofs = DOFS[spec?.kind ?? "FIXED"];
    /** @param {number} k @param {(b: any) => void} change */
    const setBind = (k, change) =>
      edit(() => {
        part.binds ??= [{}, {}, {}];
        while (part.binds.length < 3) part.binds.push({});
        change(part.binds[k]);
        if (part.binds[k].channel && !part.binds[k].sign) part.binds[k].sign = 1;
        if (!part.binds[k].channel) part.binds[k] = {};
      });
    return [
      section(`Binds: ${part.name}`, [
        dofs.length === 0 && h("div", { class: "muted", style: { padding: "4px 10px" } }, part.joint ? `${part.joint} doesn't turn` : "no joint (set one in the Model tab)"),
        dofs.map((dof, k) => {
          const b = part.binds?.[k] ?? {};
          return row(dof, [
            select({ value: b.channel, none: "(still)", options: channels, onchange: (v) => setBind(k, (bb) => (bb.channel = v || undefined)) }),
            b.channel && btn(icon("mirror"), () => setBind(k, (bb) => (bb.sign = (bb.sign ?? 1) < 0 ? 1 : -1)), { on: (b.sign ?? 1) < 0, title: (b.sign ?? 1) < 0 ? "Mirrored (sign −1): click for +1" : "Not mirrored (sign +1): click to mirror on this side" }),
          ]);
        }),
      ]),
    ];
  }

  if (editor.inspect === "channel" && m.channels?.[editor.channel]) {
    const c = m.channels[editor.channel];
    const users = (m.parts ?? []).filter((/** @type {any} */ p) => p.binds?.some((/** @type {any} */ b) => b.channel === c.name)).map((/** @type {any} */ p) => p.name);
    return section("Channel", [
      row("name", text({ value: c.name, onchange: (v) => editor.edit("both", () => (renameChannel(m, editor.anim, c.name, v), (c.name = v))) }), "renames carry through the model and the open animation"),
      row("slider range", [num({ value: c.min ?? 0, step: 0.05, digits: 4, onchange: (v) => edit(() => (c.min = v), "min") }), num({ value: c.max ?? 0, step: 0.05, digits: 4, onchange: (v) => edit(() => (c.max = v), "max") })]),
      row("used by", h("span", { class: "tag" }, users.join(", ") || "nothing")),
    ]);
  }

  if (editor.inspect === "driver" && m.drivers?.[editor.driver]) {
    const d = m.drivers[editor.driver];
    /** @param {"from" | "to"} key @param {number} k @param {number} v */
    const setPair = (key, k, v) => edit(() => ((d[key] ??= [0, 1]), (d[key][k] = v)), key);
    return section(
      "Driver",
      [
        row("target", select({ value: d.target, none: "(none)", options: channels, onchange: (v) => edit(() => (d.target = v)) })),
        row("source", select({ value: d.source, none: "(none)", options: channels, onchange: (v) => edit(() => (d.source = v)) })),
        row("source from", [num({ value: d.from?.[0] ?? 0, step: 0.05, onchange: (v) => setPair("from", 0, v) }), num({ value: d.from?.[1] ?? 1, step: 0.05, onchange: (v) => setPair("from", 1, v) })]),
        row("maps to", [num({ value: d.to?.[0] ?? 0, step: 0.05, digits: 4, onchange: (v) => setPair("to", 0, v) }), num({ value: d.to?.[1] ?? 1, step: 0.05, digits: 4, onchange: (v) => setPair("to", 1, v) })]),
        row("", check({ value: d.clamp, label: "clamp to the ends", onchange: (v) => edit(() => (d.clamp = v)) })),
        driverCurve(d),
      ],
      { actions: [btn(icon("trash"), () => edit(() => (m.drivers.splice(editor.driver, 1), (editor.inspect = "character"))), { kind: "icon", title: "Delete this driver" })] },
    );
  }

  if (editor.inspect === "leg" && m.legs?.[editor.leg]) {
    const l = m.legs[editor.leg];
    return [
      section(
        "Leg (two-link IK keeps the foot down)",
        ["hip", "knee", "ankle"].map((k) => row(k, select({ value: l[k], none: "(none)", options: channels, onchange: (v) => edit(() => (l[k] = v || undefined)) }))),
        { actions: [btn(icon("trash"), () => edit(() => (m.legs.splice(editor.leg, 1), (editor.inspect = "character"))), { kind: "icon", title: "Delete this leg" })] },
      ),
      section("Pelvis level", row("level", select({ value: m.level, none: "(none)", options: channels, onchange: (v) => edit(() => (m.level = v || undefined)) }), "-1 lowers the pelvis as far as a 60° knee bend")),
    ];
  }

  return [];
}
