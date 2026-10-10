// Strings always become text nodes, so model output and page text can't inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  setProps(el, props);
  appendChildren(el, children);
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  appendChildren(el, children);
  return el;
}

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'selected', 'open']);

function setProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (PROPERTIES.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

// 24x24 stroke icons.
const ICONS = {
  arrowRight: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  dash: [['path', { d: 'M6 12h12' }]],
};

export function icon(name, size = 18) {
  const el = svg('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: 'icon',
  });
  for (const [tag, attrs] of ICONS[name] || []) el.append(svg(tag, attrs));
  return el;
}
