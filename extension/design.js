import { fillIcons, mark } from "./icons.js";

fillIcons();
for (const el of document.querySelectorAll("[data-mark]")) el.outerHTML = mark({ size: Number(el.dataset.mark) });
