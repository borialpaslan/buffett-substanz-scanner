const fs = require('fs');
const path = require('path');

const SCAN_FILE = path.join(__dirname, '..', 'data', 'latest-scan.json');
const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');

function round2(n) {
  return n != null && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function fetchYahooRaw(symbol, range, interval, hostIdx = 0) {
  const host = hostIdx % 2 === 0 ? 'query1.finance.yahoo.com' : 'query2.finance.yahoo.com';
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.chart?.result?.[0] || null;
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

function extractCompactSeries(result, maxPoints = 1500) {
  if (!result || !Array.isArray(result.timestamp)) return { prevClose: null, candles: [] };
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0] || {};
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const vols = q.volume || [];

  const candles = [];
  const step = ts.length > maxPoints ? Math.ceil(ts.length / maxPoints) : 1;
  for (let i = 0; i < ts.length; i += step) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    candles.push([
      ts[i],
      round2(opens[i] ?? c),
      round2(highs[i] ?? c),
      round2(lows[i] ?? c),
      round2(c),
      Math.round(vols[i] || 0)
    ]);
  }
  // Ensure the very last valid candle is always included
  const lastIdx = ts.length - 1;
  if (lastIdx >= 0 && (lastIdx % step !== 0) && closes[lastIdx] != null && Number.isFinite(closes[lastIdx])) {
    const c = closes[lastIdx];
    candles.push([
      ts[lastIdx],
      round2(opens[lastIdx] ?? c),
      round2(highs[lastIdx] ?? c),
      round2(lows[lastIdx] ?? c),
      round2(c),
      Math.round(vols[lastIdx] || 0)
    ]);
  }

  return {
    prevClose: round2(result.meta?.chartPreviousClose ?? result.meta?.previousClose ?? null),
    candles
  };
}

async function buildAllChartsCache() {
  if (!fs.existsSync(SCAN_FILE)) {
    throw new Error('latest-scan.json nicht gefunden');
  }
  fs.mkdirSync(CHARTS_DIR, { recursive: true });

  const scan = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
  const stocks = scan.stocks || [];
  console.log(`Lade echte Yahoo-Finance-Historie (Intraday + 5 Jahre) für ${stocks.length} Aktien...`);

  let cursor = 0;
  let successCount = 0;
  const concurrency = 32;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, workerId) => {
      while (cursor < stocks.length) {
        const idx = cursor++;
        const s = stocks[idx];
        const sym = s.symbol;
        try {
          const [intradayRes, dailyRes] = await Promise.all([
            fetchYahooRaw(sym, '5d', '15m', idx + workerId),
            fetchYahooRaw(sym, '5y', '1d', idx + workerId + 1)
          ]);

          const intraday = extractCompactSeries(intradayRes, 220);
          const daily = extractCompactSeries(dailyRes, 1300);

          const payload = {
            s: sym,
            pc: intraday.prevClose || daily.prevClose || s.prevClose || s.price,
            i: intraday.candles, // [tSec, o, h, l, c, v] 15m über 5 Handelstage (inkl. 1T Heute)
            d: daily.candles     // [tSec, o, h, l, c, v] 1d über 5 Jahre (für 1M, 6M, YTD, 1J, 5J, MAX)
          };

          const safeFile = path.join(CHARTS_DIR, `c_${sym}.json`);
          fs.writeFileSync(safeFile, JSON.stringify(payload), 'utf8');
          successCount++;
        } catch (err) {
          console.warn(`Warnung bei ${sym}:`, err.message);
        }
      }
    })
  );

  console.log(`Fertig: ${successCount} / ${stocks.length} echte Chart-Dateien in data/charts/ gespeichert.`);
}

if (require.main === module) {
  buildAllChartsCache().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildAllChartsCache };
