"""
TubeGrab — YouTube Video/Audio Downloader
Flask backend with yt-dlp integration, download queue, and SSE progress.
"""

import os
import uuid
import json
import time
import threading
import queue
from datetime import datetime
from flask import Flask, request, jsonify, send_file, Response, render_template
from flask_cors import CORS
from whitenoise import WhiteNoise

app = Flask(__name__, static_folder='static', template_folder='templates')
app.wsgi_app = WhiteNoise(app.wsgi_app, root='static/', prefix='static/')
CORS(app)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Download Queue & State
# ---------------------------------------------------------------------------
download_tasks = {}        # task_id -> task dict
task_order = []            # ordered list of task_ids
task_queue = queue.Queue() # sequential processing queue
progress_listeners = []    # SSE listeners
queue_lock = threading.Lock()


def broadcast_progress(data):
    """Send SSE event to all listeners."""
    message = f"data: {json.dumps(data)}\n\n"
    dead = []
    for i, q in enumerate(progress_listeners):
        try:
            q.put_nowait(message)
        except Exception:
            dead.append(i)
    for i in reversed(dead):
        progress_listeners.pop(i)


def create_task(video_info, format_type, quality):
    """Create a new download task."""
    task_id = str(uuid.uuid4())[:8]
    task = {
        'id': task_id,
        'url': video_info.get('webpage_url', video_info.get('url', '')),
        'title': video_info.get('title', 'Unknown'),
        'thumbnail': video_info.get('thumbnail', ''),
        'duration': video_info.get('duration', 0),
        'channel': video_info.get('channel', video_info.get('uploader', 'Unknown')),
        'format_type': format_type,   # 'mp4' or 'mp3'
        'quality': quality,           # '1080', '720', '480', '360', 'best'
        'status': 'queued',           # queued, downloading, converting, completed, failed, cancelled
        'progress': 0,
        'speed': '',
        'eta': '',
        'filesize': '',
        'filename': '',
        'error': '',
        'created_at': datetime.now().isoformat(),
    }
    with queue_lock:
        download_tasks[task_id] = task
        task_order.append(task_id)
    return task


def download_worker():
    """Worker thread that processes downloads sequentially."""
    while True:
        task_id = task_queue.get()
        if task_id is None:
            break

        task = download_tasks.get(task_id)
        if not task or task['status'] == 'cancelled':
            task_queue.task_done()
            continue

        try:
            _execute_download(task)
        except Exception as e:
            task['status'] = 'failed'
            task['error'] = str(e)
            broadcast_progress({'type': 'task_update', 'task': _sanitize_task(task)})
        finally:
            task_queue.task_done()


def _execute_download(task):
    """Execute a single download using yt-dlp."""
    import yt_dlp

    task['status'] = 'downloading'
    broadcast_progress({'type': 'task_update', 'task': _sanitize_task(task)})

    def progress_hook(d):
        if task['status'] == 'cancelled':
            raise Exception('Download cancelled by user')

        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes', 0)
            if total > 0:
                task['progress'] = round((downloaded / total) * 100, 1)
            task['speed'] = d.get('_speed_str', '').strip()
            task['eta'] = d.get('_eta_str', '').strip()
            task['filesize'] = d.get('_total_bytes_str', '').strip() or d.get('_total_bytes_estimate_str', '').strip()
            broadcast_progress({'type': 'task_update', 'task': _sanitize_task(task)})

        elif d['status'] == 'finished':
            task['progress'] = 100
            task['speed'] = ''
            if task['format_type'] == 'mp3':
                task['status'] = 'converting'
            broadcast_progress({'type': 'task_update', 'task': _sanitize_task(task)})

    # Build yt-dlp options
    output_template = os.path.join(DOWNLOAD_DIR, f'{task["id"]}_%(title)s.%(ext)s')

    if task['format_type'] == 'mp3':
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': output_template,
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }],
            'progress_hooks': [progress_hook],
            'quiet': True,
            'no_warnings': True,
        }
    else:
        # MP4 with quality selection
        quality = task['quality']
        if quality == 'best':
            format_str = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
        else:
            height = quality.replace('p', '')
            format_str = f'bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}][ext=mp4]/best[height<={height}]'

        ydl_opts = {
            'format': format_str,
            'outtmpl': output_template,
            'merge_output_format': 'mp4',
            'progress_hooks': [progress_hook],
            'quiet': True,
            'no_warnings': True,
        }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(task['url'], download=True)
        # Find the downloaded file
        if info:
            filename = ydl.prepare_filename(info)
            if task['format_type'] == 'mp3':
                # After post-processing, extension changes to .mp3
                base = os.path.splitext(filename)[0]
                filename = base + '.mp3'
            task['filename'] = os.path.basename(filename)

    task['status'] = 'completed'
    task['progress'] = 100
    broadcast_progress({'type': 'task_update', 'task': _sanitize_task(task)})


def _sanitize_task(task):
    """Return a safe copy of task for JSON serialization."""
    return {k: v for k, v in task.items()}


# Start worker thread
worker_thread = threading.Thread(target=download_worker, daemon=True)
worker_thread.start()


# ---------------------------------------------------------------------------
# Routes — Pages
# ---------------------------------------------------------------------------
@app.route('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------
@app.route('/api/info', methods=['POST'])
def get_video_info():
    """Fetch video/playlist metadata from a YouTube URL."""
    import yt_dlp

    data = request.get_json()
    url = data.get('url', '').strip()

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': 'in_playlist',
        'skip_download': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            return jsonify({'error': 'Could not fetch video information'}), 400

        # Check if it's a playlist
        if info.get('_type') == 'playlist':
            entries = []
            for entry in (info.get('entries') or []):
                if entry:
                    entries.append({
                        'url': entry.get('url', ''),
                        'title': entry.get('title', 'Unknown'),
                        'thumbnail': entry.get('thumbnails', [{}])[-1].get('url', '') if entry.get('thumbnails') else '',
                        'duration': entry.get('duration', 0),
                        'channel': entry.get('channel', entry.get('uploader', 'Unknown')),
                    })

            return jsonify({
                'type': 'playlist',
                'title': info.get('title', 'Unknown Playlist'),
                'channel': info.get('channel', info.get('uploader', 'Unknown')),
                'count': len(entries),
                'entries': entries,
            })
        else:
            # Single video — also get available formats for quality selection
            # Re-fetch without flat extraction for format details
            ydl_opts_full = {
                'quiet': True,
                'no_warnings': True,
                'skip_download': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts_full) as ydl:
                full_info = ydl.extract_info(url, download=False)

            qualities = set()
            if full_info.get('formats'):
                for fmt in full_info['formats']:
                    h = fmt.get('height')
                    if h and h >= 144:
                        qualities.add(h)

            sorted_qualities = sorted(qualities, reverse=True)

            return jsonify({
                'type': 'video',
                'url': full_info.get('webpage_url', url),
                'title': full_info.get('title', 'Unknown'),
                'thumbnail': full_info.get('thumbnail', ''),
                'duration': full_info.get('duration', 0),
                'channel': full_info.get('channel', full_info.get('uploader', 'Unknown')),
                'view_count': full_info.get('view_count', 0),
                'qualities': [f'{q}p' for q in sorted_qualities] if sorted_qualities else ['best'],
            })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/download', methods=['POST'])
def start_download():
    """Add a video to the download queue."""
    data = request.get_json()
    url = data.get('url', '').strip()
    title = data.get('title', 'Unknown')
    thumbnail = data.get('thumbnail', '')
    duration = data.get('duration', 0)
    channel = data.get('channel', 'Unknown')
    format_type = data.get('format', 'mp4').lower()
    quality = data.get('quality', 'best').replace('p', '')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    if format_type not in ('mp4', 'mp3'):
        format_type = 'mp4'

    video_info = {
        'webpage_url': url,
        'url': url,
        'title': title,
        'thumbnail': thumbnail,
        'duration': duration,
        'channel': channel,
    }

    task = create_task(video_info, format_type, quality)
    task_queue.put(task['id'])

    broadcast_progress({'type': 'task_added', 'task': _sanitize_task(task)})

    return jsonify({'task': _sanitize_task(task)})


@app.route('/api/queue', methods=['GET'])
def get_queue():
    """Get all tasks in order."""
    with queue_lock:
        tasks = [_sanitize_task(download_tasks[tid]) for tid in task_order if tid in download_tasks]
    return jsonify({'tasks': tasks})


@app.route('/api/queue/<task_id>', methods=['DELETE'])
def cancel_task(task_id):
    """Cancel or remove a task."""
    task = download_tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    if task['status'] in ('queued', 'downloading', 'converting'):
        task['status'] = 'cancelled'
    with queue_lock:
        if task_id in task_order:
            task_order.remove(task_id)
        del download_tasks[task_id]

    broadcast_progress({'type': 'task_removed', 'task_id': task_id})
    return jsonify({'success': True})


@app.route('/api/queue/clear', methods=['POST'])
def clear_completed():
    """Remove completed/failed/cancelled tasks from queue."""
    removed = []
    with queue_lock:
        to_remove = [tid for tid in task_order
                      if download_tasks.get(tid, {}).get('status') in ('completed', 'failed', 'cancelled')]
        for tid in to_remove:
            task_order.remove(tid)
            del download_tasks[tid]
            removed.append(tid)

    for tid in removed:
        broadcast_progress({'type': 'task_removed', 'task_id': tid})

    return jsonify({'removed': len(removed)})


@app.route('/api/download-file/<task_id>', methods=['GET'])
def download_file(task_id):
    """Serve a completed download file."""
    task = download_tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    if task['status'] != 'completed' or not task['filename']:
        return jsonify({'error': 'File not ready'}), 400

    filepath = os.path.join(DOWNLOAD_DIR, task['filename'])
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found on disk'}), 404

    return send_file(filepath, as_attachment=True, download_name=task['filename'])


@app.route('/api/progress')
def progress_stream():
    """SSE endpoint for real-time progress updates."""
    def event_stream():
        q = queue.Queue()
        progress_listeners.append(q)
        try:
            # Send initial state
            with queue_lock:
                tasks = [_sanitize_task(download_tasks[tid]) for tid in task_order if tid in download_tasks]
            yield f"data: {json.dumps({'type': 'init', 'tasks': tasks})}\n\n"

            while True:
                try:
                    message = q.get(timeout=30)
                    yield message
                except queue.Empty:
                    # Send heartbeat to keep connection alive
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except GeneratorExit:
            if q in progress_listeners:
                progress_listeners.remove(q)

    return Response(event_stream(), mimetype='text/event-stream',
                    headers={
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no',
                    })


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"\n  +======================================+")
    print(f"  |         TubeGrab v1.0                |")
    print(f"  |   YouTube Downloader                 |")
    print(f"  |   http://localhost:{port}               |")
    print(f"  +======================================+\n")
    app.run(debug=True, host='0.0.0.0', port=port, threaded=True)
