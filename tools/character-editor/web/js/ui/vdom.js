// @ts-check
// A small virtual DOM: panels describe what they show with h() and render() makes a container
// show it, reusing the elements already there (by `key`, else by position) and changing only what
// differs. So a panel can be drawn again from the data at any time: the field being typed in keeps
// its focus and its text, a list keeps its scroll, a widget keeps its state.
//
//   h(tag, props, ...children)   an element: props starting with "on" are listeners, `class`,
//                                `style` (an object), `key` (its identity among its siblings),
//                                `ref` (called with the element when made); others are set as
//                                properties when the element has them, else as attributes
//   h(Component, props, ...)     a function of its props (children in props.children) returning
//                                one node; useState and useRef keep state across draws
//   a string or a number         text; a DOM Node: shown as it is (an icon, a canvas)
//   null, undefined, booleans    nothing
//
// A text field with the focus is never written over: it shows what is typed until it commits.

const TEXT = "#text";
const NODE = "#node";
const SVG = "http://www.w3.org/2000/svg";

/** @typedef {{type: any, props: Record<string, any>, children: VNode[], key: any, text?: string, node?: Node, dom?: Node, inst?: Instance}} VNode */
/** @typedef {{type: Function, props: any, hooks: any[], child: VNode | null, vnode: VNode | null, dead: boolean, svg: boolean}} Instance */
/** @typedef {VNode | Node | string | number | null | undefined | boolean} Child */

/**
 * @param {any} type a tag or a component
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {VNode}
 */
export function h(type, props, ...children) {
  const p = props ?? {};
  const kids = normalize(children);
  if (typeof type === "function") return { type, props: { ...p, children: kids }, children: [], key: p.key };
  return { type, props: p, children: kids, key: p.key };
}

/** @param {any[]} children @returns {VNode[]} */
function normalize(children) {
  const out = [];
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || typeof c === "boolean") continue;
    if (typeof c === "string" || typeof c === "number") out.push({ type: TEXT, props: {}, children: [], key: undefined, text: String(c) });
    else if (typeof Node !== "undefined" && c instanceof Node) out.push({ type: NODE, props: {}, children: [], key: undefined, node: c });
    else out.push(c);
  }
  return out;
}

/**
 * render makes `container` show `children`, reusing what it shows already. The container is the
 * renderer's from its first render on: nothing else should add to it.
 * @param {Child | Child[]} children @param {Element} container
 */
export function render(children, container) {
  const next = normalize([children]);
  const box = /** @type {any} */ (container);
  if (!box.__vnodes) container.replaceChildren();
  patchChildren(container, box.__vnodes ?? [], next, container.namespaceURI === SVG);
  box.__vnodes = next;
}

/** el builds a real element now (for what is made once and kept: a dialog, a canvas) @param {any} tag @param {Record<string, any> | null} [props] @param {...(Child | Child[])} children */
export function el(tag, props, ...children) {
  return /** @type {HTMLElement} */ (create(h(tag, props, ...children), false));
}

// ---- making and updating ---------------------------------------------------------------------

/** @param {VNode} a @param {VNode} b */
function same(a, b) {
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === NODE) return a.node === b.node || /** @type {Node} */ (a.node).isEqualNode(/** @type {Node} */ (b.node));
  return true;
}

/** @param {VNode} v @param {boolean} svg @returns {Node} */
function create(v, svg) {
  if (v.type === TEXT) return (v.dom = document.createTextNode(/** @type {string} */ (v.text)));
  if (v.type === NODE) return (v.dom = /** @type {Node} */ (v.node));
  if (typeof v.type === "function") {
    /** @type {Instance} */
    const inst = { type: v.type, props: v.props, hooks: [], child: null, vnode: v, dead: false, svg };
    v.inst = inst;
    const child = draw(inst);
    inst.child = child;
    return (v.dom = create(child, svg));
  }
  const inSvg = svg || v.type === "svg";
  const el = inSvg ? document.createElementNS(SVG, v.type) : document.createElement(v.type);
  for (const c of v.children) el.appendChild(create(c, inSvg && v.type !== "foreignObject"));
  setProps(el, {}, v.props, inSvg);
  v.props.ref?.(el);
  return (v.dom = el);
}

/** update makes old's DOM show v, which takes it over @param {VNode} old @param {VNode} v @param {boolean} svg */
function update(old, v, svg) {
  v.dom = old.dom;
  if (v.type === TEXT) {
    if (old.text !== v.text) /** @type {Text} */ (v.dom).data = /** @type {string} */ (v.text);
    return;
  }
  if (v.type === NODE) {
    v.node = old.node; // equal: keep the one shown
    return;
  }
  if (typeof v.type === "function") {
    const inst = /** @type {Instance} */ (old.inst);
    v.inst = inst;
    inst.vnode = v;
    inst.props = v.props;
    const child = draw(inst);
    inst.child = patch(/** @type {Node} */ (old.dom).parentNode, /** @type {VNode} */ (old.inst?.child), child, svg);
    v.dom = inst.child.dom;
    return;
  }
  const inSvg = svg || v.type === "svg";
  const el = /** @type {Element} */ (v.dom);
  patchChildren(el, old.children, v.children, inSvg && v.type !== "foreignObject");
  setProps(el, old.props, v.props, inSvg);
}

/** patch shows v where old is (in `parent`), reusing old when it can; returns v @param {Node | null} parent @param {VNode} old @param {VNode} v @param {boolean} svg */
function patch(parent, old, v, svg) {
  if (same(old, v)) {
    update(old, v, svg);
    return v;
  }
  const dom = create(v, svg);
  parent?.replaceChild(dom, /** @type {Node} */ (old.dom));
  unmount(old);
  return v;
}

/** @param {Node} parent @param {VNode[]} olds @param {VNode[]} news @param {boolean} svg */
function patchChildren(parent, olds, news, svg) {
  /** @type {Map<any, VNode>} */
  const keyed = new Map();
  for (const o of olds) if (o.key !== undefined && o.key !== null) keyed.set(o.key, o);
  /** @type {Set<VNode>} */
  const used = new Set();
  news.forEach((v, i) => {
    const k = v.key !== undefined && v.key !== null;
    let o = k ? keyed.get(v.key) : olds[i];
    if (o && !k && o.key !== undefined && o.key !== null) o = undefined;
    if (o && !used.has(o) && same(o, v)) {
      used.add(o);
      update(o, v, svg);
    } else create(v, svg);
  });
  for (const o of olds) {
    if (used.has(o)) continue;
    if (o.dom?.parentNode === parent) parent.removeChild(o.dom);
    unmount(o);
  }
  news.forEach((v, i) => {
    const at = parent.childNodes[i];
    if (at !== v.dom) parent.insertBefore(/** @type {Node} */ (v.dom), at ?? null);
  });
}

/** @param {VNode} v */
function unmount(v) {
  if (v.inst) {
    v.inst.dead = true;
    if (v.inst.child) unmount(v.inst.child);
  }
  for (const c of v.children) unmount(c);
}

// ---- props -----------------------------------------------------------------------------------

/** the one listener per event of an element: it calls the element's handler of the moment @this {any} @param {Event} e */
function dispatch(e) {
  this.__on?.[e.type]?.call(this, e);
}

/** whether `el` takes typed text, which a draw must not write over while it has the focus @param {Element} el */
const typed = (el) => el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "checkbox", "radio", "color", "button"].includes(/** @type {HTMLInputElement} */ (el).type));

/** @param {Element} el @param {Record<string, any>} old @param {Record<string, any>} next @param {boolean} svg */
function setProps(el, old, next, svg) {
  const any = /** @type {any} */ (el);
  for (const k in old) if (!(k in next) || next[k] === null || next[k] === undefined || next[k] === false) unset(el, k, old[k], svg);
  // the value last: a range's min, max and step and a select's options come first
  const keys = Object.keys(next).sort((a, b) => Number(a === "value" || a === "checked") - Number(b === "value" || b === "checked"));
  for (const k of keys) {
    const v = next[k];
    if (k === "key" || k === "ref" || k === "children") continue;
    if (v === null || v === undefined || v === false) continue;
    if (k === "value" || k === "checked") {
      if (k === "value" && typed(el) && document.activeElement === el) continue;
      if (any[k] !== v) any[k] = v;
      continue;
    }
    if (v === old[k]) continue;
    if (k.startsWith("on") && typeof v === "function") {
      const name = k.slice(2).toLowerCase();
      any.__on ??= {};
      if (!(name in any.__on)) el.addEventListener(name, dispatch);
      any.__on[name] = v;
    } else if (k === "class") {
      if (svg) el.setAttribute("class", v);
      else el.className = v;
    } else if (k === "style") {
      const style = /** @type {any} */ (/** @type {HTMLElement} */ (el).style);
      if (typeof v === "string") style.cssText = v;
      else {
        if (old.style && typeof old.style === "object") for (const s in old.style) if (!(s in v)) style[s] = "";
        Object.assign(style, v);
      }
    } else if (!svg && k in el && k !== "list") any[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

/** @param {Element} el @param {string} k @param {any} was @param {boolean} svg */
function unset(el, k, was, svg) {
  const any = /** @type {any} */ (el);
  if (k === "key" || k === "ref" || k === "children") return;
  if (k.startsWith("on") && typeof was === "function") {
    if (any.__on) any.__on[k.slice(2).toLowerCase()] = null;
  } else if (k === "class") {
    if (svg) el.removeAttribute("class");
    else el.className = "";
  } else if (k === "style") {
    /** @type {HTMLElement} */ (el).style.cssText = "";
  } else if (!svg && k in el && k !== "list") {
    const now = any[k];
    if (typeof now === "boolean") any[k] = false;
    else if (typeof now === "string") any[k] = "";
    el.removeAttribute(k);
  } else el.removeAttribute(k);
}

// ---- components and their state ---------------------------------------------------------------

/** @type {Instance | null} */
let current = null;
let hook = 0;

/** @param {Instance} inst @returns {VNode} */
function draw(inst) {
  const was = current;
  const wasHook = hook;
  current = inst;
  hook = 0;
  try {
    const out = normalize([inst.type(inst.props)]);
    return out.length === 1 ? out[0] : normalize([h("span", { style: { display: "contents" } }, out)])[0];
  } finally {
    current = was;
    hook = wasHook;
  }
}

/** @type {Set<Instance>} */
const dirty = new Set();

/** redraw draws the components whose state changed, once, after the current task */
function redraw() {
  const list = [...dirty];
  dirty.clear();
  for (const inst of list) {
    if (inst.dead || !inst.child || !inst.vnode) continue;
    const child = draw(inst);
    inst.child = patch(/** @type {Node} */ (inst.child.dom).parentNode, inst.child, child, inst.svg);
    inst.vnode.dom = inst.child.dom;
  }
}

/**
 * useState keeps a value across a component's draws; setting it draws the component again.
 * @template T @param {T | (() => T)} init @returns {[T, (v: T | ((was: T) => T)) => void]}
 */
export function useState(init) {
  const inst = /** @type {Instance} */ (current);
  const k = hook++;
  if (!(k in inst.hooks)) {
    const set = (/** @type {any} */ v) => {
      const now = typeof v === "function" ? v(inst.hooks[k][0]) : v;
      if (Object.is(now, inst.hooks[k][0])) return;
      inst.hooks[k][0] = now;
      if (!dirty.size) queueMicrotask(redraw);
      dirty.add(inst);
    };
    inst.hooks[k] = [typeof init === "function" ? /** @type {any} */ (init)() : init, set];
  }
  return inst.hooks[k];
}

/** useRef keeps a box across a component's draws, which changing does not draw again @template T @param {T} init @returns {{current: T}} */
export function useRef(init) {
  const inst = /** @type {Instance} */ (current);
  const k = hook++;
  if (!(k in inst.hooks)) inst.hooks[k] = { current: init };
  return inst.hooks[k];
}
