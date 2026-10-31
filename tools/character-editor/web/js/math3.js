// @ts-check
// Small 3D math for the page's own work (mirroring, gizmos): 3×3 matrices (row major, 9
// numbers), vectors, quaternions [x, y, z, w] and euler angles as the model files hold them
// (radians, R = Rx · Ry · Rz; mech.euler in src/mech/model.odin).

/** @typedef {number[]} M3 */

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** @param {M3} a @param {M3} b @returns {M3} */
export function mul(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}
/** @param {M3} a @param {number[]} v */
export const apply = (a, v) => [0, 1, 2].map((r) => a[r * 3] * v[0] + a[r * 3 + 1] * v[1] + a[r * 3 + 2] * v[2]);
/** @param {M3} a @returns {M3} */
export const transpose = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
/** @param {number[]} v */
export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return v.map((c) => c / l);
}
/** @param {number[]} a @param {number[]} b */
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
export const add = (a, b) => a.map((c, k) => c + b[k]);
/** @param {number[]} a @param {number} s */
export const scale = (a, s) => a.map((c) => c * s);
/** I - 2ddᵀ @param {number[]} d @returns {M3} */
export const reflection = (d) => IDENTITY.map((x, k) => x - 2 * d[Math.floor(k / 3)] * d[k % 3]);

/** @param {number[]} q [x, y, z, w] @returns {M3} */
export function fromQuat([x, y, z, w]) {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

/** a turn of `angle` radians about axis 0 (x), 1 (y) or 2 (z) @param {number} axis @param {number} angle @returns {M3} */
export function rotation(axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** euler angles to a matrix: Rx · Ry · Rz @param {number[] | undefined} r @returns {M3} */
export function euler(r) {
  const [x, y, z] = r ?? [0, 0, 0];
  return mul(mul(rotation(0, x), rotation(1, y)), rotation(2, z));
}

/** euler's inverse (mech.euler_from) @param {M3} m */
export function eulerFrom(m) {
  const y = Math.atan2(m[2], Math.hypot(m[0], m[1]));
  if (Math.hypot(m[0], m[1]) > 1e-5) return [Math.atan2(-m[5], m[8]), y, Math.atan2(-m[1], m[0])];
  return [Math.atan2(m[7], m[4]), y, 0];
}
