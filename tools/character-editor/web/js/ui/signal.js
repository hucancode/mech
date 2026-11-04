// @ts-check
// Signals: values that say when they change. A `signal` holds a value; a `computed` derives one
// from others, lazily, and caches it until one of them changes; an `effect` runs a function now
// and again whenever a value it read changes (by default at once, or when its `schedule` says, a
// frame later for drawing). `batch` lets several changes notify once. Reading `.value` inside a
// computed or an effect subscribes it; `.peek()` reads without subscribing.

/** @typedef {{stale: () => void, deps: Set<Source>}} Observer */
/** @typedef {{subs: Set<Observer>}} Source */

/** @type {Observer | null} the computed or effect running now, which reads subscribe */
let running = null;
let depth = 0;
/** @type {Set<Effect>} effects to run when the outermost batch ends */
const queued = new Set();

/** @param {Source} s */
function track(s) {
  if (!running) return;
  s.subs.add(running);
  running.deps.add(s);
}

/** @param {Source} s */
function notify(s) {
  depth++;
  try {
    for (const o of [...s.subs]) o.stale();
  } finally {
    end();
  }
}

function end() {
  if (--depth > 0) return;
  while (queued.size) {
    const list = [...queued];
    queued.clear();
    for (const e of list) e.schedule(() => e.run());
  }
}

/** @param {Observer} o: forget what it read, before reading again */
function untrack(o) {
  for (const s of o.deps) s.subs.delete(o);
  o.deps.clear();
}

/** @template T */
export class Signal {
  /** @param {T} value */
  constructor(value) {
    this.v = value;
    /** @type {Set<Observer>} */
    this.subs = new Set();
  }
  get value() {
    track(this);
    return this.v;
  }
  set value(v) {
    if (Object.is(v, this.v)) return;
    this.v = v;
    notify(this);
  }
  peek() {
    return this.v;
  }
}

/** @template T */
export class Computed {
  /** @param {() => T} fn */
  constructor(fn) {
    this.fn = fn;
    /** @type {T | undefined} */
    this.v = undefined;
    this.dirty = true;
    /** @type {Set<Observer>} */
    this.subs = new Set();
    /** @type {Set<Source>} */
    this.deps = new Set();
  }
  stale() {
    if (this.dirty) return;
    this.dirty = true;
    for (const o of [...this.subs]) o.stale();
  }
  get value() {
    track(this);
    return this.peek();
  }
  /** @returns {T} */
  peek() {
    if (this.dirty) {
      untrack(this);
      const was = running;
      running = this;
      try {
        this.v = this.fn();
      } finally {
        running = was;
      }
      this.dirty = false;
    }
    return /** @type {T} */ (this.v);
  }
}

export class Effect {
  /** @param {() => void} fn @param {(run: () => void) => void} schedule */
  constructor(fn, schedule) {
    this.fn = fn;
    this.schedule = schedule;
    /** @type {Set<Source>} */
    this.deps = new Set();
    this.waiting = false;
    this.disposed = false;
  }
  stale() {
    if (this.waiting || this.disposed) return;
    this.waiting = true;
    queued.add(this);
  }
  run() {
    this.waiting = false;
    if (this.disposed) return;
    untrack(this);
    const was = running;
    running = this;
    try {
      this.fn();
    } finally {
      running = was;
    }
  }
  dispose() {
    this.disposed = true;
    untrack(this);
  }
}

/** @template T @param {T} value */
export const signal = (value) => new Signal(value);

/** @template T @param {() => T} fn */
export const computed = (fn) => new Computed(fn);

/**
 * effect runs `fn` now, and again whenever a value it read changes: at once, or through
 * `schedule` (`frame` runs it once on the next animation frame however often it changed). Returns
 * a function that stops it.
 * @param {() => void} fn @param {(run: () => void) => void} [schedule]
 */
export function effect(fn, schedule = (run) => run()) {
  const e = new Effect(fn, schedule);
  e.run();
  return () => e.dispose();
}

/** batch runs `fn`, notifying once when it is done however many values it changed @param {() => void} fn */
export function batch(fn) {
  depth++;
  try {
    fn();
  } finally {
    end();
  }
}

/** frame schedules an effect's run on the next animation frame @param {() => void} run */
export const frame = (run) => requestAnimationFrame(run);
