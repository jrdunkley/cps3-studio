/* What Art mode can do, and how far each ability has been proved in the game.
 *
 * One registry, read by every workspace: a control whose ability is not 'proven' is shown
 * disabled or labelled with the ability's sentence, and Help prints the whole list.
 * States: 'proven'   a gate compared the result exactly (the evidence names it)
 *         'limited'  proven inside the stated domain only
 *         'unverified' built or planned, not yet shown safe in the game
 * Nothing is switched on by optimism: a state changes only when a gate passes, and the evidence
 * line says which. No page code here, so the same list runs in the checks under Node.
 */
(function (g) {
  'use strict';
  const STATES = ['proven', 'limited', 'unverified'];
  const list = [
    { id: 'sprite.view', group: 'Sprites', title: 'See and export any sprite', state: 'proven',
      says: 'Sprites are read from your ROM exactly as the game stores them.', evidence: 'AG2: 36,908 sprites equal to the reference decoder; AG3 every stored stream round-trips' },
    { id: 'sprite.replace', group: 'Sprites', title: 'Replace a sprite inside its own tiles', state: 'limited', domain: 'For a sprite that shares no stored bytes, table writes or tiles with another, keeps its tiles, and fits the bytes it owns.',
      says: 'A changed sprite that keeps its tiles and fits its own bytes goes into the game as drawn.', evidence: 'AG6 + AG7 with the Studio installer: sprite 24033, 120 frames equal in pixels and game state (u4_deliver game_20261004_190101)', installMethod: 'same-shape-fixed-table-in-place'},
    { id: 'sprite.animation', group: 'Sprites', title: 'Replace every frame of an animation', state: 'limited', domain: 'Each frame under the same conditions as a single sprite.',
      says: 'A whole animation can be replaced frame by frame.', evidence: 'AG7 with the Studio installer: sprites 23136-23140, 120 frames equal (u4_deliver game_20261004_190101)' },
    { id: 'sprite.shared', group: 'Sprites', title: 'Know what else a change touches', state: 'limited',
      says: 'The Studio lists every other sprite that reads the same stored bytes, table or tiles before you change it.',
      domain: 'Complete for sprites the game stores in its sprite list. Which frames show a sprite is known for character animations; effects and interface art are not all named yet. Suggested names for the rest are labels, not proof of who uses a sprite.',
      evidence: 'P2 sharing_gate.json (65,536 rows, brute-force checked), owners_gate.json; U6 g_names.js: all 36,911 numbers' },
    { id: 'sprite.eightbit', plain: "A few sprites are stored differently (256 pens or uncompressed). You can see and export them, but not change them yet.", group: 'Sprites', title: 'Sprites stored the other way (256 pens or uncompressed)', state: 'unverified',
      says: 'A few sprites are not stored as 64 pens. They can be seen; changing them is not proved.', evidence: 'lane P2 census' },
    { id: 'sprite.room', plain: "A changed sprite can't use more space than the original yet.", group: 'Room', title: 'Use more bytes than the sprite had', state: 'unverified',
      says: 'A change that needs more bytes than the sprite owns needs spare room in the ROM. Growing into bytes freed beside it has worked exactly in the game in a test; it is not offered until every reader of those bytes and every possible load of them is accounted for.', evidence: 'R3 experiments/local_growth and growth: 120 of 120 frames exact; licensed room 0 (room_manifest.json); lane R4 closing' },
    { id: 'sprite.tiles', plain: "Drawing outside the sprite's own tiles isn't possible yet.", group: 'Room', title: 'Paint outside the stored tiles', state: 'unverified',
      says: 'A larger picture needs more tiles in the ROM and in video memory, and a complete prediction of where the game puts and copies the enlarged sprite.', evidence: 'Slot tests T1/T2: a frame drawn with other cells predicted exactly (same cell count); R4 frame-33 blocker for a different tile count (geometry_blockers.json)' },
    { id: 'sprite.origin', plain: "Moving where the game places a sprite isn't possible yet.", group: 'Room', title: 'Move the origin or the tile layout', state: 'unverified',
      says: 'Changing where the game places a sprite changes its layout record; it needs a complete prediction of its placement and copies throughout the game.', evidence: 'Slot tests T1/T2: origin from the slot row predicted exactly (writers 060874F8/06087508, 0608760C/06087690); P1 position_04 +8 witness; the installer still refuses layout edits' },
    { id: 'sprite.owncopy', plain: "Giving one frame its own copy of a shared sprite isn't possible yet, so a change shows on every frame that shares it.", group: 'Room', title: 'Give a shared frame its own copy', state: 'unverified',
      says: 'Separating a frame from the others that share its sprite needs its own record and picture bytes. A slot built from placeholder records and placeholder-only bytes has worked exactly in the game in a test; it is not offered until every reader and possible load of that storage is accounted for.', evidence: 'Slot test T3 (research project): slot 488 rebuilt in a frame\'s shape, 120 frames exact in the game, experiment under S1; R4 own-copy experiment; blockers in R4 registry_proposal.json' },
    { id: 'sprite.new', plain: "Adding new sprites or frames isn't possible yet.", group: 'Room', title: 'Add new sprites or frames', state: 'unverified',
      says: 'A new frame needs safe storage for its record and picture, with every reader accounted for. Calling a placeholder number from an animation and giving it new pictures has worked exactly in the game in tests; the slot must keep the capacity of the frame it stands in for.', evidence: 'Slot tests T1-T3 (research project report): 120 frames exact each, whole-state prediction sealed before the run, experiments under S1' },
    { id: 'sprite.budget', group: 'Room', title: 'Know that a change loads in time', state: 'limited',
      says: 'A sprite replaced inside its own tiles asks the game for exactly the same loads as the original, so it appears when the original would.',
      domain: 'Replacements that keep the sprite’s tiles. For anything larger the Studio shows how much the game must load, without a verdict: when a load finishes also depends on what else the game is drawing.',
      evidence: 'R2 stress_domain/gate.json: identical requests, service and arrival for 120 frames; queue model exact on 58,420 frames; general readiness predictor not accepted (residency_blockers.json)' },
    { id: 'palette.character', group: 'Colours', title: 'Change a character’s colours', state: 'limited',
      says: 'Each selectable colour of a character is read from the ROM and can be changed; Deliver writes the change into the ROM files.',
      domain: 'Body colours of every character, all seven colour slots (Gill\'s body is recoloured by the game as it runs and stays read-only). Effect rows: only Ryu\'s projectile rows are proved. A changed row reads back exactly from the written files and every other stored colour row is untouched; each of the other 20 characters\' body colour was shown exactly in a fight on the native machine, and Ryu\'s also in Fightcade\'s emulator. Which effect rows belong to whom is not complete.',
      evidence: 'AG16 ag16.json (21 characters, read back from the written files); colour witnesses (research project: 20 characters visible, native model, exact palette and picture); C1 AG5.json and fireball witness; P3 edit_witness (Ryu LP)', installMethod: 'stored-row-words'},
    { id: 'palette.faces', group: 'Colours', title: 'HUD and Judgement face colours', state: 'limited',
      says: 'The 16 colours of each character’s HUD face (beside the life bar) and Judgement face (the time-out decision screen) can be changed for all seven colours; Deliver writes them into the ROM files.',
      domain: 'Stored 16-colour rows that the game copies with its own palette DMA: HUD faces from 03363B00 + 0xE0 per character + 0x20 per colour (loader 060D6CC4, at fight start); Judgement faces from 03389900 + 0x300 per colour + 0x20 per character (loader 060D5258 copies the whole colour block). The HUD face picture is previewed from its 15 SS tiles; the Judgement face picture is previewed from its panel cel 0x9DA8 + character (effect 37, read in the byte-exact source). In Fightcade’s emulator, face rows written by Deliver’s FBNeo patch load bit for bit (HUD rows 1FE0/1FF0 at fight start; both Judgement colour blocks at the time-out decision) and are what the HUD face and the judges’ panels show. Infinite extra colours show the native faces.',
      evidence: 'Loaders read in the stock program (2026-11-07); the HUD face DMA was matched bit-exact in game on 2026-10-28; gate AGP (agp.json) writes, reads back and re-imports face rows; in-game proof g_ingame_proofs (22 checks, 2026-11-07: Ryu HUD face, Ryu and Ken Judgement faces, stock and patched pictures and palette rows); PalMod lists the same offsets', installMethod: 'stored-row-words'},
    { id: 'palette.stage', group: 'Colours', title: 'Change a stage’s colours', state: 'limited',
      says: 'Both stored colour banks of every stage can be changed; Deliver writes them into the ROM files. The game applies its own fades to them as it runs.',
      domain: 'Both banks of all 23 stages read back exactly from the written files with every other stored row untouched. In forced stage loads on the native machine the edited colours loaded exactly as predicted on 21 stages and changed the picture exactly on 12 banks; the fixtures for stages 13 and 16 never loaded their banks. Ryu\'s stage and stage 0 also in Fightcade\'s emulator. Round variants and lighting the game computes are not checked.',
      evidence: 'AG16 ag16.json (46 banks); colour witnesses (research project: native model: 12 visible, 30 loaded, 4 not loaded); P4 colour_repeats/results.json; B3 palette/verdict.json', installMethod: 'stored-row-words'},
    { id: 'palette.gill', group: 'Colours', title: 'Gill timed body colours', state: 'limited',
      says: 'Edit the two halves of Gill\'s colour cycle, with 48 colours in each phase.',
      domain: 'Known 48-word program sources, preserving flags, phase tables, timing and the remaining 16 words, only where Gill’s colour handler and phase tables match the verified native ones. The original game has three timed full-state and picture comparisons. Infinite 1.07b changes Gill’s colour handler, so its timed colours are not listed there yet (Palettes says so). Sources shared by repeated phases and colour selections change together.',
      evidence: 'studio_feature_complete/w4/gill/runtime/report.json: 17,388 installed-SH2 calls per source, all seven choices, both sides and scheduling orders, full RAM/palette/RGB guards; live/report.json: Original reference comparisons', installMethod: 'timed-gill-body-words'},
    { id: 'palette.extended', group: 'Colours', title: 'Infinite extra colours', state: 'limited',
      says: 'Edit Infinite body and auxiliary colours on their installed button chords.',
      domain: 'The 33 installed extra choices for 19 characters, preserving handler code, row geometry and flag bits, read only where the installed handlers match the verified ones (earlier Infinite releases). Infinite 1.07b chains these hooks through Evil Ryu’s selection and colour code, which the Studio has not verified, so its extra colours are not listed yet (Palettes says so). Fighter, copy and assist rows share each source. Faded requests retain their native writers. Natural selection and effect lifetime coverage are separate checks.',
      evidence: 'studio_feature_complete/w4/extended/report.json: 25,170 installed-SH2 cases per build; schema.json: all choices, both sides, typed read-back and Builder guards', installMethod: 'installed-program-colour-words'},
    { id: 'palette.stage-variants', group: 'Colours', title: 'Infinite stage variants', state: 'limited',
      says: 'Edit both banks of Infinite\'s installed Oro and garage variants.',
      domain: 'Seven installed variants, read only where the stage colour hook matches the verified one (an earlier Infinite release). Infinite 1.07b installs a different stage colour hook with its new stages, which the Studio has not verified, so its variants are not listed yet. Oro advances through variants 2 to 6 as total losses increase; garage defaults to 7. Copy and round refresh preserve native fallback requests. Initial layer previews use the direct palette conversion. Live mode dispatch and stage schedules have separate gates.',
      evidence: 'studio_feature_complete/w4/stage_variants/report.json: 17,664 installed-SH2 cases per release, complete RAM/palette/RGB guards', installMethod: 'installed-stage-program-words'},
    { id: 'palette.computed', plain: "Fades and time-of-day colours are made by the game as it runs, so they are shown but not edited.", group: 'Colours', title: 'Colours the game works out as it runs', state: 'unverified',
      says: 'Fades and time-of-day colours are made by the game, not stored. They are shown, not edited.', evidence: 'lane P3 item 2' },
    { id: 'background.view', group: 'Backgrounds', title: 'See a stage’s layers', state: 'limited',
      says: 'Each stage’s layers are read from your ROM as the game first loads them, and can be exported.',
      domain: 'All 23 initial stage identities: the picture each stage starts with. Moving parts, lighting changes, other rounds and where the camera looks are not shown. One stored stage picture the game was never seen to load is marked unchecked; the two bonus scenes were only seen black.',
      evidence: 'U6 stage_gate.json: 23 recipes, 69 selectors, 49 maps and 49 full 1024 x 1024 layer atlases exact against B2 (including the unchecked picture 18); B2 coverage.json: 22 loaded stage recipes equal the traced loads, 66 of 69 sampled frames rebuilt exactly' },
    { id: 'background.edit', plain: "Repainting stage artwork isn't possible yet.", group: 'Backgrounds', title: 'Change stage artwork', state: 'unverified',
      says: 'Stage tiles can be repainted where they are stored. A repainted tile and a moved tile have each appeared exactly as predicted in the game in a test; it is not offered until every reader and possible stage load of those bytes is accounted for.', evidence: 'B3 tile and map verdict.json: every pixel and state byte equal at three checked moments (experiments under S1); stored references unclassified (S1_review); lane R4 closing' },
    { id: 'interface.view', group: 'Interface', title: 'See interface art', state: 'limited',
      says: 'The small 8 × 8 interface tiles (text and gauges) are read from your ROM and can be exported.',
      domain: 'Single tiles by number, read-only. Which tiles make which word or gauge, and portraits and logos, are not identified yet.',
      evidence: 'AG5 g_palette.js: 29,263 captured tile expansions equal the ROM; P3 interface gate' },
    { id: 'interface.edit', plain: "Repainting interface art isn't possible yet.", group: 'Interface', title: 'Change interface art', state: 'unverified',
      says: 'Interface art can be repainted where it is stored.', evidence: 'lane P3 item 4' },
    { id: 'rom.write', group: 'Game', title: 'Write patched ROM files', state: 'limited', domain: 'Graphics files: same-shape sprite replacements and stored colour rows, each inside the board envelope (gate AGH).',
      says: 'The Studio writes changed ROM files to a folder you choose and never touches the installed game.', evidence: 'AG1 member identity; browser, command line and game-tested files byte-identical (AG10D, AG15D); AG16 colour read-back; AGH board envelope', installMethod: 'same-shape-fixed-table-in-place'},
    { id: 'rom.seen', group: 'Game', title: 'Check a change in the running game', state: 'limited', domain: 'In the development workspace, with its private emulator copy. The portable Studio cannot start a game; it tells you how to look.',
      says: 'A change is compared, frame by frame, with the picture the Studio predicted.', evidence: 'AG7' },
  ];
  const byId = new Map(list.map((x) => [x.id, x]));

  function get(id) { const x = byId.get(id); if (!x) throw new Error(`Unknown ability: ${id}`); return x; }
  /* Only a proven ability, or a limited one inside the domain its caller checks, may be offered. */
  function allowed(id) { return get(id).state !== 'unverified'; }
  /* The sentence a person reads beside a limited or unavailable control: plain words. The technical scope (domain) and
     evidence stay in the table for Help's Technical detail and the documents. */
  function reason(id) { const x = get(id); return x.state === 'proven' ? '' : x.state === 'limited' ? x.says : x.plain || `Not yet available. ${x.says}`; }
  /* The lead sets states from gate results; a state without evidence is refused. */
  function set(id, state, fields) {
    if (!STATES.includes(state)) throw new Error(`Unknown state: ${state}`);
    const x = get(id), next = Object.assign({}, fields || {});
    if (state !== 'unverified' && !(next.evidence || x.evidence)) throw new Error('A proved ability needs its evidence.');
    if (state === 'limited' && !(next.domain || x.domain)) throw new Error('A limited ability needs its domain in words.');
    Object.assign(x, next, { state }); return x;
  }
  function groups() { const out = new Map(); for (const x of list) { if (!out.has(x.group)) out.set(x.group, []); out.get(x.group).push(x); } return out; }

  const api = { STATES, list, get, allowed, reason, set, groups };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.ArtLimits = api;
})(typeof window !== 'undefined' ? window : globalThis);
