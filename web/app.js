const $ = id => document.getElementById(id);
let rows = [], selected = null, sort = 'artist', descending = false, page = 0;
let initialized = false, lastMessage = '', lastRevision = -1, requestId = 0;
let acceptingJob = false, polling = false, savingSettings = false, savedParser = '';

const libraryColumns = [
  ['artist', 150], ['title', 200], ['filename', 200], ['directory', 150],
  ['album', 150], ['format', 70], ['tempo', 60], ['tracks', 60], ['status', 70], ['updated_at', 180]
];
let hiddenColumns = new Set(), savingColumns = false;
let favoriteTunings = new Set(), availableTunings = [], savingFavorites = false;

function applyColumnVisibility() {
  const visibleCount = libraryColumns.filter(([key]) => !hiddenColumns.has(key)).length;
  for (const [key] of libraryColumns) {
    const hidden = hiddenColumns.has(key);
    $('col-' + key).hidden = hidden;
    $('show-' + key).checked = !hidden;
    $('show-' + key).disabled = !initialized || savingColumns || (!hidden && visibleCount === 1);
  }
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.parentElement.hidden = hiddenColumns.has(button.dataset.sort);
  }
  for (const row of $('rows').children) {
    for (const cell of row.children) cell.hidden = hiddenColumns.has(cell.dataset.column);
  }
  const width = libraryColumns.reduce((sum, [key, width]) => sum + (hiddenColumns.has(key) ? 0 : width), 0);
  $('score-table').style.setProperty('width', width + 'px');
}

for (const [key] of libraryColumns) $('show-' + key).onchange = async () => {
  if (!initialized || savingColumns) return;
  const previous = new Set(hiddenColumns);
  if ($('show-' + key).checked) hiddenColumns.delete(key);
  else hiddenColumns.add(key);
  if (hiddenColumns.size === libraryColumns.length) {
    hiddenColumns = previous;
    applyColumnVisibility();
    return;
  }
  savingColumns = true;
  applyColumnVisibility();
  $('columns-message').textContent = 'Saving...';
  try {
    await invoke('save_hidden_columns', {columns: [...hiddenColumns]});
    $('columns-message').textContent = 'Column preferences saved.';
  } catch (error) {
    hiddenColumns = previous;
    $('columns-message').textContent = displayMessage(error.message);
  } finally {
    savingColumns = false;
    applyColumnVisibility();
  }
};
applyColumnVisibility();

async function invoke(command, args) {
  try {
    return await window.__TAURI__.core.invoke(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : error.message || 'Request failed');
  }
}

function displayPath(path) {
  return path.replace(/^[\\/]{2}\?[\\/](?:UNC[\\/])?/i,
    prefix => /UNC/i.test(prefix) ? prefix[0].repeat(2) : '');
}
function displayMessage(message) {
  return message.replace(/[\\/]{2}\?[\\/](?:UNC[\\/])?/gi,
    prefix => /UNC/i.test(prefix) ? prefix[0].repeat(2) : '');
}
const originalPaths = {};
function setPathField(id, path) {
  originalPaths[id] = path;
  $(id).value = displayPath(path);
}
function pathFieldValue(id) {
  const original = originalPaths[id];
  return original !== undefined && $(id).value === displayPath(original) ? original : $(id).value;
}

function displayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function displayFolderName(name) {
  if (name !== name.toLocaleLowerCase()) return name;
  return name.replace(/(^|[\s\-_(])[\p{L}\p{N}]/gu, word => word.toLocaleUpperCase());
}

function fileLocation(path) {
  path = displayPath(path);
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  const separator = windows ? Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) : path.lastIndexOf('/');
  const filename = path.slice(separator + 1);
  const directory = separator < 0 ? '' : path.slice(0, separator) || '/';
  // Keep the separator on drive roots, such as C:\.
  const fullDirectory = windows && /^[a-z]:$/i.test(directory) ? path.slice(0, separator + 1) : directory;
  const parts = fullDirectory.split(windows ? /[\\/]/ : /\//).filter(Boolean);
  return {filename, directory: displayFolderName(parts.at(-1) || fullDirectory), fullDirectory};
}

function displayedArtist(row) {
  if (row.artist?.trim()) return {name: row.artist, fromFolder: false};
  return {name: fileLocation(row.path).directory, fromFolder: true};
}
function renderArtist(element, row) {
  const artist = displayedArtist(row);
  element.textContent = artist.name ? artist.name + (artist.fromFolder ? ' (folder)' : '') : '—';
  if (artist.name && artist.fromFolder) {
    element.title = 'From the immediate folder; the source file has no artist metadata.';
  }
}

function instrumentIcon(track) {
  // Percussion tracks share MIDI programs with melodic instruments.
  if (/drums|percussion/i.test([track?.kind, track?.instrument].join(' '))) {
    return {symbol: '🥁', label: 'Drums / Percussion'};
  }
  const program = track?.midi_program;
  if (!Number.isInteger(program) || program < 0 || program > 127) {
    return {symbol: '♫', label: 'Instrument'};
  }
  const families = [
    ['🎹', 'Piano'], ['🥁', 'Chromatic percussion'], ['🎹', 'Organ'],
    ['🎸', 'Guitar'], ['🎸', 'Bass'], ['🎻', 'Strings'],
    ['🎻', 'Ensemble'], ['🎺', 'Brass'], ['🎷', 'Reed'],
    ['🪈', 'Pipe'], ['🎹', 'Synth lead'], ['🎹', 'Synth pad'],
    ['🎹', 'Synth effects'], ['🪕', 'Ethnic instruments'],
    ['🥁', 'Percussion'], ['🔊', 'Sound effects']
  ];
  const [symbol, label] = families[Math.floor(program / 8)];
  return {symbol, label};
}

function detail(row) {
  if (selected?.path !== row?.path || !row) $('raw-details').open = false;
  selected = row;
  $('metadata-summary').hidden = !row;
  $('raw-details').hidden = !row;
  $('metadata-summary').replaceChildren();
  if (row) {
    for (const [label, value] of [
      ['Artist', row.artist], ['Album', row.album], ['Format', row.format],
      ['Tempo', row.tempo == null ? null : row.tempo + ' BPM'],
      ['Tracks', row.tracks], ['Status', row.status === 'ok' ? 'Parsed' : row.status === 'error' ? 'Parse error' : row.status]
    ]) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value == null || value === '' ? '—' : value;
      if (label === 'Artist') renderArtist(description, row);
      if (label === 'Status' && row.status === 'error') description.className = 'error';
      item.append(term);
      item.append(description);
      $('metadata-summary').append(item);
    }
  }
  const record = row ? JSON.parse(row.record) : null;
  const tracks = Array.isArray(record?.metadata?.tracks) ? record.metadata.tracks : [];
  $('track-summary').hidden = !row;
  $('tracks-empty').hidden = tracks.length > 0;
  $('track-rows').replaceChildren();
  for (const track of tracks) {
    const tr = document.createElement('tr');
    const instrument = document.createElement('td');
    const icon = instrumentIcon(track);
    const symbol = document.createElement('span');
    symbol.className = 'instrument-icon';
    symbol.textContent = icon.symbol;
    symbol.title = track?.instrument || icon.label;
    symbol.setAttribute('role', 'img');
    symbol.setAttribute('aria-label', symbol.title);
    instrument.append(symbol);
    const name = document.createElement('td');
    const title = document.createElement('span');
    title.textContent = track?.name || 'Unnamed track';
    name.append(title);
    if (track?.instrument) {
      const subtitle = document.createElement('small');
      subtitle.textContent = track.instrument;
      name.append(subtitle);
    }
    const tuning = document.createElement('td');
    tuning.textContent = Array.isArray(track?.tuning) && track.tuning.length
      ? [...track.tuning].sort((a, b) => (b?.number ?? 0) - (a?.number ?? 0)).map(string => string?.note ?? string?.midi ?? '—').join(' · ') : '—';
    tr.append(instrument);
    tr.append(name);
    tr.append(tuning);
    $('track-rows').append(tr);
  }
  $('detail-error').hidden = !record?.error;
  $('detail-error').textContent = record?.error ? displayMessage(String(record.error)) : '';
  $('selected').textContent = row ? row.title : 'Select a score';
  $('path').textContent = row ? displayPath(row.path) : 'Browse your library to inspect metadata.';
  $('metadata').textContent = row ? JSON.stringify(record, (key, value) => typeof value === 'string' ? displayPath(value) : value, 2) : '';
  $('open').disabled = !row;
  for (const tr of $('rows').children) tr.classList.toggle('selected', tr.dataset.path === row?.path);
}

function renderTunings() {
  const expanded = new Set([...$('tuning-options').children].filter(group => group.open).map(group => group.dataset.count));
  const expandedFavorites = new Set([...$('favorite-tuning-options').children].filter(group => group.open).map(group => group.dataset.count));
  const selectedTuning = $('tuning').value;

  const allTunings = document.createElement('option');
  allTunings.value = '';
  allTunings.textContent = 'All tunings';
  $('tuning').replaceChildren(allTunings);
  // Keep a selected tuning visible if a rescan removes its last matching track.
  const tunings = [...new Set([...availableTunings, ...favoriteTunings, ...(selectedTuning ? [selectedTuning] : [])])].map(key => {
    const pitches = key.split(',').map(Number).reverse();
    const notes = pitches.map(midi => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12] + (Math.floor(midi / 12) - 1));
    return {key, count: pitches.length, label: notes.join(' · ')};
  }).sort((a, b) => a.count - b.count || Number(favoriteTunings.has(b.key)) - Number(favoriteTunings.has(a.key)) || a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key));
  let group;
  let stringCount;
  for (const tuning of tunings) {
    if (tuning.count !== stringCount) {
      stringCount = tuning.count;
      group = document.createElement('optgroup');
      group.label = stringCount + (stringCount === 1 ? ' string' : ' strings');
      $('tuning').append(group);
    }
    const option = document.createElement('option');
    option.value = tuning.key;
    option.textContent = (favoriteTunings.has(tuning.key) ? '★ ' : '') + tuning.label;
    group.append(option);
  }
  $('tuning').value = selectedTuning;
  $('tuning-label').textContent = tunings.find(tuning => tuning.key === selectedTuning)?.label || 'All tunings';
  $('tuning-options').replaceChildren();
  const addChoice = (parent, key, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(key === selectedTuning));
    button.onclick = () => {
      $('tuning').value = key;
      $('tuning-picker').open = false;
      $('tuning-label').textContent = label;
      $('tuning-label').focus();
      $('tuning').onchange();
    };
    parent.append(button);
  };
  addChoice($('tuning-options'), '', 'All tunings');
  let section;
  let sectionCount;
  for (const tuning of tunings) {
    if (tuning.count !== sectionCount) {
      sectionCount = tuning.count;
      section = document.createElement('details');
      section.dataset.count = String(sectionCount);
      section.open = expanded.has(String(sectionCount));
      const summary = document.createElement('summary');
      summary.textContent = sectionCount + (sectionCount === 1 ? ' string' : ' strings');
      section.append(summary);
      $('tuning-options').append(section);
    }
    addChoice(section, tuning.key, (favoriteTunings.has(tuning.key) ? '★ ' : '') + tuning.label);
  }

  $('favorite-tuning-options').replaceChildren();
  $('favorite-tunings-empty').hidden = tunings.length > 0;
  let fieldset;
  let count;
  for (const tuning of tunings) {
    if (tuning.count !== count) {
      count = tuning.count;
      fieldset = document.createElement('details');
      fieldset.dataset.count = String(count);
      fieldset.open = expandedFavorites.has(String(count));
      fieldset.className = 'favorite-tuning-group';
      const legend = document.createElement('summary');
      legend.textContent = count + (count === 1 ? ' string' : ' strings');
      fieldset.append(legend);
      $('favorite-tuning-options').append(fieldset);
    }
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = favoriteTunings.has(tuning.key);
    checkbox.disabled = !initialized || savingFavorites;
    checkbox.dataset.tuning = tuning.key;
    checkbox.onchange = () => saveFavoriteTuning(tuning.key, checkbox.checked);
    const text = document.createElement('span');
    text.textContent = tuning.label;
    label.append(checkbox);
    label.append(text);
    fieldset.append(label);
  }
}

async function saveFavoriteTuning(key, favorite) {
  if (!initialized || savingFavorites) return;
  const previous = new Set(favoriteTunings);
  if (favorite) favoriteTunings.add(key);
  else favoriteTunings.delete(key);
  savingFavorites = true;
  renderTunings();
  $('favorite-tunings-message').textContent = 'Saving...';
  try {
    await invoke('save_favorite_tunings', {tunings: [...favoriteTunings]});
    $('favorite-tunings-message').textContent = 'Favorite tunings saved.';
  } catch (error) {
    favoriteTunings = previous;
    $('favorite-tunings-message').textContent = displayMessage(error.message);
  } finally {
    savingFavorites = false;
    renderTunings();
  }
}

async function refresh(resetPage = false) {
  if (resetPage) page = 0;
  const currentRequest = ++requestId;
  const value = await invoke('query_library', {query: {
    search: $('search').value, format: $('format').value, status: $('status').value,
    tuning: $('tuning').value, sort, descending, page
  }});
  if (currentRequest !== requestId) return;
  availableTunings = value.tunings || [];
  renderTunings();
  rows = value.rows;
  page = value.page || 0;
  const total = value.total ?? rows.length;
  const pageSize = value.page_size || Math.max(rows.length, 1);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  $('rows').replaceChildren();
  $('count').textContent = total + ' files';
  $('page-info').textContent = 'Page ' + (page + 1) + ' of ' + pageCount;
  $('previous').disabled = page === 0;
  $('next').disabled = page + 1 >= pageCount;
  $('empty').hidden = rows.length > 0;
  $('empty-title').textContent = total ? 'No files on this page' :
    ($('search').value || $('format').value || $('status').value || $('tuning').value ? 'No matching scores' : 'Build your score library');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.path = row.path;
    tr.tabIndex = 0;
    const location = fileLocation(row.path);
    for (const [key] of libraryColumns) {
      const td = document.createElement('td');
      td.dataset.column = key;
      td.textContent = (key === 'filename' || key === 'directory' ? location[key] : row[key]) ?? '—';
      if (key === 'updated_at') {
        td.textContent = displayDate(row.updated_at);
        if (row.updated_at) td.title = row.updated_at;
      }
      if (key === 'artist') renderArtist(td, row);
      if (key === 'directory') td.title = location.fullDirectory;
      if (key === 'filename') td.title = location.filename;
      if (key === 'format') {
        const span = document.createElement('span');
        span.className = 'badge';
        span.textContent = td.textContent;
        td.replaceChildren(span);
      }
      if (key === 'status' && row.status === 'error') td.className = 'error';
      tr.append(td);
    }
    tr.onclick = () => detail(row);
    tr.onkeydown = event => { if (event.key === 'Enter') detail(row); };
    tr.ondblclick = () => { detail(row); $('open').click(); };
    $('rows').append(tr);
  }
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.parentElement.setAttribute('aria-sort',
      button.dataset.sort === sort ? (descending ? 'descending' : 'ascending') : 'none');
  }
  applyColumnVisibility();
  detail(rows.find(row => row.path === selected?.path) || null);
}

function report(error) { $('message').textContent = displayMessage(error.message || String(error)); }

async function state() {
  const value = await invoke('get_state');
  if (!initialized) {
    savedParser = value.parser;
    setPathField('parser', savedParser);
    setPathField('folder', value.folder || '');
    $('database').textContent = displayPath(value.database);
    hiddenColumns = new Set((value.hidden_columns || []).filter(key => libraryColumns.some(([column]) => column === key)));
    favoriteTunings = new Set(value.favorite_tunings || []);
    initialized = true;
    renderTunings();
    applyColumnVisibility();
  }
  setBusy(value.busy || acceptingJob || savingSettings);
  $('cancel').hidden = !value.busy;
  $('cancel').disabled = value.cancelling;
  $('progress').hidden = !value.busy;
  const changed = lastMessage !== value.message;
  if (changed) $('message').textContent = displayMessage(value.message);
  const revision = value.revision ?? value.message;
  if (revision !== lastRevision && !value.busy) {
    await refresh();
    lastRevision = revision;
  }
  lastMessage = value.message;
}

function setBusy(busy) {
  for (const id of ['scan', 'import', 'browse-parser', 'browse-folder', 'parser', 'folder', 'save-settings']) {
    $(id).disabled = busy;
  }
}

async function startJob(operation) {
  if (acceptingJob || $('scan').disabled) return;
  acceptingJob = true;
  setBusy(true);
  try {
    await operation();
    acceptingJob = false;
    await state();
  } catch (error) {
    acceptingJob = false;
    setBusy(false);
    report(error);
  }
}

function showView(settings) {
  $('library-view').hidden = settings;
  $('settings-view').hidden = !settings;
  $('import').hidden = settings;
  $('library-nav').setAttribute('aria-current', settings ? 'false' : 'page');
  $('settings-nav').setAttribute('aria-current', settings ? 'page' : 'false');
  $('view-eyebrow').textContent = settings ? 'APPLICATION' : 'YOUR COLLECTION';
  $('view-title').textContent = settings ? 'Settings' : 'Score library';
  $('view-description').textContent = settings ? 'Configure your score library tools.' : 'Find the right song. Pick up where you left off.';
  $('view-title').focus();
}
$('library-nav').onclick = () => showView(false);
$('settings-nav').onclick = () => showView(true);
$('save-settings').onclick = async () => {
  if (!initialized || savingSettings || $('save-settings').disabled) return;
  const parser = pathFieldValue('parser').trim();
  if (!parser) {
    $('settings-message').textContent = 'Choose a parser executable.';
    $('parser').focus();
    return;
  }
  savingSettings = true;
  setBusy(true);
  $('settings-message').textContent = 'Saving...';
  try {
    await invoke('save_parser', {parser});
    savedParser = parser;
    setPathField('parser', parser);
    $('settings-message').textContent = 'Settings saved.';
  } catch (error) {
    $('settings-message').textContent = displayMessage(error.message);
  } finally {
    savingSettings = false;
    await state().catch(report);
  }
};
$('parser').oninput = () => { $('settings-message').textContent = ''; };

$('scan').onclick = () => startJob(() => invoke('start_scan', {
  parser: savedParser, folder: pathFieldValue('folder')
}));

$('import').onclick = async () => {
  try {
    const path = await invoke('pick_path', {kind: 'jsonl'});
    if (path) await startJob(() => invoke('start_import', {path}));
  } catch (error) { report(error); }
};
for (const [id, kind, field] of [
  ['browse-parser', 'parser', 'parser'], ['browse-folder', 'folder', 'folder']
]) {
  $(id).onclick = async () => {
    try {
      const path = await invoke('pick_path', {kind});
      if (path) {
        setPathField(field, path);
        if (field === 'parser') $('settings-message').textContent = '';
      }
    } catch (error) { report(error); }
  };
}
$('cancel').onclick = async () => {
  try { await invoke('cancel_job'); await state(); } catch (error) { report(error); }
};
$('open').onclick = async () => {
  try {
    if (selected) { await invoke('open_score', {path: selected.path}); $('message').textContent = 'Opened score'; }
  } catch (error) { report(error); }
};
let debounce;
$('search').oninput = () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => refresh(true).catch(report), 150);
};
for (const id of ['format', 'status', 'tuning']) $(id).onchange = () => refresh(true).catch(report);
for (const button of document.querySelectorAll('[data-sort]')) button.onclick = () => {
  descending = sort === button.dataset.sort ? !descending : false;
  sort = button.dataset.sort;
  refresh(true).catch(report);
};
$('previous').onclick = () => { page = Math.max(0, page - 1); refresh().catch(report); };
$('next').onclick = () => { page += 1; refresh().catch(report); };
// The divider shares the available width between the table and score details.
const paneResizer = $('pane-resizer');
let paneRatio = null, paneDrag = null;
function paneSpace() {
  return Math.max(0, $('workspace').getBoundingClientRect().width - 20);
}
function resizePanes(tableWidth) {
  const available = paneSpace();
  if (!available || window.matchMedia('(max-width:1100px)').matches) return;
  const minimum = Math.min(240, available / 2);
  tableWidth = Math.max(minimum, Math.min(available - minimum, tableWidth));
  paneRatio = tableWidth / available;
  $('workspace').style.setProperty('--pane-columns',
    `minmax(0, ${paneRatio}fr) 20px minmax(0, ${1 - paneRatio}fr)`);
  paneResizer.setAttribute('aria-valuemin', Math.round(100 * minimum / available));
  paneResizer.setAttribute('aria-valuemax', Math.round(100 * (available - minimum) / available));
  paneResizer.setAttribute('aria-valuenow', Math.round(100 * paneRatio));
}
function stopPaneDrag() {
  paneDrag = null;
  $('workspace').classList.toggle('resizing', false);
}
paneResizer.onpointerdown = event => {
  if (event.button !== 0 || window.matchMedia('(max-width:1100px)').matches) return;
  event.preventDefault();
  paneDrag = {pointerId: event.pointerId, x: event.clientX,
    width: $('collection').getBoundingClientRect().width};
  paneResizer.setPointerCapture(event.pointerId);
  paneResizer.focus();
  $('workspace').classList.toggle('resizing', true);
};
paneResizer.onpointermove = event => {
  if (paneDrag && event.pointerId === paneDrag.pointerId) {
    resizePanes(paneDrag.width + event.clientX - paneDrag.x);
  }
};
paneResizer.onpointerup = event => {
  if (paneDrag && event.pointerId === paneDrag.pointerId) {
    paneResizer.releasePointerCapture(event.pointerId);
    stopPaneDrag();
  }
};
paneResizer.onpointercancel = paneResizer.onlostpointercapture = stopPaneDrag;
paneResizer.onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width = $('collection').getBoundingClientRect().width;
  resizePanes(event.key === 'Home' ? 0 : event.key === 'End' ? paneSpace() :
    width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10));
};
paneResizer.ondblclick = () => {
  paneRatio = null;
  $('workspace').style.removeProperty('--pane-columns');
  updatePaneDivider();
};
function updatePaneDivider() {
  if (window.matchMedia('(max-width:1100px)').matches) { stopPaneDrag(); return; }
  const available = paneSpace();
  if (!available) return;
  if (paneRatio !== null) resizePanes(paneRatio * available);
  else {
    const minimum = Math.min(240, available / 2);
    paneResizer.setAttribute('aria-valuemin', Math.round(100 * minimum / available));
    paneResizer.setAttribute('aria-valuemax', Math.round(100 * (available - minimum) / available));
    paneResizer.setAttribute('aria-valuenow', Math.round(100 * $('collection').getBoundingClientRect().width / available));
  }
}
window.addEventListener('resize', updatePaneDivider);
updatePaneDivider();

async function poll() {
  if (polling) return;
  polling = true;
  try { await state(); } catch (error) { report(error); }
  finally { polling = false; setTimeout(poll, 800); }
}
poll();
