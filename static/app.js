/**
 * TubeGrab — Frontend Application Logic
 * Handles API communication, SSE progress, queue management, and UI state.
 */

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  theme: localStorage.getItem('tubegrab-theme') || 'dark',
  videoInfo: null,
  playlistInfo: null,
  format: 'mp4',
  quality: 'best',
  tasks: [],
  isFetching: false,
  selectedPlaylistItems: new Set(),
  eventSource: null,
};

// ─── DOM References ──────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(state.theme);
  connectSSE();
  bindEvents();
});

// ─── Theme Toggle ────────────────────────────────────────────────────────────
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tubegrab-theme', theme);

  const iconSun = $('#icon-sun');
  const iconMoon = $('#icon-moon');
  if (iconSun && iconMoon) {
    iconSun.style.display = theme === 'dark' ? 'block' : 'none';
    iconMoon.style.display = theme === 'light' ? 'block' : 'none';
  }
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

// ─── Event Binding ───────────────────────────────────────────────────────────
function bindEvents() {
  // Theme toggle
  $('#theme-toggle')?.addEventListener('click', toggleTheme);

  // Fetch button
  $('#fetch-btn')?.addEventListener('click', fetchVideoInfo);

  // URL input — enter key
  $('#url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchVideoInfo();
  });

  // Paste event — auto-fetch
  $('#url-input')?.addEventListener('paste', () => {
    setTimeout(fetchVideoInfo, 100);
  });

  // Format toggle
  $$('.format-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.format = btn.dataset.format;
      $$('.format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateQualityOptions();
    });
  });

  // Quality select
  $('#quality-select')?.addEventListener('change', (e) => {
    state.quality = e.target.value;
  });

  // Download / Add to Queue button
  $('#add-queue-btn')?.addEventListener('click', addToQueue);

  // Queue actions
  $('#clear-completed-btn')?.addEventListener('click', clearCompleted);
  $('#cancel-all-btn')?.addEventListener('click', cancelAll);
}

// ─── Fetch Video / Playlist Info ─────────────────────────────────────────────
async function fetchVideoInfo() {
  const url = $('#url-input')?.value.trim();
  if (!url) return;

  state.isFetching = true;
  state.videoInfo = null;
  state.playlistInfo = null;
  renderContentArea();

  try {
    const resp = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      showToast(data.error || 'Failed to fetch video info', 'error');
      state.isFetching = false;
      renderContentArea();
      return;
    }

    state.isFetching = false;

    if (data.type === 'playlist') {
      state.playlistInfo = data;
      state.videoInfo = null;
      state.selectedPlaylistItems = new Set(data.entries.map((_, i) => i));
    } else {
      state.videoInfo = data;
      state.playlistInfo = null;
      // Set available qualities
      if (data.qualities && data.qualities.length > 0) {
        state.quality = data.qualities[0];
      }
    }

    renderContentArea();
  } catch (err) {
    state.isFetching = false;
    showToast('Network error: ' + err.message, 'error');
    renderContentArea();
  }
}

// ─── Add to Queue ────────────────────────────────────────────────────────────
async function addToQueue() {
  if (state.playlistInfo) {
    // Add selected playlist items
    const entries = state.playlistInfo.entries;
    for (const idx of state.selectedPlaylistItems) {
      const entry = entries[idx];
      if (!entry) continue;

      const quality = state.format === 'mp3' ? 'best' : state.quality;
      await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: entry.url,
          title: entry.title,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
          channel: entry.channel,
          format: state.format,
          quality: quality,
        }),
      });
    }
    showToast(`Added ${state.selectedPlaylistItems.size} videos to queue`, 'success');
  } else if (state.videoInfo) {
    const quality = state.format === 'mp3' ? 'best' : state.quality;
    const resp = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.videoInfo.url,
        title: state.videoInfo.title,
        thumbnail: state.videoInfo.thumbnail,
        duration: state.videoInfo.duration,
        channel: state.videoInfo.channel,
        format: state.format,
        quality: quality,
      }),
    });

    if (resp.ok) {
      showToast('Added to download queue', 'success');
    } else {
      const data = await resp.json();
      showToast(data.error || 'Failed to add to queue', 'error');
    }
  }
}

// ─── Queue Management ────────────────────────────────────────────────────────
async function cancelTask(taskId) {
  await fetch(`/api/queue/${taskId}`, { method: 'DELETE' });
}

async function clearCompleted() {
  await fetch('/api/queue/clear', { method: 'POST' });
}

async function cancelAll() {
  const activeTasks = state.tasks.filter(t => ['queued', 'downloading', 'converting'].includes(t.status));
  for (const task of activeTasks) {
    await fetch(`/api/queue/${task.id}`, { method: 'DELETE' });
  }
}

async function downloadFile(taskId) {
  window.open(`/api/download-file/${taskId}`, '_blank');
}

// ─── SSE Connection ──────────────────────────────────────────────────────────
function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource('/api/progress');

  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'init':
        state.tasks = data.tasks || [];
        renderQueue();
        break;

      case 'task_added':
        state.tasks.push(data.task);
        renderQueue();
        break;

      case 'task_update':
        const idx = state.tasks.findIndex(t => t.id === data.task.id);
        if (idx >= 0) {
          state.tasks[idx] = data.task;
        } else {
          state.tasks.push(data.task);
        }
        renderQueue();
        break;

      case 'task_removed':
        state.tasks = state.tasks.filter(t => t.id !== data.task_id);
        renderQueue();
        break;

      case 'heartbeat':
        break;
    }
  };

  state.eventSource.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function renderContentArea() {
  const container = $('#content-area');
  if (!container) return;

  if (state.isFetching) {
    container.innerHTML = `
      <div class="loading-overlay">
        <div class="spinner"></div>
        <p>Fetching video information...</p>
      </div>`;
    return;
  }

  if (state.playlistInfo) {
    renderPlaylist(container);
    return;
  }

  if (state.videoInfo) {
    renderVideoCard(container);
    return;
  }

  // Default placeholder
  container.innerHTML = `
    <div class="fetch-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/>
      </svg>
      <h3>Paste a YouTube URL to get started</h3>
      <p>Supports single videos and playlists. Choose your format and quality, then add to the download queue.</p>
    </div>`;
}

function renderVideoCard(container) {
  const v = state.videoInfo;
  const duration = formatDuration(v.duration);
  const views = v.view_count ? formatNumber(v.view_count) + ' views' : '';

  const qualityOptions = (v.qualities || ['best']).map(q =>
    `<option value="${q}" ${q === state.quality ? 'selected' : ''}>${q === 'best' ? 'Best Available' : q}</option>`
  ).join('');

  container.innerHTML = `
    <div class="video-card">
      <div class="video-thumbnail-wrapper">
        ${v.thumbnail ? `<img src="${v.thumbnail}" alt="${escapeHtml(v.title)}" />` : ''}
        ${duration ? `<span class="video-duration-badge">${duration}</span>` : ''}
      </div>
      <div class="video-info">
        <h2 class="video-title">${escapeHtml(v.title)}</h2>
        <p class="video-channel">${escapeHtml(v.channel)}</p>
        <div class="video-meta">
          ${views ? `<span>${views}</span>` : ''}
          ${duration ? `<span>${duration}</span>` : ''}
        </div>
      </div>
      <div class="download-options">
        <div class="options-row">
          <div class="option-group">
            <span class="option-label">Format</span>
            <div class="format-toggle">
              <button class="format-btn ${state.format === 'mp4' ? 'active' : ''}" data-format="mp4">MP4</button>
              <button class="format-btn ${state.format === 'mp3' ? 'active' : ''}" data-format="mp3">MP3</button>
            </div>
          </div>
          <div class="option-group" id="quality-group">
            <span class="option-label">Quality</span>
            <select class="quality-select" id="quality-select">
              ${qualityOptions}
            </select>
          </div>
        </div>
        <div class="download-action">
          <button class="btn btn-primary" id="add-queue-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            Add to Queue
          </button>
        </div>
      </div>
    </div>`;

  // Re-bind events for dynamically created elements
  container.querySelectorAll('.format-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.format = btn.dataset.format;
      container.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateQualityOptions();
    });
  });

  container.querySelector('#quality-select')?.addEventListener('change', (e) => {
    state.quality = e.target.value;
  });

  container.querySelector('#add-queue-btn')?.addEventListener('click', addToQueue);

  updateQualityOptions();
}

function renderPlaylist(container) {
  const p = state.playlistInfo;

  const itemsHtml = p.entries.map((entry, idx) => {
    const checked = state.selectedPlaylistItems.has(idx) ? 'checked' : '';
    const duration = formatDuration(entry.duration);
    return `
      <div class="playlist-item">
        <input type="checkbox" ${checked} data-index="${idx}" class="playlist-checkbox" />
        <img class="playlist-item-thumb" src="${entry.thumbnail || ''}" alt="" onerror="this.style.display='none'" />
        <div class="playlist-item-info">
          <div class="playlist-item-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
          <div class="playlist-item-channel">${escapeHtml(entry.channel || '')}</div>
        </div>
        <span class="playlist-item-duration">${duration}</span>
      </div>`;
  }).join('');

  const qualityOptions = ['best', '1080p', '720p', '480p', '360p'].map(q =>
    `<option value="${q}" ${q === state.quality ? 'selected' : ''}>${q === 'best' ? 'Best Available' : q}</option>`
  ).join('');

  container.innerHTML = `
    <div class="playlist-card">
      <div class="playlist-header">
        <div>
          <div class="playlist-title">${escapeHtml(p.title)}</div>
          <div class="playlist-count">${p.count} videos · ${escapeHtml(p.channel || '')}</div>
        </div>
      </div>
      <div class="playlist-controls">
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-secondary btn-sm" id="select-all-btn">Select All</button>
          <button class="btn btn-secondary btn-sm" id="deselect-all-btn">Deselect All</button>
          <span style="font-size:12px;color:var(--text-tertiary)" id="selection-count">${state.selectedPlaylistItems.size} selected</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="format-toggle" style="height:32px">
            <button class="format-btn ${state.format === 'mp4' ? 'active' : ''}" data-format="mp4" style="padding:4px 16px;font-size:12px">MP4</button>
            <button class="format-btn ${state.format === 'mp3' ? 'active' : ''}" data-format="mp3" style="padding:4px 16px;font-size:12px">MP3</button>
          </div>
          <select class="quality-select" id="quality-select" style="width:140px;padding:6px 12px;font-size:12px">
            ${qualityOptions}
          </select>
        </div>
      </div>
      <div class="playlist-items">
        ${itemsHtml}
      </div>
      <div class="playlist-footer">
        <button class="btn btn-primary" id="add-queue-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          Add ${state.selectedPlaylistItems.size} Videos to Queue
        </button>
      </div>
    </div>`;

  // Bind playlist events
  container.querySelectorAll('.playlist-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      if (e.target.checked) {
        state.selectedPlaylistItems.add(idx);
      } else {
        state.selectedPlaylistItems.delete(idx);
      }
      updateSelectionCount();
    });
  });

  container.querySelector('#select-all-btn')?.addEventListener('click', () => {
    state.selectedPlaylistItems = new Set(p.entries.map((_, i) => i));
    container.querySelectorAll('.playlist-checkbox').forEach(cb => cb.checked = true);
    updateSelectionCount();
  });

  container.querySelector('#deselect-all-btn')?.addEventListener('click', () => {
    state.selectedPlaylistItems.clear();
    container.querySelectorAll('.playlist-checkbox').forEach(cb => cb.checked = false);
    updateSelectionCount();
  });

  container.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.format = btn.dataset.format;
      container.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  container.querySelector('#quality-select')?.addEventListener('change', (e) => {
    state.quality = e.target.value;
  });

  container.querySelector('#add-queue-btn')?.addEventListener('click', addToQueue);

  function updateSelectionCount() {
    const countEl = container.querySelector('#selection-count');
    const addBtn = container.querySelector('#add-queue-btn');
    if (countEl) countEl.textContent = `${state.selectedPlaylistItems.size} selected`;
    if (addBtn) addBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      Add ${state.selectedPlaylistItems.size} Videos to Queue`;
  }
}

function renderQueue() {
  const listEl = $('#queue-list');
  const countEl = $('#queue-count');
  if (!listEl) return;

  if (countEl) countEl.textContent = state.tasks.length;

  if (state.tasks.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
        </svg>
        <p>No downloads in queue.<br/>Paste a URL above to get started.</p>
      </div>`;
    return;
  }

  listEl.innerHTML = state.tasks.map(task => {
    const progressClass = task.status === 'completed' ? 'completed' : (task.status === 'failed' ? 'failed' : '');
    const statusClass = `status-${task.status}`;

    let actionHtml = '';
    if (task.status === 'completed') {
      actionHtml = `
        <button class="btn btn-secondary btn-icon" onclick="downloadFile('${task.id}')" title="Download">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        </button>`;
    }
    if (['queued', 'downloading', 'converting'].includes(task.status)) {
      actionHtml += `
        <button class="btn btn-danger btn-icon" onclick="cancelTask('${task.id}')" title="Cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </button>`;
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      actionHtml += `
        <button class="btn btn-secondary btn-icon" onclick="cancelTask('${task.id}')" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </button>`;
    }

    let statsHtml = '';
    if (task.status === 'downloading') {
      statsHtml = `
        <span>${task.progress}%</span>
        <span>${task.speed || ''} ${task.eta ? '· ' + task.eta : ''}</span>`;
    } else if (task.status === 'converting') {
      statsHtml = `<span>Converting to ${task.format_type.toUpperCase()}...</span>`;
    } else if (task.status === 'completed') {
      statsHtml = `<span>Download complete</span>`;
    } else if (task.status === 'failed') {
      statsHtml = `<span style="color:var(--error)">${escapeHtml(task.error || 'Download failed')}</span>`;
    }

    return `
      <div class="queue-item queue-item-enter">
        <img class="queue-item-thumb" src="${task.thumbnail || ''}" alt="" onerror="this.style.background='var(--bg-elevated)'" />
        <div class="queue-item-content">
          <div class="queue-item-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</div>
          <div class="queue-item-meta">
            <span class="queue-item-badge badge-format">${task.format_type.toUpperCase()}</span>
            <span class="queue-item-badge badge-quality">${task.quality === 'best' ? 'BEST' : task.quality + 'p'}</span>
            <span class="status-badge ${statusClass}">${task.status}</span>
          </div>
          <div class="queue-item-progress">
            <div class="queue-item-progress-fill ${progressClass}" style="width:${task.progress}%"></div>
          </div>
          <div class="queue-item-stats">${statsHtml}</div>
        </div>
        <div class="queue-item-actions">
          ${actionHtml}
        </div>
      </div>`;
  }).join('');
}

function updateQualityOptions() {
  const select = $('#quality-select');
  const group = $('#quality-group');
  if (!select || !group) return;

  if (state.format === 'mp3') {
    group.style.opacity = '0.4';
    group.style.pointerEvents = 'none';
    state.quality = 'best';
    select.value = 'best';
  } else {
    group.style.opacity = '1';
    group.style.pointerEvents = 'auto';
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimeout;
function showToast(message, type = 'info') {
  let toast = $('#toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}
