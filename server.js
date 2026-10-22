const express = require('express');
const path = require('path');
const cron = require('node-cron');
const {
  runDailyScan,
  getCachedScan,
  getHistoryDates,
  getScanByDate,
  getScanStatus
} = require('./src/scanner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Aktuellsten Tages-Scan abrufen
app.get('/api/scan', (req, res) => {
  const cached = getCachedScan();
  const status = getScanStatus();
  const historyDates = getHistoryDates();

  // Falls noch kein vollständiger Scan von heute vorliegt und aktuell keiner läuft -> automatisch starten
  const todayStr = new Date().toISOString().slice(0, 10);
  const missingFuture = cached && Array.isArray(cached.stocks) && cached.stocks[0] && cached.stocks[0].futureScore === undefined;
  if ((!cached || cached.scanDate !== todayStr || missingFuture) && !status.isScanning) {
    runDailyScan({ force: Boolean(missingFuture) }).catch(err => {
      console.error('Fehler beim automatischen Tages-Scan:', err.message);
    });
  }

  res.json({
    status: getScanStatus(),
    historyDates,
    data: cached
  });
});

// API: Live-Status des laufenden Scans (für Fortschrittsbalken)
app.get('/api/status', (req, res) => {
  res.json({
    status: getScanStatus(),
    historyDates: getHistoryDates()
  });
});

// API: Historischen Tages-Scan laden
app.get('/api/history/:date', (req, res) => {
  const scan = getScanByDate(req.params.date);
  if (!scan) {
    return res.status(404).json({ error: 'Kein Scan für dieses Datum gefunden.' });
  }
  res.json({
    status: getScanStatus(),
    historyDates: getHistoryDates(),
    data: scan
  });
});

// Zustandsloser Pass-Through für initiale Intraday-Chartpunkte (vermeidet Browser-CORS, 0 Server-Speicherlast)
app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const symbol = encodeURIComponent(req.params.symbol);
    const range = encodeURIComponent(req.query.range || '1d');
    const interval = encodeURIComponent(req.query.interval || '5m');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// API: Manuellen Neu-Scan anstoßen
app.post('/api/scan/refresh', async (req, res) => {
  const status = getScanStatus();
  if (req.query.wait === 'true') {
    try {
      const result = await runDailyScan({ force: true });
      return res.json({ message: 'Scan abgeschlossen', summary: result?.summary, status: getScanStatus() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (!status.isScanning) {
    runDailyScan({ force: true }).catch(err => {
      console.error('Fehler beim manuellen Scan:', err.message);
    });
  }
  res.json({
    message: 'Scan gestartet',
    status: getScanStatus()
  });
});

// Synchroner Endpunkt für Google Cloud Scheduler (hält Cloud-Run-Instanz während des 30s-Scans aktiv)
app.all('/api/cron/daily-scan', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Cloud Scheduler Tages-Scan gestartet...`);
    const result = await runDailyScan({ force: true });
    res.json({
      ok: true,
      scanDate: result?.scanDate,
      summary: result?.summary
    });
  } catch (err) {
    console.error('Cloud Scheduler Scan-Fehler:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Einmal täglich automatisch um 08:00 Uhr morgens (lokale Rechnerzeit) ausführen
cron.schedule('0 8 * * *', () => {
  console.log(`[${new Date().toISOString()}] Starte geplanten täglichen Buffett-Substanzwert-Scan...`);
  runDailyScan({ force: true }).catch(err => {
    console.error('Geplanter Tages-Scan fehlgeschlagen:', err.message);
  });
});

app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(` Buffett Substanz- & Insolvenzmasse-Scanner läuft lokal auf:`);
  console.log(` -> http://localhost:${PORT}`);
  console.log(` Indizes: DAX 40 (DE) | BIST 30 (TR) | S&P 500 (USA)`);
  console.log(` Automatischer Tages-Scan: Täglich 08:00 Uhr + beim Serverstart`);
  console.log(`================================================================`);

  // Beim Start prüfen, ob für heute bereits Daten vorliegen
  const cached = getCachedScan();
  const todayStr = new Date().toISOString().slice(0, 10);
  if (!cached || cached.scanDate !== todayStr) {
    console.log('Kein Scan für heute (%s) im Cache. Starte Hintergrund-Scan...', todayStr);
    runDailyScan({ force: false }).catch(err => {
      console.error('Initialer Scan-Fehler:', err.message);
    });
  } else {
    console.log(
      'Tages-Scan vom %s geladen (%d analysierte Aktien im Cache).',
      cached.scanDate,
      cached.stocks ? cached.stocks.length : 0
    );
  }
});
