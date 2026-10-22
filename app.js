// Studio site: a friendly face over GitHub. One project = one issue labelled "studio" + branch studio/<slug>.
// Her files go to projects/<slug>/input/ on that branch; the "studio" workflow runs the team and answers in the issue;
// finished files land in projects/<slug>/output/ and are listed here for download. Setup: docs/studio-site.md.
const OWNER = 'AdiEllis';
const REPO = 'Marketing-team';
const LABEL = 'studio';
const WORKFLOW = 'studio.yml';
const API = 'https://api.github.com';
const BOT_SYS = /^(⏳|⚠️|✓ \*\*)/;
const PROGRESS = /^(⏳|✓|⚠️) \*\*/; // the run's live checklist (studio/tools/progress.sh)

const $ = (id) => document.getElementById(id);
const store = {
  get() { try { return localStorage.getItem('studio-token') || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem('studio-token', v) : localStorage.removeItem('studio-token'); } catch {} },
};
let token = store.get();
let pollTimer = null;

// ---------- GitHub API ----------
async function gh(path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}/repos/${OWNER}/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error((data && data.message) || res.statusText); e.status = res.status; throw e; }
  return data;
}

// Errors in her words: what happened and what to do, not GitHub's English message.
function friendly(e) {
  if (!navigator.onLine || e instanceof TypeError) return 'אין חיבור לאינטרנט כרגע. כדאי לבדוק את החיבור ולנסות שוב.';
  if (e.status === 401) return 'מפתח הגישה כבר לא עובד. צריך להתנתק ולהדביק מפתח חדש.';
  if (e.status === 403 || e.status === 429) return 'GitHub ביקש לחכות רגע. כדאי לנסות שוב בעוד דקה.';
  if (e.status >= 500) return 'ל-GitHub יש תקלה זמנית. כדאי לנסות שוב בעוד כמה דקות.';
  return e.message;
}

// While files upload, leaving the page would lose them, so the browser asks first.
let busy = false;
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function safeName(name, prefix) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'file';
  return `${prefix}${base}${ext ? '.' + ext : ''}`;
}

// One commit with all files, via the Git Data API (handles large videos, unlike the contents API).
async function commitFiles(branch, dir, files, message, onProgress, createFrom) {
  if (createFrom) {
    const base = await gh(`/git/ref/heads/${createFrom}`);
    await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
  }
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const { file, path } = files[i];
    if (file.size > 95 * 1024 * 1024) throw new Error(`הקובץ ${file.name} גדול מדי (מעל 95MB)`);
    onProgress(`מעלה ${i + 1} מתוך ${files.length}: ${file.name}`);
    const blob = await gh('/git/blobs', { method: 'POST', body: { content: await readBase64(file), encoding: 'base64' } });
    entries.push({ path: `${dir}/${path}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  onProgress('שומר…');
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await gh(`/git/ref/heads/${branch}`);
    const commit = await gh(`/git/commits/${head.object.sha}`);
    const tree = await gh('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree: entries } });
    const next = await gh('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [head.object.sha] } });
    try { await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: next.sha } }); return; }
    catch (e) { if (e.status !== 422 || attempt === 2) throw e; } // the team pushed meanwhile: rebuild on the new head
  }
}

function projectMeta(issue) {
  const m = /studio-branch: (studio\/([A-Za-z0-9._-]+))/.exec(issue.body || '');
  return m ? { branch: m[1], slug: m[2] } : null;
}

async function runsByIssue() {
  const out = {};
  try {
    const data = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=100`);
    for (const r of data.workflow_runs) {
      if (r.conclusion === 'skipped' || r.conclusion === 'cancelled') continue;
      const m = /^studio #(\d+)$/.exec(r.display_title || '');
      if (m) (out[m[1]] = out[m[1]] || []).push(r); // newest first
    }
  } catch { /* no Actions permission: statuses just stay unknown */ }
  return out;
}

// A message she sends while the team works waits in line (one run per project at a time), so say so.
// Returns [full label, style, short label for the list, list group].
function statusOf(runs, issue) {
  if (issue.state === 'closed') return ['הסתיים', 'ok', 'הסתיים', 'done'];
  if (!runs || !runs.length) return ['ממתין לצוות', 'work', 'בתור לצוות', 'work'];
  const active = runs.some((r) => r.status === 'in_progress');
  const waiting = runs.some((r) => ['queued', 'pending', 'waiting', 'requested'].includes(r.status));
  if (active && waiting) return ['הצוות עובד, וההודעה שלך התקבלה ומחכה בתור', 'work', 'הצוות עובד', 'work'];
  if (active) return ['הצוות עובד…', 'work', 'הצוות עובד', 'work'];
  if (waiting) return ['ההודעה שלך התקבלה, הצוות מתחיל', 'work', 'הצוות מתחיל', 'work'];
  const last = runs[0];
  if (last.conclusion === 'failure' || last.conclusion === 'timed_out') return ['נעצר בתקלה', 'bad', 'נעצר בתקלה', 'wait'];
  return ['ממתין לך', 'wait', 'ממתין לך', 'wait'];
}

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long' });
const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// A project's face in the list: the first finished photo, else the first photo she uploaded.
const thumbCache = new Map();
function projectThumb(meta) {
  if (!thumbCache.has(meta.slug)) {
    const pick = async (dir) => {
      const items = await gh(`/contents/projects/${meta.slug}/${dir}?ref=${encodeURIComponent(meta.branch)}`).catch(() => []);
      return (items || []).find((f) => f.type === 'file' && /\.(jpe?g|png|webp)$/i.test(f.name));
    };
    thumbCache.set(meta.slug, (async () => {
      const f = (await pick('output')) || (await pick('input'));
      if (!f) return null;
      return URL.createObjectURL(await fileBlob(f.path, meta.branch));
    })().catch(() => null));
  }
  return thumbCache.get(meta.slug);
}

// ---------- views ----------
function show(view) {
  for (const v of ['viewSetup', 'viewList', 'viewNew', 'viewProject']) $(v).classList.toggle('hidden', v !== view);
  $('heroList').classList.toggle('hidden', view !== 'viewList');
  $('navHome').classList.toggle('hidden', view === 'viewList' || view === 'viewSetup');
  clearTimeout(pollTimer);
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }));
}

async function route() {
  if (!token) { show('viewSetup'); return; }
  const h = location.hash;
  const m = /^#\/p\/(\d+)$/.exec(h);
  if (m) return openProject(Number(m[1]));
  if (h === '#/new') { show('viewNew'); return; }
  show('viewList');
  loadList();
}

async function loadList() {
  const box = $('projList');
  const h = new Date().getHours();
  $('hello').textContent = h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : 'ערב טוב';
  try {
    const [issues, runs] = await Promise.all([gh(`/issues?labels=${LABEL}&state=all&per_page=100`), runsByIssue()]);
    const groups = { wait: [], work: [], done: [] };
    for (const is of issues) { const st = statusOf(runs[is.number], is); groups[st[3]].push([is, st]); }
    $('heroTitle').innerHTML = groups.wait.length ? 'יש <em>תוצרים</em> שמחכים לך' : groups.work.length ? 'הצוות <em>עובד</em> בשבילך' : 'מה <em>מפיקים</em> היום?';
    box.textContent = '';
    if (!issues.length) {
      box.innerHTML = `<div class="card empty"><span class="ic">${icon('photo')}</span><b>עוד אין פרויקטים</b><p class="hint" style="margin:0">מעלים תמונות של עבודה שסיימתם, והצוות מכין ממנה רילס ופוסט.</p></div>`;
      return;
    }
    const titles = { wait: 'ממתינים לך', work: 'בעבודה', done: 'הסתיימו' };
    for (const g of ['wait', 'work', 'done']) {
      if (!groups[g].length) continue;
      const sec = document.createElement('section'); sec.className = 'group';
      sec.innerHTML = `<h3>${titles[g]}</h3>`;
      for (const [is, [, cls, short]] of groups[g]) {
        const a = document.createElement('a');
        a.href = `#/p/${is.number}`;
        a.className = `proj ${g === 'wait' && cls === 'wait' ? 'wait' : ''}`;
        a.innerHTML = `<span class="thumb">${icon('photo')}</span><span class="body"><span class="t"></span><span class="d"></span><span class="pill ${cls}"></span></span><span class="chev">${icon('chev')}</span>`;
        a.querySelector('.t').textContent = is.title;
        a.querySelector('.d').textContent = `נפתח ב-${dateFmt.format(new Date(is.created_at))}`;
        a.querySelector('.pill').textContent = short;
        const meta = projectMeta(is);
        if (meta) projectThumb(meta).then((u) => { if (u) a.querySelector('.thumb').innerHTML = `<img src="${u}" alt="">`; });
        sec.appendChild(a);
      }
      box.appendChild(sec);
    }
  } catch (e) { box.innerHTML = '<p class="err"></p>'; box.firstChild.textContent = `לא הצלחתי לטעון את הפרויקטים. ${friendly(e)}`; }
}

async function openProject(num) {
  show('viewProject');
  $('pThread').innerHTML = '<p class="hint">טוען…</p>';
  delete $('pThread').dataset.key;
  $('pFiles').textContent = ''; delete $('pFiles').dataset.key;
  $('pFilesCard').classList.add('hidden'); $('pFilesPanel').classList.add('hidden'); $('pNew').classList.add('hidden');
  const render = async () => {
    try {
      const [issue, comments, runs] = await Promise.all([
        gh(`/issues/${num}`), gh(`/issues/${num}/comments?per_page=100`), runsByIssue(),
      ]);
      const meta = projectMeta(issue);
      $('pTitle').textContent = issue.title;
      const [label, cls] = statusOf(runs[num], issue);
      $('pStatus').textContent = label; $('pStatus').className = `pill ${cls}`;
      $('pDate').textContent = `נפתח ב-${dateFmt.format(new Date(issue.created_at))}`;
      const thread = $('pThread');
      // rebuild only when something changed, so images and scroll position stay put between polls
      const key = [issue.body, ...comments.map((c) => c.id + c.updated_at)].join('|');
      if (thread.dataset.key !== key) {
        const first = !thread.dataset.key;
        const before = thread.childElementCount;
        const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
        thread.dataset.key = key;
        thread.textContent = '';
        const add = (who, cls, body) => {
          const d = document.createElement('div');
          d.className = `msg ${cls}`;
          d.innerHTML = (who ? `<div class="who">${who}</div>` : '') + md(body);
          // the team shows images by repo path (e.g. a review sheet); load them through the API
          if (meta) d.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || '';
            if (/^(https?:|data:|blob:)/.test(src)) return;
            img.removeAttribute('src');
            fileBlob(src.replace(/^\/+/, ''), meta.branch).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
          });
          thread.appendChild(d);
        };
        add('אני', 'me', issue.body);
        for (const c of comments) {
          const mine = c.user.login.toLowerCase() === OWNER.toLowerCase();
          if (!mine && PROGRESS.test(c.body)) add('', 'note', c.body);
          else if (!mine && BOT_SYS.test(c.body)) add('', 'sys', c.body);
          else add(mine ? 'אני' : 'צוות השיווק', mine ? 'me' : 'team', c.body);
        }
        // like a messaging app: newest at the bottom; if she scrolled up to read, tell her instead of jumping
        if (first || atBottom) scrollToEnd();
        else if (thread.childElementCount > before) $('pNew').classList.remove('hidden');
      }
      if (meta) await renderFiles(meta);
      return meta;
    } catch (e) { $('pThread').innerHTML = '<p class="err"></p>'; $('pThread').firstChild.textContent = `לא הצלחתי לטעון את הפרויקט. ${friendly(e)}`; }
  };
  const meta = await render();
  $('pSend').onclick = () => sendReply(num, meta, render);
  // poll faster while the team works, so the progress note feels live
  const tick = async () => {
    if (location.hash !== `#/p/${num}`) return; // she left this project
    if (!document.hidden) await render();
    if (location.hash !== `#/p/${num}`) return;
    const working = $('pStatus').classList.contains('work');
    pollTimer = setTimeout(tick, working ? 8000 : 20000);
  };
  pollTimer = setTimeout(tick, 8000);
}

// The repo is private, so files come through the API with her token (raw.githubusercontent would 404).
async function fileBlob(path, ref) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.blob();
}

const blobUrls = [];
let readyFiles = { items: [] };
// Fetched files stay in memory (by sha): the share sheet must open inside her tap, with no download in between.
const blobCache = new Map();
async function getBlob(f, branch) {
  if (!blobCache.has(f.sha)) blobCache.set(f.sha, fileBlob(f.path, branch).catch((e) => { blobCache.delete(f.sha); throw e; }));
  return blobCache.get(f.sha);
}
const MEDIA = /\.(jpe?g|png|webp|mp4|mov)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };
const asFile = (f, blob) => new File([blob], f.name, { type: MIME[f.name.split('.').pop().toLowerCase()] || blob.type });
// On a phone the share sheet has "Save to Photos" / gallery, which is where she posts to Instagram from.
const canShareFiles = () => { try { return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; } };
async function renderFiles({ branch, slug }) {
  const box = $('pFiles');
  let items = [];
  try { items = await gh(`/contents/projects/${slug}/output?ref=${encodeURIComponent(branch)}`); }
  catch (e) { if (e.status !== 404) throw e; }
  items = (items || []).filter((f) => f.type === 'file');
  readyFiles = { items, branch, slug };
  $('pFilesCard').classList.toggle('hidden', !items.length);
  $('pFilesCount').textContent = items.length;
  const key = items.map((f) => f.sha).join();
  if (box.dataset.key === key) return; // unchanged: keep playing videos alive
  box.dataset.key = key;
  resetSaveAll();
  // load the photos and the reel in the background, so "save to gallery" opens at once
  (async () => { for (const f of items.filter((x) => MEDIA.test(x.name))) await getBlob(f, branch).catch(() => {}); })();
  box.textContent = '';
  blobUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const objectUrl = async (f) => { const u = URL.createObjectURL(await getBlob(f, branch)); blobUrls.push(u); return u; };
  for (const f of items) {
    const el = document.createElement('div');
    el.className = 'file';
    if (/\.(jpe?g|png|webp)$/i.test(f.name)) {
      const img = document.createElement('img'); img.alt = '';
      el.appendChild(img);
      objectUrl(f).then((u) => { img.src = u; }).catch(() => {});
    } else if (/\.(mp4|mov|webm)$/i.test(f.name)) {
      // videos are big: load only when she asks to watch
      const play = document.createElement('button'); play.className = 'ghost play'; play.textContent = '▶ צפייה';
      play.onclick = async () => {
        play.disabled = true; play.textContent = 'טוען…';
        try {
          const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = await objectUrl(f);
          play.replaceWith(v); v.play().catch(() => {});
        } catch { play.disabled = false; play.textContent = '▶ צפייה'; }
      };
      el.appendChild(play);
    }
    const name = document.createElement('div'); name.className = 'name'; name.textContent = f.name === 'captions.md' ? 'כיתובים' : f.name;
    const toGallery = MEDIA.test(f.name) && canShareFiles();
    const btn = document.createElement('button'); btn.textContent = toGallery ? 'שמירה לגלריה' : 'הורדה';
    btn.onclick = () => (toGallery ? saveAll([f], btn, 'שמירה לגלריה') : download(f, branch, btn));
    el.append(name, btn);
    box.appendChild(el);
  }
}

async function download(f, branch, btn) {
  btn.disabled = true; btn.textContent = 'מוריד…';
  try {
    saveBlob(await getBlob(f, branch), f.name);
    btn.textContent = 'הורדה';
  } catch { btn.textContent = 'ההורדה נכשלה, לנסות שוב'; }
  btn.disabled = false;
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function scrollToEnd() { requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight)); $('pNew').classList.add('hidden'); }

function resetSaveAll() { $('pZip').textContent = canShareFiles() ? 'שמירה לגלריה' : 'הורדת הכול'; $('pZip').disabled = false; }

// Phone: one share sheet with all photos and the reel -> "Save N items" puts them straight in the gallery.
// Computer: each file downloads on its own (no zip).
async function saveAll(files, btn, label) {
  const { branch } = readyFiles;
  if (!files.length) return;
  const share = canShareFiles();
  const settled = await Promise.all(files.map((f) => Promise.race([blobCache.get(f.sha), null]).then((b) => b || null).catch(() => null)));
  const ready = settled.every(Boolean);
  if (share && ready) {
    try { await navigator.share({ files: files.map((f, i) => asFile(f, settled[i])) }); } catch { /* she closed the sheet */ }
    btn.textContent = label; return;
  }
  btn.disabled = true;
  try {
    const blobs = [];
    for (let i = 0; i < files.length; i++) { btn.textContent = `טוען ${i + 1}/${files.length}…`; blobs.push(await getBlob(files[i], branch)); }
    if (share) { btn.textContent = 'מוכן ✓ לחצי שוב לשמירה'; } // the browser only opens the sheet straight from a tap
    else { for (let i = 0; i < files.length; i++) { saveBlob(blobs[i], files[i].name); await new Promise((r) => setTimeout(r, 400)); } btn.textContent = label; }
  } catch { btn.textContent = 'נכשל, לנסות שוב'; }
  btn.disabled = false;
}

// ---------- file pickers ----------
function picker(dropId, inputId, thumbsId) {
  const files = [];
  const drop = $(dropId), input = $(inputId), thumbs = $(thumbsId);
  const draw = () => {
    thumbs.textContent = '';
    files.forEach((f, i) => {
      const d = document.createElement('div');
      if (f.type.startsWith('image/')) { const im = document.createElement('img'); im.src = URL.createObjectURL(f); d.appendChild(im); }
      else if (f.type.startsWith('video/')) { const v = document.createElement('video'); v.src = URL.createObjectURL(f); v.muted = true; d.appendChild(v); }
      else d.textContent = f.name;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.className = 'ghost'; x.setAttribute('aria-label', `הסרת ${f.name}`);
      x.onclick = (e) => { e.preventDefault(); files.splice(i, 1); draw(); };
      d.appendChild(x);
      thumbs.appendChild(d);
    });
  };
  const addAll = (list) => { for (const f of list) files.push(f); draw(); };
  drop.onclick = () => input.click();
  input.onchange = () => { addAll(input.files); input.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addAll(e.dataTransfer.files); };
  return { files, clear() { files.length = 0; draw(); } };
}
const newPick = picker('nDrop', 'nFiles', 'nThumbs');
const replyPick = picker('pDrop', 'pFilesIn', 'pThumbs');

// ---------- actions ----------
async function createProject() {
  const title = $('nTitle').value.trim();
  const brief = $('nBrief').value.trim();
  const what = document.querySelector('input[name=what]:checked').value;
  const mode = document.querySelector('input[name=mode]:checked').value;
  const prog = (t, err) => { $('nProgress').textContent = t; $('nProgress').classList.toggle('err', !!err); };
  if (!title) { $('nTitle').focus(); return prog('חסר שם לפרויקט.', true); }
  if (!brief) { $('nBrief').focus(); return prog('חסר בריף: כמה מילים על העבודה.', true); }
  if (!newPick.files.length) { $('nDrop').focus(); return prog('צריך לצרף לפחות תמונה אחת.', true); }
  $('nSend').disabled = true; busy = true;
  try {
    const d = new Date();
    const latin = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const slug = `${stamp}-${latin || 'p' + String(d.getDate()).padStart(2, '0') + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')}`;
    const branch = `studio/${slug}`;
    const files = newPick.files.map((file, i) => ({ file, path: safeName(file.name, `${String(i + 1).padStart(2, '0')}_`) }));
    await commitFiles(branch, `projects/${slug}/input`, files, `${slug}: her uploads from the studio site`, prog, 'main');
    prog('שולח לצוות…');
    await gh('/labels', { method: 'POST', body: { name: LABEL, color: '7a5a43' } }).catch(() => {});
    const body = [
      `<!-- studio-branch: ${branch} -->`,
      `**הבריף:**\n${brief}`,
      `**מה להפיק:** ${what}`,
      `**מצב:** ${mode}`,
      `**קבצים:** ${files.length} (${files.map((f) => f.path).join(', ')})`,
    ].join('\n\n');
    const issue = await gh('/issues', { method: 'POST', body: { title, body, labels: [LABEL] } });
    newPick.clear(); $('nTitle').value = ''; $('nBrief').value = ''; prog('');
    location.hash = `#/p/${issue.number}`;
  } catch (e) { prog(`הפרויקט לא נשלח. ${friendly(e)}`, true); }
  $('nSend').disabled = false; busy = false;
}

async function sendReply(num, meta, render) {
  const text = $('pReply').value.trim();
  const prog = (t, err) => { $('pProgress').textContent = t; $('pProgress').classList.toggle('err', !!err); };
  if (!text && !replyPick.files.length) return;
  $('pSend').disabled = true; busy = true;
  try {
    let note = '';
    if (replyPick.files.length) {
      if (!meta) throw new Error('חסר ענף לפרויקט');
      const t = Date.now().toString(36);
      const files = replyPick.files.map((file, i) => ({ file, path: safeName(file.name, `add${t}_${i + 1}_`) }));
      await commitFiles(meta.branch, `projects/${meta.slug}/input`, files, `${meta.slug}: more uploads from the studio site`, prog);
      note = `\n\n📎 צירפתי ${files.length} קבצים חדשים: ${files.map((f) => f.path).join(', ')}`;
    }
    prog('שולח…');
    await gh(`/issues/${num}/comments`, { method: 'POST', body: { body: (text || 'עוד קבצים') + note } });
    $('pReply').value = ''; replyPick.clear(); prog('');
    await render();
    scrollToEnd();
    // GitHub takes a few seconds to queue the run; until then the badge would still say "waiting for you"
    if (!$('pStatus').classList.contains('work')) { $('pStatus').textContent = 'ההודעה נשלחה, הצוות מתחיל עוד רגע'; $('pStatus').className = 'pill work'; }
  } catch (e) { prog(`ההודעה לא נשלחה, והיא עדיין כאן. ${friendly(e)}`, true); }
  $('pSend').disabled = false; busy = false;
}

async function saveToken() {
  const v = $('tokenIn').value.trim();
  if (!v) return;
  token = v;
  try {
    const repo = await gh('');
    if (!repo.permissions || !repo.permissions.push) throw new Error('למפתח אין הרשאת כתיבה לריפו');
    store.set(v); $('tokenIn').value = ''; $('setupErr').textContent = '';
    location.hash = '#/'; route();
  } catch (e) { token = ''; $('setupErr').textContent = `המפתח לא עבד. ${e.status === 401 || e.status === 404 ? 'כדאי לבדוק שהעתקת אותו במלואו.' : friendly(e)}`; }
}

// ---------- wiring ----------
$('tokenSave').onclick = saveToken;
$('tokenIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
$('pZip').onclick = () => {
  const media = readyFiles.items.filter((f) => MEDIA.test(f.name));
  saveAll(canShareFiles() ? media : readyFiles.items, $('pZip'), canShareFiles() ? 'שמירה לגלריה' : 'הורדת הכול');
};
$('pFilesToggle').onclick = () => {
  const open = $('pFilesPanel').classList.toggle('hidden') === false;
  $('pFilesToggle').setAttribute('aria-expanded', String(open));
};
$('pNew').onclick = scrollToEnd;
$('pReply').addEventListener('input', () => { const t = $('pReply'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; });
$('navHome').onclick = () => { location.hash = '#/'; };
$('navNew').onclick = () => { location.hash = '#/new'; };
$('nCancel').onclick = () => { location.hash = '#/'; };
$('nSend').onclick = createProject;
$('logout').onclick = () => {
  if (!confirm('להתנתק? כדי לחזור יהיה צריך להדביק שוב את מפתח הגישה.')) return;
  store.set(''); token = ''; route();
};
document.querySelectorAll('[data-quick]').forEach((b) => { b.onclick = () => { $('pReply').value = b.dataset.quick; $('pReply').focus(); }; });
window.addEventListener('hashchange', route);
route();
