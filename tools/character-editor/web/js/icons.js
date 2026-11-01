// @ts-check
// The editor's icons: small SVGs on a 24 unit grid, stroked in the current text colour. `icon`
// returns one as an element; buttons carry the meaning in their tooltip.

/** @type {Record<string, string>} each icon's SVG content; `F` paths are filled */
const ICONS = {
  logo: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/><circle cx="12" cy="12" r="1.6" class="F"/>`,
  model: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`,
  rig: `<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="12" cy="12" r="2"/><path d="M7.9 16.1l2.6-2.6M13.5 10.5l2.6-2.6"/>`,
  animation: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2l5 2.8-5 2.8z" class="F"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  child: `<path d="M5 4v8a4 4 0 0 0 4 4h4"/><path d="M18 12v8M14 16h8"/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>`,
  trash: `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`,
  x: `<path d="M7 7l10 10M17 7L7 17"/>`,
  undo: `<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>`,
  redo: `<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>`,
  assemble: `<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>`,
  explode: `<rect x="9.5" y="9.5" width="5" height="5" rx="1" class="F"/><path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3"/><path d="M4 4h3M4 4v3M20 4h-3M20 4v3M4 20h3M4 20v-3M20 20h-3M20 20v-3"/>`,
  frame: `<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2.2"/>`,
  save: `<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="7"/>`,
  warning: `<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>`,
  dot: `<circle cx="12" cy="12" r="4.5" class="F"/>`,
  play: `<path d="M8 5l11 7-11 7z" class="F"/>`,
  pause: `<rect x="6.5" y="5" width="3.5" height="14" rx="1" class="F"/><rect x="14" y="5" width="3.5" height="14" rx="1" class="F"/>`,
  start: `<path d="M6 5v14"/><path d="M18 5l-9 7 9 7z" class="F"/>`,
  loop: `<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>`,
  key: `<path d="M10 4l6 6-6 6-6-6z"/><path d="M19 14v7M15.5 17.5h7"/>`,
  capture: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>`,
  curve: `<path d="M3 17c4 0 5-10 9-10s5 10 9 10"/>`,
  clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`,
  reset: `<path d="M4 4v6h6"/><path d="M5.6 15A7.5 7.5 0 1 0 7.5 7L4 10"/>`,
  mirror: `<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>`,
  link: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  leg: `<path d="M10 3v10.5L6 18v2h11l-3-3V3"/>`,
  expandLeft: `<path d="M4 4v16"/><path d="M20 12H8M12 8l-4 4 4 4"/>`,
  expandRight: `<path d="M20 4v16"/><path d="M4 12h12M12 8l4 4-4 4"/>`,
  panelRight: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M17.5 8h1M17.5 11h1M17.5 14h1"/>`,
  new: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>`,
  import: `<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>`,
  export: `<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>`,
  move: `<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>`,
  rotate: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>`,
  kit: `<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V5h8v3M3 13h18M11 13v2h2v-2"/>`,
  scale: `<rect x="4" y="11" width="9" height="9" rx="1"/><path d="M13 4h7v7M20 4l-8 8"/>`,
  // IK targets in the view: hidden, a point, a point and its name
  targetHidden: `<circle cx="12" cy="12" r="4.5" stroke-dasharray="2.4 2.4"/><path d="M5 19L19 5"/>`,
  targetPoint: `<circle cx="12" cy="12" r="4.5" class="F"/>`,
  targetLabel: `<circle cx="7" cy="15" r="3.5" class="F"/><path d="M12 7h8M12 11h5"/>`,
  zoomIn: `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20M10.5 7.5v6M7.5 10.5h6"/>`,
  zoomOut: `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20M7.5 10.5h6"/>`,
  snap: `<rect x="4" y="12" width="16" height="8" rx="1"/><path d="M12 3v6M9 6l3 3 3-3"/>`,
    paint: `<path d="M12 3c3.5 4.5 6 7.6 6 10.5a6 6 0 0 1-12 0C6 10.6 8.5 7.5 12 3z"/>`,
  // the primitives
  BOX: `<path d="M12 4l7 4v8l-7 4-7-4V8z"/><path d="M12 12l7-4M12 12v8M12 12L5 8"/>`,
  WEDGE: `<path d="M3 18h18v-4L3 7z"/><path d="M3 18V7"/>`,
  CYLINDER: `<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>`,
  HALF_CYLINDER: `<path d="M5 19V9a7 7 0 0 1 14 0v10z"/>`,
  QUARTER_CYLINDER: `<path d="M5 19V6a13 13 0 0 1 13 13z"/>`,
  CONE: `<path d="M12 3L5 17.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5z"/>`,
  SPHERE: `<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>`,
};

/**
 * @param {string} name one of the ICONS
 * @param {number} [size] in pixels
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 16) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS("http://www.w3.org/2000/svg", "svg"));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? ICONS.x;
  return svg;
}
