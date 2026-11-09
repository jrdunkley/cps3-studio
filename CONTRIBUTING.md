# Contributing

Thank you for helping. A few principles keep the Studio trustworthy:

1. **The driver is the instrument.** Never imitate the game's sound driver in JavaScript. To know how something
   sounds, how loud it is or what a command does, run the driver (`music_editor/js/engine.js`) and measure.
2. **Prove sound with the driver.** A change to the compiler, the formats or the engine must keep
   `node music_editor/checks/run_tests.js` green. Never loosen a comparison, skip a case or special-case a song to pass.
3. **No ROM data in the repository.** Packs, samples, sequences, renders, decompiled pieces and patched images are
   derived from Capcom's work. The `.gitignore` covers the usual places; check `git status` before you commit.
   Test material must be original (see `music_editor/checks/gates/fixtures/make_songs.js`).
4. **Keep the browser workflow portable.** The pages open from disk without a frontend build. JavaScript tools need Node.js; optional Python checks and the game engine build have their own documented requirements. Preserve compiler/runtime notices when redistributing the engine.
5. **Styles come from the kit.** Colours, font sizes, radii and shadows live in `studio_kit/kit.css`; module CSS is
   layout only (G14 checks this). Every action has a title and a hint.

Report a bug with the steps, the browser or Node version, and, where sound is concerned, the song or score that
shows it.
