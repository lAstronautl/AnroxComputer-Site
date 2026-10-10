/**
 * Browser-only post editor backed by the GitHub Contents API.
 * The PAT is kept in localStorage and sent only to api.github.com.
 */

const STORAGE_KEY = 'post-editor-session';
const API_ROOT = 'https://api.github.com';

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function api(session, path, options = {}) {
  return fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function listPosts(session) {
  const res = await api(
    session,
    `/repos/${session.repo}/contents/_posts?ref=${encodeURIComponent(session.branch)}`
  );
  if (!res.ok) throw new Error(`Не удалось получить список постов (${res.status})`);
  const items = await res.json();
  return items
    .filter((item) => item.type === 'file' && item.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getConfig(root) {
  return {
    repo: root?.dataset.repo || '',
    branch: root?.dataset.branch || 'master'
  };
}

async function getFile(session, path) {
  const res = await api(
    session,
    `/repos/${session.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(session.branch)}`
  );
  if (!res.ok) throw new Error(`Не удалось загрузить файл (${res.status})`);
  const data = await res.json();
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

async function putFile(session, path, content, message, sha) {
  const res = await api(session, `/repos/${session.repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: utf8ToBase64(content),
      branch: session.branch,
      ...(sha ? { sha } : {})
    })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Не удалось сохранить файл (${res.status})`);
  }
  return res.json();
}

function renderMarkdownPreview(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function init() {
  const root = document.getElementById('post-editor');
  const authSection = document.getElementById('pe-auth');
  const workspace = document.getElementById('pe-workspace');
  const tokenInput = document.getElementById('pe-token');
  const repoInput = document.getElementById('pe-repo');
  const connectBtn = document.getElementById('pe-connect');
  const disconnectBtn = document.getElementById('pe-disconnect');
  const authStatus = document.getElementById('pe-auth-status');

  const tabPostBtn = document.getElementById('pe-tab-post');
  const tabMapBtn = document.getElementById('pe-tab-map');
  const panelPost = document.getElementById('pe-panel-post');
  const panelMap = document.getElementById('pe-panel-map');

  const postList = document.getElementById('pe-post-list');
  const filterInput = document.getElementById('pe-filter');
  const newPostBtn = document.getElementById('pe-new-post');
  const filenameInput = document.getElementById('pe-filename');
  const contentArea = document.getElementById('pe-content');
  const previewToggle = document.getElementById('pe-preview-toggle');
  const previewPane = document.getElementById('pe-preview');
  const commitMessageInput = document.getElementById('pe-commit-message');
  const saveBtn = document.getElementById('pe-save');
  const saveStatus = document.getElementById('pe-save-status');

  const insertMapBtn = document.getElementById('pe-insert-map');
  const mapInsertBtn = document.getElementById('pe-map-insert');

  if (!authSection || !workspace) return;

  const config = getConfig(root);
  let session = loadSession();
  let posts = [];
  let currentPath = null;
  let currentSha = null;

  function switchTab(tab) {
    const isPost = tab === 'post';
    panelPost.hidden = !isPost;
    panelMap.hidden = isPost;
    tabPostBtn.classList.toggle('is-active', isPost);
    tabMapBtn.classList.toggle('is-active', !isPost);
    tabPostBtn.setAttribute('aria-selected', String(isPost));
    tabMapBtn.setAttribute('aria-selected', String(!isPost));
  }

  tabPostBtn.addEventListener('click', () => switchTab('post'));
  tabMapBtn.addEventListener('click', () => switchTab('map'));

  function setStatus(el, text, isError = false) {
    el.textContent = text;
    el.classList.toggle('is-error', isError);
  }

  function showWorkspace() {
    authSection.hidden = false;
    workspace.hidden = false;
    disconnectBtn.hidden = false;
    connectBtn.hidden = true;
    tokenInput.disabled = true;
    switchTab('post');
  }

  function showLoggedOut() {
    workspace.hidden = true;
    disconnectBtn.hidden = true;
    connectBtn.hidden = false;
    tokenInput.disabled = false;
  }

  function renderPostList() {
    const filter = filterInput.value.trim().toLowerCase();
    postList.innerHTML = '';

    posts
      .filter((p) => p.name.toLowerCase().includes(filter))
      .forEach((p) => {
        const li = document.createElement('li');
        li.textContent = p.name;
        li.className = p.path === currentPath ? 'is-active' : '';
        li.addEventListener('click', () => openPost(p.path));
        postList.appendChild(li);
      });
  }

  async function refreshPostList() {
    try {
      posts = await listPosts(session);
      renderPostList();
    } catch (err) {
      setStatus(authStatus, err.message, true);
    }
  }

  async function openPost(path) {
    try {
      setStatus(saveStatus, 'Загрузка...');
      const file = await getFile(session, path);
      currentPath = path;
      currentSha = file.sha;
      filenameInput.value = path;
      contentArea.value = file.content;
      commitMessageInput.value = `Обновление поста ${path.split('/').pop()}`;
      saveBtn.disabled = false;
      renderPostList();
      setStatus(saveStatus, '');
      if (!previewPane.hidden) previewPane.innerHTML = renderMarkdownPreview(contentArea.value);
    } catch (err) {
      setStatus(saveStatus, err.message, true);
    }
  }

  connectBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const repo = config.repo;
    const branch = config.branch;
    if (!token || !repo) {
      setStatus(authStatus, 'Укажите токен (репозиторий не настроен в _config.yml)', true);
      return;
    }

    session = { token, repo, branch };
    setStatus(authStatus, 'Проверка доступа...');

    try {
      const res = await api(session, `/repos/${repo}`);
      if (!res.ok) throw new Error('Нет доступа к репозиторию — проверьте токен и права');
      saveSession(session);
      setStatus(authStatus, `Подключено: ${repo}@${branch}`);
      showWorkspace();
      await refreshPostList();
    } catch (err) {
      setStatus(authStatus, err.message, true);
      session = null;
    }
  });

  disconnectBtn.addEventListener('click', () => {
    clearSession();
    session = null;
    posts = [];
    currentPath = null;
    currentSha = null;
    contentArea.value = '';
    filenameInput.value = '';
    setStatus(authStatus, '');
    showLoggedOut();
  });

  filterInput.addEventListener('input', renderPostList);

  newPostBtn.addEventListener('click', () => {
    currentPath = null;
    currentSha = null;
    filenameInput.value = '_posts/Новый-пост.md';
    contentArea.value = '---\ntitle: Новый пост\nnumber: 1\ncategories:\n  - Лор\ntags:\n  - graph\n---\n\n';
    commitMessageInput.value = 'Новый пост';
    saveBtn.disabled = false;
    renderPostList();
  });

  previewToggle.addEventListener('click', () => {
    previewPane.hidden = !previewPane.hidden;
    contentArea.hidden = !previewPane.hidden ? false : contentArea.hidden;
    previewToggle.textContent = previewPane.hidden ? 'Показать превью' : 'Скрыть превью';
    if (!previewPane.hidden) {
      previewPane.innerHTML = renderMarkdownPreview(contentArea.value);
    }
  });

  contentArea.addEventListener('input', () => {
    if (!previewPane.hidden) {
      previewPane.innerHTML = renderMarkdownPreview(contentArea.value);
    }
  });

  saveBtn.addEventListener('click', async () => {
    const path = filenameInput.value.trim();
    const message = commitMessageInput.value.trim() || `Обновление ${path}`;

    if (!path.startsWith('_posts/')) {
      setStatus(saveStatus, 'Путь файла должен начинаться с _posts/', true);
      return;
    }

    try {
      saveBtn.disabled = true;
      setStatus(saveStatus, 'Сохранение...');
      await putFile(session, path, contentArea.value, message, currentPath === path ? currentSha : undefined);
      setStatus(saveStatus, 'Сохранено ✓');
      currentPath = path;
      await refreshPostList();
    } catch (err) {
      setStatus(saveStatus, err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  insertMapBtn.addEventListener('click', () => {
    switchTab('map');
  });

  mapInsertBtn.addEventListener('click', () => {
    const output = document.getElementById('map-editor-output');
    if (output && output.value) {
      const cursor = contentArea.selectionStart ?? contentArea.value.length;
      contentArea.value =
        contentArea.value.slice(0, cursor) + `\n${output.value}\n` + contentArea.value.slice(cursor);
    }
    switchTab('post');
  });

  if (session) {
    setStatus(authStatus, `Подключено: ${session.repo}@${session.branch}`);
    tokenInput.value = '';
    repoInput.value = session.repo;
    showWorkspace();
    refreshPostList();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
