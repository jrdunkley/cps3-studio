/* Hidden browser runner. Wait for the actual page result: Windows' browser launcher may exit
 * before its child process, and virtual-time dump-dom can finish before IndexedDB completes. */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '..'), out = process.env.STUDIO_BROWSER_OUTPUT || path.resolve(root, 'out/browser');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const exe = [process.env.STUDIO_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
    .find(p => p && fs.existsSync(p));
  if (!exe) throw new Error('No Chrome, Chromium or Edge found; set STUDIO_BROWSER to its executable.');
  const profile = path.join(out, 'browser-' + process.pid + '-' + Date.now()), portFile = path.join(profile, 'DevToolsActivePort');
  const page = process.argv[2] || 'index.html#selftest', [file, fragment] = page.split('#'), width = +(process.argv[4] || 1600), height = +(process.argv[5] || 900);
  const proc = cp.spawn(exe, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=' + width + ',' + height, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws, call;
  try {
    const start = Date.now(); while (!fs.existsSync(portFile)) { if (Date.now() - start > 30000) throw new Error('Hidden browser did not start.'); await delay(200); }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json(), target = targets.find(t => t.type === 'page');
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map(); ws.onmessage = event => { const data = JSON.parse(event.data); if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } };
    call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('Browser timeout: ' + method)); }, 30000); pending.set(n, data => { clearTimeout(timer); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: pathToFileURL(path.join(root, file)).href + '#' + (fragment || '') });
    let text;
    for (let i = 0; i < 600; i++) {
      text = await evaluate('document.getElementById("selftest")?.textContent || ""');
      if (/selftest: \d+ checks, \d+ failures\s*$/.test(text)) break;
      if (process.argv[3] && await evaluate('document.readyState === "complete" && (!window.Studio || !!Studio.state?.project && !!Studio.activeView || !!document.querySelector(".welcome"))')) break;
      await delay(300);
    }
    if (process.env.STUDIO_BROWSER_PROBE) await require(path.resolve(process.env.STUDIO_BROWSER_PROBE))({ call, evaluate, delay });
    if (process.argv[3]) { await delay(Number(process.env.STUDIO_BROWSER_WAIT || 200)); const shot = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, process.argv[3] + '.png'), Buffer.from(shot.data, 'base64')); console.log(path.join(out, process.argv[3] + '.png')); }
    else { console.log(text || 'No self-test result.'); fs.writeFileSync(path.join(out, path.basename(file) + '.log'), text || 'No result'); if (!/selftest: [1-9]\d* checks, 0 failures\s*$/.test(text)) process.exitCode = 1; }
    fs.writeFileSync(path.join(out, (process.argv[3] || path.basename(file)) + '.dom.html'), await evaluate('document.documentElement.outerHTML'));
  } finally { if (ws && ws.readyState === WebSocket.OPEN && call) { try { await Promise.race([call('Browser.close'), delay(3000)]); } catch (_) {} } if (ws) ws.close(); if (proc.exitCode === null) proc.kill(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
