'use strict';

const https = require('https');

// Resolve a public YouTube playlist into an ordered list of video IDs WITHOUT
// an API key, by fetching the playlist page and scraping the embedded JSON.
// A consent cookie is required or YouTube 302-redirects to its consent wall.
// We own the resulting list, so the client can shuffle reliably instead of
// fighting the YouTube IFrame API's flaky setShuffle().

const CONSENT_COOKIE = 'SOCS=CAI; CONSENT=YES+1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: CONSENT_COOKIE,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function extractVideoIds(html) {
  const ids = [];
  const seen = new Set();
  const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

async function resolvePlaylist(playlistId) {
  const url =
    'https://www.youtube.com/playlist?list=' + encodeURIComponent(playlistId) + '&hl=en';
  return extractVideoIds(await fetchText(url));
}

module.exports = { resolvePlaylist, extractVideoIds };
