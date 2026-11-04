// @ts-check
// The editor's widgets, over the UI core (ui/vdom.js): h() describes elements, and panels are
// drawn again from the data whenever it changes, the renderer reusing what is shown. A field being
// typed in keeps its text and its focus; a widget that holds state between draws (a number being
// scrubbed, a slider, a section's fold) is a component.

import { icon } from "./icons.js";
import { el, h, useRef, useState } from "./ui/vdom.js";

export { el, h };

/** @typedef {import("./ui/vdom.js").Child} Child */

// ---- widgets ---------------------------------------------------------------------------------

/**
 * A button showing text or an icon (see icons.js); the tooltip says what it does.
 * @param {string | Node} label
 * @param {(e: MouseEvent) => void} onclick
 * @param {{title?: string, kind?: string, disabled?: boolean, on?: boolean}} [o]
 */
export function btn(label, onclick, o = {}) {
  return h("button", { class: `btn ${o.kind ?? ""} ${o.on ? "on" : ""}`, title: o.title, "aria-label": o.title, disabled: o.disabled, onclick }, label);
}

/**
 * A segmented control: one of several choices, its buttons joined into one bar and the chosen one
 * filled. Each choice's `label` is text or an icon. `fill` stretches it across its row.
 * @template T
 * @param {{value: T, options: {value: T, label: any, title?: string}[], onchange: (v: T) => void, fill?: boolean}} o
 */
export function segmented(o) {
  return h(
    "div",
    { class: `segmented${o.fill ? " fill" : ""}`, role: "radiogroup" },
    o.options.map((x) => btn(x.label, () => o.onchange(x.value), { on: x.value === o.value, title: x.title })),
  );
}

const DEG = 180 / Math.PI;

/** radians kept to 5 places, as the files hold them @param {number} v */
const rad = (v) => Math.round((v / DEG) * 1e5) / 1e5;

/**
 * A number field: type a value (arrow keys step it), or drag the label to scrub. With `deg`, the
 * value is radians shown and typed in degrees (step, min and max are then in degrees too).
 * @param {{value?: number, step?: number, min?: number, max?: number, label?: string, color?: string, digits?: number, deg?: boolean, onchange: (v: number) => void}} o
 */
export function num(o) {
  if (o.deg) return num({ ...o, deg: false, value: (o.value ?? 0) * DEG, step: o.step ?? 5, digits: o.digits ?? 2, onchange: (v) => o.onchange(rad(v)) });
  return h(Num, o);
}

/** the latest of a prop and of what this widget set since it last changed: a field stepped by its keys moves on from what it showed, not what the data held a frame ago @template T @param {T} prop */
function useLatest(prop) {
  const box = useRef({ prop, v: prop });
  if (!Object.is(box.current.prop, prop)) box.current = { prop, v: prop };
  return box.current;
}

/** @param {{value?: number, step?: number, min?: number, max?: number, label?: string, color?: string, digits?: number, onchange: (v: number) => void}} o */
function Num(o) {
  const step = o.step ?? 0.01;
  const digits = o.digits ?? 3;
  const now = useLatest(o.value ?? 0);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const drag = useRef(/** @type {{x: number, v: number} | null} */ (null));
  const fmt = (/** @type {number} */ v) => (Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, ""));
  const fix = (/** @type {number} */ v) => {
    const d = Math.pow(10, digits);
    return Math.round(Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v)) * d) / d;
  };
  const set = (/** @type {number} */ v) => {
    now.v = fix(v);
    if (input.current) input.current.value = fmt(now.v);
    o.onchange(now.v);
  };
  const end = () => (drag.current = null);
  return h(
    "div",
    { class: "num" },
    o.label &&
      h(
        "span",
        {
          class: "scrub",
          style: o.color ? { color: o.color } : undefined,
          title: "drag to change; shift for fine, alt for coarse",
          onpointerdown: (/** @type {PointerEvent} */ e) => {
            drag.current = { x: e.clientX, v: now.v };
            /** @type {Element} */ (e.currentTarget).setPointerCapture(e.pointerId);
            e.preventDefault();
          },
          onpointermove: (/** @type {PointerEvent} */ e) => {
            const d = drag.current;
            if (!d) return;
            const scale = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
            set(d.v + Math.round((e.clientX - d.x) / 2) * step * scale);
          },
          onpointerup: end,
          onpointercancel: end,
        },
        o.label,
      ),
    h("input", {
      type: "text",
      inputMode: "decimal",
      value: fmt(now.v),
      ref: (/** @type {HTMLInputElement} */ e) => (input.current = e),
      onchange: (/** @type {Event} */ e) => {
        const field = /** @type {HTMLInputElement} */ (e.currentTarget);
        const v = evaluate(field.value, now.v);
        Number.isNaN(v) ? (field.value = fmt(now.v)) : set(v);
      },
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === "Enter") /** @type {HTMLInputElement} */ (e.currentTarget).blur();
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          set(now.v + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1));
        }
      },
    }),
  );
}

/**
 * evaluate reads a typed number: arithmetic (`0.3*2`, `(0.4+0.1)/2`), or an operation on the
 * value now when it starts with one (`*2`, `/2`, `+0.05`; a leading `-` is a negative number).
 * NaN when it is not one.
 * @param {string} text @param {number} now
 */
export function evaluate(text, now) {
  const t = text.trim();
  const src = /^[*/+]/.test(t) ? `${now}${t}` : t;
  const tokens = src.match(/\d*\.?\d+(?:e[-+]?\d+)?|[-+*/()]|\S/gi) ?? [];
  let k = 0;
  /** @returns {number} */
  const atom = () => {
    const x = tokens[k++];
    if (x === "-") return -atom();
    if (x === "+") return atom();
    if (x === "(") {
      const v = sum();
      return tokens[k++] === ")" ? v : NaN;
    }
    return x !== undefined && /^[\d.]/.test(x) ? parseFloat(x) : NaN;
  };
  const product = () => {
    let v = atom();
    while (tokens[k] === "*" || tokens[k] === "/") v = tokens[k++] === "*" ? v * atom() : v / atom();
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[k] === "+" || tokens[k] === "-") v = tokens[k++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  return k === tokens.length && Number.isFinite(v) ? v : NaN;
}

const AXES = [
  ["x", "#e5675b"],
  ["y", "#7fc35b"],
  ["z", "#5b9be5"],
];

/** whether vec3 fields with a lock scale all three together; remembered for the session */
let locked = false;

/**
 * Three numbers, x y z. With `lock`, a toggle beside them makes a change to one scale all three
 * by as much (sizes in proportion).
 * @param {{value?: number[], step?: number, digits?: number, deg?: boolean, lock?: boolean, onchange: (v: number[]) => void}} o
 */
export function vec3(o) {
  const v = [...(o.value ?? [0, 0, 0])];
  /** @param {number} i @param {number} x */
  const change = (i, x) => {
    if (o.lock && locked && v[i]) {
      const f = x / v[i];
      for (let k = 0; k < 3; k++) v[k] = Math.round(v[k] * f * 1e5) / 1e5;
    } else v[i] = x;
    o.onchange([...v]);
  };
  const lock = o.lock && btn(icon("link"), (e) => ((locked = !locked), /** @type {HTMLElement} */ (e.currentTarget).classList.toggle("on", locked)), { kind: "icon", on: locked, title: "Lock: change all three in proportion" });
  return h(
    "div",
    { class: "vec3" },
    AXES.map(([label, color], i) => num({ label, color, step: o.step, digits: o.digits, deg: o.deg, value: v[i], onchange: (x) => change(i, x) })),
    lock,
  );
}

/**
 * A labelled row of fields.
 * @param {string} label
 * @param {Child | Child[]} fields
 * @param {string} [hint]
 */
export function row(label, fields, hint) {
  return h("div", { class: "row", title: hint }, h("span", { class: "label" }, label), h("div", { class: "field" }, fields));
}

/**
 * A dropdown. `options` are names, or [group, names] pairs for option groups; `none` adds an
 * empty choice with that label; `cls` classes it.
 * @param {{value?: string, options: (string | [string, string[]])[], none?: string, cls?: string, onchange: (v: string) => void}} o
 */
export function select(o) {
  const names = o.options.flatMap((x) => (typeof x === "string" ? [x] : x[1]));
  return h(
    "select",
    { class: o.cls, value: o.value ?? "", onchange: (/** @type {Event} */ e) => o.onchange(/** @type {HTMLSelectElement} */ (e.currentTarget).value) },
    o.none !== undefined && h("option", { value: "" }, o.none),
    o.value && !names.includes(o.value) && h("option", { value: o.value }, `${o.value} (missing)`),
    o.options.map((x) => (typeof x === "string" ? h("option", { value: x }, x) : h("optgroup", { label: x[0] }, x[1].map((n) => h("option", { value: n }, n))))),
  );
}

/** A text field that commits on Enter or blur; emptied, it reverts unless `empty` (it commits ""). @param {{value?: string, placeholder?: string, empty?: boolean, onchange: (v: string) => void}} o */
export function text(o) {
  return h("input", {
    type: "text",
    value: o.value ?? "",
    placeholder: o.placeholder,
    onchange: (/** @type {Event} */ e) => {
      const field = /** @type {HTMLInputElement} */ (e.currentTarget);
      const v = field.value.trim();
      if ((v || o.empty) && v !== o.value) o.onchange(v);
      else field.value = o.value ?? "";
    },
    onkeydown: (/** @type {KeyboardEvent} */ e) => e.key === "Enter" && /** @type {HTMLInputElement} */ (e.currentTarget).blur(),
  });
}

/** A range with a number beside it; `deg` as for num (min and max stay radians). @param {{value?: number, min: number, max: number, deg?: boolean, onchange: (v: number) => void}} o */
export function slider(o) {
  if (o.deg) return slider({ value: (o.value ?? 0) * DEG, min: o.min * DEG, max: o.max * DEG, onchange: (v) => o.onchange(rad(v)) });
  return h(Slider, o);
}

/** @param {{value?: number, min: number, max: number, onchange: (v: number) => void}} o */
function Slider(o) {
  const step = (o.max - o.min) / 400;
  // the range and the number show what was dragged to before the data comes back (a pose test
  // slider changes the view only, not the data)
  const now = useLatest(o.value ?? 0);
  const [, drawn] = useState(0);
  const set = (/** @type {number} */ v) => {
    now.v = v;
    drawn((n) => n + 1);
    o.onchange(v);
  };
  return h(
    "div",
    { class: "slider" },
    h("input", { type: "range", min: o.min, max: o.max, step, value: now.v, oninput: (/** @type {Event} */ e) => set(parseFloat(/** @type {HTMLInputElement} */ (e.currentTarget).value)) }),
    num({ value: Math.round(now.v * 1000) / 1000, step, digits: 3, onchange: set }),
  );
}

/** @param {{value?: boolean, label: string, onchange: (v: boolean) => void}} o */
export function check(o) {
  return h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!o.value, onchange: (/** @type {Event} */ e) => o.onchange(/** @type {HTMLInputElement} */ (e.currentTarget).checked) }), o.label);
}

/** A colour [r, g, b] in 0..1. @param {{value?: number[], onchange: (v: number[]) => void}} o */
export function color(o) {
  const hex = (/** @type {number[]} */ c) => "#" + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
  const value = hex(o.value ?? [0, 0, 0]);
  return [
    h("input", {
      type: "color",
      value,
      oninput: (/** @type {Event} */ e) => {
        const v = /** @type {HTMLInputElement} */ (e.currentTarget).value;
        o.onchange([1, 3, 5].map((i) => Math.round((parseInt(v.slice(i, i + 2), 16) / 255) * 1000) / 1000));
      },
    }),
    h("span", { class: "hex" }, value),
  ];
}

/** whether each section is open, by its key (its title unless it says): kept across draws, not saved @type {Map<string, boolean>} */
const opened = new Map();

/** The fold caret's glyph: ▶ (U+25B6) with U+FE0E, which asks for the text glyph, not an emoji.
 * Styled and turned down when open by `.caret` (style.css). */
export const CARET = "\u25B6\uFE0E";

/**
 * A collapsible section; it remembers whether it is open by `key`, else by title (sections of the
 * same title in different places should say a key of their own). Folded, its body is not drawn.
 * @param {string} title
 * @param {Child | Child[]} body
 * @param {{open?: boolean, actions?: Child[], key?: string}} [o]
 */
export function section(title, body, o = {}) {
  return h(Section, { title, body, open: o.open, actions: o.actions, id: o.key ?? title, key: o.key });
}

/** @param {{title: string, body: Child | Child[], open?: boolean, actions?: Child[], id: string}} o */
function Section(o) {
  const [, drawn] = useState(0);
  const open = opened.get(o.id) ?? o.open ?? true;
  const toggle = () => {
    opened.set(o.id, !open);
    drawn((n) => n + 1);
  };
  return h(
    "section",
    { class: "section", "data-section": o.title },
    h("header", null, h("button", { onclick: toggle }, h("span", { class: `caret ${open ? "open" : ""}` }, CARET), o.title), h("div", { class: "actions" }, o.actions ?? [])),
    open && h("div", { class: "body" }, o.body),
  );
}

const FACE_AXES = /** @type {[string, number[]][]} */ ([
  ["+X", [1, 0, 0]],
  ["-X", [-1, 0, 0]],
  ["+Y", [0, 1, 0]],
  ["-Y", [0, -1, 0]],
  ["+Z", [0, 0, 1]],
  ["-Z", [0, 0, -1]],
]);

/**
 * A face: its point, the direction out of the surface (normal) and one along it (forward),
 * each picked from the six axes or kept custom.
 * @param {{value?: {position?: number[], normal?: number[], forward?: number[]}, onchange: (f: any) => void}} o
 */
export function face(o) {
  const f = { ...(o.value ?? {}) };
  const axisOf = (/** @type {number[] | undefined} */ v) => FACE_AXES.find(([, d]) => v && d.every((c, i) => Math.abs(c - v[i]) < 1e-6))?.[0] ?? "custom";
  /** @param {"normal" | "forward"} key */
  const dir = (key) => {
    const sel = h(
      "select",
      {
        style: { flex: "0 0 74px" },
        value: axisOf(f[key]),
        onchange: (/** @type {Event} */ e) => o.onchange({ ...f, [key]: [...(FACE_AXES.find(([n]) => n === /** @type {HTMLSelectElement} */ (e.currentTarget).value)?.[1] ?? [0, 1, 0])] }),
      },
      FACE_AXES.map(([n]) => h("option", { value: n }, n)),
      h("option", { value: "custom", disabled: true }, "custom"),
    );
    const custom = axisOf(f[key]) === "custom" ? vec3({ value: f[key], step: 0.05, onchange: (v) => o.onchange({ ...f, [key]: v }) }) : null;
    return row(key, [sel, custom], key === "normal" ? "out of the surface" : "along the surface");
  };
  return [row("position", vec3({ value: f.position, onchange: (p) => o.onchange({ ...f, position: p }) })), dir("normal"), dir("forward")];
}

/**
 * A list of selectable items.
 * @template T
 * @param {T[]} items
 * @param {(item: T, i: number) => Child[]} content
 * @param {(i: number) => boolean} isOn
 * @param {(i: number, e: MouseEvent) => void} onpick
 */
export function list(items, content, isOn, onpick) {
  return h(
    "div",
    { class: "list" },
    items.map((it, i) => h("button", { class: `item ${isOn(i) ? "on" : ""}`, onclick: (/** @type {MouseEvent} */ e) => onpick(i, e) }, content(it, i))),
  );
}
