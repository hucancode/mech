// A small DOM for the editor's tests under Node (`node --test tools/character-editor/web/js/test`):
// just what the UI core and the editor's shell touch, no layout, no drawing. Installing it sets
// the browser's globals; `frames()` runs what asked for an animation frame.

class FakeNode {
  constructor() {
    /** @type {FakeNode[]} */
    this.childNodes = [];
    /** @type {FakeNode | null} */
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }
  get parentElement() {
    return this.parentNode;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(n) {
    return this.insertBefore(n, null);
  }
  append(...ns) {
    for (const n of ns) this.appendChild(typeof n === "string" ? new FakeText(n) : n);
  }
  insertBefore(n, ref) {
    n.parentNode?.removeChild(n);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    this.childNodes.splice(this.childNodes.indexOf(n), 1);
    n.parentNode = null;
    // a removed element loses the focus
    if (globalThis.document.activeElement === n) globalThis.document.activeElement = null;
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceChild(n, old) {
    this.insertBefore(n, old);
    return this.removeChild(old);
  }
  replaceChildren(...ns) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...ns);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(t) {
    this.replaceChildren(new FakeText(String(t)));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  isEqualNode(o) {
    return o instanceof FakeText && o.data === this.data;
  }
}

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  get list() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  add(c) {
    if (!this.contains(c)) this.el.className = [...this.list, c].join(" ");
  }
  remove(c) {
    this.el.className = this.list.filter((x) => x !== c).join(" ");
  }
  toggle(c, on = !this.contains(c)) {
    on ? this.add(c) : this.remove(c);
    return on;
  }
  contains(c) {
    return this.list.includes(c);
  }
}

class FakeElement extends FakeNode {
  constructor(tag, ns = "") {
    super();
    this.tagName = tag.toUpperCase();
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.className = "";
    this.style = { setProperty() {}, cssText: "" };
    this.dataset = {};
    this.listeners = new Map();
    this.title = "";
    this.id = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = -1;
    this.draggable = false;
    this.innerHTML = "";
    this.clientWidth = 800;
    this.clientHeight = 200;
    this.scrollTop = 0;
    this.classList = new FakeClassList(this);
    // what form controls have
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON", "OPTION"].includes(this.tagName)) {
      this.value = "";
      this.checked = false;
      this.type = this.tagName === "INPUT" ? "text" : "";
      this.placeholder = "";
      this.inputMode = "";
      this.autofocus = false;
      this.min = "";
      this.max = "";
      this.step = "";
    }
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(name, fn) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }
  /** fire calls the element's listeners for event `name`, with `extra` on the event */
  fire(name, extra = {}) {
    const e = { type: name, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.listeners.get(name) ?? []) fn.call(this, e);
  }
  dispatchEvent() {
    return true;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }
  click() {
    this.fire("click");
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
  }
  showModal() {}
  close() {
    this.fire("close");
  }
  isEqualNode(o) {
    return o instanceof FakeElement && o.tagName === this.tagName && o.innerHTML === this.innerHTML && o.textContent === this.textContent;
  }
  /** every element under this one, depth first */
  *all() {
    for (const c of this.children) {
      yield c;
      yield* c.all();
    }
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

/** @type {(() => void)[]} */
let frameQueue = [];

/** install sets the browser's globals to the small DOM; `ids` are the page's elements by id */
export function install(ids = []) {
  const body = new FakeElement("body");
  const byId = new Map();
  for (const id of ids) {
    const e = new FakeElement(id === "canvas" ? "canvas" : "div");
    e.id = id;
    byId.set(id, e);
    body.appendChild(e);
  }
  const store = new Map();
  Object.assign(globalThis, {
    Node: FakeNode,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      activeElement: null,
      body,
      documentElement: body,
      createElement: (t) => new FakeElement(t),
      createElementNS: (ns, t) => new FakeElement(t, ns),
      createTextNode: (d) => new FakeText(d),
      getElementById: (id) => byId.get(id) ?? null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 1600, innerHeight: 1000 },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    requestAnimationFrame: (fn) => frameQueue.push(fn),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class {
      observe() {}
    },
    CSS: { escape: (s) => s },
    confirm: () => true,
    prompt: () => null,
  });
  return { body, byId };
}

/** frames runs what asked for an animation frame (and what that asks for, up to `n` rounds) */
export function frames(n = 4) {
  for (let i = 0; i < n && frameQueue.length; i++) {
    const run = frameQueue;
    frameQueue = [];
    for (const fn of run) fn(0);
  }
}

export { FakeElement, FakeNode, FakeText };
