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
let savedHiddenColumns = ['album'], failColumns = false;
let savedFavorites = [], failFavorites = false;
const row = {path: 'C:\\Scores\\日本語.gp5', title: '<script>safe text</script>',
  artist: 'Björk', album: '', format: 'GP5', tempo: 120, tracks: 3, status: 'ok', updated_at: '2026-10-13T14:30:00Z',
  record: JSON.stringify({metadata: {title: '日本語', tracks: [
    {index: 1, midi_program: 25, name: '<Lead guitar>', instrument: 'Acoustic Guitar',
      tuning: [{number: 1, midi: 64, note: 'E4'}, {number: 2, midi: 59, note: 'B3'}]},
    {index: 2, midi_program: 118, name: 'Drums', instrument: 'Drums / Percussion'},
    {index: 3, name: '', tuning: [{number: 1, midi: 40}]}
  ]}})};
const responses = {folder: 'C:\\Scores', parser: 'C:\\Tools\\score_tool.exe', jsonl: 'C:\\Exports\\scan.jsonl'};
const invoke = async (command, args) => {
  calls.push({command, args});
  switch (command) {
    case 'get_state': return {busy, cancelling: false, revision, message: busy ? 'Extracting…' : 'Ready',
      parser: savedParser, folder: 'Saved folder', database: 'library.sqlite3', hidden_columns: savedHiddenColumns, favorite_tunings: savedFavorites};
    case 'query_library': return {rows: [row], page: Math.min(args.query.page, 1), page_size: 200, total: 205, tunings: ['64,59,55,50,45,40,35', '43,38,33,28', '64,59,55,50,45,40,35,30,25,20,15,10', '40,35,30,25', '60']};
    case 'pick_path': return responses[args.kind];
    case 'save_favorite_tunings':
      if (failFavorites) throw 'Cannot save favorites';
      savedFavorites = [...args.tunings]; return;
    case 'save_hidden_columns':
      if (failColumns) throw 'Cannot save column preferences';
      savedHiddenColumns = [...args.columns]; return;
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
  assert.equal(elements.rows.children[0].children[0].textContent, row.artist);

  for (const missing of ['', '  \t', null, undefined]) {
    row.artist = missing;
    await vm.runInContext('refresh()', context);
    const artistCell = elements.rows.children[0].children[0];
    assert.equal(artistCell.textContent, 'Scores (folder)');
    assert.match(artistCell.title, /source file has no artist/);
  }
  assert.equal(vm.runInContext("displayedArtist({path: 'C:/music/animals as leaders/song.gp', artist: ''}).name", context), 'Animals As Leaders');
  assert.equal(vm.runInContext("displayedArtist({path: '/music/animals as leaders/song.gp', artist: 'animals as leaders'}).name", context), 'animals as leaders');
  assert.equal(vm.runInContext("displayFolderName('AC DC')", context), 'AC DC');
  assert.equal(vm.runInContext("displayFolderName('foo-fighters')", context), 'Foo-Fighters');
  assert.equal(vm.runInContext("displayFolderName('björk')", context), 'Björk');
  row.artist = 'Björk';
  await vm.runInContext('refresh()', context);
  assert.equal(elements.rows.children[0].children[0].textContent, 'Björk');
  assert.equal(vm.runInContext("displayedArtist({path: '/music/Artist/song.gp', artist: ''}).name", context), 'Artist');

  const cells = elements.rows.children[0].children;
  assert.equal(cells.length, 10);
  assert.equal(cells[2].textContent, '日本語.gp5');
  assert.equal(cells[3].textContent, 'Scores');
  assert.equal(cells[3].title, 'C:\\Scores');
  assert.equal(cells[9].title, row.updated_at);
  assert.equal(cells[9].textContent, new Date(row.updated_at).toLocaleString());
  assert.equal(vm.runInContext('displayDate(null)', context), '—');
  assert.equal(vm.runInContext("displayDate('invalid')", context), '—');

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

  assert.equal(elements['show-album'].checked, false);
  assert.equal(elements['col-album'].hidden, true);
  assert.equal(cells[4].hidden, true);
  assert.equal(sorts.find(button => button.dataset.sort === 'album').parentElement.hidden, true);
  assert.equal(elements['score-table'].style.width, '1140px');
  elements['show-album'].checked = true;
  await elements['show-album'].onchange();
  assert.deepEqual(savedHiddenColumns, []);
  assert.equal(cells[4].hidden, false);
  elements['show-directory'].checked = false;
  await elements['show-directory'].onchange();
  assert.deepEqual(savedHiddenColumns, ['directory']);
  await vm.runInContext('refresh()', context);
  assert.equal(elements.rows.children[0].children[3].hidden, true, 'Hide columns on newly rendered rows');
  vm.runInContext('initialized = false', context);
  await vm.runInContext('state()', context);
  assert.equal(elements['show-directory'].checked, false, 'Restore saved choices on initialization');
  failColumns = true;
  elements['show-directory'].checked = true;
  await elements['show-directory'].onchange();
  assert.equal(elements['show-directory'].checked, false, 'Revert on save failure');
  assert.equal(elements['columns-message'].textContent, 'Cannot save column preferences');
  failColumns = false;
  elements['show-directory'].checked = true;
  await elements['show-directory'].onchange();
  for (const key of ['filename', 'directory', 'artist', 'album', 'format', 'tempo', 'tracks', 'status', 'updated_at']) {
    elements['show-' + key].checked = false;
    await elements['show-' + key].onchange();
  }
  assert.equal(elements['show-title'].disabled, true, 'Keep a visible column');
  assert.equal(elements['show-album'].disabled, false, 'Allow hidden columns to be restored');
  for (const key of ['filename', 'directory', 'artist', 'album', 'format', 'tempo', 'tracks', 'status', 'updated_at']) {
    elements['show-' + key].checked = true;
    await elements['show-' + key].onchange();
  }
  assert.equal(elements['show-title'].disabled, false);
  assert.equal(elements['col-directory'].hidden, false);
  assert.equal(elements['score-table'].style.width, '1290px');

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
  assert.deepEqual(elements.tuning.children.slice(1).map(group => group.label),
    ['1 string', '4 strings', '7 strings', '12 strings']);
  assert.equal(elements.tuning.children[1].children[0].textContent, 'C4');
  assert.deepEqual(elements.tuning.children[2].children.map(option => option.textContent),
    ['C#1 · F#1 · B1 · E2', 'E1 · A1 · D2 · G2']);
  assert.equal(elements.tuning.children[3].children[0].textContent, 'B1 · E2 · A2 · D3 · G3 · B3 · E4');

  const tuningSections = elements['tuning-options'].children.slice(1);
  assert.ok(tuningSections.every(section => section.open === false), 'String sections start collapsed');
  assert.ok(elements['favorite-tuning-options'].children.every(section => section.open === false));
  const fourStrings = tuningSections.find(section => section.dataset.count === '4');
  fourStrings.open = true;
  await vm.runInContext('refresh()', context);
  const refreshedSection = elements['tuning-options'].children.find(section => section.dataset.count === '4');
  assert.equal(refreshedSection.open, true, 'Keep expansion when refreshing');
  elements['tuning-picker'].open = true;
  refreshedSection.children.find(button => button.textContent === 'E1 · A1 · D2 · G2').click();
  await flush();
  assert.equal(elements['tuning-picker'].open, false, 'Close picker after choosing a tuning');
  const tuningQuery = calls.filter(call => call.command === 'query_library').at(-1).args.query;
  assert.equal(tuningQuery.tuning, '43,38,33,28');
  assert.equal(tuningQuery.page, 0);
  assert.equal(elements.tuning.value, '43,38,33,28');


  assert.equal(elements['metadata-summary'].hidden, true);
  assert.equal(elements['raw-details'].hidden, true);
  elements.rows.children[0].click();
  assert.equal(elements['track-summary'].hidden, false);
  assert.equal(elements['tracks-empty'].hidden, true);
  assert.equal(elements['track-rows'].children.length, 3);
  const trackCells = elements['track-rows'].children[0].children;
  assert.equal(trackCells[0].children[0].textContent, '🎸');
  assert.equal(trackCells[0].children[0].title, 'Acoustic Guitar');
  assert.equal(trackCells[0].children[0].attributes['aria-label'], 'Acoustic Guitar');
  assert.equal(elements['track-rows'].children[1].children[0].children[0].textContent, '🥁');
  for (const [program, expected] of [[0, '🎹'], [24, '🎸'], [32, '🎸'], [40, '🎻'], [56, '🎺'], [64, '🎷'], [112, '🥁'], [120, '🔊'], [null, '♫'], [-1, '♫'], [128, '♫']]) {
    context.iconTrack = {midi_program: program};
    assert.equal(vm.runInContext('instrumentIcon(iconTrack).symbol', context), expected);
  }
  context.iconTrack = {midi_program: 0, kind: 'Percussion'};
  assert.equal(vm.runInContext('instrumentIcon(iconTrack).symbol', context), '🥁');
  assert.equal(trackCells[1].children[0].textContent, '<Lead guitar>', 'Render names as safe text');
  assert.equal(trackCells[1].children[1].textContent, 'Acoustic Guitar');
  assert.equal(trackCells[2].textContent, 'B3 · E4');
  assert.equal(elements['track-rows'].children[1].children[2].textContent, '—');
  assert.equal(elements['track-rows'].children[2].children[0].children[0].textContent, '♫');
  assert.equal(elements['track-rows'].children[2].children[1].children[0].textContent, 'Unnamed track');
  assert.equal(elements['track-rows'].children[2].children[2].textContent, '40');
  const summaryValues = () => elements['metadata-summary'].children.map(item => item.children[1].textContent);
  assert.deepEqual(summaryValues(), ['Björk', '—', 'GP5', '120 BPM', 3, 'Parsed']);
  assert.equal(elements['raw-details'].hidden, false);
  assert.equal(elements['raw-details'].open, false);
  elements['raw-details'].open = true;
  await vm.runInContext('refresh()', context);
  assert.equal(elements['raw-details'].open, true, 'Refreshing the selected score keeps expanded JSON open');
  context.errorRow = {...row, path: 'C:\\Scores\\broken.gp5', artist: '', tempo: null, tracks: 0,
    status: 'error', record: JSON.stringify({error: '<parse failed>'})};
  vm.runInContext('detail(errorRow)', context);
  assert.equal(elements['raw-details'].open, false, 'Selecting another score collapses JSON');
  assert.deepEqual(summaryValues(), ['Scores (folder)', '—', 'GP5', '—', 0, 'Parse error']);
  assert.equal(elements['detail-error'].hidden, false);
  assert.equal(elements['detail-error'].textContent, '<parse failed>');
  assert.equal(elements['tracks-empty'].hidden, false);
  assert.equal(elements['track-rows'].children.length, 0, 'Clear tracks when selecting a record without track metadata');
  vm.runInContext('detail(null)', context);
  assert.equal(elements['track-summary'].hidden, true);
  assert.equal(elements['metadata-summary'].hidden, true);
  assert.equal(elements['metadata-summary'].children.length, 0);
  assert.equal(elements['raw-details'].hidden, true);
  assert.equal(elements.metadata.textContent, '');
  elements.rows.children[0].click();
  assert.equal(elements['detail-error'].hidden, true);
  await elements.open.click();
  assert.equal(calls.find(call => call.command === 'open_score').args.path, row.path);
  failOpen = true;
  await elements.open.click();
  assert.match(elements.message.textContent, /file was removed/);
  await vm.runInContext('state()', context);
  assert.match(elements.message.textContent, /file was removed/);

  for (const key of ['filename', 'directory', 'updated_at']) {
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
  assert.equal(elements.rows.children[0].children[3].title, String.raw`C:\Scores`);
  assert.equal(JSON.parse(elements.metadata.textContent).path, String.raw`C:\Scores\日本語.gp5`);
  failOpen = false;
  await elements.open.click();
  assert.equal(calls.filter(call => call.command === 'open_score').at(-1).args.path, row.path);

  const favoriteCheckbox = key => elements['favorite-tuning-options'].children
    .flatMap(group => group.children.slice(1)).map(label => label.children[0])
    .find(checkbox => checkbox.dataset.tuning === key);
  const bassKey = '43,38,33,28';
  const selectedTuning = elements.tuning.value;
  favoriteCheckbox(bassKey).checked = true;
  await favoriteCheckbox(bassKey).onchange();
  assert.deepEqual(savedFavorites, [bassKey]);
  assert.equal(elements.tuning.children[2].children[0].textContent, '★ E1 · A1 · D2 · G2');
  assert.equal(elements.tuning.children[2].children[0].value, bassKey);
  assert.equal(elements.tuning.value, selectedTuning, 'Favoriting preserves active filtering');
  vm.runInContext('initialized = false; favoriteTunings = new Set()', context);
  await vm.runInContext('state()', context);
  assert.equal(favoriteCheckbox(bassKey).checked, true, 'Restore favorites at startup');
  failFavorites = true;
  favoriteCheckbox(bassKey).checked = false;
  await favoriteCheckbox(bassKey).onchange();
  assert.equal(favoriteCheckbox(bassKey).checked, true, 'Revert failed favorite save');
  assert.equal(elements['favorite-tunings-message'].textContent, 'Cannot save favorites');
  failFavorites = false;
  // Multiple favorites in one group still sort alphabetically.
  favoriteCheckbox('40,35,30,25').checked = true;
  await favoriteCheckbox('40,35,30,25').onchange();
  assert.deepEqual(elements.tuning.children[2].children.map(option => option.textContent),
    ['★ C#1 · F#1 · B1 · E2', '★ E1 · A1 · D2 · G2']);
  for (const key of ['40,35,30,25', bassKey]) {
    favoriteCheckbox(key).checked = false;
    await favoriteCheckbox(key).onchange();
  }
  assert.deepEqual(savedFavorites, []);
  assert.equal(elements.tuning.children[2].children[0].textContent, 'C#1 · F#1 · B1 · E2');

  failScan = true;
  await elements.scan.click();
  assert.equal(elements.scan.disabled, false);
  assert.equal(elements.message.textContent, 'Parser unavailable');
  console.log('PASS: normalized path display and original operation paths, filename and directory columns, full directory tooltips, cross-platform paths, shared pane resizing, responsive bounds and reset, settings navigation, parser saving and errors, saved parser scan selection, native IPC, pickers, scan/cancel, JSONL import, pagination, filtering, safe text, and visible errors');
})().catch(error => {console.error(error); process.exitCode = 1;});
