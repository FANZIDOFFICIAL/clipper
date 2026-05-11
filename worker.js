/**
 * YT Clipper — Cloudflare Worker
 * Handles: get_video, get_stream
 */

const RAPIDAPI_KEY  = 'a48cef6ed4msh5cd8a61a8f2963ep1dae6bjsn7350f3a51b71';
const RAPIDAPI_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 200) {
  return json({ success: false, error: msg }, status);
}

export default {
  async fetch(request) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return err('Method not allowed', 405);
    }

    let body;
    try {
      body = await request.formData();
    } catch {
      return err('Invalid form data');
    }

    const action = (body.get('action') || '').trim();

    // ── get_video ─────────────────────────────────────────────
    if (action === 'get_video') {
      const rawUrl  = (body.get('url') || '').trim();
      const startMin = parseInt(body.get('start_min')) || 0;
      const startSec = parseInt(body.get('start_sec')) || 0;
      const endMin   = parseInt(body.get('end_min'))   || 0;
      const endSec   = parseInt(body.get('end_sec'))   || 0;

      if (!rawUrl) return err('URL tidak boleh kosong');

      const videoId = extractYouTubeID(rawUrl);
      if (!videoId) return err('URL YouTube tidak valid');

      const startTotal = startMin * 60 + startSec;
      const endTotal   = endMin   * 60 + endSec;

      if (endTotal <= startTotal) return err('Waktu akhir harus lebih besar dari waktu mulai');
      if ((endTotal - startTotal) > 600) return err('Durasi klip maksimal 10 menit');

      const result = await fetchVideoFromRapidAPI(videoId);
      if (result.error) return err(result.error);

      const info = result.data;

      if (info.duration && endTotal > info.duration) {
        return err('Waktu akhir melebihi durasi video (' + fmtTime(info.duration) + ')');
      }

      return json({
        success:    true,
        video_id:   videoId,
        title:      info.title,
        duration:   info.duration,
        thumb:      info.thumb,
        start:      startTotal,
        end:        endTotal,
        clip_label: fmtTime(startTotal) + ' → ' + fmtTime(endTotal),
      });
    }

    // ── get_stream ────────────────────────────────────────────
    if (action === 'get_stream') {
      const videoId = (body.get('video_id') || '').trim();
      if (!videoId) return err('video_id kosong');

      const result = await fetchVideoFromRapidAPI(videoId);
      if (result.error) return err(result.error);

      const videoUrl = result.data.url;

      // Relay video dari YouTube CDN ke browser
      const ytResp = await fetch(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Referer':    'https://www.youtube.com/',
          'Origin':     'https://www.youtube.com',
        },
      });

      if (!ytResp.ok) {
        return err('Gagal ambil video dari YouTube (HTTP ' + ytResp.status + ')');
      }

      // Stream langsung ke browser dengan header CORS
      const headers = new Headers(CORS);
      headers.set('Content-Type',   ytResp.headers.get('Content-Type')   || 'video/mp4');
      headers.set('Content-Length', ytResp.headers.get('Content-Length') || '');
      headers.set('Cache-Control',  'no-cache');

      return new Response(ytResp.body, { status: 200, headers });
    }

    return err('Action tidak dikenal');
  }
};

// ── Helpers ───────────────────────────────────────────────────

function extractYouTubeID(url) {
  const patterns = [
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

async function fetchVideoFromRapidAPI(videoId) {
  const url = 'https://' + RAPIDAPI_HOST + '/dl?id=' + encodeURIComponent(videoId);

  let resp, body;
  try {
    resp = await fetch(url, {
      headers: {
        'x-rapidapi-key':  RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
    });
    body = await resp.json();
  } catch (e) {
    return { error: 'Koneksi ke RapidAPI gagal: ' + e.message };
  }

  if (resp.status === 401) return { error: 'API Key tidak valid (401)' };
  if (resp.status === 403) return { error: 'API Key ditolak atau kuota habis (403)' };
  if (resp.status === 429) return { error: 'Rate limit, coba lagi sebentar (429)' };
  if (resp.status === 404) return { error: 'Video tidak ditemukan (404)' };
  if (!resp.ok)            return { error: 'API error HTTP ' + resp.status };

  if (body?.status === 'fail') {
    return { error: 'API error: ' + (body.error || 'Unknown') };
  }

  let videoUrl = null;

  // Strategi 1: formats (itag 18 = 360p mp4+audio)
  if (Array.isArray(body.formats)) {
    for (const itag of [18, 22]) {
      const f = body.formats.find(f => parseInt(f.itag) === itag && f.url);
      if (f) { videoUrl = f.url; break; }
    }
    if (!videoUrl) {
      const f = body.formats.find(f => f.url && f.audioQuality && (f.mimeType||'').includes('video/mp4'));
      if (f) videoUrl = f.url;
    }
    if (!videoUrl) {
      const f = body.formats.find(f => f.url);
      if (f) videoUrl = f.url;
    }
  }

  // Strategi 2: link object
  if (!videoUrl && body.link && typeof body.link === 'object') {
    for (const q of [360, 480, 720, 240]) {
      if (body.link[q] || body.link[String(q)]) {
        videoUrl = body.link[q] || body.link[String(q)];
        break;
      }
    }
  }

  // Strategi 3: url string
  if (!videoUrl && typeof body.url === 'string') videoUrl = body.url;

  if (!videoUrl) return { error: 'URL video tidak ditemukan' };

  let thumb = '';
  if (Array.isArray(body.thumbnail)) {
    const best = body.thumbnail.reduce((a, b) => ((b.width||0) > (a.width||0) ? b : a), {});
    thumb = best.url || '';
  } else if (typeof body.thumbnail === 'string') {
    thumb = body.thumbnail;
  }

  return {
    data: {
      url:      videoUrl,
      title:    body.title    || 'Video YouTube',
      duration: parseInt(body.lengthSeconds || body.duration || 0),
      thumb,
    }
  };
}
