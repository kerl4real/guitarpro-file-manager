// Native frontend interaction checks without a browser or third-party test runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.value = ''; this.textContent = '';
    this.disabled = false; this.hidden = false; this.attributes = {};
    this.classList = {toggle: () => {}};
  }
  append(element) { this.children.push(element); }
  replaceChildren(...elements) { this.children = elements; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { return this.onclick?.(); }
}

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
const sorts = [...html.matchAll(/data-sort="([^"]+)"/g)].map(match => {
  const button = new Element();
  button.dataset.sort = match[1];
  button.parentElement = new Element();
  return button;
});
const calls = [];
let revision = 0, busy = false, failScan = false, failOpen = false;
const row = {path: 'C:\\Scores\\日本語.gp5', title: '<script>safe text</script>',
  artist: 'Björk', album: '', format: 'GP5', tempo: 120, tracks: 3, status: 'ok',
  record: JSON.stringify({metadata: {title: '日本語'}})};
const responses = {folder: 'C:\\Scores', parser: 'C:\\Tools\\score_tool.exe', jsonl: 'C:\\Exports\\scan.jsonl'};
const invoke = async (command, args) => {
  calls.push({command, args});
  switch (command) {
    case 'get_state': return {busy, cancelling: false, revision, message: busy ? 'Extracting…' : 'Ready',
      parser: 'score_tool', folder: 'Saved folder', database: 'library.sqlite3'};
    case 'query_library': return {rows: [row], page: Math.min(args.query.page, 1), page_size: 200, total: 205};
    case 'pick_path': return responses[args.kind];
    case 'start_scan':
      if (failScan) throw 'Parser unavailable';
      busy = true; return;
    case 'start_import': busy = true; return;
    case 'cancel_job': busy = false; revision += 1; return;
    case 'open_score':
      if (failOpen) throw 'Cannot open score: file was removed';
      return;
    default: throw new Error('Unexpected native command: ' + command);
  }
};
const context = vm.createContext({
  window: {__TAURI__: {core: {invoke}}},
  document: {getElementById: id => {
    assert.ok(elements[id], 'Missing element ' + id); return elements[id];
  }, createElement: () => new Element(), querySelectorAll: () => sorts},
  URL, URLSearchParams, console, setTimeout: () => 1, clearTimeout: () => {},
  // All backend communication must use Tauri IPC.
  fetch: () => {throw new Error('Native frontend attempted HTTP');}
});
vm.runInContext(fs.readFileSync(path.join(root, 'web/app.js'), 'utf8'), context);
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};

(async () => {
  await flush();
  assert.equal(elements.folder.value, 'Saved folder');
  assert.equal(elements['count'].textContent, '205 files');
  assert.equal(elements.next.disabled, false);
  assert.equal(elements.rows.children[0].children[0].textContent, row.title);

  await elements['browse-folder'].click();
  assert.equal(elements.folder.value, responses.folder);
  await elements['browse-parser'].click();
  assert.equal(elements.parser.value, responses.parser);
  await elements.scan.click();
  assert.equal(calls.find(call => call.command === 'start_scan').args.folder, responses.folder);
  assert.equal(elements.scan.disabled, true);
  assert.equal(elements.cancel.hidden, false);
  await elements.cancel.click();
  assert.equal(elements.scan.disabled, false);

  await elements.import.click();
  assert.equal(calls.find(call => call.command === 'start_import').args.path, responses.jsonl);
  await elements.cancel.click();
  responses.jsonl = null;
  const priorImports = calls.filter(call => call.command === 'start_import').length;
  await elements.import.click();
  assert.equal(calls.filter(call => call.command === 'start_import').length, priorImports);

  elements.next.click();
  await flush();
  assert.equal(elements['page-info'].textContent, 'Page 2 of 2');
  assert.equal(elements.next.disabled, true);
  elements.format.value = 'GP5';
  await elements.format.onchange();
  const query = calls.filter(call => call.command === 'query_library').at(-1).args.query;
  assert.equal(query.format, 'GP5');
  assert.equal(query.page, 0);

  elements.rows.children[0].click();
  await elements.open.click();
  assert.equal(calls.find(call => call.command === 'open_score').args.path, row.path);
  failOpen = true;
  await elements.open.click();
  assert.match(elements.message.textContent, /file was removed/);
  await vm.runInContext('state()', context);
  assert.match(elements.message.textContent, /file was removed/);

  failScan = true;
  await elements.scan.click();
  assert.equal(elements.scan.disabled, false);
  assert.equal(elements.message.textContent, 'Parser unavailable');
  console.log('PASS: native IPC, pickers, scan/cancel, JSONL import, pagination, filtering, safe text, and visible errors');
})().catch(error => {console.error(error); process.exitCode = 1;});
