// Icons from Lucide (https://lucide.dev), ISC license.

const PATHS = {
  check: `<path d="M20 6 9 17l-5-5"/>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "chevron-left": `<path d="m15 18-6-6 6-6"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
  "ellipsis-vertical": `<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  "trash-2": `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
};

/** An inline SVG icon. With `label` it's announced; otherwise it's decorative. */
export function icon(name, { cls = "", label = "" } = {}) {
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="lucide ${cls}" ${a11y} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
}

/** Fill in `<svg data-icon="name">` placeholders in static HTML. */
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) el.outerHTML = icon(el.dataset.icon, { cls: el.getAttribute("class") ?? "" });
}
