/**
 * @file utils.js
 * @description Small DOM helpers and UI builders shared across the app.
 * Exports:
 *  - DOM helpers: qs, qsa, el, addClass, removeClass, toggleClass, hide, show
 *  - Misc: unique, by, colorForKey
 *  - UI: createElementBar, createPreferenceBar, setupPreferenceToggle
 */

/** ---------- DOM HELPERS ---------- **/

/**
 * Query a single element.
 * @param {string} sel CSS selector
 * @param {ParentNode} [root=document] Optional root
 * @returns {Element|null}
 */
export const qs  = (sel, root = document) => root.querySelector(sel);

/**
 * Query all elements (as an Array).
 * @param {string} sel CSS selector
 * @param {ParentNode} [root=document] Optional root
 * @returns {Element[]}
 */
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Create an element with classes/attributes.
 * @param {keyof HTMLElementTagNameMap} tag
 * @param {string|string[]} [classNames=[]]
 * @param {Record<string,string|number|boolean>} [attrs={}]
 * @returns {HTMLElement}
 */
export const el = (tag, classNames = [], attrs = {}) => {
    // Create element using tags
    const node = document.createElement(tag);

    // Set classes
    if (typeof classNames === "string") node.className = classNames;
    else if (Array.isArray(classNames)) node.classList.add(...classNames);

    // Set attributes 
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    
    // Return created node
    return node;
};

/**
 * Add one or more class names.
 * @param {Element} node
 * @param {...string} cls
 */
export const addClass = (node, ...cls) => node.classList.add(...cls);

/**
 * Remove one or more class names.
 * @param {Element} node
 * @param {...string} cls
 */
export const removeClass = (node, ...cls) => node.classList.remove(...cls);

/**
 * Toggle a class name, with optional force.
 * @param {Element} node
 * @param {string} cls
 * @param {boolean} [force]
 * @returns {boolean} New state
 */
export const toggleClass = (node, cls, force) => node.classList.toggle(cls, force);

/**
 * Add the "hidden" class.
 * @param {Element} node
 */
export const hide = (node) => addClass(node, "hidden");

/**
 * Remove the "hidden" class.
 * @param {Element} node
 */
export const show = (node) => removeClass(node, "hidden");


/** ---------- MISC HELPERS ---------- **/

/**
 * Return unique values in an array (preserves first occurrence order).
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export const unique = (arr) => Array.from(new Set(arr));

/**
 * Comparator factory for Array.prototype.sort().
 * @param {string} k Object key to compare by
 * @returns {(a:any,b:any)=>number}
 */
export const by = (k) => (a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0);

/**
 * Random-but-stable HSL color from a string key (e.g., an aspect name).
 * @param {string} key
 * @returns {string} CSS `hsl(...)` string
 */
export function colorForKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}


/** ---------- UI BUILDERS ---------- **/

/**
 * Create a compact “element bar” for a point and wire click to focus the map.
 * The parent provides the click handler to center/zoom and optionally open a popup.
 * @param {{name?:string, latitude:number, longitude:number, [key:string]:any}} p
 * @param {(lat:number, lng:number, point:object)=>void} onClick
 * @returns {HTMLDivElement}
 */
export function createElementBar(p, onClick) {
    // Create elememt bar 
    const bar = el("div", "bar element-bar");

    // Populate with the values
    bar.innerHTML = `
        <p class="element-bar-label bar-label">${p.name ?? "Unnamed"}</p>
        <p class="element-bar-label bar-label">${p.latitude + ", " + p.longitude}</p>
    `;

    // Attach click listener
    bar.addEventListener("click", () => onClick(p.latitude, p.longitude, p));
    
    // Return created element bar
    return bar;
}


/** ---------- Preference bar (Good / Bad / N/A) ---------- **/

/**
 * Turn an arbitrary string into a safe slug for element IDs.
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Build an icon path for a tri-state toggle button.
 * Filenames must exist under `static/icons/` as `*-outline.svg` and `*-filled.svg`.
 * @param {"good"|"bad"|"na"} kind
 * @param {boolean} filled
 * @returns {string}
 */
function iconPath(kind, filled) {
    const base = {
        good: ["arrow-up-outline.svg",   "arrow-up-filled.svg"],
        bad:  ["arrow-down-outline.svg", "arrow-down-filled.svg"],
        na:   ["x-outline.svg",          "x-filled.svg"]
    }[kind];
    return "static/icons/" + (filled ? base[1] : base[0]);
}

/**
 * Build a single preference bar for a given element type (e.g., “Parks”, “Bars”).
 * Only one of the 3 buttons can be active at a time; defaults to N/A.
 * @param {string} type
 * @param {(type:string, value:"good"|"bad"|"na")=>void} onChange Callback on change
 * @returns {HTMLDivElement}
 */
export function createPreferenceBar(type, onChange) {
    // Create slug and bar element's 
    const typeSlug = slugify(type);
    const bar = el("div", "bar preference-bar");
    const panel = el("div", "preference-bar-button-panel");

    // Per-type unique IDs keep the DOM valid and make testing easier.
    const btnGood = el("button", "preference-bar-btn", { type: "button", id: `${typeSlug}-good-button` });
    const btnBad  = el("button", "preference-bar-btn", { type: "button", id: `${typeSlug}-bad-button` });
    const btnNA   = el("button", "preference-bar-btn", { type: "button", id: `${typeSlug}-na-button` });

    const imgGood = el("img", "bar-icon", { src: iconPath("good", false), alt: "Good" });
    const imgBad  = el("img", "bar-icon", { src: iconPath("bad",  false), alt: "Bad"  });
    const imgNA   = el("img", "bar-icon", { src: iconPath("na",   true ),  alt: "N/A"  }); // start filled

    // Attach icons to the buttons
    btnGood.appendChild(imgGood);
    btnBad.appendChild(imgBad);
    btnNA.appendChild(imgNA);

    // Attach buttons to the panel
    panel.append(btnGood, btnBad, btnNA);

    // Create and attach the label
    const label = el("p", ["preference-bar-label", "bar-label"]);
    label.textContent = type;
    bar.append(panel, label);

    // --- Tri-state selection logic ---
    /** @type {"good"|"bad"|"na"} */
    let current = "na";

    /**
     * @param {"good"|"bad"|"na"} value
     */
    function setSelection(value) {
        // reset to outlines
        imgGood.setAttribute("src", iconPath("good", false));
        imgBad .setAttribute("src", iconPath("bad",  false));
        imgNA  .setAttribute("src", iconPath("na",   false));

        // fill the chosen one
        if (value === "good")      imgGood.setAttribute("src", iconPath("good", true));
        else if (value === "bad")  imgBad.setAttribute("src",  iconPath("bad",  true));
        else                       imgNA.setAttribute("src",   iconPath("na",   true));

        current = value;
        onChange?.(type, current);
    }

    // Initialize as N/A
    onChange?.(type, current);

    // Clicks (no bubbling—keeps parent bars from misfiring)
    btnGood.addEventListener("click", (e) => { e.stopPropagation(); if (current !== "good") setSelection("good"); });
    btnBad .addEventListener("click", (e) => { e.stopPropagation(); if (current !== "bad")  setSelection("bad");  });
    btnNA  .addEventListener("click", (e) => { e.stopPropagation(); if (current !== "na")   setSelection("na");   });

    // Return created element bar
    return bar;
}


/** ---------- Preference toggle (Elements ⇄ Preferences) ---------- **/

/**
 * Wire a single button that toggles visibility between the Elements panel
 * and the Preferences panel, updating the button label and .on class.
 * @param {string} btnSelector        CSS selector for the toggle button
 * @param {string} elementsSelector   CSS selector for the Elements panel
 * @param {string} prefsSelector      CSS selector for the Preferences panel
 */
export function setupPreferenceToggle(btnSelector, elementsSelector, prefsSelector) {
    // Determine button and panels
    const btn = qs(btnSelector);
    const elementsPanel = qs(elementsSelector);
    const prefPanel = qs(prefsSelector);

    // Check any are invalid
    if (!btn || !elementsPanel || !prefPanel) {
        console.warn("Preference toggle: missing one or more elements");
        return;
    }

    // Attach click listener
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        const showingPrefs = !prefPanel.classList.contains("hidden");

        // Invert the visiablility of preference and element bars 
        if (showingPrefs) {
            hide(prefPanel);
            show(elementsPanel);
            btn.classList.remove("on");
            btn.textContent = "Preferences";
        } 
        else {
            hide(elementsPanel);
            show(prefPanel);
            btn.classList.add("on");
            btn.textContent = "Elements";
        }
    });
}
