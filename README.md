# TubeGrab — YouTube Video & Audio Downloader

A professional, self-hosted YouTube downloader with a clean web interface. Download videos in MP4 or MP3 format with quality selection, queue management, and full playlist support.

## Features

- **Single Video Downloads** — Paste a URL, select format & quality, download
- **Playlist Support** — Detect playlists, select/deselect individual videos, bulk queue
- **Format Selection** — Toggle between MP4 (video) and MP3 (audio)
- **Quality Selection** — Choose from available qualities (1080p, 720p, 480p, 360p, etc.)
- **Download Queue** — Sequential download queue with real-time progress via SSE
- **Dark/Light Theme** — Toggle between dark and light mode
- **Professional UI** — Clean, flat SaaS design — no glassmorphism

## Prerequisites

- **Python 3.10+**
- **ffmpeg** — Required for MP3 conversion and video stream merging
  ```bash
  # Windows (via winget)
  winget install ffmpeg

  # Windows (via chocolatey)
  choco install ffmpeg

  # macOS
  brew install ffmpeg

  # Ubuntu/Debian
  sudo apt install ffmpeg
  ```

## Setup

```bash
# 1. Create virtual environment
python -m venv venv

# 2. Activate it
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the server
python app.py
```

Then open **http://localhost:5000** in your browser.

## Usage

1. Paste a YouTube video or playlist URL in the input field
2. Click **Fetch Info** (or just paste — it auto-fetches)
3. Choose **MP4** or **MP3** format
4. Select video quality (for MP4)
5. Click **Add to Queue**
6. Watch real-time progress in the queue panel
7. Click the download icon to save completed files

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, Flask, yt-dlp |
| Frontend | HTML, CSS, JavaScript (vanilla) |
| Real-time | Server-Sent Events (SSE) |
| Design | Stitch Design System ("SaaS Precision") |

## Disclaimer

This tool is intended for personal use only. Downloading copyrighted content without permission may violate YouTube's Terms of Service. Use responsibly.
