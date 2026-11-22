// A small, escape-first Markdown renderer for agent replies. Handles what
// agents write: headings, paragraphs, emphasis, inline code, links, nested
// lists, tables, block quotes, fenced code and rules. It's re-run on the
// whole text as replies stream in, so unfinished syntax (an open code fence,
// half a table) must render sensibly.

import { icon } from "./icons.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Inline Markdown in already-unescaped text. Code spans are protected first. */
export function inline(src, { modLinks = false } = {}) {
  const codes = [];
  let s = String(src).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => {
    const html = `<code>${esc(code.trim() || code)}</code>`;
    const mod = modLinks && modId(code.trim());
    codes.push(mod ? `<a class="mod-link" data-mod="${esc(mod)}" data-text="${esc(code.trim())}">${html}</a>` : html);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links = [];
  s = s.replace(/\[([^\]\n]+)\]\(\s*<?((?:https?:\/\/|mailto:)[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => {
    links.push({ text, url });
    return `\u0001${links.length - 1}\u0001`;
  });
  s = esc(s);
  // Bare URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
  s = emphasis(s);
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => {
    const { text, url } = links[i];
    return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${emphasis(esc(text))}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

/**
 * The mod a code span names, if it's a mod file: `foo.user.js`, or a path to
 * one in the mods folder (`~/.eyepatch/mods/foo.user.css`). Same rule as
 * Agent Bridge's mod ids.
 */
function modId(code) {
  const m = /^(?:(?:\S*\/)?mods\/)?([a-z0-9][a-z0-9._-]*\.user\.(?:js|css))$/i.exec(code);
  return m ? m[1] : null;
}

/** Inline Markdown in an agent reply, where mod file names are links. */
const blockInline = (s) => inline(s, { modLinks: true });

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;

export function markdown(src) {
  return blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

function blocks(lines) {
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or past the end while streaming)
      html += codeBlock(body.join("\n"), m[2]);
    } else if ((m = HEADING.exec(line))) {
      const level = Math.min(m[1].length, 3);
      html += `<h${level}>${blockInline(m[2])}</h${level}>`;
      i++;
    } else if (HR.test(line)) {
      html += "<hr>";
      i++;
    } else if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || body.length)) {
        if (!QUOTE.test(lines[i]) && (ITEM.test(lines[i]) || FENCE.test(lines[i]) || HEADING.test(lines[i]))) break;
        body.push(lines[i++].replace(QUOTE, ""));
      }
      html += `<blockquote>${blocks(body)}</blockquote>`;
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const rows = [];
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align: ${align[j]}"` : ""}>${blockInline(c)}</${tag}>`;
      html +=
        `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${head.map((_, j) => td("td", r[j] ?? "", j)).join("")}</tr>`).join("")}</tbody></table></div>`;
    } else if (ITEM.test(line)) {
      const start = i;
      const base = indentOf(line);
      const ordered = (l) => /\d/.test(ITEM.exec(l)[2]);
      const kind = ordered(line);
      // An item of the other kind at this indent starts a new list.
      const otherList = (l) => ITEM.test(l) && indentOf(l) === base && ordered(l) !== kind;
      i++;
      // The list runs until a blank line followed by something that isn't part of it, or a less-indented block.
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next === undefined || otherList(next) || (!(ITEM.test(next) && indentOf(next) >= base) && indentOf(next) <= base)) break;
          i++;
          continue;
        }
        if (indentOf(l) < base || otherList(l)) break;
        if (indentOf(l) === base && !ITEM.test(l) && (HEADING.test(l) || FENCE.test(l) || HR.test(l) || QUOTE.test(l))) break;
        i++;
      }
      html += list(lines.slice(start, i));
    } else {
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !(para.length && (FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i])))
      ) {
        if (lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && para.length) break;
        para.push(lines[i++].trim());
      }
      html += `<p>${para.map(blockInline).join("<br>")}</p>`;
    }
  }
  return html;
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Lines of one list (and its nested content) at the first item's indent. */
function list(lines) {
  const base = indentOf(lines[0]);
  const ordered = /\d/.test(ITEM.exec(lines[0])[2]);
  const items = [];
  for (const l of lines) {
    const m = ITEM.exec(l);
    if (m && indentOf(l) === base) items.push([m[3]]);
    else if (items.length) items[items.length - 1].push(indentOf(l) > base ? l.slice(Math.min(indentOf(l), base + 2)) : l);
  }
  const start = ordered ? parseInt(ITEM.exec(lines[0])[2], 10) : 1;
  const tag = ordered ? "ol" : "ul";
  const body = items
    .map(([first, ...rest]) => {
      const task = /^\[([ xX])\]\s+/.exec(first);
      const lead = task ? `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ` : "";
      const text = task ? first.slice(task[0].length) : first;
      const nested = rest.some((l) => l.trim()) ? blocks(dedent(rest)) : "";
      return `<li>${lead}${blockInline(text)}${nested}</li>`;
    })
    .join("");
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`;
}

function dedent(lines) {
  const n = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => l.slice(Math.min(n, indentOf(l))));
}

export function codeBlock(code, lang = "") {
  return (
    `<div class="code-block"><div class="code-head"><span class="lang">${esc(lang || "text")}</span>` +
    `<button type="button" class="icon-btn" data-copy aria-label="Copy code" title="Copy">${icon("copy", { size: 14 })}</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`
  );
}
