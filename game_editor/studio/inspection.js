/* Pixel inspection reads the paused machine; the engine reuses the native compositor. */
(function (g) {
  'use strict';
  const K = Kit, el = K.el;
  let active = false, last = null;
  const hex = n => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
  function show(result) {
    const winner = result.contributors.at(-1), kind = { sprite: 'Sprite', map: 'Background layer', score: 'Interface tile', clear: 'Backdrop', retained: 'Earlier picture' };
    const body = el('div.vbox', null, el('p', null, `Frame ${result.frame} · pixel ${result.x}, ${result.y}`),
      el('b', null, kind[winner.kind]), el('p', null, `Colour entry ${result.index}${winner.bits ? ' \u00b7 source palette '+winner.palette+' \u00b7 pen '+winner.pen : ''}`));
    const swatch = el('div', { style: { height: '44px', borderRadius: '8px', background: '#' + result.rgb.toString(16).padStart(6, '0') } });
    body.append(swatch);
    const owner=winner.owner;
    if(owner){
      const who=owner.work===0x02068C6C?'Player 1':owner.work===0x02069104?'Player 2':'Object '+hex(owner.work);
      body.append(el('b',{'data-owner-work':hex(owner.work)},who+' \u00b7 sprite '+owner.cel),el('p.hint',null,'Captured when this object submitted its picture, at frame '+owner.submitted+'.'));
      const target=new URL('../art_editor/index.html',location.href),params=new URLSearchParams({sprite:owner.cel,source:GameStudio.source.id,program:GameStudio.rom.sha256,charset:owner.charset,script:owner.script,index:owner.scriptIndex});
      target.hash=params.toString();
      body.append(el('a.btn.primary',{'data-inspected-art':'',href:target.href,onclick:async event=>{event.preventDefault();await CPS3Studio.flush();location.href=target.href;}},'Open artwork and animation'));
    }else if(winner.kind==='sprite')body.append(el('p.hint',null,winner.buffered?'This picture came from a buffered display list. Its submitting object is unknown.':'No verified submission was observed for this draw record.'));
    if (winner.kind === 'retained') body.append(el('p.hint', null, 'The board reused a pixel from its persistent picture buffer at this zoom. The current display list did not draw it.'));
    if (result.contributors.length > 1) body.append(el('p', null, result.contributors.length + ' contributors, including blend effects.'));
    const advanced = el('details', null, el('summary', null, 'Drawing details'));
    const fields = [['Field pixel', result.fieldX + ', ' + result.fieldY], ['Zoom register', result.zoom], ['Tile', winner.tile], ['Cell address', hex(winner.cellAddress)],
      ['Character RAM byte', hex(winner.charAddress)], ['Source pixel', winner.sourceX + ', ' + winner.sourceY], ['Pens', 1 << winner.bits], ['Mirror', winner.flip], ['Blend', winner.blend]];
    for (const [name, value] of fields) advanced.append(el('p.hbox', null, el('small', null, name), el('span.num', null, String(value))));
    if(owner)for(const [name,value]of [['WORK',hex(owner.work)],['Queue node',hex(owner.node)],['Object fields',owner.workId+' / '+owner.objectId],['Charset',owner.charset],['Script',hex(owner.script)],['Script dword index',owner.scriptIndex],['Position',owner.x+', '+owner.y+', '+owner.z],['Submitted / emitted',owner.submitted+' / '+owner.emitted]])advanced.append(el('p.hbox',null,el('small',null,name),el('span.num',null,String(value))));
    body.append(advanced);
    return K.dialog({ title: 'Picture inspector', body, width: 540 });
  }
  async function inspect(x, y) {
    const S = GameStudio;
    if (S.game.playing) await K.run('game.play');
    S.flushPicture();await new Promise(requestAnimationFrame);
    const result = await S.game.inspectPixel(x, y);
    if (!result.matches) throw new Error('The picture changed before inspection. Step once and inspect again.');
    last = result; show(result); return result;
  }
  document.addEventListener('DOMContentLoaded', () => {
    K.action({ id: 'game.inspect', title: 'Inspect a pixel', hint: 'Pause, then click a game pixel to see what drew it.', group: 'Game', enabled: () => GameStudio.ready,
      run: async () => {
        if (GameStudio.game.playing) await K.run('game.play');
        GameStudio.flushPicture();await new Promise(requestAnimationFrame);
        active = !active; button.classList.toggle('on', active);
        const canvas = document.querySelector('.game-screen'); if (canvas) canvas.style.cursor = active ? 'crosshair' : '';
        K.status(active ? 'Click a pixel to inspect its sprite, background or interface source.' : 'Pixel inspection off.');
      } });
    const button = el('button.btn.ghost', { 'data-action': 'game.inspect' }, 'Inspect');
    document.getElementById('slots').before(button); K.bind(button, 'game.inspect');
    document.getElementById('workspace').addEventListener('pointerdown', event => {
      if (!active || event.button !== 0 || !event.target.matches('.game-screen')) return;
      event.preventDefault(); const r = event.target.getBoundingClientRect();
      inspect(Math.min(383, Math.floor((event.clientX - r.left) * 384 / r.width)), Math.min(223, Math.floor((event.clientY - r.top) * 224 / r.height))).catch(error => K.toast(error.message, { kind: 'bad' }));
    });
  });
  g.GameInspection = { inspect, get last() { return last; } };
})(window);
