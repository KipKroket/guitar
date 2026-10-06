// Guitar — two small shared pieces of UI so every screen asks for "more
// options" the same way:
//   GuitarUI.openMenu(anchorEl, items)  a popover list under a "..." button
//   GuitarUI.openSheet({ title, render }) a bottom sheet with a scrim
// Both live in .app (so they inherit the palette and the phone-width shell)
// and above every overlay. Only one is open at a time.
(function () {
  let open = null; // { node, scrim, onClose }

  function host() {
    return document.querySelector(".app") || document.body;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function close() {
    if (!open) return;
    const cur = open;
    open = null;
    document.removeEventListener("keydown", onKey, true);
    cur.scrim.remove();
    if (cur.node !== cur.scrim) cur.node.remove();
    if (cur.onClose) cur.onClose();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function mount(node, scrim, onClose) {
    close();
    host().appendChild(scrim);
    if (node !== scrim) host().appendChild(node);
    open = { node, scrim, onClose };
    document.addEventListener("keydown", onKey, true);
  }

  // items: [{ label, icon (svg markup), onClick, danger, hidden, disabled, divider }]
  function openMenu(anchorEl, items) {
    const scrim = el("div", "ui-scrim ui-scrim--clear");
    scrim.addEventListener("click", close);
    const menu = el("div", "ui-menu");
    menu.setAttribute("role", "menu");
    items
      .filter((it) => it && !it.hidden)
      .forEach((it) => {
        if (it.divider) {
          menu.appendChild(el("hr", "ui-menu__divider"));
          return;
        }
        const b = el("button", "ui-menu__item" + (it.danger ? " is-danger" : ""));
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.disabled = !!it.disabled;
        if (it.icon) {
          const ic = el("span", "ui-menu__icon");
          ic.innerHTML = it.icon;
          b.appendChild(ic);
        }
        b.appendChild(el("span", "ui-menu__label", it.label));
        b.addEventListener("click", () => {
          close();
          if (it.onClick) it.onClick();
        });
        menu.appendChild(b);
      });
    mount(menu, scrim);
    // Anchor under the "..." button, right-aligned to it, clamped to the shell.
    const appRect = host().getBoundingClientRect();
    const r = anchorEl.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom - appRect.top + 6) + "px";
    menu.style.right = Math.max(8, Math.round(appRect.right - r.right)) + "px";
    const first = menu.querySelector("button:not([disabled])");
    if (first) first.focus({ preventScroll: true });
    return { close };
  }

  // render(body, api) fills the sheet; api.close() dismisses it. Returns api.
  function openSheet(opts) {
    const scrim = el("div", "ui-scrim");
    scrim.addEventListener("click", close);
    const sheet = el("div", "ui-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    if (opts.title) sheet.setAttribute("aria-label", opts.title);
    sheet.appendChild(el("span", "ui-sheet__grab"));
    if (opts.title) sheet.appendChild(el("h2", "ui-sheet__title", opts.title));
    const body = el("div", "ui-sheet__body");
    sheet.appendChild(body);
    mount(sheet, scrim, opts.onClose);
    const api = { close, body, sheet };
    if (opts.render) opts.render(body, api);
    return api;
  }

  // A labelled switch row: [text ... switch].
  function switchRow(label, hint, checked, onChange) {
    const row = el("div", "ui-row");
    const text = el("div", "ui-row__text");
    text.appendChild(el("span", null, label));
    if (hint) text.appendChild(el("small", null, hint));
    row.appendChild(text);
    const sw = el("button", "ui-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", label);
    sw.setAttribute("aria-checked", checked ? "true" : "false");
    sw.addEventListener("click", () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", next ? "true" : "false");
      onChange(next);
    });
    row.appendChild(sw);
    return row;
  }

  // A labelled -/+ stepper row. format(value) -> string.
  function stepperRow(label, hint, format, onStep) {
    const row = el("div", "ui-row");
    const text = el("div", "ui-row__text");
    text.appendChild(el("span", null, label));
    if (hint) text.appendChild(el("small", null, hint));
    row.appendChild(text);
    const wrap = el("div", "ui-stepper");
    const minus = el("button", null, "−");
    minus.type = "button";
    minus.setAttribute("aria-label", label + " down");
    const val = el("b", null, "");
    const plus = el("button", null, "+");
    plus.type = "button";
    plus.setAttribute("aria-label", label + " up");
    const apply = (v) => { val.textContent = format(v); };
    minus.addEventListener("click", () => apply(onStep(-1)));
    plus.addEventListener("click", () => apply(onStep(1)));
    wrap.appendChild(minus);
    wrap.appendChild(val);
    wrap.appendChild(plus);
    row.appendChild(wrap);
    apply(onStep(0));
    return row;
  }

  window.GuitarUI = { openMenu, openSheet, close, switchRow, stepperRow, el, isOpen: () => !!open };
})();
