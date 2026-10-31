// @ts-check
// A tiny DOM toolkit: h() builds elements, and the widgets below are the editor's fields. Panels
// rebuild their DOM when data changes; while a field is being dragged or typed in, the editor is
// "busy" and rebuilds wait until it is done, so the field under the pointer never goes away.

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * h builds an element. Props starting with "on" are listeners, `class` and `style` as expected,
 * other props are set as properties when the element has them, else as attributes.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else if (k in el && k !== "list") /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---- busy: hold rebuilds while a field is in use ---------------------------------------------

export const ui = {
  busy: 0,
  /** @type {(() => void) | null} */
  onIdle: null,
};

export function hold() {
  ui.busy++;
}

export function release() {
  ui.busy = Math.max(0, ui.busy - 1);
  if (ui.busy === 0) ui.onIdle?.();
}

/** holdWhileFocused keeps the editor busy while `el` has focus. @param {HTMLElement} el */
function holdWhileFocused(el) {
  el.addEventListener("focus", hold);
  el.addEventListener("blur", release);
}

// ---- widgets ---------------------------------------------------------------------------------

/**
 * A button showing text or an icon (see icons.js); the tooltip says what it does.
 * @param {string | Node} label
 * @param {() => void} onclick
 * @param {{title?: string, kind?: string, disabled?: boolean, on?: boolean}} [o]
 */
export function btn(label, onclick, o = {}) {
  return h("button", { class: `btn ${o.kind ?? ""} ${o.on ? "on" : ""}`, title: o.title, "aria-label": o.title, disabled: o.disabled, onclick }, label);
}

/**
 * A number field: type a value (arrow keys step it), or drag the label to scrub.
 * @param {{value?: number, step?: number, min?: number, max?: number, label?: string, color?: string, digits?: number, onchange: (v: number) => void}} o
 */
export function num(o) {
  const step = o.step ?? 0.01;
  const digits = o.digits ?? 3;
  let value = o.value ?? 0;
  const fmt = (/** @type {number} */ v) => (Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, ""));
  const fix = (/** @type {number} */ v) => {
    const d = Math.pow(10, digits);
    return Math.round(Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v)) * d) / d;
  };
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputMode: "decimal", value: fmt(value) }));
  const set = (/** @type {number} */ v) => {
    value = fix(v);
    input.value = fmt(value);
    o.onchange(value);
  };
  holdWhileFocused(input);
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    Number.isNaN(v) ? (input.value = fmt(value)) : set(v);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      set(value + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1));
    }
  });
  const box = h("div", { class: "num" });
  if (o.label) {
    const scrub = h("span", { class: "scrub", style: o.color ? { color: o.color } : undefined, title: "drag to change; shift for fine, alt for coarse" }, o.label);
    /** @type {{x: number, v: number} | null} */
    let drag = null;
    scrub.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, v: value };
      scrub.setPointerCapture(e.pointerId);
      hold();
      e.preventDefault();
    });
    scrub.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const scale = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
      set(drag.v + Math.round((e.clientX - drag.x) / 2) * step * scale);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      release();
    };
    scrub.addEventListener("pointerup", end);
    scrub.addEventListener("pointercancel", end);
    box.append(scrub);
  }
  box.append(input);
  return box;
}

const AXES = [
  ["x", "#e5675b"],
  ["y", "#7fc35b"],
  ["z", "#5b9be5"],
];

/** @param {{value?: number[], step?: number, digits?: number, onchange: (v: number[]) => void}} o */
export function vec3(o) {
  const v = [...(o.value ?? [0, 0, 0])];
  return h(
    "div",
    { class: "vec3" },
    AXES.map(([label, color], i) =>
      num({ label, color, step: o.step, digits: o.digits, value: v[i], onchange: (x) => ((v[i] = x), o.onchange([...v])) }),
    ),
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
 * empty choice with that label.
 * @param {{value?: string, options: (string | [string, string[]])[], none?: string, onchange: (v: string) => void}} o
 */
export function select(o) {
  const names = o.options.flatMap((x) => (typeof x === "string" ? [x] : x[1]));
  const el = /** @type {HTMLSelectElement} */ (
    h(
      "select",
      { onchange: () => o.onchange(el.value) },
      o.none !== undefined && h("option", { value: "" }, o.none),
      o.value && !names.includes(o.value) && h("option", { value: o.value }, `${o.value} (missing)`),
      o.options.map((x) => (typeof x === "string" ? h("option", { value: x }, x) : h("optgroup", { label: x[0] }, x[1].map((n) => h("option", { value: n }, n))))),
    )
  );
  el.value = o.value ?? "";
  return el;
}

/** A text field that commits on Enter or blur. @param {{value?: string, placeholder?: string, onchange: (v: string) => void}} o */
export function text(o) {
  const el = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: o.value ?? "", placeholder: o.placeholder }));
  holdWhileFocused(el);
  el.addEventListener("change", () => {
    const v = el.value.trim();
    if (v && v !== o.value) o.onchange(v);
    else el.value = o.value ?? "";
  });
  el.addEventListener("keydown", (e) => e.key === "Enter" && el.blur());
  return el;
}

/** A range with a number beside it. @param {{value?: number, min: number, max: number, onchange: (v: number) => void}} o */
export function slider(o) {
  const step = (o.max - o.min) / 400;
  const range = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: o.min, max: o.max, step, value: o.value ?? 0 }));
  const box = h("div", { class: "slider" }, range);
  const field = num({ value: o.value ?? 0, step, digits: 3, onchange: (v) => ((range.value = String(v)), o.onchange(v)) });
  range.addEventListener("pointerdown", hold);
  range.addEventListener("pointerup", release);
  range.addEventListener("input", () => {
    const v = parseFloat(range.value);
    /** @type {HTMLInputElement} */ (field.querySelector("input")).value = String(Math.round(v * 1000) / 1000);
    o.onchange(v);
  });
  box.append(field);
  return box;
}

/** @param {{value?: boolean, label: string, onchange: (v: boolean) => void}} o */
export function check(o) {
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!o.value }));
  input.addEventListener("change", () => o.onchange(input.checked));
  return h("label", { class: "check" }, input, o.label);
}

/** A colour [r, g, b] in 0..1. @param {{value?: number[], onchange: (v: number[]) => void}} o */
export function color(o) {
  const hex = (/** @type {number[]} */ c) => "#" + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: hex(o.value ?? [0, 0, 0]) }));
  const label = h("span", { class: "hex" }, input.value);
  input.addEventListener("pointerdown", hold);
  input.addEventListener("change", release);
  input.addEventListener("input", () => {
    label.textContent = input.value;
    o.onchange([1, 3, 5].map((i) => Math.round((parseInt(input.value.slice(i, i + 2), 16) / 255) * 1000) / 1000));
  });
  return [input, label];
}

/** @type {Map<string, boolean>} */
const opened = new Map();

/**
 * A collapsible section; it remembers whether it is open by title.
 * @param {string} title
 * @param {Child | Child[]} body
 * @param {{open?: boolean, actions?: Child[]}} [o]
 */
export function section(title, body, o = {}) {
  const open = opened.get(title) ?? o.open ?? true;
  const bodyEl = h("div", { class: "body", style: open ? undefined : { display: "none" } }, body);
  const caret = h("span", { class: `caret ${open ? "open" : ""}` }, "▸");
  const toggle = () => {
    const now = bodyEl.style.display === "none";
    opened.set(title, now);
    bodyEl.style.display = now ? "" : "none";
    caret.classList.toggle("open", now);
  };
  return h("section", { class: "section", "data-section": title }, h("header", null, h("button", { onclick: toggle }, caret, title), h("div", { class: "actions" }, o.actions ?? [])), bodyEl);
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
    const sel = /** @type {HTMLSelectElement} */ (
      h(
        "select",
        { style: { flex: "0 0 74px" } },
        FACE_AXES.map(([n]) => h("option", { value: n }, n)),
        h("option", { value: "custom", disabled: true }, "custom"),
      )
    );
    sel.value = axisOf(f[key]);
    sel.addEventListener("change", () => o.onchange({ ...f, [key]: [...(FACE_AXES.find(([n]) => n === sel.value)?.[1] ?? [0, 1, 0])] }));
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
 * @param {(i: number) => void} onpick
 */
export function list(items, content, isOn, onpick) {
  return h(
    "div",
    { class: "list" },
    items.map((it, i) => h("button", { class: `item ${isOn(i) ? "on" : ""}`, onclick: () => onpick(i) }, content(it, i))),
  );
}
