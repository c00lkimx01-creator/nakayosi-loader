'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── yt-dlp binary path ─────────────────────────────────────
function getYtdlpBin() {
  const candidates = [
    path.join(__dirname, '..', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        execSync(`${c} --version`, { timeout: 5000 });
        return c;
      }
    } catch(e) {}
  }
  try { execSync('yt-dlp --version', { timeout: 5000 }); return 'yt-dlp'; } catch(e) {}
  return null;
}

let YTDLP_BIN = null;
try { YTDLP_BIN = getYtdlpBin(); } catch(e) {}
console.log('[server] yt-dlp binary:', YTDLP_BIN || 'NOT FOUND (fallback mode)');

// ─── Middleware ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', limiter);

// ─── Static frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Helpers ────────────────────────────────────────────────
function extractVideoId(url) {
  if (!url) return null;
  let m = url.match(/[?&]v=([^&#]{11})/);
  if (m) return m[1];
  m = url.match(/youtu\.be\/([^?&#]{11})/);
  if (m) return m[1];
  m = url.match(/\/embed\/([^?&#]{11})/);
  if (m) return m[1];
  m = url.match(/\/shorts\/([^?&#]{11})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

function runYtdlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!YTDLP_BIN) return reject(new Error('yt-dlp not available'));
    let stdout = '', stderr = '';
    // Add proxy argument
    const finalArgs = ['--proxy', 'http://ytproxy-siawaseok.duckdns.org:3007', ...args];
    const proc = spawn(YTDLP_BIN, finalArgs);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')); }, timeout);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Exit code ${code}`));
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Classify a format entry
function classifyFormat(fmt) {
  const hasVideo = !!(fmt.vcodec && fmt.vcodec !== 'none');
  const hasAudio = !!(fmt.acodec && fmt.acodec !== 'none');
  let streamType;
  if (hasVideo && hasAudio) streamType = 'both';
  else if (hasVideo) streamType = 'video only';
  else if (hasAudio) streamType = 'audio only';
  else streamType = 'unknown';

  const isM3u8 = !!(
    fmt.protocol === 'hls' ||
    (fmt.url && (fmt.url.includes('.m3u8') || fmt.url.includes('manifest'))) ||
    fmt.format_id?.includes('hls')
  );

  return { hasVideo, hasAudio, streamType, isM3u8 };
}

// ─── API: /api/info ─────────────────────────────────────────
// Returns video metadata + format list with classification
app.get('/api/info', async (req, res) => {
  const { url, id } = req.query;
  const vid = extractVideoId(id || url);
  if (!vid) return res.status(400).json({ error: 'Invalid video ID or URL' });

  const ytUrl = `https://www.youtube.com/watch?v=${vid}`;

  // Try yt-dlp first
  if (YTDLP_BIN) {
    try {
      const json = await runYtdlp([
        '--dump-json', '--no-playlist',
        '--no-warnings', '--skip-download',
        ytUrl
      ], 25000);
      const info = JSON.parse(json);

      const formats = (info.formats || []).map(fmt => {
        const cls = classifyFormat(fmt);
        return {
          formatId: fmt.format_id,
          ext: fmt.ext,
          quality: fmt.format_note || fmt.quality,
          resolution: fmt.resolution || (fmt.height ? `${fmt.width}x${fmt.height}` : null),
          fps: fmt.fps,
          filesize: fmt.filesize || fmt.filesize_approx,
          vcodec: fmt.vcodec,
          acodec: fmt.acodec,
          abr: fmt.abr,
          vbr: fmt.vbr,
          url: fmt.url,
          ...cls
        };
      });

      return res.json({
        id: vid,
        title: info.title,
        channel: info.uploader || info.channel,
        duration: info.duration,
        thumbnail: info.thumbnail,
        description: info.description?.slice(0, 300),
        viewCount: info.view_count,
        likeCount: info.like_count,
        uploadDate: info.upload_date,
        formats,
        source: 'ytdlp'
      });
    } catch(e) {
      console.warn('[info] yt-dlp failed:', e.message);
    }
  }

  // Fallback: Invidious
  try {
    const invBase = process.env.INVIDIOUS_URL || 'https://invidious.fdn.fr';
    const r = await fetch(`${invBase}/api/v1/videos/${vid}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (r.ok) {
      const info = await r.json();
      const formats = [
        ...(info.formatStreams || []).map(fmt => {
          const hasVideo = true, hasAudio = true;
          return { formatId: fmt.itag, ext: fmt.container, quality: fmt.qualityLabel, resolution: fmt.resolution, url: fmt.url, hasVideo, hasAudio, streamType: 'both', isM3u8: false };
        }),
        ...(info.adaptiveFormats || []).map(fmt => {
          const hasVideo = fmt.type?.startsWith('video') || false;
          const hasAudio = fmt.type?.startsWith('audio') || false;
          const streamType = hasVideo && hasAudio ? 'both' : hasVideo ? 'video only' : 'audio only';
          return { formatId: fmt.itag, ext: fmt.container || 'webm', quality: fmt.qualityLabel || fmt.bitrate, url: fmt.url, hasVideo, hasAudio, streamType, isM3u8: false };
        })
      ];
      return res.json({
        id: vid, title: info.title, channel: info.author,
        duration: info.lengthSeconds, thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        formats, source: 'invidious'
      });
    }
  } catch(e) { console.warn('[info] Invidious failed:', e.message); }

  res.status(502).json({ error: 'Could not fetch video info. Try fallback API.' });
});

// ─── API: /api/streams/:id ───────────────────────────────────
// Returns available stream URLs with full metadata flags
app.get('/api/streams/:id', async (req, res) => {
  const vid = extractVideoId(req.params.id);
  if (!vid) return res.status(400).json({ error: 'Invalid video ID' });

  const ytUrl = `https://www.youtube.com/watch?v=${vid}`;
  let streams = [];

  // yt-dlp path
  if (YTDLP_BIN) {
    try {
      const json = await runYtdlp([
        '--dump-json', '--no-playlist', '--no-warnings', '--skip-download', ytUrl
      ], 25000);
      const info = JSON.parse(json);

      streams = (info.formats || [])
        .filter(fmt => fmt.url)
        .map(fmt => {
          const cls = classifyFormat(fmt);
          return {
            formatId: fmt.format_id,
            ext: fmt.ext || 'mp4',
            quality: fmt.format_note || String(fmt.height || ''),
            resolution: fmt.resolution || (fmt.height ? `${fmt.width || '?'}x${fmt.height}` : null),
            fps: fmt.fps || null,
            filesize: fmt.filesize || fmt.filesize_approx || null,
            tbr: fmt.tbr || null,
            abr: fmt.abr || null,
            vbr: fmt.vbr || null,
            vcodec: fmt.vcodec || null,
            acodec: fmt.acodec || null,
            url: fmt.url,
            // ── Classification flags ──────────────────────
            hasVideo: cls.hasVideo,
            hasAudio: cls.hasAudio,
            streamType: cls.streamType,
            isM3u8: cls.isM3u8,
          };
        });

      const best = (() => {
        const both = streams.filter(s => s.streamType === 'both').sort((a,b) => (b.tbr||0)-(a.tbr||0));
        return both[0] || streams[0] || null;
      })();

      return res.json({
        id: vid,
        source: 'ytdlp',
        streamCount: streams.length,
        best: best ? {
          url: best.url,
          quality: best.quality,
          ext: best.ext,
          hasVideo: best.hasVideo,
          hasAudio: best.hasAudio,
          streamType: best.streamType,
          isM3u8: best.isM3u8,
        } : null,
        streams,
      });
    } catch(e) {
      console.warn('[streams] yt-dlp failed:', e.message);
    }
  }

  // Fallback: external API
  const fallbackUrl = `https://siawaseok.f5.si/api/streams/${vid}`;
  try {
    const r = await fetch(fallbackUrl, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const data = await r.json();
      // Enrich with classification flags if missing
      const enriched = (Array.isArray(data) ? data : data.streams || []).map(s => {
        if ('hasVideo' in s) return s; // already classified
        const cls = classifyFormat({ vcodec: s.vcodec, acodec: s.acodec, url: s.url, format_id: s.formatId });
        return { ...s, ...cls };
      });
      return res.json({
        id: vid, source: 'fallback', streamCount: enriched.length,
        best: enriched[0] || null, streams: enriched,
        fallbackUsed: true
      });
    }
  } catch(e) { console.warn('[streams] fallback failed:', e.message); }

  res.status(502).json({ error: 'Could not get stream URLs', id: vid });
});

// ─── API: /api/download ──────────────────────────────────────
// Proxies the stream to the client (actual download)
app.get('/api/download', async (req, res) => {
  const { url, id, format, filename } = req.query;
  const vid = extractVideoId(id || '');

  let streamUrl = url;

  // If no direct URL, get best stream via yt-dlp
  if (!streamUrl && vid && YTDLP_BIN) {
    try {
      const fmtArg = format === 'audio' ? 'bestaudio' :
                     format === '1080' ? 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' :
                     format === '720'  ? 'bestvideo[height<=720]+bestaudio/best[height<=720]' :
                     format === '480'  ? 'bestvideo[height<=480]+bestaudio/best[height<=480]' :
                     'bestvideo+bestaudio/best';
      streamUrl = await runYtdlp([
        '--get-url', '--format', fmtArg, '--no-playlist',
        `https://www.youtube.com/watch?v=${vid}`
      ], 20000);
      // yt-dlp may return multiple lines (video + audio), take first
      streamUrl = streamUrl.split('\n')[0].trim();
    } catch(e) {
      // fallback
      if (vid) streamUrl = `https://siawaseok.f5.si/api/streams/${vid}`;
    }
  }

  if (!streamUrl) return res.status(400).json({ error: 'No stream URL available' });

  // Proxy the stream
  try {
    const proto = streamUrl.startsWith('https') ? https : http;
    const fname = filename || (vid ? `video_${vid}.mp4` : 'download.mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const proxyReq = proto.get(streamUrl, { timeout: 30000 }, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      console.error('[download] proxy error:', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Stream proxy failed' });
    });
    req.on('close', () => proxyReq.destroy());
  } catch(e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── API: /api/thumbnail ─────────────────────────────────────
app.get('/api/thumbnail', (req, res) => {
  const { id, quality } = req.query;
  const vid = extractVideoId(id);
  if (!vid) return res.status(400).json({ error: 'Invalid video ID' });
  const q = quality || 'hqdefault';
  const thumbUrl = `https://i.ytimg.com/vi/${vid}/${q}.jpg`;
  res.redirect(thumbUrl);
});

// ─── API: /api/status ────────────────────────────────────────
app.get('/api/status', (req, res) => {
  let ytdlpVersion = null;
  try {
    if (YTDLP_BIN) ytdlpVersion = execSync(`${YTDLP_BIN} --version`, { timeout: 5000 }).toString().trim();
  } catch(e) {}
  res.json({
    ok: true,
    ytdlp: !!YTDLP_BIN,
    ytdlpVersion,
    ytdlpPath: YTDLP_BIN,
    node: process.version,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'production',
  });
});

// ─── SPA fallback ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] 仲良しtube2 running on port ${PORT}`);
  console.log(`[server] yt-dlp: ${YTDLP_BIN || 'not found'}`);
});
