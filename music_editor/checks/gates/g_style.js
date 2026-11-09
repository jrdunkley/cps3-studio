/* GATE G14 (docs/plan/06_GATES.md, package B1): the Studio uses only the kit's styles, and every action is described.
 *
 *   node checks/gates/g_style.js [--list] [--browser] [--file some.css|.js|.html]
 *
 * Runs in plain Node, no browser (--browser also runs the kit's reference page in a hidden browser, see the end).
 * --list names the files checked; --file prints what the rules say about one file (any file) and stops.
 *
 * 1. STYLE. Files checked (the count is printed; with no Studio file yet the style part passes with that count):
 *      studio/*.css and studio/*.js (any depth, but not studio/mock/, the design reference),
 *      studio.html when it exists, index.html ONLY once it is the Studio (it loads studio/main.js; until the
 *      cut-over, package C2, it is the old page and is skipped), and the kit's own behaviour code:
 *      ../studio_kit/kit.js, demo.html, and any other ../studio_kit/*.js (icons.js, shell.js) but not core/
 *      and not kit.css (which is where the tokens are defined).
 *    Comments are ignored. In what is left it fails on:
 *      - a colour literal: #rgb #rrggbb #rrggbbaa, rgb( rgba( hsl( hsla( hwb( lab( lch( oklab( oklch(, a named colour
 *        (red, white...) in a colour property, and in script a string literal given to fillStyle, strokeStyle,
 *        shadowColor or addColorStop (canvas colours are read from the --cv-* and role tokens at run time);
 *      - font-size (or the font shorthand) with a length literal: 12px, 1.2em, 90%... (var(--t-*) only; canvas
 *        font strings are read from --cv-font, --cv-mono, --cv-mono-sm);
 *      - border-radius that is not var(--r*), 0 or 50% (a circle);
 *      - box-shadow that is not none or one var(--...) token (var(--shadow)).
 *    A match is only a violation where it can be CSS: a .css file, a <style> block, an inline style attribute, or
 *    a string in script (so a JavaScript object key called color is not mistaken for a declaration).
 * 2. ACTIONS. Every Kit.action({ ... }) call written as an object literal in studio/*.js and ../studio_kit/*.js
 *    (a small brace-matching parser reads the members) must have id, title and hint that are not empty strings.
 *    Calls whose argument is not a literal are counted and printed but cannot be read statically; the registry
 *    refuses them at run time, which section 4 proves.
 * 3. SELF-CHECKS. Planted samples are run through the same code: a stray colour, font size, radius, shadow and a
 *    canvas colour literal, and actions without a hint or with an empty title, MUST be caught, and a clean sample
 *    with the same shapes as tokens, comments, selectors and strings MUST pass (negative and positive controls).
 * 4. THE KIT. ../studio_kit/kit.js loads in Node (nothing touches the page while loading) and has the documented
 *    API; the pure parts behave as written in docs/plan/wp/B1_kit.md: fmt (bars.beats.ticks, note names, KB),
 *    clamp, key parsing and matching, fuzzy ranking, the action registry (a missing title, hint, id or run is
 *    refused), the store and pref memory fallbacks. ../studio_kit/demo.html uses every control.
 * --browser: also opens ../studio_kit/demo.html#selftest in a hidden Edge or Chrome (real time, driven over the
 *    DevTools protocol, a throw-away profile under out/tests/G14/) and requires the page's own
 *    line "selftest: N checks, 0 failures" (about 289 checks: tooltips, keys, palette, menus, dialogs, toasts,
 *    sliders, knobs, numbers, tabs, splits, canvas, drag, wheel, storage, files). The board does not pass it: the
 *    board's G14 needs no browser. STUDIO_KIT_DIR=<folder> judges a copy of the kit instead of ../studio_kit.
 * Exit 0 when everything holds, 1 on any failure, 2 while ../studio_kit/kit.js does not exist yet.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');                 /* music_editor */
const KIT = process.env.STUDIO_KIT_DIR || path.join(ROOT, '..', 'studio_kit');       /* (the variable lets a scratch copy of the kit be judged: how the gate was shown to notice a broken kit.js) */
const args = process.argv.slice(2);

/* ------------------------------------------------------------------------------------------------ lexing -- */
/* One pass over JavaScript. Returns two strings of the same length as the source (newlines kept, so line numbers hold):
 *   clean  = the source with comments blanked (strings and regular expressions kept)
 *   masked = clean with the inside of strings, templates and regular expressions blanked too (what the structure
 *            parser needs: braces and commas inside strings must not count). The code inside ${ } stays. */
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await']);
function lexJs(src) {
  const n = src.length, clean = Array.from(src), masked = Array.from(src);
  const blank = (a, b, both) => { for (let k = a; k < b; k++) if (src[k] !== '\n' && src[k] !== '\r') { masked[k] = ' '; if (both) clean[k] = ' '; } };
  let i = 0, prev = '', word = '';
  const regexAllowed = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || (prev === 'a' && KEYWORDS_BEFORE_REGEX.has(word));
  function str(q) {
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    blank(i + 1, Math.min(j, n), false); i = Math.min(j + 1, n);
  }
  function tpl() {
    let a = i + 1; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(a, i, false); i += 2; code(true); a = i + 1; i++; continue; }
      i++;
    }
    blank(a, Math.min(i, n), false); i = Math.min(i + 1, n);
  }
  function regex() {
    let j = i + 1, cls = false;
    while (j < n && src[j] !== '\n') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
      j++;
    }
    if (src[j] !== '/') { i++; return; }                       /* not a regular expression after all: a division */
    blank(i + 1, j, false); i = j + 1;
    while (/[a-z]/i.test(src[i] || '')) i++;
  }
  function code(inTemplate) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i), end = e < 0 ? n : e; blank(i, end, true); i = end; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? n : e + 2; blank(i, end, true); i = end; continue; }
      if (c === '"' || c === "'") { str(c); prev = '"'; continue; }
      if (c === '`') { tpl(); prev = '"'; continue; }
      if (c === '/' && regexAllowed()) { const before = i; regex(); if (i > before + 1) prev = '"'; continue; }
      if (inTemplate) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return; depth--; } }
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; word = src.slice(i, j); prev = 'a'; i = j; continue; }
      if (/[0-9]/.test(c)) { let j = i; while (j < n && /[\w.]/.test(src[j])) j++; prev = '0'; i = j; continue; }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  code(false);
  return { clean: clean.join(''), masked: masked.join('') };
}
function blankRanges(text, ranges) {                          /* ranges: [from, to) pairs; newlines stay */
  const a = Array.from(text);
  for (const [x, y] of ranges) for (let k = x; k < y; k++) if (a[k] !== '\n' && a[k] !== '\r') a[k] = ' ';
  return a.join('');
}
const stripCss = (src) => blankRanges(src, [...src.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)].map((m) => [m.index, m.index + m[0].length]));
/* HTML: comments out; <script> bodies lexed as JavaScript; <style> bodies stripped as CSS.
 * js = the script bodies only, in place (everything else blank), for the action parser and the "is it in a string" test. */
function lexHtml(src) {
  let text = blankRanges(src, [...src.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((m) => [m.index, m.index + m[0].length]));
  const clean = Array.from(text), jsClean = Array.from(text).map((c) => (c === '\n' || c === '\r' ? c : ' ')), jsMasked = jsClean.slice();
  const put = (arr, at, s) => { for (let k = 0; k < s.length; k++) arr[at + k] = s[k]; };
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi)) {
    const at = m.index + m[1].length, lx = lexJs(m[2]);
    put(clean, at, lx.clean); put(jsClean, at, lx.clean); put(jsMasked, at, lx.masked);
  }
  for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi)) put(clean, m.index + m[1].length, stripCss(m[2]));
  return { clean: clean.join(''), js: { clean: jsClean.join(''), masked: jsMasked.join('') } };
}
function prepare(name, src) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.css') return { kind: 'css', clean: stripCss(src), js: null };
  if (ext === '.html' || ext === '.htm') return Object.assign({ kind: 'html' }, lexHtml(src));
  const lx = lexJs(src);
  return { kind: 'js', clean: lx.clean, js: lx };
}

/* ------------------------------------------------------------------------------------------- style rules -- */
const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
  'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise ' +
  'darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
  'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
  'lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue ' +
  'mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple ' +
  'red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke ' +
  'yellow yellowgreen').split(' '));
const HEX = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/gi;
const LENGTH = /-?(?:\d+\.?\d*|\.\d+)(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|%)(?![\w-])/g;
const COLOR_PROP = /^(?:color|background|background-color|background-image|border|border-(?:top|right|bottom|left|inline|block)|border(?:-(?:top|right|bottom|left|inline|block))?-color|outline|outline-color|fill|stroke|caret-color|accent-color|text-decoration|text-decoration-color|column-rule|column-rule-color|box-shadow|text-shadow|scrollbar-color)$/;
const PROP_NAMES = 'color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block))?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|box-shadow|text-shadow|scrollbar-color|' +
  'font-size|font|border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius';
const CAMEL = 'backgroundColor|backgroundImage|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|outlineColor|caretColor|accentColor|textDecorationColor|columnRuleColor|boxShadow|textShadow|scrollbarColor|' +
  'fontSize|borderRadius|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius|borderStartStartRadius|borderStartEndRadius|borderEndStartRadius|borderEndEndRadius';
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const stripVar = (v) => { let prev; do { prev = v; v = v.replace(/\b(?:var|url|env)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, 'VAR'); } while (v !== prev); return v; };

/* what is wrong with the value of one CSS property, or null */
function badDeclaration(prop, raw) {
  const v = stripVar(raw.replace(/!important/i, '').trim());
  if (COLOR_PROP.test(prop)) {
    const words = v.toLowerCase().match(/[a-z]+/g) || [];
    if (words.some((w) => NAMED.has(w))) return `named colour in ${prop}: ${raw.trim()}`;
  }
  if (prop === 'font-size' || prop === 'font') {
    if (v.match(LENGTH)) return `${prop} with a length literal: ${raw.trim()} (use var(--t-xs..--t-xl))`;
  }
  if (/radius$/.test(prop)) {
    const left = (v.match(LENGTH) || []).filter((x) => !/^0+(?:\.0*)?[a-z%]*$/.test(x) && x !== '50%');
    if (left.length) return `${prop} literal: ${raw.trim()} (use var(--r1..--r3), 0 or 50%)`;
  }
  if (prop === 'box-shadow') {
    if (!/^(?:none|inherit|initial|unset|revert|VAR)$/.test(v)) return `box-shadow literal: ${raw.trim()} (use var(--shadow) or none)`;
  }
  return null;
}
/* every violation in one prepared file: [{ line, rule, text }] */
function styleViolations(p) {
  const out = [], text = p.clean;
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  const lineOf = (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
  const inString = (idx) => !p.js || p.js.masked[idx] !== p.js.clean[idx];       /* in a CSS file everything may be CSS; in script only strings */
  const add = (idx, rule, snippet) => out.push({ line: lineOf(idx), rule, text: snippet.replace(/\s+/g, ' ').slice(0, 90) });
  const inCssText = (idx) => p.kind !== 'js' || inString(idx);
  for (const m of text.matchAll(HEX)) add(m.index, 'colour', m[0]);
  for (const m of text.matchAll(COLOR_FN)) add(m.index, 'colour', text.slice(m.index, m.index + 30));
  /* declarations written as prop: value; (CSS, <style>, style="", and inside strings in script) */
  for (const m of text.matchAll(new RegExp(`(?<![\\w-])(${PROP_NAMES})\\s*:\\s*([^;{}"'\`\\n]*)`, 'gi'))) {
    if (!inCssText(m.index)) continue;
    const why = badDeclaration(m[1].toLowerCase(), m[2]);
    if (why) add(m.index, why.split(' ')[0] === 'named' ? 'colour' : /font/.test(m[1]) ? 'font-size' : /radius/i.test(m[1]) ? 'radius' : 'shadow', why);
  }
  /* script: { color: 'red' }, { borderRadius: '4px' }, el.style.fontSize = '12px', setProperty('font-size', '12px') */
  const scriptDecls = [
    new RegExp(`(?<![\\w-])(${PROP_NAMES}|${CAMEL})\\s*:\\s*(['"\`])([^'"\`\\n]*)\\2`, 'g'),
    new RegExp(`\\.(${CAMEL}|color|background|fill|stroke|font)\\s*=\\s*(['"\`])([^'"\`\\n]*)\\2`, 'g'),
    new RegExp(`setProperty\\(\\s*(['"])(${PROP_NAMES})\\1\\s*,\\s*(['"\`])([^'"\`\\n]*)\\3`, 'g'),
  ];
  if (p.kind !== 'css') {
    scriptDecls.forEach((re, k) => {
      for (const m of text.matchAll(re)) {
        const prop = kebab(k === 2 ? m[2] : m[1]).toLowerCase(), value = k === 2 ? m[4] : m[3];
        const from = m.index + m[0].length - 1 - value.length;                       /* the value's own characters: are they inside a string? */
        if (p.js && p.js.masked.slice(from, from + value.length) === p.js.clean.slice(from, from + value.length)) continue;
        if (k === 0 && /^(?:font|fill|stroke|color|background)$/.test(prop) && !value) continue;
        const why = badDeclaration(prop, value);
        if (why) add(m.index, /named|colour/.test(why) ? 'colour' : /font/.test(prop) ? 'font-size' : /radius/.test(prop) ? 'radius' : 'shadow', why);
      }
    });
    /* canvas: colours are read from tokens, never written */
    for (const m of text.matchAll(/\b(?:fillStyle|strokeStyle|shadowColor)\s*=\s*(['"`])([^'"`\n]*)\1/g)) if (!/^\s*(?:transparent|currentcolor|none)?\s*$/i.test(m[2])) add(m.index, 'colour', `canvas colour literal: ${m[0]} (read it with Kit.css('--token'))`);
    for (const m of text.matchAll(/addColorStop\s*\([^,()]+,\s*(['"`])([^'"`\n]*)\1/g)) if (!/^\s*(?:transparent|currentcolor)?\s*$/i.test(m[2])) add(m.index, 'colour', `canvas colour literal: ${m[0]}`);
    for (const m of text.matchAll(/\.font\s*=\s*(['"`])([^'"`\n]*)\1/g)) if (m[2].match(LENGTH)) add(m.index, 'font-size', `canvas font literal: ${m[0]} (read --cv-font, --cv-mono or --cv-mono-sm)`);
  }
  /* the same finding twice (a hex inside a declaration) is one finding */
  const seen = new Set();
  return out.filter((v) => { const k = `${v.line}|${v.rule}|${v.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* --------------------------------------------------------------------------------------------- actions -- */
/* Members of the object literal that starts at masked[open] === '{': [{ key, value, spread, computed, method }] */
function objectMembers(masked, clean, open) {
  let depth = 0, k = open, start = open + 1;
  const parts = [];
  for (; k < masked.length; k++) {
    const c = masked[k];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) { parts.push([start, k]); break; } }
    else if (c === ',' && depth === 1) { parts.push([start, k]); start = k + 1; }
  }
  if (k >= masked.length) return null;
  const members = parts.map(([a, b]) => clean.slice(a, b).trim()).filter(Boolean).map((t) => {
    if (t.startsWith('...')) return { spread: true };
    let m;
    if ((m = /^\[/.exec(t))) return { computed: true };
    if ((m = /^(?:async\s+|get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(t))) return { key: m[1], method: true, value: t };
    if ((m = /^([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*([\s\S]*)$/.exec(t))) return { key: m[1].replace(/^['"]|['"]$/g, ''), value: m[2].trim() };
    if ((m = /^([A-Za-z_$][\w$]*)$/.exec(t))) return { key: m[1], value: m[1], shorthand: true };
    return { unknown: t };
  });
  return { members, end: k };
}
const EMPTY_VALUE = /^(?:''|""|``|null|undefined|false|0)$/;
/* every Kit.action( call in one prepared file with script in it: { line, literal, problems[] } */
function actionCalls(p) {
  if (!p.js) return [];
  const { masked, clean } = p.js, calls = [];
  for (const m of masked.matchAll(/(?<![\w$.])Kit\s*\.\s*action\s*\(\s*/g)) {
    const at = m.index + m[0].length, line = masked.slice(0, m.index).split('\n').length;
    if (masked[at] !== '{') { calls.push({ line, literal: false, problems: [] }); continue; }
    const parsed = objectMembers(masked, clean, at);
    if (!parsed) { calls.push({ line, literal: true, problems: ['the object literal never closes'] }); continue; }
    const problems = [], uncertain = parsed.members.some((x) => x.spread || x.computed || x.unknown);
    for (const key of ['id', 'title', 'hint']) {
      const member = parsed.members.find((x) => x.key === key);
      if (!member) { if (!uncertain) problems.push(`no ${key}`); continue; }
      if (!member.method && EMPTY_VALUE.test(member.value)) problems.push(`empty ${key}`);
      else if (/^(['"`])\s*\1$/.test(member.value || '')) problems.push(`empty ${key}`);
    }
    calls.push({ line, literal: true, problems, uncertain });
  }
  return calls;
}

/* ----------------------------------------------------------------------------------------------- gate -- */
let checks = 0, failed = 0;
const check = (ok, what) => { checks++; if (!ok) { failed++; console.log('FAIL', what); } return ok; };
const rel = (f) => path.relative(path.join(ROOT, '..'), f).replace(/\\/g, '/');

function listFiles() {
  const files = [], notes = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'mock' && e.name !== 'core' && e.name !== 'node_modules') walk(f); } else if (/\.(css|js)$/i.test(e.name)) files.push(f);
    }
  };
  walk(path.join(ROOT, 'studio'));
  const studioCount = files.length;
  for (const name of ['studio.html', 'index.html']) {
    const f = path.join(ROOT, name);
    if (!fs.existsSync(f)) continue;
    if (name === 'index.html' && !/studio\/main\.js/.test(fs.readFileSync(f, 'utf8'))) { notes.push('index.html is still the old page (it does not load studio/main.js): skipped until the cut-over'); continue; }
    files.push(f);
  }
  const htmlCount = files.length - studioCount;
  if (fs.existsSync(KIT)) for (const e of fs.readdirSync(KIT, { withFileTypes: true })) if (e.isFile() && /\.js$/i.test(e.name)) files.push(path.join(KIT, e.name));
  if (fs.existsSync(path.join(KIT, 'demo.html'))) files.push(path.join(KIT, 'demo.html'));
  return { files, notes, studioCount, htmlCount };
}

/* ---- 3. self-checks first: the yardstick must be right before it measures anything ---- */
function selfChecks() {
  const rules = (name, src) => styleViolations(prepare(name, src)).map((v) => v.rule);
  const bad = {
    'hex colour': ['.a { color: #fff; }', 'colour'], 'short hex with alpha': ['.a { background: #ffff; }', 'colour'], 'long hex': ['.a { border-color: #12345678; }', 'colour'],
    'rgba()': ['.a { background: rgba(0, 0, 0, .5); }', 'colour'], 'hsl()': ['.a { color: hsl(10 20% 30%); }', 'colour'], 'named colour': ['.a { border: 1px solid red; }', 'colour'],
    'font-size px': ['.a { font-size: 12px; }', 'font-size'], 'font-size em': ['.a { font-size: 1.2em; }', 'font-size'], 'font shorthand': ['.a { font: 600 12px/1.4 sans-serif; }', 'font-size'],
    'radius px': ['.a { border-radius: 4px; }', 'radius'], 'corner radius': ['.a { border-top-left-radius: 3px; }', 'radius'], 'radius 100%': ['.a { border-radius: 100%; }', 'radius'],
    'shadow literal': ['.a { box-shadow: 0 1px 2px var(--line); }', 'shadow'], 'shadow named': ['.a { box-shadow: 0 0 4px black; }', 'colour'],
  };
  for (const [what, [css, rule]] of Object.entries(bad)) check(rules('bad.css', css).includes(rule), `self-check: a ${what} in CSS is not caught`);
  const badJs = {
    'canvas fillStyle hex': ["c.fillStyle = '#ff0';", 'colour'], 'canvas strokeStyle name': ['c.strokeStyle = "white";', 'colour'], 'shadowColor': ["c.shadowColor = 'rgba(0,0,0,.3)';", 'colour'],
    'addColorStop': ["g.addColorStop(0, 'orange');", 'colour'], 'style.fontSize': ["el.style.fontSize = '12px';", 'font-size'], 'style.borderRadius': ["el.style.borderRadius = '3px';", 'radius'],
    'style.boxShadow': ["el.style.boxShadow = '0 0 4px var(--accent)';", 'shadow'], 'canvas font': ["c.font = '12px Arial';", 'font-size'], 'object key': ["const s = { borderRadius: '8px' };", 'radius'],
    'cssText string': ["el.style.cssText = 'color: hsl(1, 2%, 3%); font-size: 11px';", 'colour'], 'setProperty': ["el.style.setProperty('border-radius', '5px');", 'radius'],
    'template string': ['const h = `<i style="background: #abc"></i>`;', 'colour'], 'named in string': ["el.style.color = 'tomato';", 'colour'],
  };
  for (const [what, [js, rule]] of Object.entries(badJs)) check(rules('bad.js', js).includes(rule), `self-check: ${what} in script is not caught`);
  check(rules('bad.html', '<div style="font-size: 13px; color: #123"></div>').length >= 2, 'self-check: an inline style in HTML is not checked');
  check(rules('bad.html', '<style>.x { box-shadow: 0 0 1px #000; }</style><script>c.fillStyle = "#fff";</script>').length >= 2, 'self-check: <style> and <script> blocks in HTML are not checked');
  const good = {
    'tokens in CSS': '/* #fff rgb(1,2,3) font-size: 12px border-radius: 4px */ .a { color: var(--ink); background: var(--bg-1); font-size: var(--t-md); border-radius: var(--r1); border-radius: 50%; border-radius: 0; box-shadow: var(--shadow); box-shadow: none; background: transparent; font: 600 var(--t-md)/1.4 var(--font); border: 1px solid var(--line-2); width: 268px; margin: 12px; }',
    'media query and layout px': '@media (max-width: 1439px) { .compose { grid-template-columns: 240px 1fr 280px; } .x { padding: 0 var(--s3); outline: 2px solid var(--focus); } }',
    'tokens in script': "// color: #fff and rgb(0,0,0) in a comment\n/* c.fillStyle = 'white' */\nconst css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();\nc.fillStyle = css('--accent'); c.font = css('--cv-font'); c.strokeStyle = 'transparent'; el.style.borderRadius = 'var(--r2)'; el.style.fontSize = 'var(--t-sm)'; el.style.setProperty('--fill', '50%'); el.style.cssText = 'width: 84px; --fill: 78%; background: var(--role-lead)';",
    'selectors, hashes, regexes, templates': "const u = location.hash === '#view=mix' || href === '#i-play'; const re = /#[0-9a-f]{3}|rgb\\(/; const q = a / b / c; const t = `${x} ${'}'} / ${y}`; const color = (role) => css('--role-' + role); const c = color('lead'); const o = { color: red, fill: gold }; const w = a / 2; // end",
    'role colours as names in code': 'const roles = { color: tan, fill: plum }; const border = 1; const background = tomato;',
    'html with tokens': '<!-- #fff --><div style="width: 84px; --fill: 78%; background: var(--role-lead)"><svg class="ic" style="width: 12px; height: 12px"></svg></div><style>.x { border-radius: var(--r1); }</style><script>const a = css("--bg-0"); /* #000 */</script>',
  };
  for (const [what, src] of Object.entries(good)) {
    const name = /^<|<!--/.test(src) ? 'ok.html' : /\{|\}/.test(src.split('\n')[0]) && !/const|\/\/|=>/.test(src) ? 'ok.css' : 'ok.js';
    const found = styleViolations(prepare(name, src));
    check(found.length === 0, `self-check: clean sample "${what}" was reported: ${found.map((v) => v.rule + ' ' + v.text).join(' | ')}`);
  }
  /* actions */
  const calls = (src) => actionCalls(prepare('sample.js', src));
  const only = (src) => { const c = calls(src); return c.length === 1 ? c[0] : null; };
  const cases = [
    ['an action without a hint', "Kit.action({ id: 'a.b', title: 'Play', run() {} });", ['no hint']],
    ['an action without a title', "Kit.action({ id: 'a.b', hint: 'Starts it.', run() {} });", ['no title']],
    ['an action with an empty title', "Kit.action({ id: 'a.b', title: '', hint: 'Starts it.', run() {} });", ['empty title']],
    ['an action with an empty hint (template)', "Kit.action({ id: 'a.b', title: 'Play', hint: ``, run() {} });", ['empty hint']],
    ['an action without an id', "Kit.action({ title: 'Play', hint: 'Starts it.', run() {} });", ['no id']],
    ['a complete action', "Kit.action({ id: 'a.b', title: 'Play', hint: 'Starts the song.', keys: 'Space', run() { if (x) { f('}'); } } });", []],
    ['a complete action with shorthand members', "const id = 'q', title = 'Q', hint = 'Does q.'; Kit.action({ id, title, hint, run });", []],
    ['a complete action with computed text', "Kit.action({ id: 'tool.' + t, title: T[t].name, hint: `${T[t].name} tool.`, run: () => use(t) });", []],
    ['a complete action over several lines with comments', "Kit.action({\n  id: 'x', // the id, { not a brace\n  title: 'X', /* } */\n  hint: 'Does x, then y.',\n  run() {},\n});", []],
  ];
  for (const [what, src, want] of cases) {
    const c = only(src);
    check(!!c && c.literal && JSON.stringify(c.problems) === JSON.stringify(want), `self-check: ${what}: expected [${want}], got ${c ? '[' + c.problems + ']' : 'no call found'}`);
  }
  check(calls("// Kit.action({ id: 'a' })\nconst s = 'Kit.action({ id: 1 })';\n/* Kit.action({}) */").length === 0, 'self-check: Kit.action in a comment or a string was treated as a call');
  const dyn = only('Kit.action(spec);');
  check(!!dyn && !dyn.literal, 'self-check: a call with a variable argument must be counted as not literal');
  const two = calls("Kit.action({ id: 'a', title: 'A', hint: 'One.', run() {} });\nKit.action({ id: 'b', title: 'B', run() {} });");
  check(two.length === 2 && two[0].problems.length === 0 && two[1].problems[0] === 'no hint' && two[1].line === 2, 'self-check: two calls on two lines are not told apart');
  check(calls('x.Kit.action({})').length === 0 && calls('myKit.action({})').length === 0, 'self-check: only Kit.action( is an action registration');
}

/* ---- 4. the kit itself ---- */
const API = {
  functions: ['el', 'icon', 'clamp', 'css', 'status', 'action', 'run', 'bind', 'unbind', 'refresh', 'actions', 'scope', 'palette', 'paletteSource', 'keymap', 'menu', 'dialog', 'confirm', 'prompt', 'alert', 'toast',
    'slider', 'knob', 'number', 'seg', 'toggle', 'select', 'split', 'tabs', 'canvas', 'drag', 'wheel', 'store', 'pref', 'download', 'pickFile', 'readFile', 'drop', 'pickFolder', 'saveInto', 'init'],
  objects: { fmt: ['pos', 'note', 'parseNote', 'bytes', 'int', 'time', 'pct', 'signed'], keys: ['parse', 'label', 'matches', 'find'], fuzzy: ['score', 'rank'], tip: ['show', 'hide', 'set'] },
};
const DEMO_USES = ['el', 'icon', 'tip.show', 'status', 'action', 'bind', 'palette', 'paletteSource', 'keymap', 'menu', 'dialog', 'confirm', 'prompt', 'toast', 'slider', 'knob', 'number', 'seg', 'toggle', 'select', 'split',
  'tabs', 'canvas', 'drag', 'wheel', 'store', 'pref', 'download', 'pickFile', 'drop', 'saveInto', 'fmt.pos', 'fmt.note', 'fmt.bytes', 'css'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function kitChecks(Kit) {
  for (const f of API.functions) check(typeof Kit[f] === 'function', `Kit.${f} is not a function`);
  for (const [o, members] of Object.entries(API.objects)) for (const m of members) check(Kit[o] && typeof Kit[o][m] === 'function', `Kit.${o}.${m} is not a function`);
  check(typeof Kit.store === 'function' && typeof Kit.store.kv === 'object', 'Kit.store(name) must be a function with the five stores (kv, projects, versions, pack, cache) as properties');
  check(typeof Kit.pref.set === 'function' && typeof Kit.pref.del === 'function', 'Kit.pref needs set and del');
  check(typeof Kit.action.remove === 'function' && typeof Kit.action.get === 'function', 'Kit.action needs remove and get');
  /* clamp */
  check(Kit.clamp(5, 0, 3) === 3 && Kit.clamp(-1, 0, 3) === 0 && Kit.clamp(2, 0, 3) === 2 && Kit.clamp(NaN, 0, 3) === 0, 'clamp');
  /* fmt */
  const F = Kit.fmt;
  const table = [
    ['pos(1656)', F.pos(1656), '9.3.24'], ['pos(0)', F.pos(0), '1.1.0'], ['pos(191)', F.pos(191), '1.4.47'], ['pos(192)', F.pos(192), '2.1.0'], ['pos 3/4 time', F.pos(144 * 2 + 48 + 5, { beat: 48, beats: 3 }), '3.2.5'],
    ['note(60)', F.note(60), 'C4'], ['note(61)', F.note(61), 'C#4'], ['note(21)', F.note(21), 'A0'], ['note(0)', F.note(0), 'C-1'], ['note(127)', F.note(127), 'G9'], ['note(NaN)', F.note(NaN), '-'],
    ['bytes(0)', F.bytes(0), '0 B'], ['bytes(812)', F.bytes(812), '812 B'], ['bytes(4200)', F.bytes(4200), '4.1 KB'], ['bytes(410, kb)', F.bytes(410, { kb: true }), '0.4 KB'], ['bytes(192922)', F.bytes(192922), '188.4 KB'],
    ['bytes(5 MB)', F.bytes(5 * 1048576), '5.0 MB'], ['bytes(1023)', F.bytes(1023), '1023 B'], ['bytes(1024)', F.bytes(1024), '1.0 KB'],
    ['int(37287)', F.int(37287), '37,287'], ['int(12)', F.int(12), '12'], ['int(-1234567)', F.int(-1234567), '-1,234,567'], ['int(1000)', F.int(1000), '1,000'],
    ['time(83.4)', F.time(83.4), '1:23.4'], ['time(5)', F.time(5), '0:05.0'], ['time(3600)', F.time(3600), '60:00.0'], ['time(5.96)', F.time(5.96), '0:06.0'], ['time(59.96)', F.time(59.96), '1:00.0'], ['time(-3)', F.time(-3), '0:00.0'],
    ['pct(.52)', F.pct(0.52), '52%'], ['pct(1)', F.pct(1), '100%'], ['signed(3)', F.signed(3), '+3'], ['signed(0)', F.signed(0), '0'], ['signed(-2)', F.signed(-2), '-2'],
  ];
  for (const [what, got, want] of table) check(got === want, `fmt ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  check(F.parseNote('C#4') === 61 && F.parseNote('A0') === 21 && F.parseNote('c-1') === 0 && F.parseNote('Db4') === 61 && F.parseNote('x') === null, 'fmt.parseNote');
  for (let n = 0; n < 128; n += 7) if (!check(F.parseNote(F.note(n)) === n, `fmt.parseNote(fmt.note(${n}))`)) break;
  /* keys */
  const K = Kit.keys, ev = (o) => Object.assign({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o);
  check(same(K.parse('Ctrl+Shift+Z'), { ctrl: true, shift: true, alt: false, meta: false, key: 'z' }), 'keys.parse Ctrl+Shift+Z');
  check(K.parse('Ctrl K').ctrl && K.parse('Ctrl K').key === 'k' && K.parse('Space').key === 'space' && K.parse('Escape').key === 'esc' && K.parse('Del').key === 'delete' && K.parse('ArrowUp').key === 'up', 'keys.parse names');
  check(K.parse('?').key === '?' && K.parse(']').key === ']' && K.parse('+').key === '+' && K.parse('Ctrl++').key === '+' && K.parse('Ctrl++').ctrl, 'keys.parse symbols');
  check(K.label('ctrl+shift+z') === 'Ctrl Shift Z' && K.label('space') === 'Space' && K.label('Q') === 'Q' && K.label('esc') === 'Esc' && K.label('Shift+Up') === 'Shift Up' && K.label('?') === '?', 'keys.label');
  const m = (spec, e) => K.matches(spec, ev(e));
  check(m('Ctrl K', { key: 'k', code: 'KeyK', ctrlKey: true }), 'keys.matches Ctrl K');
  check(m('Ctrl K', { key: 'K', code: 'KeyK', metaKey: true }), 'keys.matches Ctrl K by the Mac command key');
  check(!m('Ctrl K', { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }) && !m('K', { key: 'k', code: 'KeyK', ctrlKey: true }) && !m('Ctrl K', { key: 'k', code: 'KeyK' }), 'keys.matches must compare the modifiers exactly');
  check(m('?', { key: '?', code: 'Slash', shiftKey: true }) && m(']', { key: ']', code: 'BracketRight' }) && m('Space', { key: ' ', code: 'Space' }) && m('Esc', { key: 'Escape', code: 'Escape' }), 'keys.matches symbols and names');
  check(m('Shift+Up', { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }) && !m('Up', { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }) && m('Up', { key: 'ArrowUp', code: 'ArrowUp' }), 'keys.matches arrows');
  check(m('Ctrl K', { key: 'л', code: 'KeyK', ctrlKey: true }) && m('Alt K', { key: '\u02da', code: 'KeyK', altKey: true }), 'keys.matches by the physical key when the layout gives another letter');
  check(m('Q', { key: 'q', code: 'KeyQ' }) && m('Q', { key: 'Q', code: 'KeyQ', shiftKey: false }) && !m('Q', { key: 'Q', code: 'KeyQ', shiftKey: true }) && m('Shift+Q', { key: 'Q', code: 'KeyQ', shiftKey: true }), 'keys.matches letters');
  check(!m('Ctrl K', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }) && m('Ctrl Alt K', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }) && m('Alt K', { key: 'k', code: 'KeyK', altKey: true }) && !m('K', { key: 'k', code: 'KeyK', altKey: true }), 'keys.matches Alt as exactly as Ctrl');
  check(m('1', { key: '1', code: 'Digit1' }) && m('Delete', { key: 'Delete', code: 'Delete' }) && m('F1', { key: 'F1', code: 'F1' }) && m('Enter', { key: 'Enter', code: 'Enter' }), 'keys.matches digits and named keys');
  /* fuzzy */
  const Z = Kit.fuzzy;
  check(Z.score('pl', 'Play') > 0 && Z.score('xz', 'Play') < 0 && Z.score('', 'Play') >= 0, 'fuzzy.score: a subsequence matches, a miss is negative, an empty query matches');
  check(Z.score('PL', 'play') > 0 && Z.score('play', 'PLAY') > 0, 'fuzzy.score: case does not matter');
  check(Z.score('part add', 'Add part') > 0 && Z.score('part zzz', 'Add part') < 0, 'fuzzy.score: every word of the query must match, in any order');
  /* the order a person would expect, whatever order the items come in: the whole text, its start, a word start, the word in one piece, the letters scattered */
  const orders = [
    ['play', ['Pretty lazy yes', 'Replay', 'Play from start', 'Play'], ['Play', 'Play from start', 'Replay', 'Pretty lazy yes']],
    ['p', ['aplay', 'a play', 'play'], ['play', 'a play', 'aplay']],
    ['ab', ['xacb', 'xa b', 'xab', 'ab'], ['ab', 'xab', 'xa b', 'xacb']],
    ['ap', ['Capture', 'Add part', 'Apple'], ['Apple', 'Add part', 'Capture']],
    ['cp', ['Copy', 'Command palette'], ['Command palette', 'Copy']],
    ['un', ['Run', 'Undo', 'Add rhythm unit'], ['Undo', 'Add rhythm unit', 'Run']],
    ['sav', ['Auto save', 'Save as', 'Save'], ['Save', 'Save as', 'Auto save']],
  ];
  for (const [q, items, want] of orders) { const got = Z.rank(q, items, (s) => s).map((r) => r.item); check(same(got, want), `fuzzy.rank "${q}" gives ${got.join(' > ')}, expected ${want.join(' > ')}`); }
  const names = ['Add part loop', 'Open file', 'Replay', 'Play', 'Undo', 'Redo', 'Play from start'];
  const top = (q) => (Z.rank(q, names, (s) => s)[0] || {}).item;
  check(top('play') === 'Play' && top('undo') === 'Undo' && top('opf') === 'Open file' && top('pfs') === 'Play from start' && Z.rank('zzz', names, (s) => s).length === 0, `fuzzy.rank order: ${Z.rank('play', names, (s) => s).map((r) => r.item).join(', ')}`);
  const r = Z.rank('pl', names, (s) => s)[0];
  check(r && Array.isArray(r.idx) && r.idx.length === 2 && r.score > 0, 'fuzzy.rank gives the matched positions');
  check(Z.rank('', names, (s) => s).length === names.length, 'fuzzy.rank with an empty query keeps everything');
  /* actions */
  const made = [];
  const reg = (spec) => { made.push(spec.id); return Kit.action(spec); };
  let ran = 0;
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  check(throws(() => Kit.action({ id: 't.nohint', title: 'X', run() {} })), 'Kit.action accepted an action without a hint');
  check(throws(() => Kit.action({ id: 't.notitle', hint: 'Does it.', run() {} })), 'Kit.action accepted an action without a title');
  check(throws(() => Kit.action({ id: 't.blank', title: '  ', hint: 'Does it.', run() {} })), 'Kit.action accepted a blank title');
  check(throws(() => Kit.action({ title: 'X', hint: 'Does it.', run() {} })), 'Kit.action accepted an action without an id');
  check(throws(() => Kit.action({ id: 't.norun', title: 'X', hint: 'Does it.' })), 'Kit.action accepted an action without run');
  check(throws(() => Kit.action()) && throws(() => Kit.action('x')), 'Kit.action accepted a non-object');
  check(!Kit.action.get('t.nohint') && !Kit.action.get('t.notitle'), 'a refused action must not be registered');
  const a = reg({ id: 't.ok', title: 'Test action', hint: 'Does the test thing.', keys: 'Ctrl+Shift+F9, F8', group: 'Test', run() { ran++; } });
  check(a && a.id === 't.ok' && Kit.action.get('t.ok') === a, 'Kit.action returns the registered action');
  check(Kit.keys.find('Ctrl+Shift+F9') === a && Kit.keys.find('F8') === a && Kit.keys.find('F7') == null, 'keys.find follows the bindings, including a second key');
  Kit.run('t.ok'); check(ran === 1, 'Kit.run runs an action');
  let on = true; reg({ id: 't.gated', title: 'Gated', hint: 'Only when on.', enabled: () => on, run() { ran += 10; } });
  Kit.run('t.gated'); on = false; Kit.run('t.gated'); check(ran === 11, 'Kit.run must not run a disabled action');
  reg({ id: 't.ok', title: 'Test action 2', hint: 'Replaces the first.', run() { ran += 100; } });
  check(Kit.actions().filter((x) => x.id === 't.ok').length === 1 && Kit.action.get('t.ok').title === 'Test action 2', 'registering an id twice replaces the action');
  check(Kit.keys.find('Ctrl+Shift+F9') == null, 'replacing an action drops its old keys');
  const bad = Kit.actions().filter((x) => !x.title || !x.hint || typeof x.run !== 'function' || !x.id);
  check(bad.length === 0, `registered actions without title, hint, id or run: ${bad.map((x) => x.id)}`);
  check(Kit.actions().some((x) => x.id === 'palette.open') && Kit.actions().some((x) => x.id === 'keymap.show'), 'the kit registers the command palette and key map actions itself');
  for (const id of made) Kit.action.remove(id);
  check(!Kit.action.get('t.ok') && !Kit.action.get('t.gated'), 'Kit.action.remove');
  /* storage fallbacks (no IndexedDB, no localStorage in Node) */
  const s = Kit.store('t_store'), obj = { a: 1, b: [1, 2, { c: 3 }] }, bytes = new Uint8Array([1, 2, 3]);
  check(await s.get('missing') === undefined, 'store.get of a missing key must be undefined');
  await s.set('o', obj); obj.b[2].c = 99; const back = await s.get('o');
  check(back && back.b[2].c === 3, 'store.set must keep a copy, not the caller\'s object');
  back.a = 5; check((await s.get('o')).a === 1, 'store.get must give a copy');
  await s.set('bytes', bytes); const gb = await s.get('bytes');
  check(gb instanceof Uint8Array && same(Array.from(gb), [1, 2, 3]) && gb !== bytes, 'store keeps Uint8Array contents');
  check(same((await s.keys()).sort(), ['bytes', 'o']), 'store.keys');
  await s.del('o'); check(same(await s.keys(), ['bytes']) && await s.get('o') === undefined, 'store.del');
  await s.clear(); check((await s.keys()).length === 0, 'store.clear');
  await Kit.store.kv.set('x', 1); check(await Kit.store.kv.get('x') === 1, 'Kit.store.kv');
  await Kit.store.kv.del('x');
  check(Kit.store.mode === 'memory', `without IndexedDB the store must say mode "memory" (it says ${Kit.store.mode})`);
  check(Kit.pref('t.p', 3) === 3, 'pref default');
  Kit.pref.set('t.p', { a: [1] }); check(same(Kit.pref('t.p', 3), { a: [1] }), 'pref set and get');
  Kit.pref.del('t.p'); check(Kit.pref('t.p', 3) === 3, 'pref del');
}

function demoChecks() {
  const file = path.join(KIT, 'demo.html');
  const html = fs.readFileSync(file, 'utf8'), p = prepare('demo.html', html), js = p.js.masked;
  check(/<link[^>]+kit\.css/.test(html) && /<script[^>]+icons\.js/.test(html) && /<script[^>]+kit\.js/.test(html), 'demo.html must load kit.css, icons.js and kit.js');
  check(/<title>[^<]{3,}<\/title>/.test(html), 'demo.html needs a title');
  const missing = DEMO_USES.filter((name) => !new RegExp(`(?<![\\w$])Kit\\s*\\.\\s*${name.replace('.', '\\s*\\.\\s*')}\\b`).test(js));
  check(missing.length === 0, `demo.html does not use: ${missing.map((x) => 'Kit.' + x).join(', ')}`);
  check(/#selftest|selftest/.test(html), 'demo.html needs its self-test (demo.html#selftest)');
}

/* The page's own browser self-test, in real time (a hidden Edge or Chrome driven over the DevTools protocol, a throw-away profile): the page is left to run and
 * this reads its result. Not through --virtual-time-budget: that races the clock ahead while the page waits for IndexedDB, which is not what a person's browser does. */
async function browserSelfTest() {
  const candidates = [process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`, process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`].filter(Boolean);
  const exe = candidates.find((c) => fs.existsSync(c));
  if (!check(!!exe, 'no Edge or Chrome found for --browser')) return;
  if (!check(typeof WebSocket === 'function', '--browser needs a Node with a WebSocket (version 22 or later)')) return;
  const http = require('http'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = path.join(ROOT, 'out', 'tests', 'G14', `g14_browser_profile_${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const url = require('url').pathToFileURL(path.join(KIT, 'demo.html')).href + '#selftest';
  const proc = cp.spawn(exe, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,720', url], { windowsHide: true, stdio: 'ignore' });
  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      try { page = (await getJson(`http://127.0.0.1:${port}/json`)).find((t) => t.type === 'page' && /demo\.html/.test(t.url)); } catch (e) { /* not up yet */ }
      if (!page) await sleep(200);
    }
    if (!check(!!page, 'the hidden browser did not start')) return;
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0; const waiting = new Map();
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
    const read = () => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: "(document.getElementById('selftest') || {}).textContent || ''", returnByValue: true } })); })
      .then((d) => (d.result && d.result.result && d.result.result.value) || '');
    let text = '';
    for (const t0 = Date.now(); Date.now() - t0 < 150000;) {
      text = await read();
      if (/selftest: \d+ checks, \d+ failures\s*$/.test(text)) break;
      await sleep(400);
    }
    const lines = text.trim().split('\n');
    for (const l of lines.filter((x) => /^FAIL/.test(x))) console.log(l);
    check(/selftest: \d+ checks, 0 failures$/.test(lines[lines.length - 1]), `browser self-test: ${lines[lines.length - 1]}`);
    console.log('browser: ' + lines[lines.length - 1]);
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* closed */ }
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); else proc.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* still in use: the next run makes its own */ }
  }
}

(async function main() {
  const kitFile = path.join(KIT, 'kit.js');
  const one = args.indexOf('--file');                            /* node g_style.js --file some.css|js|html: what the rules say about any one file */
  if (one >= 0) {
    const f = path.resolve(args[one + 1]), p = prepare(f, fs.readFileSync(f, 'utf8')), v = styleViolations(p), a = actionCalls(p);
    for (const x of v) console.log(`${rel(f)}:${x.line} ${x.rule}: ${x.text}`);
    for (const c of a) console.log(`${rel(f)}:${c.line} Kit.action ${c.literal ? (c.problems.join(', ') || 'ok') : 'not literal'}`);
    process.exit(v.length || a.some((c) => c.problems.length) ? 1 : 0);
  }
  selfChecks();                                                /* the yardstick is proven first, even while the kit is not built */
  if (!fs.existsSync(kitFile) || !fs.existsSync(path.join(KIT, 'demo.html'))) {
    if (failed) { console.log(`G14: ${checks} checks, ${failed} failures`); process.exit(1); }
    console.log(`NOT BUILT YET: ${!fs.existsSync(kitFile) ? 'studio_kit/kit.js' : 'studio_kit/demo.html'} (docs/plan/wp/B1_kit.md); the style rules' own self-checks pass (${checks} checks)`);
    process.exit(2);
  }
  const { files, notes, studioCount, htmlCount } = listFiles();
  let literal = 0, dynamic = 0, uncertain = 0, found = 0;
  for (const f of files) {
    const p = prepare(f, fs.readFileSync(f, 'utf8')), v = styleViolations(p);
    found += v.length;
    for (const x of v) check(false, `${rel(f)}:${x.line} ${x.rule}: ${x.text}`);
    check(true, `${rel(f)} style`);
    if (/\.(js|html)$/i.test(f) && !/[\\/]mock[\\/]/.test(f)) for (const c of actionCalls(p)) {
      if (!c.literal) { dynamic++; console.log(`note: ${rel(f)}:${c.line} Kit.action(...) is not an object literal: not checked statically (the registry refuses a missing title or hint at run time)`); continue; }
      literal++; if (c.uncertain) uncertain++;
      check(c.problems.length === 0, `${rel(f)}:${c.line} Kit.action: ${c.problems.join(', ')}`);
    }
  }
  if (args.includes('--list')) for (const f of files) console.log('  checked ' + rel(f));
  for (const n of notes) console.log('note: ' + n);
  try { await kitChecks(require(kitFile)); } catch (e) { check(false, `kit.js does not load or work in Node: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
  try { demoChecks(); } catch (e) { check(false, `demo.html: ${e.message}`); }
  if (args.includes('--browser')) await browserSelfTest();
  const studio = `studio/ ${studioCount} files${htmlCount ? ', ' + htmlCount + ' page' + (htmlCount > 1 ? 's' : '') : ''}`;
  console.log(`G14: style ${files.length} files (${studio}, kit ${files.length - studioCount - htmlCount}), ${found} violations; ${literal} Kit.action calls read` + `${dynamic ? ', ' + dynamic + ' not literal' : ''}${uncertain ? ', ' + uncertain + ' with spread or computed members' : ''}; ${checks} checks, ${failed} failures`);
  process.exit(failed ? 1 : 0);
})();
