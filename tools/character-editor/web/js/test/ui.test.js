// The UI core's tests: `node --test tools/character-editor/web/js/test`, over the small DOM of
// fakedom.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeElement, FakeText, install } from "./fakedom.js";

install();
const { h, render, useState, useRef } = await import("../ui/vdom.js");
const { signal, computed, effect, batch } = await import("../ui/signal.js");

const box = () => new FakeElement("div");
const tick = () => new Promise((r) => queueMicrotask(r));

// ---- vdom ----------------------------------------------------------------------------------------

test("render shows the tree, and a second render reuses its elements", () => {
  const root = box();
  render(h("ul", { class: "list" }, h("li", null, "a"), h("li", null, "b")), root);
  const ul = root.childNodes[0];
  assert.equal(ul.className, "list");
  assert.equal(ul.textContent, "ab");
  const [a, b] = ul.childNodes;
  render(h("ul", { class: "list on" }, h("li", null, "a"), h("li", null, "c")), root);
  assert.equal(root.childNodes[0], ul, "the same ul");
  assert.equal(ul.className, "list on");
  assert.deepEqual(ul.childNodes, [a, b], "the same lis");
  assert.equal(ul.textContent, "ac");
});

test("keyed children move with their elements, inserted and removed in the middle", () => {
  const root = box();
  const draw = (keys) => render(keys.map((k) => h("p", { key: k }, k)), root);
  draw(["a", "b", "c", "d"]);
  const [a, b, c, d] = root.childNodes;
  draw(["d", "a", "x", "c"]);
  assert.equal(root.textContent, "daxc");
  assert.equal(root.childNodes[0], d);
  assert.equal(root.childNodes[1], a);
  assert.equal(root.childNodes[3], c);
  assert.equal(b.parentNode, null, "b is gone");
});

test("a focused text field keeps what is typed; a range does not", () => {
  const root = box();
  const draw = (v) => render([h("input", { type: "text", value: v }), h("input", { type: "range", value: v })], root);
  draw("1");
  const [text, range] = root.childNodes;
  text.focus();
  text.value = "12";
  draw("5");
  assert.equal(text.value, "12", "typing is not overwritten");
  assert.equal(range.value, "5");
  globalThis.document.activeElement = null;
  draw("6");
  assert.equal(text.value, "6", "after it lets go, the data shows");
});

test("listeners swap without piling up; removed props are removed", () => {
  const root = box();
  const calls = [];
  render(h("button", { onclick: () => calls.push(1), disabled: true, title: "t", "data-x": "1" }), root);
  const b = root.childNodes[0];
  assert.equal(b.disabled, true);
  render(h("button", { onclick: () => calls.push(2) }), root);
  b.fire("click");
  assert.deepEqual(calls, [2], "only the current handler, once");
  assert.equal(b.listeners.get("click").length, 1);
  assert.equal(b.disabled, false);
  assert.equal(b.title, "");
  assert.equal(b.getAttribute("data-x"), null);
  render(h("button", null), root);
  b.fire("click");
  assert.deepEqual(calls, [2], "a handler taken away no longer runs");
});

test("a select's value is set after its options; style keys are diffed", () => {
  const root = box();
  render(h("select", { value: "b", style: { width: "10px", color: "red" } }, h("option", { value: "a" }), h("option", { value: "b" })), root);
  const s = root.childNodes[0];
  assert.equal(s.value, "b");
  render(h("select", { value: "a", style: { width: "20px" } }, h("option", { value: "a" })), root);
  assert.equal(s.value, "a");
  assert.equal(s.style.width, "20px");
  assert.equal(s.style.color, "");
});

test("a changed tag replaces the element; DOM nodes pass through, equal ones kept", () => {
  const root = box();
  const icon = () => {
    const e = new FakeElement("svg");
    e.appendChild(new FakeText("x"));
    return e;
  };
  const first = icon();
  render([h("div", null, "a"), first], root);
  const div = root.childNodes[0];
  render([h("span", null, "a"), icon()], root);
  assert.notEqual(root.childNodes[0], div);
  assert.equal(root.childNodes[0].tagName, "SPAN");
  assert.equal(root.childNodes[1], first, "an equal node keeps the one shown");
});

test("components keep their state across draws and redraw themselves", async () => {
  const root = box();
  let set;
  const Counter = (/** @type {any} */ p) => {
    const [n, setN] = useState(0);
    const drawn = useRef(0);
    drawn.current++;
    set = setN;
    return h("b", null, `${p.label}${n}:${drawn.current}`);
  };
  render(h("div", null, h(Counter, { label: "x" })), root);
  const b = root.childNodes[0].childNodes[0];
  assert.equal(b.textContent, "x0:1");
  set(5);
  await tick();
  assert.equal(b.textContent, "x5:2", "set draws it again, the same element");
  render(h("div", null, h(Counter, { label: "y" })), root);
  assert.equal(root.childNodes[0].childNodes[0], b);
  assert.equal(b.textContent, "y5:3", "new props, state kept");
  render(h("div", null, h("i", null)), root);
  set(9);
  await tick();
  assert.equal(root.childNodes[0].childNodes[0].tagName, "I", "an unmounted component draws no more");
});

test("refs are called with the element when made", () => {
  const root = box();
  let got = null;
  render(h("canvas", { ref: (e) => (got = e) }), root);
  assert.equal(got, root.childNodes[0]);
});

// ---- signals -------------------------------------------------------------------------------------

test("a computed is lazy and cached until what it read changes", () => {
  const a = signal(1);
  const b = signal(10);
  let runs = 0;
  const sum = computed(() => (runs++, a.value + b.value));
  assert.equal(runs, 0, "lazy");
  assert.equal(sum.value, 11);
  assert.equal(sum.value, 11);
  assert.equal(runs, 1, "cached");
  a.value = 2;
  assert.equal(runs, 1, "still lazy after a change");
  assert.equal(sum.value, 12);
  assert.equal(runs, 2);
});

test("an effect runs again when what it read changes; batch notifies once; dispose stops it", () => {
  const a = signal(1);
  const twice = computed(() => a.value * 2);
  const seen = [];
  const stop = effect(() => seen.push(twice.value));
  a.value = 2;
  batch(() => {
    a.value = 3;
    a.value = 4;
  });
  a.value = 4; // unchanged: nothing
  assert.deepEqual(seen, [2, 4, 8]);
  stop();
  a.value = 5;
  assert.deepEqual(seen, [2, 4, 8]);
});

test("an effect's dependencies follow what it read last", () => {
  const which = signal(true);
  const a = signal("a");
  const b = signal("b");
  const seen = [];
  effect(() => seen.push(which.value ? a.value : b.value));
  which.value = false;
  a.value = "A"; // no longer read
  b.value = "B";
  assert.deepEqual(seen, ["a", "b", "B"]);
});

test("a scheduled effect runs once for many changes", () => {
  const a = signal(0);
  /** @type {(() => void)[]} */
  const later = [];
  let runs = 0;
  effect(
    () => (a.value, runs++),
    (run) => later.push(run),
  );
  a.value = 1;
  a.value = 2;
  assert.equal(runs, 1);
  assert.equal(later.length, 1, "scheduled once");
  later[0]();
  assert.equal(runs, 2);
});
