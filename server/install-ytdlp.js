#!/usr/bin/env node
// Automatically installs yt-dlp binary on Render (Linux x64)
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const YTDLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

function log(msg) { console.log('[install-ytdlp]', msg); }

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return get(res.headers.location);
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    };
    get(url);
  });
}

(async () => {
  try {
    const binDir = path.join(__dirname, '..', 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    // Check if already installed
    if (fs.existsSync(YTDLP_PATH)) {
      try {
        const v = execSync(`${YTDLP_PATH} --version`, { timeout: 10000 }).toString().trim();
        log(`yt-dlp already installed: ${v}`);
        return;
      } catch(e) {
        log('existing binary broken, re-downloading...');
        try { fs.unlinkSync(YTDLP_PATH); } catch(_) {}
      }
    }

    // Try system yt-dlp first
    try {
      const v = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim();
      log(`System yt-dlp found: ${v}`);
      // Create symlink to bin/ (skip if already exists)
      if (!fs.existsSync(YTDLP_PATH)) {
        const which = execSync('which yt-dlp').toString().trim();
        fs.symlinkSync(which, YTDLP_PATH);
      }
      return;
    } catch(e) {}

    // Try pip install
    try {
      log('Trying pip install yt-dlp...');
      execSync('pip install yt-dlp --break-system-packages -q', { timeout: 120000, stdio: 'inherit' });
      const ytdlpBin = execSync('which yt-dlp 2>/dev/null || echo ""').toString().trim();
      if (ytdlpBin) {
        if (!fs.existsSync(YTDLP_PATH)) fs.symlinkSync(ytdlpBin, YTDLP_PATH);
        log('yt-dlp installed via pip');
        return;
      }
    } catch(e) { log('pip install failed: ' + e.message); }

    // Download binary directly
    log(`Downloading yt-dlp from GitHub...`);
    try {
      await download(YTDLP_URL, YTDLP_PATH);
      fs.chmodSync(YTDLP_PATH, '755');
      const v = execSync(`${YTDLP_PATH} --version`, { timeout: 15000 }).toString().trim();
      log(`yt-dlp installed: ${v}`);
    } catch(e) {
      log('WARNING: Could not download yt-dlp: ' + e.message);
      log('Fallback API will be used instead.');
    }

  } catch(e) {
    // Never let this script fail the npm install
    console.warn('[install-ytdlp] Unexpected error (non-fatal):', e.message);
  }

  process.exit(0);
})();