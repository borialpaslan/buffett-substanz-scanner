const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ID = 'buffett-scanner-2026';
const SITE_ID = 'buffett-scanner-2026';

function getAccessToken() {
  if (process.env.GCLOUD_ACCESS_TOKEN) return process.env.GCLOUD_ACCESS_TOKEN.trim();
  const sdkPath1 = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
  const gcloudCmd = fs.existsSync(sdkPath1) ? `"${sdkPath1}"` : 'gcloud';
  return execSync(`${gcloudCmd} auth print-access-token`, { encoding: 'utf8' }).trim();
}

async function deployToFirebaseHosting() {
  const token = getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'x-goog-user-project': PROJECT_ID,
    'Content-Type': 'application/json'
  };

  // 1. Stelle sicher, dass die Hosting-Site existiert
  await fetch(`https://firebasehosting.googleapis.com/v1beta1/projects/${PROJECT_ID}/sites?siteId=${SITE_ID}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  });

  // 2. Neue Version anlegen
  const verRes = await fetch(`https://firebasehosting.googleapis.com/v1beta1/sites/${SITE_ID}/versions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      config: {
        headers: [
          {
            glob: '/data/**',
            headers: { 'Cache-Control': 'no-cache, max-age=0' }
          }
        ]
      }
    })
  });
  const verJson = await verRes.json();
  if (!verRes.ok) {
    throw new Error(`Fehler beim Erstellen der Hosting-Version: ${JSON.stringify(verJson)}`);
  }
  const versionName = verJson.name;

  // 3. Dateien sammeln, komprimieren (gzip) und SHA256 berechnen
  const rootDir = path.join(__dirname, '..');
  const fileEntries = [
    { webPath: '/index.html', diskPath: path.join(rootDir, 'public', 'index.html') },
    { webPath: '/styles.css', diskPath: path.join(rootDir, 'public', 'styles.css') },
    { webPath: '/app.js', diskPath: path.join(rootDir, 'public', 'app.js') },
    { webPath: '/data/latest-scan.json', diskPath: path.join(rootDir, 'data', 'latest-scan.json') }
  ];

  const chartsDir = path.join(rootDir, 'data', 'charts');
  if (fs.existsSync(chartsDir)) {
    for (const fn of fs.readdirSync(chartsDir)) {
      if (fn.endsWith('.json')) {
        fileEntries.push({
          webPath: `/data/charts/${fn}`,
          diskPath: path.join(chartsDir, fn)
        });
      }
    }
  }

  const filesMap = {};
  const gzByHash = new Map();

  for (const item of fileEntries) {
    if (!fs.existsSync(item.diskPath)) continue;
    const raw = fs.readFileSync(item.diskPath);
    const gz = zlib.gzipSync(raw, { level: 9 });
    const hash = crypto.createHash('sha256').update(gz).digest('hex');
    filesMap[item.webPath] = hash;
    gzByHash.set(hash, gz);
  }

  // 4. populateFiles aufrufen
  const popRes = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${versionName}:populateFiles`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ files: filesMap })
  });
  const popJson = await popRes.json();
  if (!popRes.ok) {
    throw new Error(`populateFiles fehlgeschlagen: ${JSON.stringify(popJson)}`);
  }

  const requiredHashes = popJson.uploadRequiredHashes || [];
  const uploadUrl = popJson.uploadUrl;
  console.log(`Lade ${requiredHashes.length} geänderte Dateien zu Google Firebase Hosting hoch...`);

  // 5. Fehlende Dateien parallel hochladen
  let upCursor = 0;
  const upConcurrency = 25;
  await Promise.all(
    Array.from({ length: upConcurrency }, async () => {
      while (upCursor < requiredHashes.length) {
        const hash = requiredHashes[upCursor++];
        const gzBuf = gzByHash.get(hash);
        if (!gzBuf) continue;
        const upRes = await fetch(`${uploadUrl}/${hash}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-goog-user-project': PROJECT_ID,
            'Content-Type': 'application/octet-stream'
          },
          body: gzBuf
        });
        if (!upRes.ok) {
          throw new Error(`Upload für ${hash} fehlgeschlagen: ${upRes.status}`);
        }
      }
    })
  );

  // 6. Version finalisieren
  const finRes = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${versionName}?update_mask=status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'FINALIZED' })
  });
  if (!finRes.ok) {
    throw new Error(`Finalisierung fehlgeschlagen: ${await finRes.text()}`);
  }

  // 7. Release veröffentlichen
  const relRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE_ID}/releases?versionName=${encodeURIComponent(versionName)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: `Auto-Deploy ${new Date().toISOString()}` })
    }
  );
  if (!relRes.ok) {
    throw new Error(`Release fehlgeschlagen: ${await relRes.text()}`);
  }

  const publicUrl = `https://${SITE_ID}.web.app`;
  console.log(`================================================================`);
  console.log(` LIVE AUF GOOGLE HOSTING VERÖFFENTLICHT (0,00 EUR / Spark-Plan):`);
  console.log(` -> ${publicUrl}`);
  console.log(`================================================================`);
  return publicUrl;
}

if (require.main === module) {
  deployToFirebaseHosting().catch(err => {
    console.error('Deployment-Fehler:', err.message);
    process.exit(1);
  });
}

module.exports = { deployToFirebaseHosting };
