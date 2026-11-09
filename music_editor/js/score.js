/* The text score: the whole project as readable text and back (docs/plan/04_FORMATS.md section 3).
 *
 *   SF3Score.parse(text)            text -> a normalised version-2 project (SF3Compile.normalize), or a ScoreError
 *   SF3Score.print(project, opts)   project -> canonical text; parse(print(p)) deep-equals normalize(p) (ui aside)
 *   SF3Score.ScoreError             { message, line, column, part, bar, token }  (+ partIndex, field for tools)
 *   SF3Score.setBanks(banks)        the game's instrument banks (SF3Data.load().banks), so that kit parts print raw keys
 *
 * Headless: the same file runs in the checks under Node and in the page. Gate: G8 (checks/gates/g_score.js).
 *
 * Reading, in short (the grammar of 04_FORMATS section 3 plus the decisions it leaves open):
 *  - A bar is closed by `|`. A bar line is `[v<N>] bar <N> | bar | bar |`; a bar may be spread over several lines
 *    (a line that starts with none of the words below goes on with the open bar line).
 *  - Sticky length and velocity start at a quarter note and 100 on every bar line and flow through its bars.
 *    A rest `r:8` sets the length too. `%` copies the previous bar of the same voice and changes nothing sticky.
 *  - A note that starts inside the bar may run past the bar line (it keeps sounding; the next bar starts at its own
 *    tick 0). A token that would START at or after the bar line (or a rest running past it) is an error:
 *    `part "Bass", bar 7: 12 ticks too long (204 of 192)`.
 *  - Notes come out sorted by tick, then highest key first, then voice, then reading order; a project whose notes
 *    are in another order prints `json order: [...]` (the position each note takes), so nothing is lost.
 *  - Nothing is ever dropped: whatever the grammar cannot say exactly goes through `json <field>: <JSON>`; print()
 *    reads its own text back and moves any field that did not come back identical to a json line.
 *  Additions to the grammar of section 3 (the page should take them over): lane points `tick=value!` (post) and
 *  `tick=value<` (pre); `title: ` / `author: ` as header lines; a bar line `bar N` may carry `{...}` extras with
 *  `bend=dt:value;dt:value`.
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const compile = () => g.SF3Compile || require('./compile.js');
  const BAR = Seq.BAR || 192;
  const VERSION = 1;
  const DEFAULT_LEN = BAR / 4, DEFAULT_VEL = 100;

  class ScoreError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'ScoreError';
      Object.assign(this, { line: null, column: null, part: null, bar: null, token: null, partIndex: null, field: null }, info || {});
    }
  }

  /* ---- small helpers ------------------------------------------------------------------------- */
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isInt = (v) => Number.isInteger(v);
  const isWs = (c) => c === ' ' || c === '\t';
  const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  const BAREWORD = /^[A-Za-z_][\w-]*$/;
  const RESERVED = new Set(['true', 'false', 'null']);

  function eq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false; return true; }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !eq(a[k], b[k])) return false;
    return true;
  }
  function distance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function suggest(word, list) {
    let best = null, bestD = Infinity;
    for (const w of list) { const d = distance(word.toLowerCase(), w.toLowerCase()); if (d < bestD) { best = w; bestD = d; } }
    return best !== null && bestD <= Math.max(1, Math.floor(word.length / 3)) ? ` (did you mean "${best}"?)` : '';
  }

  /* ---- pitches and lengths ------------------------------------------------------------------- */
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const noteName = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1);

  /* shortest spelling of every length that has one: 4 = quarter, 4. dotted, 8t triplet (16 ticks) */
  const SPELL = new Map();
  (function () {
    const best = (ticks, text) => { const old = SPELL.get(ticks); if (!old || text.length < old.length) SPELL.set(ticks, text); };
    for (const d of [1, 2, 4, 8, 16, 32, 64]) {
      const base = BAR / d;
      best(base, String(d));
      if (Number.isInteger(base * 1.5)) best(base * 1.5, `${d}.`);
      if (Number.isInteger(base * 2 / 3)) best(base * 2 / 3, `${d}t`);
    }
  })();
  const spell = (ticks) => SPELL.get(ticks) || `=${ticks}`;
  const DIVISORS = new Set([1, 2, 4, 8, 16, 32, 64]);

  /* ---- what a note may carry ----------------------------------------------------------------- */
  const EXTRA_KEYS = ['slide', 'cents', 'bank', 'program', 'volume', 'expression', 'pan', 'bend'];
  const NOTE_KEYS = new Set(['t', 'n', 'v', 'len', 'tie'].concat(EXTRA_KEYS));
  /* null when the value is fine, else the reason */
  function extraProblem(k, v) {
    const int = (lo, hi) => (isInt(v) && v >= lo && v <= hi ? null : `${k} must be a whole number ${lo}..${hi}`);
    switch (k) {
      case 'slide': return int(1, 127);
      case 'cents': return isNum(v) && v >= -100 && v <= 100 ? null : 'cents must be a number -100..100';
      case 'bank': return int(0, 15);
      case 'program': case 'volume': case 'expression': case 'pan': return int(0, 127);
      case 'bend': return Array.isArray(v) && v.length && v.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1])) ? null : 'bend must be pairs dt:value';
      default: return `unknown extra "${k}"`;
    }
  }
  function noteExpressible(n) {
    if (!n || typeof n !== 'object') return false;
    for (const k of Object.keys(n)) if (!NOTE_KEYS.has(k)) return false;
    if (!isInt(n.t) || n.t < 0 || !isInt(n.len) || n.len < 1 || !isInt(n.n) || n.n < 0 || n.n > 127 || !isInt(n.v) || n.v < 1 || n.v > 127) return false;
    if ('tie' in n && n.tie !== true) return false;
    for (const k of EXTRA_KEYS) if (k in n && extraProblem(k, n[k])) return false;
    return true;
  }

  /* ---- part words and header lines ----------------------------------------------------------- */
  const WORDS = ['program', 'bank', 'volume', 'expression', 'pan', 'transpose', 'gain', 'tune', 'voices', 'track', 'role', 'legato'];
  const WORD_SPEC = {
    program: ['int', 0, 127], bank: ['int', 0, 15], volume: ['int', 0, 127], expression: ['int', 0, 127], pan: ['int', 0, 127],
    transpose: ['num'], gain: ['int', -64, 63], tune: ['num'], voices: ['int', 1, 16], track: ['int', 0, 15], role: ['str'], legato: ['bool'],
  };
  const ALWAYS_WORDS = new Set(['program', 'volume', 'expression', 'pan']);
  const HEADER_WORDS = ['title', 'author', 'tempo', 'tempo-change', 'bars', 'loop', 'markers', 'key', 'lead', 'autotune', 'chorus', 'section'];
  const HEADER_RE = /^(title|author|tempo-change|tempo|bars|loop|markers|key|lead|autotune|chorus|section)(?:[ \t]+([^:\s]+))?[ \t]*:[ \t]*(.*)$/;
  const PART_WORDS_ALL = ['json', 'device', 'lane', 'vibrato', 'part'];
  const VIBRATO_KEYS = ['depth', 'rate', 'sync', 'delay', 'tremolo'];

  function parseBool(s) {
    const v = String(s).toLowerCase();
    if (v === '1' || v === 'on' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'off' || v === 'false' || v === 'no') return false;
    return null;
  }

  /* ---- scanning pieces ----------------------------------------------------------------------- */
  /* end index of the JSON value (array, object or string) that starts at s[i], or -1 */
  function jsonEnd(s, i) {
    let depth = 0, inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') { inStr = false; if (depth === 0) return j + 1; } continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  }
  /* whitespace separated words; a "quoted string" is one word. [{ text, col }], col 1-based from `base` */
  function scanWords(str, base, fail) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      if (isWs(str[i])) { i++; continue; }
      let j = i;
      if (str[i] === '"') {
        j = jsonEnd(str, i);
        if (j < 0) throw fail('this text in quotes never ends', str.slice(i), base + i);
      } else while (j < str.length && !isWs(str[j])) j++;
      out.push({ text: str.slice(i, j), col: base + i });
      i = j;
    }
    return out;
  }
  /* key=value pairs; a value that starts with [ { or " runs to its matching end */
  function scanPairs(str, base, fail) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      if (isWs(str[i])) { i++; continue; }
      const m = /^[A-Za-z_]\w*=/.exec(str.slice(i));
      if (!m) { let j = i; while (j < str.length && !isWs(str[j])) j++; throw fail('expected key=value', str.slice(i, j), base + i); }
      const key = m[0].slice(0, -1);
      let a = i + m[0].length, b = a;
      if ('[{"'.includes(str[a] || '')) { b = jsonEnd(str, a); if (b < 0) throw fail(`the value of ${key} never ends`, str.slice(a), base + a); }
      else while (b < str.length && !isWs(str[b])) b++;
      out.push({ key, text: str.slice(a, b), col: base + i, valueCol: base + a });
      i = b;
    }
    return out;
  }
  /* a value in a device line: number, true / false / null, JSON, or a bare word */
  function scalar(text, fail, token, col) {
    if (NUM.test(text)) return Number(text);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if ('[{"'.includes(text[0] || '')) { try { return JSON.parse(text); } catch (e) { throw fail(`this is not valid JSON (${e.message})`, token, col); } }
    if (text === '') throw fail('a value is missing', token, col);
    return text;
  }

  /* ---- parse --------------------------------------------------------------------------------- */
  function parseRaw(text) {
    const C = compile();
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const raw = { format: 'sf3project', version: 2 };
    const parts = [];
    let part = null, open = null, started = false;

    /* an error that names its place: part and bar when there are some */
    const mk = (ctx) => (msg, token, col, field) => {
      const pname = ctx.part ? ctx.part.name : null;
      const bar = ctx.bar === undefined ? null : ctx.bar;
      const message = pname !== null ? (bar !== null ? `part "${pname}", bar ${bar}: ${msg}` : `part "${pname}": ${msg}`) : `line ${ctx.line}: ${msg}`;
      return new ScoreError(message, { line: ctx.line, column: col === undefined ? null : col, part: pname, bar, token: token === undefined ? null : token,
                                       partIndex: ctx.part ? ctx.part.index : null, field: field || null });
    };

    function finishPart() {
      if (!part) return;
      flush();
      const p = part;
      let notes;
      const collected = [];
      let seq = 0;
      for (const tag of Array.from(p.voices.keys()).sort((a, b) => a - b)) {
        const v = p.voices.get(tag);
        for (const barNo of Array.from(v.bars.keys()).sort((a, b) => a - b)) {
          for (const n of v.bars.get(barNo)) collected.push({ note: Object.assign({}, n, { t: n.t + (barNo - 1) * BAR }), voice: tag, seq: seq++ });
        }
      }
      if (p.jsonNotes !== undefined) {
        if (collected.length) throw mk({ line: p.line, part: p })('this part has bar lines and a "json notes" line; use one of them', 'json notes', 1, 'notes');
        notes = p.jsonNotes;
      } else {
        collected.sort((a, b) => a.note.t - b.note.t || b.note.n - a.note.n || a.voice - b.voice || a.seq - b.seq);
        notes = collected.map((c) => c.note);
      }
      if (p.order !== undefined) {
        const o = p.order, fail = mk({ line: p.line, part: p });
        if (!Array.isArray(o) || o.length !== notes.length || !o.every(isInt) || new Set(o).size !== o.length || o.some((x) => x < 0 || x >= o.length)) {
          throw fail(`"json order" must list each of the ${notes.length} notes' places once`, 'json order', 1, 'notes');
        }
        notes = o.map((k) => notes[k]);
      }
      p.raw.notes = notes;
      if (p.automation) p.raw.automation = p.automation;
      if (p.devices) p.raw.devices = p.devices;
      parts.push(p.raw);
      part = null;
    }

    /* ---- the bar machinery ---- */
    function finishBar(o) {
      const bar = o.cur || { notes: [], tokens: 0 };
      let v = o.part.voices.get(o.tag);
      if (!v) { v = { bars: new Map() }; o.part.voices.set(o.tag, v); }
      if (v.bars.has(o.nextBar)) throw mk({ line: o.line, part: o.part, bar: o.nextBar })(`this bar of voice ${o.tag} is written twice`, undefined, undefined, 'notes');
      v.bars.set(o.nextBar, bar.notes);
      o.nextBar++;
      o.cur = null;
    }
    function flush() {
      if (open && open.cur && open.cur.tokens > 0) finishBar(open);
      open = null;
    }
    function parsePitch(text, fail, token, col) {
      let m = /^#(\d+)$/.exec(text);
      let n;
      if (m) n = Number(m[1]);
      else {
        m = /^([A-G])(#|b)?(-?\d+)$/.exec(text);
        if (!m) throw fail(`unknown token "${token}"`, token, col, 'notes');
        n = LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1);
      }
      if (n < 0 || n > 127) throw fail(`${text} is outside the keys 0..127`, token, col, 'notes');
      return n;
    }
    function parseExtras(inner, notes, fail, token, col) {
      const words = scanWords(inner, col + 1, fail);
      for (const w of words) {
        const m = /^([a-z]+)=(.*)$/.exec(w.text);
        if (!m || !EXTRA_KEYS.includes(m[1])) throw fail(`unknown extra "${w.text}"${m ? suggest(m[1], EXTRA_KEYS) : ''}`, token, col, 'notes');
        let value;
        if (m[1] === 'bend') {
          value = m[2].split(';').map((pair) => { const q = pair.split(':'); return q.length === 2 && NUM.test(q[0]) && NUM.test(q[1]) ? [Number(q[0]), Number(q[1])] : null; });
          if (!m[2] || value.some((x) => !x)) throw fail(`bend must be pairs dt:value joined by ";", not "${m[2]}"`, token, col, 'notes');
        } else {
          if (!NUM.test(m[2])) throw fail(`${m[1]} needs a number, not "${m[2]}"`, token, col, 'notes');
          value = Number(m[2]);
        }
        const why = extraProblem(m[1], value);
        if (why) throw fail(why, token, col, 'notes');
        for (const n of notes) n[m[1]] = value;
      }
    }
    function handleToken(o, text, ln, col) {
      const fail = mk({ line: ln, part: o.part, bar: o.nextBar });
      const bar = o.cur || (o.cur = { notes: [], tokens: 0, cursor: 0, last: null, repeat: false });
      if (bar.repeat) throw fail('a bar written as % has nothing else in it', text, col, 'notes');
      bar.tokens++;
      if (text === '%') {
        if (bar.tokens > 1) throw fail('% must be alone in its bar', text, col, 'notes');
        const v = o.part.voices.get(o.tag), prev = v && v.bars.get(o.nextBar - 1);
        if (!prev) throw fail('nothing to repeat (the bar before is not written for this voice)', text, col, 'notes');
        bar.repeat = true;
        for (const n of prev) bar.notes.push(Object.assign({}, n, n.bend ? { bend: n.bend.map((p) => p.slice()) } : {}));
        return;
      }
      let m = /^@(\d+)$/.exec(text);
      if (m) {
        const at = Number(m[1]);
        if (at >= BAR) throw fail(`@${at} is past the end of the bar (${BAR} ticks)`, text, col, 'notes');
        bar.cursor = at; bar.last = null;
        return;
      }
      let pitches = [], rest = text, isRest = false, modsOnly = false;
      if (text[0] === ':' || text[0] === '!' || text[0] === '~' || text[0] === '{') modsOnly = true;
      else if (/^r(?=[:!~{]|$)/.test(text)) { isRest = true; rest = text.slice(1); }
      else if (text[0] === '[') {
        const k = text.indexOf(']');
        if (k < 0) throw fail(`the chord ${text} is never closed`, text, col, 'notes');
        const names = text.slice(1, k).trim().split(/\s+/).filter(Boolean);
        if (!names.length) throw fail('a chord needs at least one note', text, col, 'notes');
        pitches = names.map((nm) => parsePitch(nm, fail, text, col));
        rest = text.slice(k + 1);
      } else {
        m = /^(#\d+|[A-G][#b]?-?\d+)/.exec(text);
        if (!m) throw fail(`unknown token "${text}"`, text, col, 'notes');
        pitches = [parsePitch(m[1], fail, text, col)];
        rest = text.slice(m[1].length);
      }
      /* suffixes: :length !velocity ~ {extras}, in any order */
      let len = null, vel = null, tie = false, extras = null, pos = 0;
      while (pos < rest.length) {
        const c = rest[pos];
        if (c === ':') {
          const q = /^:(?:=(\d+)|(\d+)(\.)?(t)?)/.exec(rest.slice(pos));
          if (!q) throw fail(`"${rest.slice(pos)}" is not a note length (use 1 2 4 8 16 32 64, with . or t, or :=ticks)`, text, col, 'notes');
          if (q[1] !== undefined) len = Number(q[1]);
          else {
            const d = Number(q[2]);
            if (!DIVISORS.has(d)) throw fail(`:${q[2]} is not a note length (use 1 2 4 8 16 32 64, with . or t, or :=ticks)`, text, col, 'notes');
            len = (BAR / d) * (q[3] ? 1.5 : 1) * (q[4] ? 2 / 3 : 1);
            if (!Number.isInteger(len)) throw fail(`:${q[0].slice(1)} does not make a whole number of ticks; use :=ticks`, text, col, 'notes');
          }
          if (len < 1) throw fail('a length must be at least 1 tick', text, col, 'notes');
          pos += q[0].length;
        } else if (c === '!') {
          const q = /^!(\d+)/.exec(rest.slice(pos));
          if (!q) throw fail(`"${rest.slice(pos)}" is not a velocity (!1 to !127)`, text, col, 'notes');
          vel = Number(q[1]);
          if (vel < 1 || vel > 127) throw fail(`velocity ${vel} is not 1..127`, text, col, 'notes');
          pos += q[0].length;
        } else if (c === '~') { tie = true; pos++; }
        else if (c === '{') {
          const k = rest.indexOf('}', pos);
          if (k < 0) throw fail('the { extras } are never closed', text, col, 'notes');
          extras = (extras || []).concat([rest.slice(pos + 1, k)]);
          pos = k + 1;
        } else throw fail(`unknown token "${text}"`, text, col, 'notes');
      }
      if (len !== null) o.state.len = len;
      if (vel !== null) o.state.vel = vel;
      if (modsOnly) {
        if (len === null && vel === null && !tie && !extras) throw fail(`unknown token "${text}"`, text, col, 'notes');
        if ((tie || extras) && !bar.last) throw fail('nothing to attach this to (put it right after a note)', text, col, 'notes');
        if (tie) for (const n of bar.last) n.tie = true;
        if (extras) for (const e of extras) parseExtras(e, bar.last, fail, text, col);
        return;
      }
      const length = o.state.len, start = bar.cursor;
      if (isRest) {
        if (vel !== null || tie || extras) throw fail('a rest has no velocity, slur or extras', text, col, 'notes');
        if (start + length > BAR) throw fail(`${start + length - BAR} ticks too long (${start + length} of ${BAR})`, text, col, 'notes');
        bar.cursor = start + length; bar.last = null;
        return;
      }
      if (start >= BAR) throw fail(`${start + length - BAR} ticks too long (${start + length} of ${BAR})`, text, col, 'notes');
      const made = pitches.map((n) => {
        const note = { t: start, n, v: o.state.vel, len: length };
        if (tie) note.tie = true;
        return note;
      });
      if (extras) for (const e of extras) parseExtras(e, made, fail, text, col);
      for (const n of made) bar.notes.push(n);
      bar.cursor = start + length; bar.last = made;
    }
    function scanBars(o, s, from, ln) {
      let i = from;
      while (i < s.length) {
        const c = s[i];
        if (isWs(c)) { i++; continue; }
        if (c === '|') { finishBar(o); i++; continue; }
        const start = i;
        let j = i;
        while (j < s.length && !isWs(s[j]) && s[j] !== '|') {
          if (s[j] === '[' || s[j] === '{') {
            const close = s.indexOf(s[j] === '[' ? ']' : '}', j);
            if (close < 0) throw mk({ line: ln, part: o.part, bar: o.nextBar })(`${s[j]} is never closed`, s.slice(start), start + 1, 'notes');
            j = close + 1;
          } else j++;
        }
        handleToken(o, s.slice(start, j), ln, start + 1);
        i = j;
      }
    }

    /* ---- the lines ---- */
    for (let li = 0; li < lines.length; li++) {
      const s = lines[li], t = s.trim(), ln = li + 1;
      if (!t || t === '#' || /^#\s/.test(t)) continue;
      const indent = s.length - s.trimStart().length;
      const body = s.slice(indent);
      const here = (extra) => Object.assign({ line: ln, part }, extra);
      if (!started) {
        const m = /^cps3[ \t]+score[ \t]+(\S+)\s*$/.exec(t);
        if (!m) throw mk({ line: ln })('the first line must be "cps3 score 1"', t.split(/\s+/)[0], indent + 1);
        if (m[1] !== String(VERSION)) throw mk({ line: ln })(`score version ${m[1]} is not supported (this reader knows ${VERSION})`, m[1], indent + 1);
        started = true;
        continue;
      }
      const vm = /^(?:v(\d+)[ \t]+)?bar[ \t]+(\d+)[ \t]*\|/.exec(body);
      if (vm) {
        flush();
        if (!part) throw mk({ line: ln })('a bar line must come after a "part" line', 'bar', indent + 1);
        const no = Number(vm[2]);
        if (no < 1) throw mk(here())('bars are numbered from 1', `bar ${vm[2]}`, indent + 1, 'notes');
        open = { part, tag: vm[1] ? Number(vm[1]) : 1, nextBar: no, state: { len: DEFAULT_LEN, vel: DEFAULT_VEL }, cur: null, line: ln };
        if (vm[1] !== undefined && Number(vm[1]) < 1) throw mk(here())('voices are numbered from 1', `v${vm[1]}`, indent + 1, 'notes');
        scanBars(open, s, indent + vm[0].length, ln);
        continue;
      }
      const word = /^[^\s:]+/.exec(body)[0];
      if (/^(v\d+[ \t]+)?bar\b/.test(body)) {
        throw mk(here())('write a bar line as "bar 1 | ... |" (the number, then |)', body.split(/\s+/).slice(0, 2).join(' '), indent + 1, 'notes');
      }
      if (word === 'part') {
        flush(); finishPart();
        const fail = mk({ line: ln });
        const toks = scanWords(body.slice(4), indent + 5, (m, tk, c) => fail(m, tk, c));
        if (!toks.length) throw fail('a part needs a name: part <name>', 'part', indent + 1);
        let name;
        if (toks[0].text[0] === '"') { try { name = JSON.parse(toks[0].text); } catch (e) { throw fail('the part name in quotes is not valid', toks[0].text, toks[0].col); } if (typeof name !== 'string') throw fail('the part name must be text', toks[0].text, toks[0].col); }
        else name = toks[0].text;
        part = { name, index: parts.length, line: ln, voices: new Map(), raw: { name }, automation: null, devices: null };
        const pf = mk({ line: ln, part });
        for (let k = 1; k < toks.length; k += 2) {
          const w = toks[k], spec = WORD_SPEC[w.text];
          if (!spec) throw pf(`unknown word "${w.text}"${suggest(w.text, WORDS)}`, w.text, w.col);
          const v = toks[k + 1];
          if (!v) throw pf(`"${w.text}" needs a value`, w.text, w.col, w.text);
          let value;
          if (spec[0] === 'bool') { value = parseBool(v.text); if (value === null) throw pf(`${w.text} must be 1 or 0 (or on / off), not "${v.text}"`, v.text, v.col, w.text); }
          else if (spec[0] === 'str') {
            if (v.text[0] === '"') { try { value = JSON.parse(v.text); } catch (e) { value = undefined; } if (typeof value !== 'string') throw pf(`${w.text} must be a word`, v.text, v.col, w.text); }
            else value = v.text;
          } else {
            if (!NUM.test(v.text)) throw pf(`${w.text} needs a number, not "${v.text}"`, v.text, v.col, w.text);
            value = Number(v.text);
            if (spec[0] === 'int' && (!isInt(value) || value < spec[1] || value > spec[2])) throw pf(`${w.text} must be a whole number ${spec[1]}..${spec[2]}, not ${v.text}`, v.text, v.col, w.text);
          }
          part.raw[w.text] = value;
        }
        continue;
      }
      if (word === 'json') {
        flush();
        const m = /^json[ \t]+([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/.exec(body);
        const fail = mk(here());
        if (!m) throw fail('write a json line as: json <field>: <JSON>', 'json', indent + 1);
        let value;
        try { value = JSON.parse(m[2]); } catch (e) { throw fail(`the JSON in "json ${m[1]}" is not valid (${e.message})`, `json ${m[1]}`, indent + 1, m[1]); }
        const field = m[1];
        if (part) {
          if (field === 'notes') part.jsonNotes = value;
          else if (field === 'order') part.order = value;
          else if (field === 'automation') { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('"json automation" must be an object of lanes', 'json automation', indent + 1, 'automation'); part.automation = Object.assign(part.automation || {}, value); }
          else if (field === 'devices') { if (!Array.isArray(value)) throw fail('"json devices" must be a list', 'json devices', indent + 1, 'devices'); part.devices = (part.devices || []).concat(value); }
          else if (field === 'vibrato') { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('"json vibrato" must be an object', 'json vibrato', indent + 1, 'vibrato'); part.raw.vibrato = Object.assign(part.raw.vibrato || {}, value); }
          else if (field === 'name') { if (typeof value !== 'string') { part.raw.name = value; } else { part.raw.name = value; part.name = value; } }
          else part.raw[field] = value;
        } else {
          if (field === 'parts' || field === 'format' || field === 'version') throw fail(`"${field}" cannot be set with a json line`, `json ${field}`, indent + 1, field);
          raw[field] = value;
        }
        continue;
      }
      if (part && (word === 'device' || word === 'lane' || word === 'vibrato')) {
        flush();
        const fail = mk(here());
        if (word === 'device') {
          const m = /^device[ \t]+(\S+)(.*)$/.exec(body);
          if (!m) throw fail('write a device line as: device <type> key=value ...', 'device', indent + 1, 'devices');
          const types = Object.keys(C.DEVICE_DEFAULTS);
          if (!C.DEVICE_DEFAULTS[m[1]]) throw fail(`unknown device "${m[1]}"${suggest(m[1], types)}`, m[1], indent + 8, 'devices');
          const dv = { type: m[1] };
          const keys = Object.keys(C.DEVICE_DEFAULTS[m[1]]).concat(['on']);
          for (const pr of scanPairs(m[2], indent + 8 + m[1].length, (msg, tk, c) => fail(msg, tk, c, 'devices'))) {
            if (!keys.includes(pr.key)) throw fail(`the ${m[1]} device has no "${pr.key}"${suggest(pr.key, keys)}`, `${pr.key}=${pr.text}`, pr.col, 'devices');
            let value = scalar(pr.text, (msg, tk, c) => fail(msg, tk, c, 'devices'), `${pr.key}=${pr.text}`, pr.col);
            if (pr.key === 'on' && (value === 0 || value === 1)) value = value === 1;
            dv[pr.key] = value;
          }
          (part.devices || (part.devices = [])).push(dv);
        } else if (word === 'lane') {
          const m = /^lane[ \t]+([A-Za-z]\w*)[ \t]*:(.*)$/.exec(body);
          if (!m) throw fail('write a lane line as: lane <name>: tick=value tick=value! ...', 'lane', indent + 1);
          if (!C.LANES.includes(m[1])) throw fail(`unknown lane "${m[1]}"${suggest(m[1], C.LANES)}`, m[1], indent + 6, `lane:${m[1]}`);
          const pts = [];
          for (const w of scanWords(m[2], indent + body.indexOf(':') + 2, fail)) {
            const q = /^(-?\d+)=([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([!<]*)$/i.exec(w.text);
            if (!q || /(.).*\1/.test(q[3])) throw fail(`"${w.text}" is not a lane point (tick=value, then ! for post or < for pre)`, w.text, w.col, `lane:${m[1]}`);
            const pt = { t: Number(q[1]), v: Number(q[2]) };
            if (q[3].includes('!')) pt.post = true;
            if (q[3].includes('<')) pt.pre = true;
            pts.push(pt);
          }
          const lanes = part.automation || (part.automation = {});
          lanes[m[1]] = (lanes[m[1]] || []).concat(pts);
        } else {
          const vib = part.raw.vibrato || (part.raw.vibrato = {});
          for (const pr of scanPairs(body.slice(7), indent + 8, (msg, tk, c) => fail(msg, tk, c, 'vibrato'))) {
            if (!VIBRATO_KEYS.includes(pr.key)) throw fail(`unknown vibrato setting "${pr.key}"${suggest(pr.key, VIBRATO_KEYS)}`, pr.key, pr.col, 'vibrato');
            if (pr.key === 'sync') {
              const b = parseBool(pr.text);
              if (b === null) throw fail(`sync must be 1 or 0, not "${pr.text}"`, `sync=${pr.text}`, pr.col, 'vibrato');
              vib.sync = b;
            } else {
              if (!NUM.test(pr.text)) throw fail(`${pr.key} needs a number, not "${pr.text}"`, `${pr.key}=${pr.text}`, pr.col, 'vibrato');
              vib[pr.key] = Number(pr.text);
            }
          }
        }
        continue;
      }
      if (word === 'device' || word === 'lane' || word === 'vibrato') throw mk({ line: ln })(`"${word}" belongs under a part`, word, indent + 1);
      const hm = HEADER_RE.exec(body);
      if (hm) {
        flush();
        const key = hm[1], arg = hm[2], val = hm[3].trim();
        const bad =(msg, field) => mk({ line: ln, part })(msg, hm[0].split(':')[0].trim(), indent + 1, field);
        if (part) throw bad(`"${key}:" is a header line; put header lines before the first part`, null);
        const needNum = (field) => { if (!NUM.test(val)) throw bad(`${key} needs a number, not "${val}"`, field); return Number(val); };
        switch (key) {
          case 'title': raw.name = val; break;
          case 'author': raw.author = val; break;
          case 'tempo': { const v = needNum('bpm'); if (!(v > 0)) throw bad(`tempo must be above 0, not ${val}`, 'bpm'); raw.bpm = v; break; }
          case 'bars': { const v = needNum('bars'); if (!isInt(v) || v < 1) throw bad(`bars must be a whole number from 1, not ${val}`, 'bars'); raw.bars = v; break; }
          case 'markers': { const v = needNum('markerBars'); if (v !== 0 && v !== 2 && v !== 4) throw bad(`markers must be 0, 2 or 4, not ${val}`, 'markerBars'); raw.markerBars = v; break; }
          case 'lead': { const v = needNum('leadIn'); if (!isInt(v) || v < 0) throw bad(`lead must be a whole number of ticks, not ${val}`, 'leadIn'); raw.leadIn = v; break; }
          case 'loop': {
            if (val === 'off') { raw.loop = { on: false }; break; }
            const m = /^(\d+)[ \t]*-[ \t]*(\d+)$/.exec(val);
            if (!m || Number(m[1]) < 1 || Number(m[2]) < Number(m[1])) throw bad(`loop must be "first-last" bars (like 5-16) or "off", not "${val}"`, 'loop');
            raw.loop = { on: true, startBar: Number(m[1]), endBar: Number(m[2]) };
            break;
          }
          case 'autotune': { const b = parseBool(val); if (b === null) throw bad(`autotune must be on or off, not "${val}"`, 'autoTune'); raw.autoTune = b; break; }
          case 'chorus': { if (val === 'off' || val === 'none') { raw.chorusBar = null; break; } const v = needNum('chorusBar'); if (!isInt(v) || v < 1) throw bad(`chorus must be a bar number, not ${val}`, 'chorusBar'); raw.chorusBar = v; break; }
          case 'key': {
            if (val === 'none' || val === 'off') { raw.key = null; break; }
            const m = /^([A-Ga-g])(#|b)?[ \t]+(\S+)$/.exec(val);
            if (!m) throw bad(`key must be a note and a scale (like "A minor"), not "${val}"`, 'key');
            raw.key = { root: (LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12, scale: m[3] };
            break;
          }
          case 'section': {
            if (!arg || !/^\d+$/.test(arg) || Number(arg) < 1) throw bad('write a section as "section <bar>: <name>"', 'sections');
            (raw.sections || (raw.sections = [])).push({ bar: Number(arg), name: val });
            break;
          }
          case 'tempo-change': {
            const m = arg ? /^(\d+)\.(\d+)$/.exec(arg) : null;
            if (!m || Number(m[1]) < 1 || Number(m[2]) < 1 || Number(m[2]) > 4) throw bad('write a tempo change as "tempo-change <bar>.<beat>: <bpm>" (beat 1..4)', 'tempoChanges');
            const v = needNum('tempoChanges');
            if (!(v > 0)) throw bad(`tempo must be above 0, not ${val}`, 'tempoChanges');
            (raw.tempoChanges || (raw.tempoChanges = [])).push({ t: (Number(m[1]) - 1) * BAR + (Number(m[2]) - 1) * (BAR / 4), bpm: v });
            break;
          }
          default: break;
        }
        continue;
      }
      if (open) { scanBars(open, s, indent, ln); continue; }
      const first = /^[A-Za-z][\w-]*/.exec(body);
      const known = HEADER_WORDS.concat(PART_WORDS_ALL).concat(['bar']);
      throw mk({ line: ln })(`unknown word "${first ? first[0] : body.split(/\s+/)[0]}"${first ? suggest(first[0], known) : ''}`, first ? first[0] : body.split(/\s+/)[0], indent + 1);
    }
    if (!started) throw mk({ line: 1 })('the score is empty; the first line must be "cps3 score 1"', '', 1);
    flush(); finishPart();
    raw.parts = parts;
    if (raw.bars === undefined) {
      let top = 1;
      for (const p of parts) for (const n of p.notes) top = Math.max(top, Math.floor(n.t / BAR) + 1);
      raw.bars = top;
    }
    if (raw.loop === undefined) raw.loop = { on: true, startBar: 1, endBar: raw.bars };
    return raw;
  }

  function parse(text) { return compile().normalize(parseRaw(text)); }

  /* ---- print --------------------------------------------------------------------------------- */
  let defaultBanks = null;
  const setBanks = (banks) => { defaultBanks = banks || null; };

  const wordText = (w, v) => {
    const spec = WORD_SPEC[w];
    if (spec[0] === 'bool') return v === true ? '1' : null;
    if (spec[0] === 'str') return typeof v !== 'string' ? null : v !== '' && !/\s/.test(v) && v[0] !== '"' ? v : JSON.stringify(v);
    if (!isNum(v)) return null;
    if (spec[0] === 'int' && (!isInt(v) || v < spec[1] || v > spec[2])) return null;
    return String(v);
  };
  /* a value in a device line */
  function valueText(v) {
    if (isNum(v)) return String(v);
    if (v === true || v === false || v === null) return String(v);
    if (typeof v === 'string') return BAREWORD.test(v) && !RESERVED.has(v) ? v : JSON.stringify(v);
    if (Array.isArray(v) || (v && typeof v === 'object')) return JSON.stringify(v);
    return null;
  }

  function noteToken(n, kit, state) {
    let tok = kit ? `#${n.n}` : noteName(n.n);
    if (n.len !== state.len) { tok += ':' + spell(n.len); state.len = n.len; }
    if (n.v !== state.vel) { tok += '!' + n.v; state.vel = n.v; }
    if (n.tie) tok += '~';
    const ex = [];
    for (const k of EXTRA_KEYS) if (k in n) ex.push(k === 'bend' ? `bend=${n.bend.map((p) => `${p[0]}:${p[1]}`).join(';')}` : `${k}=${n[k]}`);
    if (ex.length) tok += `{${ex.join(' ')}}`;
    return tok;
  }
  /* the text of one bar of one voice; `state` carries the sticky length and velocity */
  function barText(arr, kit, state) {
    let cursor = 0;
    const toks = [];
    for (const n of arr) {
      if (n.rel > cursor) {
        const gap = n.rel - cursor;
        if (SPELL.has(gap)) { toks.push('r' + (gap !== state.len ? ':' + SPELL.get(gap) : '')); state.len = gap; }
        else toks.push('@' + n.rel);
        cursor = n.rel;
      }
      toks.push(noteToken(n, kit, state));
      cursor = n.rel + n.len;
    }
    return toks.join(' ');
  }
  const barKey = (arr) => arr.map((n) => `${n.rel},${n.n},${n.len},${n.v},${n.tie ? 1 : 0},${EXTRA_KEYS.map((k) => (k in n ? JSON.stringify(n[k]) : '')).join(',')}`).join(';');

  /* One voice line per simultaneous voice: first fit by end tick, highest key first at equal ticks, no note dropped.
   * The same split as Seq.lanes with room for every voice, kept here so that the text a project prints as never
   * depends on a change to the compiler's own voice allocation. */
  function splitVoices(notes) {
    const sorted = notes.slice().sort((a, b) => a.t - b.t || b.n - a.n);
    const lanes = [];
    for (const n of sorted) {
      let lane = lanes.find((l) => l.end <= n.t);
      if (!lane) { lane = { end: 0, notes: [] }; lanes.push(lane); }
      lane.notes.push(n);
      lane.end = n.t + n.len;
    }
    return lanes.map((l) => l.notes);
  }

  /* bar lines for one part's notes, or null when some note has no exact spelling */
  function noteLines(notes, kit) {
    if (!notes.length) return { lines: [], order: null };
    if (!notes.every(noteExpressible)) return null;
    const split = { lanes: splitVoices(notes.map((n, i) => Object.assign({}, n, { __i: i }))) };
    const lines = [], places = [];
    split.lanes.forEach((voice, vi) => {
      const byBar = new Map();
      voice.forEach((n, pos) => {
        const b = Math.floor(n.t / BAR), item = Object.assign({}, n, { rel: n.t - b * BAR });
        if (!byBar.has(b)) byBar.set(b, []);
        byBar.get(b).push(item);
        places.push({ i: n.__i, t: n.t, n: n.n, voice: vi + 1, pos });
      });
      const keys = new Map();
      for (const [b, arr] of byBar) keys.set(b, barKey(arr));
      const chunks = Array.from(new Set(Array.from(byBar.keys()).map((b) => Math.floor(b / 4)))).sort((a, b) => a - b);
      for (const chunk of chunks) {
        const first = chunk * 4;
        let last = first;
        for (let b = first; b < first + 4; b++) if (byBar.has(b)) last = b;
        const state = { len: DEFAULT_LEN, vel: DEFAULT_VEL }, segs = [];
        for (let b = first; b <= last; b++) {
          const arr = byBar.get(b);
          if (!arr) segs.push('');
          else if (b > 0 && keys.get(b - 1) === keys.get(b)) segs.push('%');
          else segs.push(barText(arr, kit, state));
        }
        lines.push(`${split.lanes.length > 1 ? `v${vi + 1} ` : ''}bar ${first + 1} |${segs.map((sg) => (sg ? ` ${sg} |` : ' |')).join('')}`);
      }
    });
    places.sort((a, b) => a.t - b.t || b.n - a.n || a.voice - b.voice || a.pos - b.pos);
    const order = new Array(notes.length);
    places.forEach((p, k) => { order[p.i] = k; });
    return { lines, order: order.every((v, i) => v === i) ? null : order };
  }

  function partIsKit(part, banks) {
    if (part.role === 'drums' || part.role === 'perc') return true;
    const bank = banks && banks[part.bank], prog = bank && bank[part.program];
    return !!(prog && prog.kit);
  }

  function emit(P, force, defSong, defPart, banks) {
    const out = ['cps3 score 1'];
    const T = force.top, allTop = T.has('*');
    const J = (field, value) => `json ${field}: ${JSON.stringify(value)}`;
    const text = (v) => (typeof v === 'string' && !/[\r\n]/.test(v) ? v : null);
    const tempoLine = (c) => {
      if (!c || !isInt(c.t) || c.t < 0 || c.t % (BAR / 4) || !isNum(c.bpm) || !(c.bpm > 0) || Object.keys(c).length !== 2) return null;
      return `tempo-change ${Math.floor(c.t / BAR) + 1}.${Math.floor((c.t % BAR) / (BAR / 4)) + 1}: ${c.bpm}`;
    };
    const FIELDS = [
      ['name', true, (v) => (text(v) !== null ? [`title:${v ? ' ' + v : ''}`] : null)],
      ['author', false, (v) => (text(v) !== null ? [`author:${v ? ' ' + v : ''}`] : null)],
      ['bpm', true, (v) => (isNum(v) && v > 0 ? [`tempo: ${v}`] : null)],
      ['tempoChanges', false, (v) => { if (!Array.isArray(v)) return null; const l = v.map(tempoLine); return l.every(Boolean) ? l : null; }],
      ['bars', true, (v) => (isInt(v) && v >= 1 ? [`bars: ${v}`] : null)],
      ['loop', true, (v) => (v && v.on === true && isInt(v.startBar) && isInt(v.endBar) ? [`loop: ${v.startBar}-${v.endBar}`] : v && v.on === false ? ['loop: off'] : null)],
      ['markerBars', true, (v) => (v === 0 || v === 2 || v === 4 ? [`markers: ${v}`] : null)],
      ['key', false, (v) => (v && isInt(v.root) && v.root >= 0 && v.root < 12 && typeof v.scale === 'string' && /^\S+$/.test(v.scale) && Object.keys(v).length === 2 ? [`key: ${NAMES[v.root]} ${v.scale}`] : null)],
      ['leadIn', false, (v) => (isInt(v) && v >= 0 ? [`lead: ${v}`] : null)],
      ['autoTune', true, (v) => (typeof v === 'boolean' ? [`autotune: ${v ? 'on' : 'off'}`] : null)],
      ['chorusBar', false, (v) => (isInt(v) && v >= 1 ? [`chorus: ${v}`] : null)],
      ['sections', false, (v) => { if (!Array.isArray(v)) return null; const l = v.map((s) => (s && isInt(s.bar) && s.bar >= 1 && text(s.name) !== null && s.name === s.name.trim() && Object.keys(s).length === 2 ? `section ${s.bar}: ${s.name}` : null)); return l.every(Boolean) ? l : null; }],
    ];
    const handled = new Set(['format', 'version', 'parts', 'ui']);
    const jsons = [];
    for (const [field, always, fn] of FIELDS) {
      handled.add(field);
      const v = P[field];
      const lines = allTop || T.has(field) ? null : (always || !eq(v, defSong[field]) ? fn(v) : []);
      if (lines === null) { if (always || !eq(v, defSong[field]) || T.has(field)) jsons.push(J(field, v)); }
      else for (const l of lines) out.push(l);
    }
    for (const k of Object.keys(P)) if (!handled.has(k) && !eq(P[k], defSong[k])) jsons.push(J(k, P[k]));
    for (const l of jsons) out.push(l);

    P.parts.forEach((part, i) => {
      out.push('');
      const F = force.parts[i], allP = F.has('*');
      const pj = [], kids = [];
      const nameOk = typeof part.name === 'string' && !allP && !F.has('name');
      const nameTok = nameOk ? (/^[^\s"]+$/.test(part.name) ? part.name : JSON.stringify(part.name)) : '""';
      if (!nameOk) pj.push(J('name', part.name));
      const words = [];
      for (const w of WORDS) {
        const v = part[w], must = ALWAYS_WORDS.has(w);
        if (!must && eq(v, defPart[w]) && !F.has(w)) continue;
        const t = allP || F.has(w) ? null : wordText(w, v);
        if (t === null) { if (must || !eq(v, defPart[w])) pj.push(J(w, v)); }
        else words.push(`${w} ${t}`);
      }
      out.push(`part ${nameTok}${words.length ? ' ' + words.join(' ') : ''}`);
      const handledP = new Set(['name', 'notes', 'automation', 'devices', 'raw', 'vibrato'].concat(WORDS));
      for (const k of Object.keys(part)) {
        if (handledP.has(k)) continue;
        if (k === 'id' ? part.id !== `p${i + 1}` : !eq(part[k], defPart[k])) pj.push(J(k, part[k]));
      }
      /* vibrato */
      if (!eq(part.vibrato, defPart.vibrato)) {
        const vb = part.vibrato;
        let line = null;
        if (!allP && !F.has('vibrato') && vb && typeof vb === 'object' && !Array.isArray(vb) && Object.keys(vb).every((k) => VIBRATO_KEYS.includes(k))
            && ['depth', 'rate', 'delay', 'tremolo'].every((k) => !(k in vb) || isNum(vb[k])) && (!('sync' in vb) || typeof vb.sync === 'boolean')) {
          const bits = VIBRATO_KEYS.filter((k) => k in vb && !eq(vb[k], defPart.vibrato[k])).map((k) => `${k}=${k === 'sync' ? (vb.sync ? 1 : 0) : vb[k]}`);
          line = bits.length ? `vibrato ${bits.join(' ')}` : null;
        }
        if (line) kids.push(line); else pj.push(J('vibrato', part.vibrato));
      }
      /* devices */
      if (part.devices.length) {
        const lines = allP || F.has('devices') ? null : part.devices.map((dv) => {
          const def = dv && typeof dv === 'object' ? compile().DEVICE_DEFAULTS[dv.type] : null;
          if (!def || typeof dv.type !== 'string') return null;
          const bits = [];
          for (const k of Object.keys(dv)) {
            if (k === 'type') continue;
            if (k !== 'on' && !(k in def)) return null;
            if (k in def && eq(dv[k], def[k])) continue;
            const vt = valueText(dv[k]);
            if (vt === null) return null;
            bits.push(`${k}=${vt}`);
          }
          return `device ${dv.type}${bits.length ? ' ' + bits.join(' ') : ''}`;
        });
        if (lines && lines.every(Boolean)) for (const l of lines) kids.push(l); else pj.push(J('devices', part.devices));
      }
      /* lanes */
      const laneJson = {};
      const laneNames = compile().LANES;
      for (const name of Object.keys(part.automation)) {
        const pts = part.automation[name];
        const ok = !allP && !F.has(`lane:${name}`) && laneNames.includes(name) && Array.isArray(pts)
          && pts.every((p) => p && typeof p === 'object' && Object.keys(p).every((k) => k === 't' || k === 'v' || k === 'post' || k === 'pre')
            && isInt(p.t) && isNum(p.v) && (!('post' in p) || p.post === true) && (!('pre' in p) || p.pre === true));
        if (ok) kids.push(`lane ${name}:${pts.map((p) => ` ${p.t}=${p.v}${p.post ? '!' : ''}${p.pre ? '<' : ''}`).join('')}`);
        else laneJson[name] = pts;
      }
      if (Object.keys(laneJson).length) pj.push(J('automation', laneJson));
      if (part.raw.length) pj.push(J('raw', part.raw));
      /* notes */
      let nl = null;
      if (!allP && !F.has('notes')) nl = noteLines(part.notes, partIsKit(part, banks));
      if (nl) { for (const l of nl.lines) kids.push(l); if (nl.order) pj.push(J('order', nl.order)); }
      else if (part.notes.length || F.has('notes')) pj.push(J('notes', part.notes));
      for (const l of pj) out.push('  ' + l);
      for (const l of kids) out.push('  ' + l);
    });
    return out.join('\n') + '\n';
  }

  /* what differs between two normalised projects: [{ part: index | null, key }] */
  function diff(P, Q) {
    const found = [];
    const keys = (a, b) => Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
    for (const k of keys(P, Q)) if (k !== 'parts' && k !== 'ui' && !eq(P[k], Q[k])) found.push({ part: null, key: k });
    if (P.parts.length !== Q.parts.length) throw new Error('SF3Score.print: the text reads back with a different number of parts');
    P.parts.forEach((a, i) => {
      const b = Q.parts[i];
      for (const k of keys(a, b)) {
        if (eq(a[k], b[k])) continue;
        if (k === 'automation') for (const lane of keys(a.automation, b.automation)) { if (!eq(a.automation[lane], b.automation[lane])) found.push({ part: i, key: `lane:${lane}` }); }
        else found.push({ part: i, key: k });
      }
    });
    return found;
  }

  function print(project, opts) {
    const C = compile();
    const banks = (opts && opts.banks) || defaultBanks;
    const P = C.normalize(project);
    const defSong = C.normalize({ format: 'sf3project', version: 2, parts: [{}] }), defPart = defSong.parts[0];
    const force = { top: new Set(), parts: P.parts.map(() => new Set()) };
    let last = '';
    for (let round = 0; round < 5; round++) {
      const text = emit(P, force, defSong, defPart, banks);
      last = text;
      let Q;
      try { Q = parse(text); } catch (e) {
        if (!(e instanceof ScoreError)) throw e;
        const set = e.partIndex !== null && e.partIndex !== undefined ? force.parts[e.partIndex] : force.top;
        const token = e.field || '*';
        if (set.has(token) && set.has('*')) throw new Error(`SF3Score.print: its own text does not read back (${e.message})`);
        set.add(set.has(token) ? '*' : token);
        continue;
      }
      const d = diff(P, Q);
      if (!d.length) return text;
      let progress = false;
      for (const x of d) {
        const set = x.part === null ? force.top : force.parts[x.part];
        if (!set.has(x.key)) { set.add(x.key); progress = true; }
      }
      if (!progress) {
        for (const x of d) { const set = x.part === null ? force.top : force.parts[x.part]; if (!set.has('*')) { set.add('*'); progress = true; } }
        if (!progress) throw new Error(`SF3Score.print: ${d.map((x) => (x.part === null ? x.key : `part ${x.part + 1} ${x.key}`)).join(', ')} does not read back identically`);
      }
    }
    throw new Error(`SF3Score.print: no stable text after 5 rounds (${last.length} characters)`);
  }

  const api = { parse, print, ScoreError, setBanks, noteName, spell, VERSION };
  g.SF3Score = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
