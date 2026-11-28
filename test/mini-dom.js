class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.id = attrs.id || "";
    this.className = attrs.class || attrs.className || "";
    this.hidden = !!attrs.hidden;
    this.disabled = !!attrs.disabled;
    this.style = { ...(attrs.style || {}) };
    this.value = attrs.value || "";
    this.text = attrs.text || "";
    this.children = [];
    this.parentElement = null;
    this.clicked = 0;
    this.events = [];
    for (const kid of kids) this.append(kid);
  }

  append(kid) {
    kid.parentElement = this;
    this.children.push(kid);
    return kid;
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  get classList() {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    return { has: (name) => classes.has(name) };
  }

  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === "id") this.id = String(value);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.tagName && matches(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  dispatchEvent(event) {
    this.events.push(event);
  }

  addEventListener(_type, fn) {
    (this.listeners || (this.listeners = [])).push(fn);
  }

  click() {
    this.clicked += 1;
    const event = { preventDefault() { this.defaultPrevented = true; } };
    const chain = [];
    let node = this;
    while (node) {
      chain.push(node);
      node = node.parentElement;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      for (const fn of chain[i].listeners || []) fn(event);
    }
    this.defaultPrevented = !!event.defaultPrevented;
  }
}

function matchCompound(el, compound) {
  let rest = compound.trim();
  if (!rest || rest === "*") return true;
  if (/^[a-zA-Z]/.test(rest)) {
    const tag = /^[a-zA-Z][\w-]*/.exec(rest);
    if (!tag || el.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    if (rest[0] === "#") {
      const id = /^#([^\s#.[]+)/.exec(rest);
      if (!id || el.id !== id[1]) return false;
      rest = rest.slice(id[0].length);
    } else if (rest[0] === ".") {
      const cls = /^\.([^\s#.[]+)/.exec(rest);
      if (!cls || !el.classList.has(cls[1])) return false;
      rest = rest.slice(cls[0].length);
    } else if (rest[0] === "[") {
      const attr = /^\[([^\s=~|^$*\]]+)(?:(\*=|=)["']([^"']*)["'])?\]/.exec(rest);
      if (!attr) return false;
      const value = el.getAttribute(attr[1]);
      if (attr[2] === "=" && value !== attr[3]) return false;
      if (attr[2] === "*=" && (value == null || !String(value).includes(attr[3]))) return false;
      if (!attr[2] && value == null) return false;
      rest = rest.slice(attr[0].length);
    } else return false;
  }
  return true;
}

function matches(el, selector) {
  return String(selector)
    .split(",")
    .some((group) => {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || !matchCompound(el, parts[parts.length - 1])) return false;
      let node = el;
      for (let i = parts.length - 2; i >= 0; i--) {
        let parent = node.parentElement;
        let found = false;
        while (parent) {
          if (parent.tagName && matchCompound(parent, parts[i])) {
            node = parent;
            found = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (!found) return false;
      }
      return true;
    });
}

function documentFrom(body) {
  const root = new El("document");
  root.body = body;
  root.children = [body];
  body.parentElement = root;
  root.visibilityState = "visible";
  root.hasFocus = () => true;
  root.querySelectorAll = (selector) => body.querySelectorAll(selector);
  root.querySelector = (selector) => body.querySelector(selector);
  return root;
}

module.exports = { El, documentFrom, matches };
