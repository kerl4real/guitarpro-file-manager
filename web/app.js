const $ = id => document.getElementById(id);
let rows = [], selected = null, sort = 'title', descending = false, page = 0;
let initialized = false, lastMessage = '', lastRevision = -1, requestId = 0;
let acceptingJob = false, polling = false;

async function invoke(command, args) {
  try {
    return await window.__TAURI__.core.invoke(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : error.message || 'Request failed');
  }
}

function detail(row) {
  selected = row;
  $('selected').textContent = row ? row.title : 'Select a score';
  $('path').textContent = row ? row.path : 'Browse your library to inspect metadata.';
  $('metadata').textContent = row ? JSON.stringify(JSON.parse(row.record), null, 2) : '';
  $('open').disabled = !row;
  for (const tr of $('rows').children) tr.classList.toggle('selected', tr.dataset.path === row?.path);
}

async function refresh(resetPage = false) {
  if (resetPage) page = 0;
  const currentRequest = ++requestId;
  const value = await invoke('query_library', {query: {
    search: $('search').value, format: $('format').value, status: $('status').value,
    sort, descending, page
  }});
  if (currentRequest !== requestId) return;
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
    ($('search').value || $('format').value || $('status').value ? 'No matching scores' : 'Build your score library');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.path = row.path;
    tr.tabIndex = 0;
    for (const key of ['title', 'artist', 'album', 'format', 'tempo', 'tracks', 'status']) {
      const td = document.createElement('td');
      td.textContent = row[key] ?? '—';
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
  detail(rows.find(row => row.path === selected?.path) || null);
}

function report(error) { $('message').textContent = error.message || String(error); }

async function state() {
  const value = await invoke('get_state');
  if (!initialized) {
    $('parser').value = value.parser;
    $('folder').value = value.folder || '';
    $('database').textContent = value.database;
    initialized = true;
  }
  setBusy(value.busy || acceptingJob);
  $('cancel').hidden = !value.busy;
  $('cancel').disabled = value.cancelling;
  $('progress').hidden = !value.busy;
  const changed = lastMessage !== value.message;
  if (changed) $('message').textContent = value.message;
  const revision = value.revision ?? value.message;
  if (revision !== lastRevision && !value.busy) {
    await refresh();
    lastRevision = revision;
  }
  lastMessage = value.message;
}

function setBusy(busy) {
  for (const id of ['scan', 'import', 'browse-parser', 'browse-folder', 'parser', 'folder']) {
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

$('scan').onclick = () => startJob(() => invoke('start_scan', {
  parser: $('parser').value, folder: $('folder').value
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
      if (path) $(field).value = path;
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
for (const id of ['format', 'status']) $(id).onchange = () => refresh(true).catch(report);
for (const button of document.querySelectorAll('[data-sort]')) button.onclick = () => {
  descending = sort === button.dataset.sort ? !descending : false;
  sort = button.dataset.sort;
  refresh(true).catch(report);
};
$('previous').onclick = () => { page = Math.max(0, page - 1); refresh().catch(report); };
$('next').onclick = () => { page += 1; refresh().catch(report); };
async function poll() {
  if (polling) return;
  polling = true;
  try { await state(); } catch (error) { report(error); }
  finally { polling = false; setTimeout(poll, 800); }
}
poll();
