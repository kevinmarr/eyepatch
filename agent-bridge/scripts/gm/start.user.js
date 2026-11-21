// ==UserScript==
// @name         GM API suite (document-start)
// @namespace    eyepatch-tests
// @version      1.0
// @description  Values must be readable before the page starts loading.
// @match        http://127.0.0.1:8124/suite.html*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

const count = GM_getValue("startCount", 0);
GM_setValue("startCount", count + 1);
document.documentElement.dataset.start = JSON.stringify({ readyState: document.readyState, count });
