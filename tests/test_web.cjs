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
    this.style = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; }
    };
    this.classList = {toggle: () => {}};
  }
  append(element) { this.children.push(element); }
  replaceChildren(...elements) { this.children = elements; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  setPointerCapture(id) { this.pointerId = id; }
  releasePointerCapture() { this.pointerId = null; }
  click() { return this.onclick?.(); }
}

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML element IDs must be unique');
const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
let workspaceWidth = 1000, narrowLayout = false;
const windowEvents = {};
elements.workspace.getBoundingClientRect = () => ({width: workspaceWidth});
elements.collection.getBoundingClientRect = () => {
  const columns = elements.workspace.style['--pane-columns'];
  const ratio = columns ? Number(columns.match(/minmax\(0, ([\d.]+)fr/)[1]) : null;
  return {width: ratio === null ? workspaceWidth - 310 : (workspaceWidth - 20) * ratio};
};
const sorts = [...html.matchAll(/data-sort="([^"]+)"/g)].map(match => {
  const button = new Element();
  button.dataset.sort = match[1];
  button.textContent = match[1];
  button.parentElement = new Element();
  button.parentElement.append(button);
  return button;
});
const calls = [];
let revision = 0, busy = false, failScan = false, failOpen = false, failSave = false, savedParser = 'score_tool';
const row = {path: 'C:\\Scores\\日本語.gp5', title: '<script>safe text</script>',
  artist: 'Björk', album: '', format: 'GP5', tempo: 120, tracks: 3, status: 'ok',
  record: JSON.stringify({metadata: {title: '日本語'}})};
const responses = {folder: 'C:\\Scores', parser: 'C:\\Tools\\score_tool.exe', jsonl: 'C:\\Exports\\scan.jsonl'};
const invoke = async (command, args) => {
  calls.push({command, args});
  switch (command) {
    case 'get_state': return {busy, cancelling: false, revision, message: busy ? 'Extracting…' : 'Ready',
      parser: savedParser, folder: 'Saved folder', database: 'library.sqlite3'};
    case 'query_library': return {rows: [row], page: Math.min(args.query.page, 1), page_size: 200, total: 205};
    case 'pick_path': return responses[args.kind];
    case 'save_parser':
      if (failSave) throw 'Cannot save settings';
      savedParser = args.parser; return;
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
  window: {__TAURI__: {core: {invoke}}, matchMedia: () => ({matches: narrowLayout}),
    addEventListener: (name, callback) => { windowEvents[name] = callback; }},
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

  const cells = elements.rows.children[0].children;
  assert.equal(cells.length, 9);
  assert.equal(cells[1].textContent, '日本語.gp5');
  assert.equal(cells[2].textContent, 'Scores');
  assert.equal(cells[2].title, 'C:\\Scores');
  for (const [filePath, filename, directory, fullDirectory] of [
    ['C:/Music/Artist/song.gp', 'song.gp', 'Artist', 'C:/Music/Artist'],
    ['/home/music/Artist/song.gp', 'song.gp', 'Artist', '/home/music/Artist'],
    ['/song.gp', 'song.gp', '/', '/'],
    ['C:\\song.gp', 'song.gp', 'C:', 'C:\\'],
    ['\\\\server\\share\\Album\\song.gp', 'song.gp', 'Album', '\\\\server\\share\\Album'],
    ['/music/<album>/song.gp', 'song.gp', '<album>', '/music/<album>']
  ]) {
    context.testPath = filePath;
    const location = vm.runInContext('fileLocation(testPath)', context);
    assert.equal(location.filename, filename);
    assert.equal(location.directory, directory);
    assert.equal(location.fullDirectory, fullDirectory);
  }

  const pointer = (clientX, pointerId = 1) => ({clientX, pointerId, button: 0, preventDefault() {}});
  assert.ok(sorts.every(button => button.parentElement.children.length === 1));

  const divider = elements['pane-resizer'];
  divider.onpointerdown(pointer(690));
  divider.onpointermove(pointer(490, 2));
  assert.equal(elements.workspace.style['--pane-columns'], undefined);
  divider.onpointermove(pointer(490));
  assert.equal(elements.collection.getBoundingClientRect().width, 490);
  assert.equal(workspaceWidth - 20 - elements.collection.getBoundingClientRect().width, 490);
  divider.onpointermove(pointer(-1000));
  assert.equal(elements.collection.getBoundingClientRect().width, 240);
  divider.onpointerup(pointer(-1000));
  divider.onpointermove(pointer(690));
  assert.equal(elements.collection.getBoundingClientRect().width, 240);
  divider.onkeydown({key: 'End', preventDefault() {}});
  assert.equal(elements.collection.getBoundingClientRect().width, 740);
  divider.onkeydown({key: 'ArrowLeft', shiftKey: true, preventDefault() {}});
  assert.equal(elements.collection.getBoundingClientRect().width, 690);
  divider.onpointerdown(pointer(690));
  divider.onpointercancel();
  divider.onpointermove(pointer(300));
  assert.equal(elements.collection.getBoundingClientRect().width, 690);
  workspaceWidth = 600;
  windowEvents.resize();
  assert.ok(elements.collection.getBoundingClientRect().width <= 340);
  narrowLayout = true;
  const priorColumns = elements.workspace.style['--pane-columns'];
  divider.onpointerdown(pointer(300));
  divider.onpointermove(pointer(100));
  assert.equal(elements.workspace.style['--pane-columns'], priorColumns);
  narrowLayout = false;
  workspaceWidth = 1000;
  divider.ondblclick();
  assert.equal(elements.workspace.style['--pane-columns'], undefined);
  assert.equal(elements.collection.getBoundingClientRect().width, 690);

  elements['settings-nav'].click();
  assert.equal(elements['library-view'].hidden, true);
  assert.equal(elements['settings-view'].hidden, false);
  assert.equal(elements['settings-nav'].attributes['aria-current'], 'page');
  assert.equal(elements['view-title'].textContent, 'Settings');
  elements.parser.value = '   ';
  await elements['save-settings'].click();
  assert.equal(calls.filter(call => call.command === 'save_parser').length, 0);
  assert.match(elements['settings-message'].textContent, /Choose/);

  await elements['browse-folder'].click();
  assert.equal(elements.folder.value, responses.folder);
  await elements['browse-parser'].click();
  assert.equal(elements.parser.value, responses.parser);
  await elements['save-settings'].click();
  assert.equal(savedParser, responses.parser);
  assert.equal(elements['settings-message'].textContent, 'Settings saved.');
  await vm.runInContext('state()', context);
  assert.equal(elements.parser.value, responses.parser);
  failSave = true;
  elements.parser.value = 'Unsaved parser';
  await elements['save-settings'].click();
  assert.equal(elements['settings-message'].textContent, 'Cannot save settings');
  assert.equal(elements['save-settings'].disabled, false);
  elements['library-nav'].click();
  assert.equal(elements['library-view'].hidden, false);
  assert.equal(elements['settings-view'].hidden, true);
  assert.equal(elements.import.hidden, false);
  await elements.scan.click();
  assert.equal(calls.find(call => call.command === 'start_scan').args.parser, responses.parser);
  assert.equal(elements['save-settings'].disabled, true);
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

  for (const key of ['filename', 'directory']) {
    const button = sorts.find(button => button.dataset.sort === key);
    button.click();
    await flush();
    let query = calls.filter(call => call.command === 'query_library').at(-1).args.query;
    assert.equal(query.sort, key);
    assert.equal(query.descending, false);
    assert.equal(query.page, 0);
    assert.equal(button.parentElement.attributes['aria-sort'], 'ascending');
    button.click();
    await flush();
    query = calls.filter(call => call.command === 'query_library').at(-1).args.query;
    assert.equal(query.descending, true);
    assert.equal(button.parentElement.attributes['aria-sort'], 'descending');
  }

  for (const [original, display] of [
    [String.raw`\\?\C:\Music\Scores`, String.raw`C:\Music\Scores`],
    ['//?/C:/Music/Scores', 'C:/Music/Scores'],
    [String.raw`\\?\UNC\server\share\Scores`, String.raw`\\server\share\Scores`],
    ['//?/UNC/server/share/Scores', '//server/share/Scores'],
    [String.raw`\\server\share\Scores`, String.raw`\\server\share\Scores`],
    ['/home/music/Scores', '/home/music/Scores']
  ]) {
    context.testPath = original;
    assert.equal(vm.runInContext('displayPath(testPath)', context), display);
    vm.runInContext("setPathField('folder', testPath)", context);
    assert.equal(elements.folder.value, display);
    assert.equal(vm.runInContext("pathFieldValue('folder')", context), original);
  }
  elements.folder.value = 'Changed folder';
  assert.equal(vm.runInContext("pathFieldValue('folder')", context), 'Changed folder');
  row.path = String.raw`\\?\C:\Scores\日本語.gp5`;
  row.record = JSON.stringify({path: row.path});
  await vm.runInContext('refresh()', context);
  elements.rows.children[0].click();
  assert.equal(elements.path.textContent, String.raw`C:\Scores\日本語.gp5`);
  assert.equal(elements.rows.children[0].children[2].title, String.raw`C:\Scores`);
  assert.equal(JSON.parse(elements.metadata.textContent).path, String.raw`C:\Scores\日本語.gp5`);
  failOpen = false;
  await elements.open.click();
  assert.equal(calls.filter(call => call.command === 'open_score').at(-1).args.path, row.path);

  failScan = true;
  await elements.scan.click();
  assert.equal(elements.scan.disabled, false);
  assert.equal(elements.message.textContent, 'Parser unavailable');
  console.log('PASS: normalized path display and original operation paths, filename and directory columns, full directory tooltips, cross-platform paths, shared pane resizing, responsive bounds and reset, settings navigation, parser saving and errors, saved parser scan selection, native IPC, pickers, scan/cancel, JSONL import, pagination, filtering, safe text, and visible errors');
})().catch(error => {console.error(error); process.exitCode = 1;});
