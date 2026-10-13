const token = location.hash.slice(1) || sessionStorage.getItem('library-token');
if (token) sessionStorage.setItem('library-token', token);
history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let rows = [], selected = null, sort = 'title', descending = false, initialized = false, lastMessage = '', requestId = 0;
async function api(path, body) {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'X-Library-Token': token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
function detail(row) {
  selected = row;
  $('selected').textContent = row ? row.title : 'Select a score';
  $('path').textContent = row ? row.path : 'Browse your library to inspect metadata.';
  $('metadata').textContent = row ? JSON.stringify(JSON.parse(row.record), null, 2) : '';
  $('open').disabled = !row;
  for (const tr of $('rows').children) tr.classList.toggle('selected', tr.dataset.path === row?.path);
}
async function refresh() {
  const currentRequest = ++requestId;
  const params = new URLSearchParams({search: $('search').value, format: $('format').value, status: $('status').value, sort, descending});
  const value = await api('/api/library?' + params);
  if (currentRequest !== requestId) return;
  rows = value.rows;
  $('rows').replaceChildren();
  $('count').textContent = `${rows.length} files`;
  $('empty').hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.path = row.path;
    tr.tabIndex = 0;
    for (const key of ['title', 'artist', 'album', 'format', 'tempo', 'tracks', 'status']) {
      const td = document.createElement('td');
      td.textContent = row[key] ?? '—';
      if (key === 'format') {const span = document.createElement('span'); span.className = 'badge'; span.textContent = td.textContent; td.replaceChildren(span);}
      if (key === 'status' && row.status === 'error') td.className = 'error';
      tr.append(td);
    }
    tr.onclick = () => detail(row);
    tr.onkeydown = event => {if(event.key === 'Enter') detail(row);};
    tr.ondblclick = () => {detail(row); $('open').click();};
    $('rows').append(tr);
  }
  detail(rows.find(row => row.path === selected?.path) || null);
}
function report(error) { $('message').textContent = error.message; }
async function state() {
  const value = await api('/api/state');
  if (!initialized) { $('parser').value = value.parser; $('database').textContent = value.database; initialized = true; }
  $('scan').disabled = $('import').disabled = value.busy;
  if (lastMessage !== value.message) {
    $('message').textContent = value.message;
    if (!value.busy) await refresh();
  }
  lastMessage = value.message;
}
$('scan').onclick = async () => {try {await api('/api/scan', {parser: $('parser').value, folder: $('folder').value}); await state();} catch(error) {report(error);}};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {try {const file = $('file').files[0]; if(file) {await api('/api/import', {jsonl: await file.text()}); await state();}} catch(error) {report(error);} finally {$('file').value = '';}};
$('open').onclick = async () => {try {if(selected) {await api('/api/open', {path: selected.path}); $('message').textContent = 'Opened score';}} catch(error) {report(error);}};
let debounce;
$('search').oninput = () => {clearTimeout(debounce); debounce = setTimeout(() => refresh().catch(report), 150);};
for (const id of ['format', 'status']) $(id).onchange = () => refresh().catch(report);
for (const button of document.querySelectorAll('[data-sort]')) button.onclick = () => {descending = sort === button.dataset.sort ? !descending : false; sort = button.dataset.sort; refresh().catch(report);};
(async () => {try {await state();} catch(error) {report(error);} finally {setTimeout(argumentsPoll, 800);}})();
async function argumentsPoll() {try {await state();} catch(error) {report(error);} finally {setTimeout(argumentsPoll, 800);}}
