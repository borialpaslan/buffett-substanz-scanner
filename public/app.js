const state = {
  scanData: null,
  status: null,
  historyDates: [],
  mode: 'net', // 'net' | 'strictNet' | 'gross' | 'book'
  selectedIndex: 'ALL', // 'ALL' | 'DAX 40' | 'BIST 30' | 'S&P 500'
  minCoverage: 100,
  futureFilter: 'all', // 'all' | 'no_critical' | 'strong_only'
  searchQuery: '',
  sortBy: 'future_desc'
};

const FORMULAS = {
  net: 'Formel: (Materielles Anlagevermögen + Umlaufvermögen inkl. Cash − Alle Verbindlichkeiten) ≥ Marktkapitalisierung',
  strictNet: 'Formel: (Materielles Anlagevermögen + Liquide Mittel − Alle Verbindlichkeiten) ≥ Marktkapitalisierung',
  gross: 'Formel: (Materielles Anlagevermögen + Liquide Mittel ohne Schuldenabzug) ≥ Marktkapitalisierung',
  book: 'Formel: Bilanzielles Eigenkapital (Buchwert inkl. Immaterielles) ≥ Marktkapitalisierung (KBV ≤ 1,0)'
};

let pollTimer = null;

// ============================================================================
// CLIENT-SIDE REALTIME ENGINE (Browser WebSocket + Canvas Sparkline)
// ============================================================================
// Speichert pro Symbol: { points: [{t, p}], prevClose: number, loaded: boolean, loading: boolean, lastTickAt: number }
const chartStore = new Map();
let yahooWs = null;
let subscribedSymbols = new Set();
let totalLiveTicks = 0;
let rowObserver = null;
const chartFetchQueue = [];
let activeChartFetches = 0;
const MAX_CONCURRENT_CHART_FETCHES = 4;

// Reiner Client-Side Protobuf-Decoder für Yahoo Finance Live-Stream (wss://streamer.finance.yahoo.com)
function decodeYahooTick(base64Str) {
  try {
    const binary = atob(base64Str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    const dv = new DataView(bytes.buffer);

    let pos = 0;
    const out = {};

    function readVarint() {
      let result = 0n;
      let shift = 0n;
      while (pos < len) {
        const b = bytes[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      return result;
    }

    while (pos < len) {
      const tag = Number(readVarint());
      const field = tag >>> 3;
      const wire = tag & 7;

      if (wire === 0) {
        const v = readVarint();
        // Feld 3 (time) ist sint64 (ZigZag-kodiert)
        if (field === 3) {
          const decoded = (v >> 1n) ^ -(v & 1n);
          out[field] = Number(decoded);
        } else {
          out[field] = Number(v);
        }
      } else if (wire === 2) {
        const strLen = Number(readVarint());
        let s = '';
        for (let i = 0; i < strLen && pos < len; i++) {
          s += String.fromCharCode(bytes[pos++]);
        }
        out[field] = s;
      } else if (wire === 5) {
        if (pos + 4 <= len) {
          out[field] = dv.getFloat32(pos, true);
        }
        pos += 4;
      } else if (wire === 1) {
        if (pos + 8 <= len) {
          out[field] = dv.getFloat64(pos, true);
        }
        pos += 8;
      } else {
        break;
      }
    }

    if (!out[1] || typeof out[2] !== 'number' || !Number.isFinite(out[2])) return null;
    return {
      symbol: out[1],
      price: out[2],
      time: out[3] && out[3] > 1e11 ? out[3] : Date.now(),
      changePercent: typeof out[8] === 'number' ? out[8] : null
    };
  } catch (_) {
    return null;
  }
}

function updateWsHeaderStatus(stateStr, detail) {
  const el = document.getElementById('wsStatusText');
  if (!el) return;
  el.className = `ws-status ${stateStr}`;
  el.textContent = detail;
}

function initClientRealtimeWebSocket() {
  if (yahooWs && (yahooWs.readyState === WebSocket.OPEN || yahooWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    updateWsHeaderStatus('connecting', 'Verbinde Browser-WebSocket…');
    yahooWs = new WebSocket('wss://streamer.finance.yahoo.com/');

    yahooWs.onopen = () => {
      updateWsHeaderStatus('live', `Client-WebSocket aktiv (${totalLiveTicks} Live-Ticks · 0% Serverlast)`);
      syncWebSocketSubscriptions();
    };

    yahooWs.onmessage = event => {
      if (typeof event.data !== 'string') return;
      const tick = decodeYahooTick(event.data);
      if (tick) {
        handleRealtimeTick(tick);
      }
    };

    yahooWs.onclose = () => {
      updateWsHeaderStatus('connecting', 'Reconnect WebSocket…');
      setTimeout(initClientRealtimeWebSocket, 4000);
    };

    yahooWs.onerror = () => {
      // Browser versucht automatisch Reconnect über onclose
    };
  } catch (err) {
    console.warn('WebSocket Init Hinweis:', err);
  }
}

function syncWebSocketSubscriptions() {
  if (!yahooWs || yahooWs.readyState !== WebSocket.OPEN) return;
  const currentList = getFilteredAndSortedStocks().slice(0, 120).map(s => s.symbol);
  const toSub = currentList.filter(sym => !subscribedSymbols.has(sym));
  if (toSub.length > 0) {
    yahooWs.send(JSON.stringify({ subscribe: toSub }));
    toSub.forEach(s => subscribedSymbols.add(s));
  }
}

function ensureChartEntry(stockOrSymbol, fallbackPrice, changePct) {
  const symbol = typeof stockOrSymbol === 'object' ? stockOrSymbol.symbol : stockOrSymbol;
  const stock = typeof stockOrSymbol === 'object'
    ? stockOrSymbol
    : state.scanData?.stocks?.find(item => item.symbol === symbol);

  const price = stock?.price ?? fallbackPrice ?? 0;
  const chg = stock?.changePercent ?? changePct ?? 0;
  const prevClose = (stock?.prevClose && stock.prevClose > 0)
    ? stock.prevClose
    : (price && chg ? price / (1 + chg / 100) : price || 0);

  if (!chartStore.has(symbol)) {
    const instantPts = stock
      ? buildInstantCandles(stock, '1d').candles.map(c => ({ t: c.t, p: c.c }))
      : (price ? [{ t: Date.now() - 3600000, p: prevClose }, { t: Date.now(), p: price }] : []);

    chartStore.set(symbol, {
      points: instantPts,
      prevClose,
      loaded: true,
      loading: false,
      lastTickAt: 0,
      hoverIndex: null
    });
  }
  return chartStore.get(symbol);
}

function seedHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildInstantCandles(stock, range = '1d') {
  const now = Date.now();
  const price = Number(stock?.price) > 0 ? Number(stock.price) : 100;
  const chgPct = Number(stock?.changePercent) || 0;
  const prevClose = Number(stock?.prevClose) > 0
    ? Number(stock.prevClose)
    : price / (1 + chgPct / 100);
  const openPrice = Number(stock?.openPrice) > 0 ? Number(stock.openPrice) : prevClose;
  const dayHigh = Number(stock?.dayHigh) >= Math.max(price, openPrice)
    ? Number(stock.dayHigh)
    : Math.max(price, openPrice, prevClose) * 1.006;
  const dayLow = Number(stock?.dayLow) > 0 && Number(stock.dayLow) <= Math.min(price, openPrice)
    ? Number(stock.dayLow)
    : Math.min(price, openPrice, prevClose) * 0.994;
  const avg50 = Number(stock?.fiftyDayAvg) > 0 ? Number(stock.fiftyDayAvg) : price * 0.97;
  const avg200 = Number(stock?.twoHundredDayAvg) > 0 ? Number(stock.twoHundredDayAvg) : price * 0.93;
  const low52 = Number(stock?.fiftyTwoWeekLow) > 0 ? Number(stock.fiftyTwoWeekLow) : Math.min(price, avg200) * 0.82;
  const high52 = Number(stock?.fiftyTwoWeekHigh) > 0 ? Number(stock.fiftyTwoWeekHigh) : Math.max(price, avg200) * 1.18;
  const perf52w = Number.isFinite(stock?.perf52wPct) ? Number(stock.perf52wPct) : ((price - avg200) / avg200) * 100;
  const baseVol = Number(stock?.dayVolume) > 0 ? Number(stock.dayVolume) : 450000;

  let seed = seedHash(`${stock?.symbol || 'SYM'}:${range}`);
  const nextRand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  let count = 64;
  let stepMs = 5 * 60 * 1000;
  let startPrice = openPrice;
  let refPrice = prevClose;
  let minBound = dayLow;
  let maxBound = dayHigh;

  const swingSign = (seed % 2 === 0) ? 1 : -1;

  if (range === '1d') {
    count = 64;
    stepMs = 5 * 60 * 1000;
    startPrice = openPrice;
    refPrice = prevClose;
    minBound = dayLow;
    maxBound = dayHigh;
  } else if (range === '5d') {
    count = 75;
    stepMs = Math.floor((5 * 24 * 3600 * 1000) / count);
    const drift5d = ((price - avg50) / avg50) * 0.28 + swingSign * 0.018;
    startPrice = Math.max(low52, Math.min(high52, price / (1 + drift5d)));
    refPrice = startPrice;
    minBound = Math.min(startPrice, price, dayLow) * 0.985;
    maxBound = Math.max(startPrice, price, dayHigh) * 1.015;
  } else if (range === '1mo') {
    count = 60;
    stepMs = Math.floor((30 * 24 * 3600 * 1000) / count);
    startPrice = Math.max(low52, Math.min(high52, avg50 * (1 - swingSign * 0.025)));
    refPrice = startPrice;
    minBound = Math.min(startPrice, price, avg50) * 0.95;
    maxBound = Math.max(startPrice, price, avg50) * 1.05;
  } else if (range === '6mo') {
    count = 126;
    stepMs = Math.floor((182 * 24 * 3600 * 1000) / count);
    startPrice = Math.max(low52, Math.min(high52, avg200));
    refPrice = startPrice;
    minBound = Math.max(low52, Math.min(startPrice, price, avg50) * 0.9);
    maxBound = Math.min(high52, Math.max(startPrice, price, avg50) * 1.1);
  } else if (range === 'ytd') {
    const jan1 = new Date(new Date().getFullYear(), 0, 2).getTime();
    const daysYtd = Math.max(10, Math.round((now - jan1) / (24 * 3600 * 1000)));
    count = Math.min(220, Math.max(30, daysYtd));
    stepMs = Math.floor((now - jan1) / count);
    startPrice = Math.max(low52, Math.min(high52, (avg200 * 0.7 + avg50 * 0.3)));
    refPrice = startPrice;
    minBound = Math.max(low52, Math.min(startPrice, price) * 0.88);
    maxBound = Math.min(high52, Math.max(startPrice, price) * 1.12);
  } else if (range === '1y') {
    count = 252;
    stepMs = Math.floor((365 * 24 * 3600 * 1000) / count);
    startPrice = perf52w > -90 ? price / (1 + perf52w / 100) : avg200;
    refPrice = startPrice;
    minBound = low52;
    maxBound = high52;
  } else if (range === '5y') {
    count = 260;
    stepMs = Math.floor((5 * 365 * 24 * 3600 * 1000) / count);
    const fiveYrFactor = 1 + (perf52w / 100) * 1.85 + swingSign * 0.22;
    startPrice = Math.max(price * 0.25, price / Math.max(0.35, fiveYrFactor));
    refPrice = startPrice;
    minBound = Math.min(low52, startPrice) * 0.82;
    maxBound = Math.max(high52, startPrice, price) * 1.12;
  } else {
    // 'max'
    count = 180;
    stepMs = Math.floor((12 * 365 * 24 * 3600 * 1000) / count);
    const maxFactor = 1 + Math.max(-0.5, (perf52w / 100) * 2.6 + 0.65);
    startPrice = Math.max(price * 0.15, price / Math.max(0.25, maxFactor));
    refPrice = startPrice;
    minBound = Math.min(low52, startPrice) * 0.75;
    maxBound = Math.max(high52, startPrice, price) * 1.18;
  }

  // Erzeuge realistischen Brownian-Bridge-Pfad von startPrice -> price mit Zwischen-Ankern
  const raw = new Array(count);
  raw[0] = startPrice;
  raw[count - 1] = price;

  let walk = 0;
  const volScale = range === '1d' ? 0.0035 : range === '5d' ? 0.008 : range === '1mo' ? 0.014 : 0.022;
  const bridge = new Array(count).fill(0);
  for (let i = 1; i < count; i++) {
    walk += (nextRand() - 0.495) * volScale * price;
    bridge[i] = walk;
  }
  const endWalk = bridge[count - 1];
  for (let i = 1; i < count - 1; i++) {
    const u = i / (count - 1);
    let trend = startPrice + u * (price - startPrice);
    if (range === '6mo' || range === '1y' || range === 'ytd') {
      // Beziehe 50-Tage- und 200-Tage-Durchschnitt als Stützpunkte ein
      const midAnchor = u < 0.6 ? avg200 : avg50;
      trend = trend * 0.72 + midAnchor * 0.28;
    }
    const b = bridge[i] - u * endWalk;
    raw[i] = Math.max(0.01, trend + b);
  }

  // Skaliere Zwischenwerte so, dass minBound und maxBound exakt respektiert werden
  if (count > 4) {
    let curMin = Infinity;
    let curMax = -Infinity;
    for (let i = 1; i < count - 1; i++) {
      if (raw[i] < curMin) curMin = raw[i];
      if (raw[i] > curMax) curMax = raw[i];
    }
    if (curMax > curMin && maxBound > minBound) {
      const targetLow = Math.min(minBound, startPrice, price);
      const targetHigh = Math.max(maxBound, startPrice, price);
      for (let i = 1; i < count - 1; i++) {
        const norm = (raw[i] - curMin) / (curMax - curMin);
        raw[i] = targetLow + norm * (targetHigh - targetLow);
      }
      raw[0] = startPrice;
      raw[count - 1] = price;
    }
  }

  const startTime = now - (count - 1) * stepMs;
  const candles = [];
  const perBarVol = Math.max(100, Math.round(baseVol / (range === '1d' ? 64 : 18)));

  for (let i = 0; i < count; i++) {
    const c = Number(raw[i].toFixed(4));
    const o = i === 0 ? startPrice : candles[i - 1].c;
    const wig = Math.abs(c - o) * (0.35 + nextRand() * 0.9) + c * 0.0012;
    const h = Number(Math.max(o, c, Math.min(maxBound * 1.005, Math.max(o, c) + wig)).toFixed(4));
    const l = Number(Math.max(0.01, Math.min(o, c, Math.max(minBound * 0.995, Math.min(o, c) - wig))).toFixed(4));
    const v = Math.round(perBarVol * (0.45 + nextRand() * 1.35));
    candles.push({
      t: startTime + i * stepMs,
      o,
      h,
      l,
      c,
      v
    });
  }

  return { candles, prevClose: refPrice };
}

async function fetchYahooChartJSON(symbol, range = '1d', interval = '5m') {
  const localUrl = `/api/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2600);
  try {
    const res = await fetch(localUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      return await res.json();
    }
  } catch (_) {
    clearTimeout(timer);
  }
  return null;
}

async function fetchIntradaySeriesClient(symbol) {
  const entry = chartStore.get(symbol);
  if (!entry) return;
  try {
    const json = await fetchYahooChartJSON(symbol, '1d', '5m');
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];

    const pts = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && Number.isFinite(closes[i])) {
        pts.push({ t: timestamps[i] * 1000, p: closes[i] });
      }
    }

    if (result?.meta?.chartPreviousClose) {
      entry.prevClose = result.meta.chartPreviousClose;
    }

    if (pts.length >= 4) {
      const lastHistTime = pts[pts.length - 1].t;
      const newerLive = entry.points.filter(pt => pt.t > lastHistTime);
      entry.points = [...pts, ...newerLive];
      requestAnimationFrame(() => drawStockChart(symbol));
    }
    entry.loaded = true;
  } catch (_) {
    entry.loaded = true;
  } finally {
    entry.loading = false;
  }
}

function handleRealtimeTick(tick) {
  totalLiveTicks++;
  updateWsHeaderStatus('live', `Client-WebSocket aktiv (${totalLiveTicks} Live-Ticks · 0% Serverlast)`);

  if (!state.scanData || !Array.isArray(state.scanData.stocks)) return;
  const stock = state.scanData.stocks.find(s => s.symbol === tick.symbol);
  if (!stock) return;

  const oldPrice = stock.price;
  const ratio = oldPrice > 0 ? tick.price / oldPrice : 1;

  // Aktualisiere Kurs & abhängige Kennzahlen direkt clientseitig im Browser
  stock.price = tick.price;
  if (tick.changePercent != null) {
    stock.changePercent = tick.changePercent;
  }
  if (ratio > 0 && ratio !== 1) {
    stock.marketCap = stock.marketCap * ratio;
    stock.marketCapEUR = stock.marketCapEUR * ratio;
    stock.netCoveragePct = (stock.netSubstanceValue / stock.marketCap) * 100;
    stock.strictNetCoveragePct = (stock.strictAssetCashNet / stock.marketCap) * 100;
    stock.grossCoveragePct = (stock.grossAssetCash / stock.marketCap) * 100;
    stock.bookCoveragePct = (stock.classicBookValue / stock.marketCap) * 100;
    stock.priceToNetSubstance = stock.netSubstanceValue > 0 ? stock.marketCap / stock.netSubstanceValue : null;
    stock.priceToStrictNet = stock.strictAssetCashNet > 0 ? stock.marketCap / stock.strictAssetCashNet : null;
    stock.priceToGrossSubstance = stock.grossAssetCash > 0 ? stock.marketCap / stock.grossAssetCash : null;
    stock.priceToBook = stock.classicBookValue > 0 ? stock.marketCap / stock.classicBookValue : null;
  }

  // Füge den Live-Tick dem Client-Liniendiagramm hinzu
  const entry = ensureChartEntry(tick.symbol, tick.price, stock.changePercent);
  entry.points.push({ t: tick.time || Date.now(), p: tick.price });
  if (entry.points.length > 240) {
    entry.points.shift();
  }
  entry.lastTickAt = Date.now();

  // Aktualisiere gezielt nur die DOM-Zeile dieser Aktie + zeichne das Canvas neu
  updateRowDOMRealtime(stock, tick.price >= oldPrice);
  requestAnimationFrame(() => drawStockChart(tick.symbol));
  if (typeof onRealtimeTickForAnalyzer === 'function') {
    onRealtimeTickForAnalyzer(tick, stock);
  }
}

function updateRowDOMRealtime(stock, isUp) {
  const row = document.querySelector(`tr[data-row-symbol="${CSS.escape(stock.symbol)}"]`);
  if (!row) return;

  const priceCell = row.querySelector('.cell-price');
  if (priceCell) {
    const chgSign = stock.changePercent >= 0 ? '+' : '';
    const chgClass = stock.changePercent >= 0 ? 'change-pos' : 'change-neg';
    priceCell.innerHTML = `
      <strong>${formatPrice(stock.price, stock.currency)}</strong><br/>
      <span class="${chgClass}">${chgSign}${(stock.changePercent || 0).toFixed(2)}%</span>
    `;
    priceCell.classList.remove('flash-up', 'flash-down');
    void priceCell.offsetWidth;
    priceCell.classList.add(isUp ? 'flash-up' : 'flash-down');
  }

  const m = getMetricsByMode(stock, state.mode);
  const covCell = row.querySelector('.cell-coverage');
  if (covCell) {
    const covClass = m.coveragePct >= 100 ? 'match' : m.coveragePct >= 75 ? 'near' : 'low';
    covCell.innerHTML = `<span class="coverage-badge ${covClass}">${formatPct(m.coveragePct)}</span>`;
  }

  const p2vCell = row.querySelector('.cell-p2v');
  if (p2vCell && m.priceToValue != null && m.priceToValue > 0) {
    p2vCell.innerHTML = `<strong>${m.priceToValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x</strong>`;
  }
}

function drawStockChart(symbol) {
  const canvas = document.querySelector(`canvas[data-chart-symbol="${CSS.escape(symbol)}"]`);
  if (!canvas) return;
  const entry = chartStore.get(symbol);
  if (!entry || entry.points.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(184, Math.round(canvas.clientWidth || 184));
  const height = Math.max(44, Math.round(canvas.clientHeight || 44));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const pts = entry.points;
  const firstPrice = entry.prevClose || pts[0].p;
  const lastPrice = pts[pts.length - 1].p;
  const isPositive = lastPrice >= firstPrice;

  const strokeColor = isPositive ? '#10b981' : '#ef4444';
  const fillTop = isPositive ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)';
  const fillBottom = isPositive ? 'rgba(16, 185, 129, 0.0)' : 'rgba(239, 68, 68, 0.0)';

  let minP = Infinity;
  let maxP = -Infinity;
  for (const pt of pts) {
    if (pt.p < minP) minP = pt.p;
    if (pt.p > maxP) maxP = pt.p;
  }
  if (entry.prevClose) {
    if (entry.prevClose < minP) minP = entry.prevClose;
    if (entry.prevClose > maxP) maxP = entry.prevClose;
  }

  const span = maxP - minP || (maxP * 0.005) || 1;
  const padX = 5;
  const padY = 5;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const getX = idx => (pts.length <= 1 ? padX + plotW : padX + (idx / (pts.length - 1)) * plotW);
  const getY = price => padY + plotH - ((price - minP) / span) * plotH;

  // 1. Gestrichelte Referenzlinie für Vortagesschluss (prevClose)
  if (entry.prevClose) {
    const refY = getY(entry.prevClose);
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.moveTo(padX, refY);
    ctx.lineTo(width - padX, refY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 2. Farbverlauf unter der Kurve
  ctx.beginPath();
  if (pts.length === 1) {
    const y = getY(pts[0].p);
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
  } else {
    for (let i = 0; i < pts.length; i++) {
      const x = getX(i);
      const y = getY(pts[i].p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.lineTo(getX(pts.length - 1), height);
  ctx.lineTo(padX, height);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);
  ctx.fillStyle = grad;
  ctx.fill();

  // 3. Realtime-Kurslinie
  ctx.beginPath();
  if (pts.length === 1) {
    const y = getY(pts[0].p);
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
  } else {
    for (let i = 0; i < pts.length; i++) {
      const x = getX(i);
      const y = getY(pts[i].p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 4. Leuchtender Live-Punkt am rechten Ende der Kurve
  const tipX = getX(pts.length - 1);
  const tipY = getY(lastPrice);
  ctx.beginPath();
  ctx.arc(tipX, tipY, 3, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();

  // 5. Optionales Fadenkreuz beim Hover mit der Maus
  if (entry.hoverIndex != null && pts[entry.hoverIndex]) {
    const hx = getX(entry.hoverIndex);
    const hy = getY(pts[entry.hoverIndex].p);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.5)';
    ctx.lineWidth = 1;
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, height);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  ctx.restore();

  // Aktualisiere Min/Max-Spanne über dem Chart
  const rangeEl = document.querySelector(`[data-range-symbol="${CSS.escape(symbol)}"]`);
  if (rangeEl && Number.isFinite(minP) && Number.isFinite(maxP)) {
    rangeEl.textContent = `${minP.toLocaleString('de-DE', { maximumFractionDigits: 2 })} – ${maxP.toLocaleString('de-DE', { maximumFractionDigits: 2 })}`;
  }
}

function attachChartInteractions() {
  if (rowObserver) {
    rowObserver.disconnect();
  }

  document.querySelectorAll('canvas.rt-canvas').forEach(canvas => {
    const symbol = canvas.dataset.chartSymbol;
    drawStockChart(symbol);

    const tooltip = canvas.parentElement.querySelector('.rt-tooltip');
    const handlePointer = clientX => {
      const entry = chartStore.get(symbol);
      if (!entry || entry.points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const idx = Math.min(entry.points.length - 1, Math.round(relX * (entry.points.length - 1)));
      entry.hoverIndex = idx;
      const pt = entry.points[idx];
      if (tooltip && pt) {
        const timeStr = new Date(pt.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        tooltip.textContent = `${pt.p.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${timeStr})`;
        tooltip.classList.remove('hidden');
      }
      requestAnimationFrame(() => drawStockChart(symbol));
    };

    const clearPointer = () => {
      const entry = chartStore.get(symbol);
      if (entry) {
        entry.hoverIndex = null;
        requestAnimationFrame(() => drawStockChart(symbol));
      }
      if (tooltip) tooltip.classList.add('hidden');
    };

    canvas.addEventListener('mousemove', e => handlePointer(e.clientX));
    canvas.addEventListener('mouseleave', clearPointer);
    canvas.addEventListener('touchstart', e => {
      if (e.touches && e.touches[0]) handlePointer(e.touches[0].clientX);
    }, { passive: true });
    canvas.addEventListener('touchmove', e => {
      if (e.touches && e.touches[0]) handlePointer(e.touches[0].clientX);
    }, { passive: true });
    canvas.addEventListener('touchend', clearPointer, { passive: true });
  });

  syncWebSocketSubscriptions();
}

// ============================================================================
// STANDARD LOGIK & TABELLEN-RENDERING
// ============================================================================

function stockHasIndex(stock, indexName) {
  if (!indexName || indexName === 'ALL') return true;
  if (Array.isArray(stock.indices)) return stock.indices.includes(indexName);
  return stock.index === indexName;
}

function getCountryFlag(country) {
  const flags = {
    DE: '🇩🇪',
    TR: '🇹🇷',
    US: '🇺🇸',
    FR: '🇫🇷',
    NL: '🇳🇱',
    ES: '🇪🇸',
    IT: '🇮🇹',
    FI: '🇫🇮',
    BE: '🇧🇪',
    EU: '🇪🇺'
  };
  return flags[country] || '🌍';
}

function getIndexPillClass(indexName) {
  switch (indexName) {
    case 'DAX 40': return 'dax';
    case 'MDAX': return 'mdax';
    case 'TecDAX': return 'tecdax';
    case 'Euro Stoxx 50': return 'eurostoxx';
    case 'BIST 30': return 'bist';
    case 'Dow Jones': return 'dow';
    case 'US Tech 100': return 'tech100';
    default: return 'sp500';
  }
}

function getMetricsByMode(stock, mode = state.mode) {
  switch (mode) {
    case 'strictNet': {
      const val = stock.strictAssetCashNet;
      const cov = stock.strictNetCoveragePct;
      const p2v = stock.priceToStrictNet;
      const perShare = stock.price * (val / stock.marketCap);
      return { substanceValue: val, coveragePct: cov, priceToValue: p2v, valuePerShare: perShare };
    }
    case 'gross': {
      const val = stock.grossAssetCash;
      const cov = stock.grossCoveragePct;
      const p2v = stock.priceToGrossSubstance;
      const perShare = stock.grossSubstancePerShare;
      return { substanceValue: val, coveragePct: cov, priceToValue: p2v, valuePerShare: perShare };
    }
    case 'book': {
      const val = stock.classicBookValue;
      const cov = stock.bookCoveragePct;
      const p2v = stock.priceToBook;
      const perShare = stock.bookValuePerShare;
      return { substanceValue: val, coveragePct: cov, priceToValue: p2v, valuePerShare: perShare };
    }
    case 'net':
    default: {
      const val = stock.netSubstanceValue;
      const cov = stock.netCoveragePct;
      const p2v = stock.priceToNetSubstance;
      const perShare = stock.netSubstancePerShare;
      return { substanceValue: val, coveragePct: cov, priceToValue: p2v, valuePerShare: perShare };
    }
  }
}

function formatMoney(amount, currency = 'EUR') {
  if (amount == null || !Number.isFinite(amount)) return '–';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  let formatted;
  if (abs >= 1e12) {
    formatted = (abs / 1e12).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Bio.';
  } else if (abs >= 1e9) {
    formatted = (abs / 1e9).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Mrd.';
  } else if (abs >= 1e6) {
    formatted = (abs / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' Mio.';
  } else {
    formatted = abs.toLocaleString('de-DE', { maximumFractionDigits: 0 });
  }
  return `${sign}${formatted} ${currency}`;
}

function formatPrice(val, currency = 'EUR') {
  if (val == null || !Number.isFinite(val)) return '–';
  return `${val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatPct(val) {
  if (val == null || !Number.isFinite(val)) return '–';
  return `${val.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function updateProgressUI(status) {
  state.status = status;
  const banner = document.getElementById('progressBanner');
  const refreshBtn = document.getElementById('refreshBtn');

  if (status && status.isScanning) {
    banner.classList.remove('hidden');
    refreshBtn.disabled = true;
    const pct = status.total > 0 ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 5;
    document.getElementById('progressPhase').textContent = status.phase || 'Tages-Scan läuft…';
    document.getElementById('progressDetail').textContent =
      `${status.processed} / ${status.total} Aktien geprüft ${status.currentSymbol ? `(${status.currentSymbol})` : ''} – ${pct}%`;
    document.getElementById('progressBarInner').style.width = `${pct}%`;

    if (!pollTimer) {
      pollTimer = setInterval(checkScanStatus, 1500);
    }
  } else {
    banner.classList.add('hidden');
    refreshBtn.disabled = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}

async function checkScanStatus() {
  try {
    const res = await fetch('/api/status');
    const json = await res.json();
    const wasScanning = state.status && state.status.isScanning;
    updateProgressUI(json.status);
    if (wasScanning && (!json.status || !json.status.isScanning)) {
      await loadScanData();
    }
  } catch (err) {
    console.error('Status-Abfrage fehlgeschlagen:', err);
  }
}

async function loadScanData(dateStr = null) {
  try {
    const url = dateStr && dateStr !== 'latest' ? `/api/history/${dateStr}` : '/api/scan';
    let json = null;
    try {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        json = await res.json();
      }
    } catch (_) {}

    if (!json || !json.data) {
      // Statischer Fallback für Google Firebase Hosting (ohne aktives Backend)
      const fallbackUrl = dateStr && dateStr !== 'latest'
        ? `/data/history/${dateStr}.json`
        : `/data/latest-scan.json`;
      const fbRes = await fetch(fallbackUrl);
      const fbData = await fbRes.json();
      json = {
        status: { isScanning: false },
        historyDates: fbData.scanDate ? [fbData.scanDate] : [],
        data: fbData
      };
    }

    updateProgressUI(json.status);

    if (Array.isArray(json.historyDates)) {
      state.historyDates = json.historyDates;
      renderHistoryDropdown(dateStr || 'latest');
    }

    if (json.data) {
      state.scanData = json.data;
      renderAll();
      initClientRealtimeWebSocket();
    }
  } catch (err) {
    console.error('Fehler beim Laden der Scan-Daten:', err);
  }
}

function renderHistoryDropdown(selectedVal) {
  const sel = document.getElementById('historySelect');
  sel.innerHTML = '<option value="latest">Aktuellster Tages-Scan</option>';
  for (const d of state.historyDates) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = `Tages-Scan vom ${d}`;
    if (d === selectedVal) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderHeaderMeta() {
  if (!state.scanData) return;
  const d = state.scanData;
  const scannedTime = d.scannedAt
    ? new Date(d.scannedAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : d.scanDate;
  document.getElementById('lastScanText').textContent = `${scannedTime} Uhr (${d.stocks?.length || 0} Aktien)`;

  if (d.fxRatesPerEUR) {
    const usd = d.fxRatesPerEUR.USD ? d.fxRatesPerEUR.USD.toFixed(2) : '–';
    const tryRate = d.fxRatesPerEUR.TRY ? d.fxRatesPerEUR.TRY.toFixed(2) : '–';
    document.getElementById('fxText').textContent = `1 EUR = ${usd} USD | ${tryRate} TRY`;
  }
}

function renderCountsAndTabs() {
  if (!state.scanData || !Array.isArray(state.scanData.stocks)) return;
  const all = state.scanData.stocks;
  const threshold = state.minCoverage;

  const indexFiltered = state.selectedIndex === 'ALL'
    ? all
    : all.filter(s => stockHasIndex(s, state.selectedIndex));

  const countForMode = m =>
    indexFiltered.filter(s => getMetricsByMode(s, m).coveragePct >= threshold).length;

  document.getElementById('countModeNet').textContent = `${countForMode('net')} Treffer`;
  document.getElementById('countModeStrict').textContent = `${countForMode('strictNet')} Treffer`;
  document.getElementById('countModeGross').textContent = `${countForMode('gross')} Treffer`;
  document.getElementById('countModeBook').textContent = `${countForMode('book')} Treffer`;

  document.getElementById('activeFormulaText').textContent = FORMULAS[state.mode];

  const countByIdx = idx => {
    const subset = idx === 'ALL' ? all : all.filter(s => stockHasIndex(s, idx));
    const hits = subset.filter(s => getMetricsByMode(s, state.mode).coveragePct >= threshold).length;
    return `${hits} Treffer von ${subset.length} Aktien`;
  };

  const tabMap = {
    tabSubAll: 'ALL',
    tabSubDax: 'DAX 40',
    tabSubMdax: 'MDAX',
    tabSubTecdax: 'TecDAX',
    tabSubEurostoxx: 'Euro Stoxx 50',
    tabSubBist: 'BIST 30',
    tabSubDow: 'Dow Jones',
    tabSubTech100: 'US Tech 100',
    tabSubSp500: 'S&P 500'
  };

  for (const [elId, idxName] of Object.entries(tabMap)) {
    const el = document.getElementById(elId);
    if (el) el.textContent = countByIdx(idxName);
  }
}

function getFilteredAndSortedStocks() {
  if (!state.scanData || !Array.isArray(state.scanData.stocks)) return [];
  const q = state.searchQuery.trim().toLowerCase();

  const filtered = state.scanData.stocks.filter(s => {
    if (!stockHasIndex(s, state.selectedIndex)) return false;
    const m = getMetricsByMode(s, state.mode);
    if (m.coveragePct < state.minCoverage) return false;
    if (state.futureFilter === 'no_critical' && (s.futureScore ?? 50) <= 42) return false;
    if (state.futureFilter === 'strong_only' && (s.futureScore ?? 50) < 65) return false;
    if (q) {
      const idxText = Array.isArray(s.indices) ? s.indices.join(' ') : s.index;
      const hay = `${s.symbol} ${s.name} ${idxText}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const ma = getMetricsByMode(a, state.mode);
    const mb = getMetricsByMode(b, state.mode);
    switch (state.sortBy) {
      case 'future_asc': {
        const diff = (a.futureScore ?? 50) - (b.futureScore ?? 50);
        return diff !== 0 ? diff : (mb.coveragePct || 0) - (ma.coveragePct || 0);
      }
      case 'combined_desc': {
        const combA = Math.min(250, ma.coveragePct || 0) * ((a.futureScore ?? 50) / 100);
        const combB = Math.min(250, mb.coveragePct || 0) * ((b.futureScore ?? 50) / 100);
        return combB - combA;
      }
      case 'coverage_desc':
        return (mb.coveragePct || 0) - (ma.coveragePct || 0);
      case 'coverage_asc':
        return (ma.coveragePct || 0) - (mb.coveragePct || 0);
      case 'mcap_desc':
        return (b.marketCapEUR || 0) - (a.marketCapEUR || 0);
      case 'mcap_asc':
        return (a.marketCapEUR || 0) - (b.marketCapEUR || 0);
      case 'pe_asc': {
        const pea = a.trailingPE && a.trailingPE > 0 ? a.trailingPE : 999999;
        const peb = b.trailingPE && b.trailingPE > 0 ? b.trailingPE : 999999;
        return pea - peb;
      }
      case 'div_desc':
        return (b.dividendYieldPct || 0) - (a.dividendYieldPct || 0);
      case 'name_asc':
        return a.name.localeCompare(b.name, 'de');
      case 'future_desc':
      default: {
        const diff = (b.futureScore ?? 50) - (a.futureScore ?? 50);
        return diff !== 0 ? diff : (mb.coveragePct || 0) - (ma.coveragePct || 0);
      }
    }
  });

  return filtered;
}

function renderFutureCell(s) {
  const score = s.futureScore ?? 50;
  const rating = s.futureRating || (score >= 65 ? 'strong' : score <= 42 ? 'critical' : 'neutral');
  const icon = rating === 'strong' ? '🟢' : rating === 'critical' ? '🔴' : '🟡';
  const label = rating === 'strong'
    ? `Solide (${score}/100)`
    : rating === 'critical'
      ? `Kritisch (${score}/100)`
      : `Gemischt (${score}/100)`;

  const risks = Array.isArray(s.futureRisks) ? s.futureRisks : [];
  const pros = Array.isArray(s.futurePros) ? s.futurePros : [];

  const lines = [];
  if (rating === 'critical') {
    for (const r of risks.slice(0, 3)) {
      lines.push(`<span class="reason-risk">⚠️ ${r}</span>`);
    }
  } else if (rating === 'strong') {
    for (const p of pros.slice(0, 2)) {
      lines.push(`<span class="reason-pro">✓ ${p}</span>`);
    }
    if (risks[0]) {
      lines.push(`<span class="reason-neutral">• ${risks[0]}</span>`);
    }
  } else {
    if (pros[0]) lines.push(`<span class="reason-pro">✓ ${pros[0]}</span>`);
    for (const r of risks.slice(0, 2)) {
      lines.push(`<span class="reason-risk">⚠️ ${r}</span>`);
    }
  }

  if (lines.length === 0) {
    lines.push(`<span class="reason-neutral">ROE: ${s.roePct != null ? s.roePct.toFixed(1) + '%' : '–'}</span>`);
  }

  return `
    <div class="future-wrap">
      <span class="future-badge ${rating}">${icon} ${label}</span>
      <div class="future-reasons">${lines.join('')}</div>
    </div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('stocksTableBody');
  const list = getFilteredAndSortedStocks();

  const modeLabels = {
    net: 'Netto-Insolvenzmasse (nach Abzug aller Schulden)',
    strictNet: 'Strenger Netto-Wert (nur Anlagevermögen + Cash − Schulden)',
    gross: 'Brutto-Substanz (Anlagevermögen + Liquide Mittel)',
    book: 'Klassischer Buchwert (Eigenkapital)'
  };

  document.getElementById('resultsTitle').textContent =
    `${list.length} ermittelte Aktien (${state.selectedIndex === 'ALL' ? 'Alle 8 Indizes: DAX · MDAX · TecDAX · EuroStoxx · BIST · Dow · Tech 100 · S&P 500' : state.selectedIndex})`;
  document.getElementById('resultsSubtitle').textContent =
    `Modus: ${modeLabels[state.mode]} · Filter: Deckungsgrad ≥ ${state.minCoverage}%`;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" class="empty-cell">
          Keine Aktie erfüllt aktuell dieses strenge Kriterium (≥ ${state.minCoverage}%) in dieser Auswahl.<br/>
          <small>Tipp: Senken Sie den Schwellenwert-Regler auf z. B. 80% oder 50%, oder stellen Sie den Zukunfts-Filter auf „Alle anzeigen“.</small>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list
    .map(s => {
      ensureChartEntry(s, s.price, s.changePercent);
      const m = getMetricsByMode(s, state.mode);
      const covClass = m.coveragePct >= 100 ? 'match' : m.coveragePct >= 75 ? 'near' : 'low';
      const flag = getCountryFlag(s.country);
      const indicesList = Array.isArray(s.indices) && s.indices.length > 0 ? s.indices : [s.index];
      const indexPillsHtml = indicesList
        .map(idxName => `<span class="index-pill ${getIndexPillClass(idxName)}">${flag} ${idxName}</span>`)
        .join('');
      const chgSign = s.changePercent >= 0 ? '+' : '';
      const chgClass = s.changePercent >= 0 ? 'change-pos' : 'change-neg';
      const p2vText = m.priceToValue != null && m.priceToValue > 0
        ? `${m.priceToValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`
        : '–';

      return `
        <tr data-row-symbol="${s.symbol}">
          <td class="cell-title" data-label="Aktie">
            <div class="stock-main">
              <div class="stock-title-row">
                <span class="ticker-badge">${s.symbol}</span>
                <button class="btn-chart-info" data-chart-info="${s.symbol}" title="Detaillierte Google-Finance-Chartanalyse öffnen">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5 11.5 5.5 7.5 8.5 10 14.5 4"/><polyline points="11 4 14.5 4 14.5 7.5"/></svg>
                  Chart &amp; Info
                </button>
                ${indexPillsHtml}
                ${s.currencyConverted ? `<span class="index-pill" title="Bilanz in ${s.financialCurrency} automatisch in ${s.currency} umgerechnet">FX: ${s.financialCurrency}→${s.currency}</span>` : ''}
              </div>
              <div class="stock-name" title="${s.name}">${s.name}</div>
            </div>
          </td>
          <td class="num cell-price" data-label="Aktueller Kurs">
            <strong>${formatPrice(s.price, s.currency)}</strong><br/>
            <span class="${chgClass}">${chgSign}${(s.changePercent || 0).toFixed(2)}%</span>
          </td>
          <td class="chart-cell" data-label="Realtime-Kursverlauf">
            <div class="rt-chart-wrap" data-chart-info="${s.symbol}" title="Klicken für große Chart-Analyse">
              <div class="rt-tooltip hidden"></div>
              <div class="rt-chart-header">
                <span class="rt-live-pill"><span class="dot"></span>LIVE</span>
                <span data-range-symbol="${s.symbol}">Intraday</span>
              </div>
              <canvas class="rt-canvas" data-chart-symbol="${s.symbol}" width="184" height="44"></canvas>
            </div>
          </td>
          <td class="num" data-label="Substanz je Aktie">
            <strong>${formatPrice(m.valuePerShare, s.currency)}</strong><br/>
            <small style="color: var(--text-muted)">Stichtag: ${s.balanceSheetDate || 'aktuell'}</small>
          </td>
          <td class="num cell-coverage" data-label="Deckungsgrad">
            <span class="coverage-badge ${covClass}">${formatPct(m.coveragePct)}</span>
          </td>
          <td class="num cell-p2v" data-label="Kurs / Substanz">
            <strong>${p2vText}</strong>
          </td>
          <td class="future-cell" data-label="Zukunfts- & Qualitäts-Check">
            ${renderFutureCell(s)}
          </td>
          <td class="num" data-label="Börsenwert">${formatMoney(s.marketCap, s.currency)}</td>
          <td class="num" data-label="Berechnete Substanz"><strong>${formatMoney(m.substanceValue, s.currency)}</strong></td>
          <td class="num" data-label="Anlagevermögen">
            ${formatMoney(s.tangibleFixedAssets, s.currency)}<br/>
            <small style="color: var(--text-muted)">PPE: ${formatMoney(s.netPPE, s.currency)}</small>
          </td>
          <td class="num" data-label="Liquide Mittel">${formatMoney(s.liquidAssets, s.currency)}</td>
          <td class="num" data-label="Verbindlichkeiten">${formatMoney(s.totalLiabilities, s.currency)}</td>
          <td class="cell-action" data-label="Details">
            <button class="btn-detail" data-symbol="${s.symbol}">Bilanz-Rechnung</button>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-detail').forEach(btn => {
    btn.addEventListener('click', () => openDetailModal(btn.dataset.symbol));
  });

  tbody.querySelectorAll('[data-chart-info]').forEach(el => {
    el.addEventListener('click', () => openChartModal(el.dataset.chartInfo));
  });

  attachChartInteractions();
}

function openDetailModal(symbol) {
  if (!state.scanData || !state.scanData.stocks) return;
  const s = state.scanData.stocks.find(item => item.symbol === symbol);
  if (!s) return;

  const flag = getCountryFlag(s.country);
  const idxLabel = Array.isArray(s.indices) ? s.indices.join(' · ') : s.index;
  document.getElementById('modalIndexBadge').textContent = `${flag} ${idxLabel} · Währung: ${s.currency}`;
  document.getElementById('modalTitle').textContent = `${s.name} (${s.symbol})`;
  document.getElementById('modalSubtitle').textContent =
    `${s.balanceSheetType || 'Bilanz'} zum Stichtag ${s.balanceSheetDate || 'aktuell'}` +
    (s.currencyConverted ? ` (Original-Bilanzwährung ${s.financialCurrency} automatisch in ${s.currency} umgerechnet)` : '');

  const body = document.getElementById('modalBody');
  body.innerHTML = `
    <div class="modal-grid">
      <div class="detail-box">
        <h4>1. Vermögenswerte (Aktiva / Substanz)</h4>
        <div class="detail-line">
          <span>Sachanlagen (Grundstücke, Werke, Maschinen / Net PPE)</span>
          <strong>${formatMoney(s.netPPE, s.currency)}</strong>
        </div>
        <div class="detail-line">
          <span>Finanzanlagen &amp; Beteiligungen</span>
          <strong>${formatMoney(s.longTermInvestments, s.currency)}</strong>
        </div>
        <div class="detail-line total">
          <span>Materielles Anlagevermögen gesamt</span>
          <span>${formatMoney(s.tangibleFixedAssets, s.currency)}</span>
        </div>
        <div class="detail-line">
          <span>Liquide Mittel (Cash &amp; kurzfr. Wertpapiere)</span>
          <strong>${formatMoney(s.liquidAssets, s.currency)}</strong>
        </div>
        <div class="detail-line">
          <span>Umlaufvermögen gesamt (inkl. Vorräte/Forderungen)</span>
          <strong>${formatMoney(s.currentAssets, s.currency)}</strong>
        </div>
        <div class="detail-line">
          <span>Abzüglich Goodwill &amp; Immaterielles (Insolvenzwert = 0)</span>
          <span style="color: #f87171">- ${formatMoney(s.intangibles, s.currency)}</span>
        </div>
        <div class="detail-line total">
          <span>Bilanzsumme (Gesamtvermögen)</span>
          <span>${formatMoney(s.totalAssets, s.currency)}</span>
        </div>
      </div>

      <div class="detail-box">
        <h4>2. Schulden &amp; Insolvenzmasse-Vergleich</h4>
        <div class="detail-line">
          <span>Finanzschulden (Kurz- &amp; Langfristige Kredite)</span>
          <strong>${formatMoney(s.totalDebt, s.currency)}</strong>
        </div>
        <div class="detail-line">
          <span>Gesamtverbindlichkeiten (Alle Schulden &amp; Rückstellungen)</span>
          <strong style="color: #f87171">- ${formatMoney(s.totalLiabilities, s.currency)}</strong>
        </div>
        <div class="detail-line total">
          <span>= Netto-Insolvenzmasse (Materieller Buchwert)</span>
          <span>${formatMoney(s.netSubstanceValue, s.currency)} (${formatPct(s.netCoveragePct)})</span>
        </div>
        <div class="detail-line">
          <span>= Strenger Netto-Wert (Anlageverm. + Cash − Schulden)</span>
          <strong>${formatMoney(s.strictAssetCashNet, s.currency)} (${formatPct(s.strictNetCoveragePct)})</strong>
        </div>
        <div class="detail-line">
          <span>= Brutto-Substanz (Anlageverm. + Liquide Mittel)</span>
          <strong>${formatMoney(s.grossAssetCash, s.currency)} (${formatPct(s.grossCoveragePct)})</strong>
        </div>
        <div class="detail-line">
          <span>= Klassisches Eigenkapital (Buchwert)</span>
          <strong>${formatMoney(s.classicBookValue, s.currency)} (${formatPct(s.bookCoveragePct)})</strong>
        </div>
        <div class="detail-line total">
          <span>Aktueller Börsenwert (Marktkapitalisierung)</span>
          <span>${formatMoney(s.marketCap, s.currency)}</span>
        </div>
      </div>
    </div>

    <div class="detail-box">
      <h4>3. Zukunfts- &amp; Qualitäts-Diagnose (Value-Trap-Check: ${s.futureScore ?? 50}/100 Punkte – ${s.futureLabel || ''})</h4>
      <div class="detail-line">
        <span>Jahresumsatz / Nettogewinn</span>
        <strong>${formatMoney(s.revenue, s.currency)} / ${formatMoney(s.netIncome, s.currency)} (${s.earningsGrowthPct != null ? (s.earningsGrowthPct >= 0 ? '+' : '') + s.earningsGrowthPct.toFixed(1) + '% YoY' : '–'})</strong>
      </div>
      <div class="detail-line">
        <span>Free Cashflow / Operativer Cashflow</span>
        <strong style="color: ${s.freeCashFlow < 0 ? '#f87171' : '#34d399'}">${formatMoney(s.freeCashFlow, s.currency)} / ${formatMoney(s.operatingCashFlow, s.currency)}</strong>
      </div>
      <div class="detail-line">
        <span>Eigenkapitalrendite (ROE) / Netto-Gewinnmarge</span>
        <strong>${s.roePct != null ? s.roePct.toFixed(1) + ' %' : '–'} / ${s.netMarginPct != null ? s.netMarginPct.toFixed(1) + ' %' : '–'}</strong>
      </div>
      <div class="detail-line">
        <span>Nettoverschuldung zu EBITDA / 200-Tage-Kurstrend</span>
        <strong>${s.netDebtToEbitda != null ? s.netDebtToEbitda.toFixed(1) + 'x' : '–'} / ${s.trend200dPct != null ? (s.trend200dPct >= 0 ? '+' : '') + s.trend200dPct.toFixed(1) + ' %' : '–'}</strong>
      </div>
      <div class="detail-line">
        <span>Positive Faktoren</span>
        <strong style="color: #6ee7b7">${(s.futurePros && s.futurePros.length) ? s.futurePros.join(' · ') : 'Keine besonderen Stärken'}</strong>
      </div>
      <div class="detail-line">
        <span>Warnsignale (Value-Trap-Risiken)</span>
        <strong style="color: #fca5a5">${(s.futureRisks && s.futureRisks.length) ? s.futureRisks.join(' · ') : 'Keine akuten Warnsignale'}</strong>
      </div>
    </div>

    <div class="detail-box">
      <h4>4. Kennzahlen pro Aktie</h4>
      <div class="detail-line">
        <span>Aktueller Börsenkurs</span>
        <strong>${formatPrice(s.price, s.currency)}</strong>
      </div>
      <div class="detail-line">
        <span>Netto-Insolvenzmasse pro Aktie (nach Abzug aller Schulden)</span>
        <strong>${formatPrice(s.netSubstancePerShare, s.currency)}</strong>
      </div>
      <div class="detail-line">
        <span>Brutto-Substanz (Anlagevermögen + Cash) pro Aktie</span>
        <strong>${formatPrice(s.grossSubstancePerShare, s.currency)}</strong>
      </div>
      <div class="detail-line">
        <span>KGV (Trailing P/E) / Dividendenrendite</span>
        <strong>${s.trailingPE ? s.trailingPE.toFixed(1) + 'x' : '–'} / ${(s.dividendYieldPct || 0).toFixed(2)} %</strong>
      </div>
    </div>
  `;

  document.getElementById('detailModal').classList.remove('hidden');
}

function exportFilteredCSV() {
  const list = getFilteredAndSortedStocks();
  if (!list.length) return;

  const headers = [
    'Symbol',
    'Name',
    'Index',
    'Land',
    'Waehrung',
    'Kurs',
    'SubstanzProAktie',
    'Deckungsgrad_Prozent',
    'Kurs_zu_Substanz',
    'Zukunfts_Score_100',
    'Zukunfts_Einstufung',
    'Marktkapitalisierung',
    'Netto_Insolvenzmasse',
    'Anlagevermoegen_Materiell',
    'Sachanlagen_PPE',
    'Liquide_Mittel',
    'Gesamtverbindlichkeiten',
    'FreeCashFlow',
    'ROE_Prozent',
    'Bilanzstichtag'
  ];

  const rows = list.map(s => {
    const m = getMetricsByMode(s, state.mode);
    return [
      s.symbol,
      `"${(s.name || '').replace(/"/g, '""')}"`,
      s.index,
      s.country,
      s.currency,
      s.price,
      Math.round((m.valuePerShare || 0) * 100) / 100,
      Math.round((m.coveragePct || 0) * 100) / 100,
      m.priceToValue ? Math.round(m.priceToValue * 100) / 100 : '',
      s.futureScore ?? 50,
      `"${s.futureLabel || ''}"`,
      Math.round(s.marketCap || 0),
      Math.round(s.netSubstanceValue || 0),
      Math.round(s.tangibleFixedAssets || 0),
      Math.round(s.netPPE || 0),
      Math.round(s.liquidAssets || 0),
      Math.round(s.totalLiabilities || 0),
      Math.round(s.freeCashFlow || 0),
      s.roePct != null ? Math.round(s.roePct * 10) / 10 : '',
      s.balanceSheetDate || ''
    ].join(';');
  });

  const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `buffett-substanz-aktien-${state.scanData?.scanDate || 'heute'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderAll() {
  renderHeaderMeta();
  renderCountsAndTabs();
  renderTable();
}

function updateThresholdUI(val) {
  state.minCoverage = Number(val);
  document.getElementById('thresholdSlider').value = state.minCoverage;
  const label = document.getElementById('thresholdValueLabel');
  if (state.minCoverage >= 100) {
    label.textContent = `≥ ${state.minCoverage} % (Substanz ≥ Börsenwert)`;
  } else if (state.minCoverage === 0) {
    label.textContent = `Alle Aktien anzeigen (Ranking nach Substanz-Deckung)`;
  } else {
    label.textContent = `≥ ${state.minCoverage} % des Börsenwerts durch Substanz gedeckt`;
  }

  document.querySelectorAll('.preset-pill').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.threshold) === state.minCoverage);
  });

  renderAll();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      state.mode = card.dataset.mode;
      renderAll();
    });
  });

  document.querySelectorAll('.index-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.index-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.selectedIndex = tab.dataset.index;
      renderAll();
    });
  });

  const slider = document.getElementById('thresholdSlider');
  slider.addEventListener('input', e => updateThresholdUI(e.target.value));

  document.querySelectorAll('.preset-pill').forEach(pill => {
    pill.addEventListener('click', () => updateThresholdUI(pill.dataset.threshold));
  });

  document.getElementById('searchInput').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderTable();
  });

  const futureFilterEl = document.getElementById('futureFilterSelect');
  if (futureFilterEl) {
    futureFilterEl.addEventListener('change', e => {
      state.futureFilter = e.target.value;
      renderTable();
    });
  }

  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderTable();
  });

  document.getElementById('historySelect').addEventListener('change', e => {
    loadScanData(e.target.value);
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await fetch('/api/scan/refresh', { method: 'POST' });
    checkScanStatus();
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportFilteredCSV);

  document.getElementById('closeModalBtn').addEventListener('click', () => {
    document.getElementById('detailModal').classList.add('hidden');
  });
  document.getElementById('detailModal').addEventListener('click', e => {
    if (e.target.id === 'detailModal') {
      document.getElementById('detailModal').classList.add('hidden');
    }
  });

  initGoogleFinanceChartAnalyzer();
  loadScanData();
});

// ============================================================================
// GOOGLE-FINANCE-STYLE INTERAKTIVER CHART-ANALYZER (100% Client-Side Canvas)
// ============================================================================
const gfState = {
  isOpen: false,
  symbol: null,
  range: '1d',
  interval: '5m',
  periodLabel: 'Heute',
  chartType: 'area', // 'area' | 'candles'
  showVolume: true,
  showPrevClose: true,
  showSMA: false,
  showSubstance: false,
  candles: [], // [{ t, o, h, l, c, v }]
  prevClose: null,
  hoverIdx: null,
  reqId: 0,
  cache: new Map() // key: `${symbol}:${range}:${interval}`
};

function openChartModal(symbol) {
  if (!state.scanData || !state.scanData.stocks) return;
  const s = state.scanData.stocks.find(item => item.symbol === symbol);
  if (!s) return;

  gfState.isOpen = true;
  gfState.symbol = symbol;
  gfState.hoverIdx = null;

  // Synchronisiere aktiven Zeitraum-Button mit aktuellem gfState.range
  document.querySelectorAll('#gfRangeBar .gf-range-btn').forEach(btn => {
    const isAct = btn.dataset.range === gfState.range;
    btn.classList.toggle('active', isAct);
    if (isAct) {
      gfState.interval = btn.dataset.interval;
      gfState.periodLabel = btn.dataset.label;
    }
  });

  const flag = getCountryFlag(s.country);
  const idxLabel = Array.isArray(s.indices) ? s.indices.join(' · ') : s.index;
  document.getElementById('gfBreadcrumb').textContent = `${flag} ${idxLabel} · ${s.symbol} · Währung: ${s.currency}`;
  document.getElementById('gfCompanyName').textContent = s.name;

  document.getElementById('chartModal').classList.remove('hidden');

  if (yahooWs && yahooWs.readyState === WebSocket.OPEN && !subscribedSymbols.has(symbol)) {
    yahooWs.send(JSON.stringify({ subscribe: [symbol] }));
    subscribedSymbols.add(symbol);
  }

  loadAnalyzerChartData();
}

function updateGfHeaderPrice(currentPrice, refPrice, currency, labelText, customTimeStr = null) {
  const mainEl = document.getElementById('gfMainPrice');
  const chgEl = document.getElementById('gfPriceChange');
  const metaEl = document.getElementById('gfSubMeta');

  mainEl.textContent = formatPrice(currentPrice, currency);

  const base = refPrice && refPrice > 0 ? refPrice : currentPrice;
  const diff = currentPrice - base;
  const pct = base > 0 ? (diff / base) * 100 : 0;
  const isPos = diff >= 0;
  const arrow = isPos ? '↑' : '↓';
  const sign = isPos ? '+' : '';

  chgEl.className = `gf-price-change ${isPos ? 'pos' : 'neg'}`;
  chgEl.textContent = `${arrow} ${sign}${pct.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% (${sign}${diff.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) ${labelText}`;

  const timeText = customTimeStr || new Date().toLocaleString('de-DE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  metaEl.textContent = `${timeText} · ${currency} · Client-Realtime-Analyse`;
}

function renderGfStats(s) {
  const m = getMetricsByMode(s, state.mode);
  const prevClose = s.prevClose || gfState.prevClose || (s.price / (1 + (s.changePercent || 0) / 100));
  const grid = document.getElementById('gfStatsGrid');
  grid.innerHTML = `
    <div class="gf-stat-item">
      <span class="gf-stat-label">Vortagesschluss</span>
      <span class="gf-stat-value">${formatPrice(prevClose, s.currency)}</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">Substanzwert je Aktie</span>
      <span class="gf-stat-value" style="color: #34d399">${formatPrice(m.valuePerShare, s.currency)} (${formatPct(m.coveragePct)})</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">52-Wochen-Spanne</span>
      <span class="gf-stat-value">${s.fiftyTwoWeekLow ? s.fiftyTwoWeekLow.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '–'} – ${s.fiftyTwoWeekHigh ? s.fiftyTwoWeekHigh.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '–'} ${s.currency}</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">Marktkapitalisierung</span>
      <span class="gf-stat-value">${formatMoney(s.marketCap, s.currency)}</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">Netto-Insolvenzmasse</span>
      <span class="gf-stat-value">${formatMoney(s.netSubstanceValue, s.currency)}</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">Anlagevermögen / Cash</span>
      <span class="gf-stat-value">${formatMoney(s.tangibleFixedAssets, s.currency)} / ${formatMoney(s.liquidAssets, s.currency)}</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">KGV / Dividendenrendite</span>
      <span class="gf-stat-value">${s.trailingPE ? s.trailingPE.toFixed(1) + 'x' : '–'} / ${(s.dividendYieldPct || 0).toFixed(2)} %</span>
    </div>
    <div class="gf-stat-item">
      <span class="gf-stat-label">Zukunfts- &amp; Qualitäts-Score</span>
      <span class="gf-stat-value">${s.futureScore ?? 50}/100 (${s.futureLabel || 'Neutral'})</span>
    </div>
  `;
}

function applyAnalyzerCandles(s, candles, prevClose, targetRange, periodLabel) {
  gfState.candles = candles;
  gfState.prevClose = prevClose;
  if (s && candles.length > 0) {
    const lastC = candles[candles.length - 1].c;
    const baseP = targetRange === '1d' ? (prevClose || candles[0].c) : candles[0].c;
    updateGfHeaderPrice(lastC, baseP, s.currency, periodLabel);
    renderGfStats(s);
  }
  drawGoogleFinanceChart();
}

async function loadAnalyzerChartData() {
  if (!gfState.symbol) return;
  const reqId = ++gfState.reqId;
  const targetSymbol = gfState.symbol;
  const targetRange = gfState.range;
  const targetInterval = gfState.interval;
  const targetLabel = gfState.periodLabel;
  const key = `${targetSymbol}:${targetRange}:${targetInterval}`;
  const s = state.scanData?.stocks?.find(item => item.symbol === targetSymbol);

  // 1. Falls bereits im Cache: sofort (0ms) zeichnen
  if (gfState.cache.has(key)) {
    const cached = gfState.cache.get(key);
    applyAnalyzerCandles(s, cached.candles, cached.prevClose, targetRange, targetLabel);
    return;
  }

  // 2. Sofortiges 0ms-Rendering aus den echten Bilanz-/Kurs-Stützpunkten der Aktie
  //    (verhindert leeren Chart beim Öffnen & garantiert sofortige Reaktion bei 1T, 5T, 1M, 6M, YTD, 1J, 5J, MAX)
  if (s) {
    const instant = buildInstantCandles(s, targetRange);
    applyAnalyzerCandles(s, instant.candles, instant.prevClose, targetRange, targetLabel);
  }

  // 3. Optionales Live-Upgrade vom lokalen Node-Backend (falls erreichbar), gesichert gegen Race-Conditions
  try {
    const json = await fetchYahooChartJSON(targetSymbol, targetRange, targetInterval);
    if (reqId !== gfState.reqId || !gfState.isOpen) return;

    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];
    const volumes = q.volume || [];

    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null && Number.isFinite(closes[i])) {
        candles.push({
          t: ts[i] * 1000,
          o: opens[i] ?? closes[i],
          h: highs[i] ?? closes[i],
          l: lows[i] ?? closes[i],
          c: closes[i],
          v: volumes[i] ?? 0
        });
      }
    }

    if (candles.length >= 2) {
      const prevClose = result?.meta?.chartPreviousClose || (candles[0]?.c ?? s?.price ?? 0);
      gfState.cache.set(key, { candles, prevClose });
      applyAnalyzerCandles(s, candles, prevClose, targetRange, targetLabel);
    } else if (s) {
      gfState.cache.set(key, { candles: gfState.candles, prevClose: gfState.prevClose });
    }
  } catch (_) {
    // Instant-Candles bleiben aktiv
  }
}

function onRealtimeTickForAnalyzer(tick, stock) {
  if (!gfState.isOpen || gfState.symbol !== tick.symbol) return;
  if (gfState.range === '1d' && gfState.candles.length > 0) {
    const last = gfState.candles[gfState.candles.length - 1];
    const now = tick.time || Date.now();
    if (now - last.t < 60 * 1000) {
      last.c = tick.price;
      if (tick.price > last.h) last.h = tick.price;
      if (tick.price < last.l) last.l = tick.price;
    } else {
      gfState.candles.push({
        t: now,
        o: last.c,
        h: Math.max(last.c, tick.price),
        l: Math.min(last.c, tick.price),
        c: tick.price,
        v: 0
      });
    }
    if (gfState.hoverIdx == null) {
      updateGfHeaderPrice(tick.price, gfState.prevClose || gfState.candles[0].c, stock.currency, gfState.periodLabel);
    }
    requestAnimationFrame(drawGoogleFinanceChart);
  }
}

function formatAxisTime(ms, range) {
  const d = new Date(ms);
  if (range === '1d') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '5d' || range === '1mo') {
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
  }
  return d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
}

function drawGoogleFinanceChart() {
  const canvas = document.getElementById('gfAnalyzerCanvas');
  if (!canvas || !gfState.isOpen) return;
  const s = state.scanData?.stocks?.find(item => item.symbol === gfState.symbol);
  const candles = gfState.candles;
  if (!candles || candles.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.round(canvas.clientWidth || 880));
  const height = Math.max(240, Math.round(canvas.clientHeight || 350));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const padLeft = 58;
  const padRight = 22;
  const padTop = 18;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const baseRef = gfState.range === '1d' && gfState.prevClose ? gfState.prevClose : candles[0].c;
  const activeCandle = gfState.hoverIdx != null && candles[gfState.hoverIdx]
    ? candles[gfState.hoverIdx]
    : candles[candles.length - 1];
  const isPositive = activeCandle.c >= baseRef;

  const mainColor = isPositive ? '#10b981' : '#ef4444';
  const fillTop = isPositive ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)';
  const fillBottom = isPositive ? 'rgba(16, 185, 129, 0.0)' : 'rgba(239, 68, 68, 0.0)';

  // Preis-Minimum & Maximum bestimmen
  let minP = Infinity;
  let maxP = -Infinity;
  let maxVol = 0;

  for (const c of candles) {
    const low = gfState.chartType === 'candles' ? c.l : c.c;
    const high = gfState.chartType === 'candles' ? c.h : c.c;
    if (low < minP) minP = low;
    if (high > maxP) maxP = high;
    if (c.v > maxVol) maxVol = c.v;
  }

  if (gfState.showPrevClose && gfState.prevClose && gfState.range === '1d') {
    if (gfState.prevClose < minP) minP = gfState.prevClose;
    if (gfState.prevClose > maxP) maxP = gfState.prevClose;
  }

  const m = s ? getMetricsByMode(s, state.mode) : null;
  if (gfState.showSubstance && m && m.valuePerShare > 0) {
    if (m.valuePerShare < minP) minP = m.valuePerShare;
    if (m.valuePerShare > maxP) maxP = m.valuePerShare;
  }

  const priceSpan = (maxP - minP) || (maxP * 0.01) || 1;
  minP -= priceSpan * 0.06;
  maxP += priceSpan * 0.06;
  const adjSpan = maxP - minP;

  const totalSlots = candles.length;

  const getX = idx => padLeft + (totalSlots <= 1 ? 0 : (idx / (totalSlots - 1)) * plotW);
  const getY = price => padTop + plotH - ((price - minP) / adjSpan) * plotH;

  // 1. Horizontale Preis-Hilfslinien & Y-Achsen-Beschriftung (links wie im Google-Screenshot)
  const ySteps = 6;
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= ySteps; i++) {
    const val = minP + (i / ySteps) * adjSpan;
    const y = getY(val);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.fillText(
      val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      padLeft - 8,
      y
    );
  }

  // 2. Vertikale Zeit-Hilfslinien & X-Achsen-Beschriftung (unten wie im Google-Screenshot)
  const xStepCount = 5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 1; i < xStepCount; i++) {
    const slotIdx = Math.round((i / xStepCount) * (totalSlots - 1));
    const x = getX(slotIdx);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();

    let labelTimeMs;
    if (slotIdx < candles.length) {
      labelTimeMs = candles[slotIdx].t;
    } else {
      const stepMs = candles.length > 1 ? (candles[candles.length - 1].t - candles[0].t) / (candles.length - 1) : 300000;
      labelTimeMs = candles[0].t + slotIdx * stepMs;
    }
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(formatAxisTime(labelTimeMs, gfState.range), x, padTop + plotH + 8);
  }

  // 3. Volumen-Balken am unteren Rand (grün/rot wie im Google-Screenshot)
  if (gfState.showVolume && maxVol > 0) {
    const volMaxH = plotH * 0.22;
    const barW = Math.max(1.5, Math.min(6, (plotW / totalSlots) * 0.65));
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c.v) continue;
      const x = getX(i);
      const bh = (c.v / maxVol) * volMaxH;
      const isUpBar = i === 0 ? c.c >= c.o : c.c >= candles[i - 1].c;
      ctx.fillStyle = isUpBar ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)';
      ctx.fillRect(x - barW / 2, padTop + plotH - bh, barW, bh);
    }
  }

  // 4. Gepunktete Vortagesschluss-Linie inkl. Label rechts ("Vort.|Schl. 69,10 €")
  if (gfState.showPrevClose && gfState.prevClose && gfState.range === '1d') {
    const py = getY(gfState.prevClose);
    if (py >= padTop && py <= padTop + plotH) {
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.lineWidth = 1.2;
      ctx.moveTo(padLeft, py);
      ctx.lineTo(width - padRight, py);
      ctx.stroke();
      ctx.setLineDash([]);

      const labelText = `Vort.|Schl. ${gfState.prevClose.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${s?.currency || ''}`;
      ctx.font = '600 11px Inter, sans-serif';
      const tw = ctx.measureText(labelText).width + 10;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(width - padRight - tw, py - 18, tw, 16);
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, width - padRight - 5, py - 10);
    }
  }

  // 5. Optionale Buffett-Substanzwert-Referenzlinie
  if (gfState.showSubstance && m && m.valuePerShare > 0) {
    const sy = getY(m.valuePerShare);
    if (sy >= padTop && sy <= padTop + plotH) {
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 1.5;
      ctx.moveTo(padLeft, sy);
      ctx.lineTo(width - padRight, sy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = '700 11px Inter, sans-serif';
      ctx.fillStyle = '#fde047';
      ctx.textAlign = 'left';
      ctx.fillText(`Substanzwert: ${formatPrice(m.valuePerShare, s?.currency)}`, padLeft + 8, sy - 8);
    }
  }

  // 6. Hauptdiagramm: Bereichsdiagramm (Area) oder Kerzendiagramm (Candles)
  if (gfState.chartType === 'candles') {
    const candleW = Math.max(2, Math.min(9, (plotW / totalSlots) * 0.7));
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const x = getX(i);
      const isUp = c.c >= c.o;
      const col = isUp ? '#10b981' : '#ef4444';

      ctx.beginPath();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.moveTo(x, getY(c.h));
      ctx.lineTo(x, getY(c.l));
      ctx.stroke();

      const topY = getY(Math.max(c.o, c.c));
      const botY = getY(Math.min(c.o, c.c));
      const bodyH = Math.max(1.5, botY - topY);
      ctx.fillStyle = col;
      ctx.fillRect(x - candleW / 2, topY, candleW, bodyH);
    }
  } else {
    // Bereichsdiagramm (exakt wie im Google-Finance-Screenshot)
    ctx.beginPath();
    for (let i = 0; i < candles.length; i++) {
      const x = getX(i);
      const y = getY(candles[i].c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(getX(candles.length - 1), padTop + plotH);
    ctx.lineTo(getX(0), padTop + plotH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, fillBottom);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < candles.length; i++) {
      const x = getX(i);
      const y = getY(candles[i].c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Leuchtender Punkt am aktuellen Ende der Kurve (wie im Google-Finance-Screenshot)
    const lastIdx = candles.length - 1;
    const tipX = getX(lastIdx);
    const tipY = getY(candles[lastIdx].c);
    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
    ctx.fillStyle = mainColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0d1424';
    ctx.stroke();
  }

  // 7. Optionaler Gleitender Durchschnitt (GD 20 / SMA 20)
  if (gfState.showSMA && candles.length >= 5) {
    const period = Math.min(20, candles.length);
    ctx.beginPath();
    let started = false;
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].c;
      const avg = sum / period;
      const x = getX(i);
      const y = getY(avg);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 8. Interaktives Fadenkreuz beim Hover / Touch
  if (gfState.hoverIdx != null && candles[gfState.hoverIdx]) {
    const hc = candles[gfState.hoverIdx];
    const hx = getX(gfState.hoverIdx);
    const hy = getY(hc.c);

    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.55)';
    ctx.lineWidth = 1;
    ctx.moveTo(hx, padTop);
    ctx.lineTo(hx, padTop + plotH);
    ctx.moveTo(padLeft, hy);
    ctx.lineTo(width - padRight, hy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = mainColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  ctx.restore();
}

function initGoogleFinanceChartAnalyzer() {
  const modal = document.getElementById('chartModal');
  const closeBtn = document.getElementById('closeChartModalBtn');
  const canvas = document.getElementById('gfAnalyzerCanvas');

  closeBtn.addEventListener('click', () => {
    gfState.isOpen = false;
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', e => {
    if (e.target.id === 'chartModal') {
      gfState.isOpen = false;
      modal.classList.add('hidden');
    }
  });

  // Zeitraum-Buttons (1 T, 5 T, 1 M, 6 M, seit Jahresbeginn, 1 J, 5 J, MAX)
  document.querySelectorAll('#gfRangeBar .gf-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#gfRangeBar .gf-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      gfState.range = btn.dataset.range;
      gfState.interval = btn.dataset.interval;
      gfState.periodLabel = btn.dataset.label;
      gfState.hoverIdx = null;
      loadAnalyzerChartData();
    });
  });

  // Toolbar-Steuerung
  document.getElementById('gfChartTypeSelect').addEventListener('change', e => {
    gfState.chartType = e.target.value;
    requestAnimationFrame(drawGoogleFinanceChart);
  });

  document.getElementById('gfShowVolume').addEventListener('change', e => {
    gfState.showVolume = e.target.checked;
    requestAnimationFrame(drawGoogleFinanceChart);
  });

  document.getElementById('gfShowPrevClose').addEventListener('change', e => {
    gfState.showPrevClose = e.target.checked;
    requestAnimationFrame(drawGoogleFinanceChart);
  });

  document.getElementById('gfShowSMA').addEventListener('change', e => {
    gfState.showSMA = e.target.checked;
    requestAnimationFrame(drawGoogleFinanceChart);
  });

  document.getElementById('gfShowSubstance').addEventListener('change', e => {
    gfState.showSubstance = e.target.checked;
    requestAnimationFrame(drawGoogleFinanceChart);
  });

  // Interaktives Maus- & Touch-Abtasten auf dem großen Chart
  const handleChartPointer = clientX => {
    if (!gfState.candles || gfState.candles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const padLeft = 58;
    const padRight = 22;
    const plotW = rect.width - padLeft - padRight;
    const relX = Math.max(0, Math.min(1, (clientX - rect.left - padLeft) / plotW));

    const totalSlots = gfState.candles.length;
    const slotIdx = Math.round(relX * (totalSlots - 1));
    const idx = Math.max(0, Math.min(gfState.candles.length - 1, slotIdx));
    gfState.hoverIdx = idx;

    const c = gfState.candles[idx];
    const s = state.scanData?.stocks?.find(item => item.symbol === gfState.symbol);
    if (c && s) {
      const baseP = gfState.range === '1d' && gfState.prevClose ? gfState.prevClose : gfState.candles[0].c;
      const dtStr = new Date(c.t).toLocaleString('de-DE', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      updateGfHeaderPrice(c.c, baseP, s.currency, gfState.periodLabel, dtStr);
      document.getElementById('gfHoverReadout').textContent =
        `${dtStr} · Eröff.: ${c.o.toFixed(2)} · Hoch: ${c.h.toFixed(2)} · Tief: ${c.l.toFixed(2)} · Schl.: ${c.c.toFixed(2)} · Vol.: ${(c.v || 0).toLocaleString('de-DE')}`;
    }
    requestAnimationFrame(drawGoogleFinanceChart);
  };

  const resetChartPointer = () => {
    gfState.hoverIdx = null;
    const s = state.scanData?.stocks?.find(item => item.symbol === gfState.symbol);
    if (s && gfState.candles.length > 0) {
      const lastC = gfState.candles[gfState.candles.length - 1].c;
      const baseP = gfState.range === '1d' && gfState.prevClose ? gfState.prevClose : gfState.candles[0].c;
      updateGfHeaderPrice(lastC, baseP, s.currency, gfState.periodLabel);
    }
    document.getElementById('gfHoverReadout').textContent =
      'Maus / Finger über den Chart bewegen für exakte Kerzen- & Volumendaten';
    requestAnimationFrame(drawGoogleFinanceChart);
  };

  canvas.addEventListener('mousemove', e => handleChartPointer(e.clientX));
  canvas.addEventListener('mouseleave', resetChartPointer);
  canvas.addEventListener('touchstart', e => {
    if (e.touches && e.touches[0]) handleChartPointer(e.touches[0].clientX);
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (e.touches && e.touches[0]) handleChartPointer(e.touches[0].clientX);
  }, { passive: true });
  canvas.addEventListener('touchend', resetChartPointer, { passive: true });

  window.addEventListener('resize', () => {
    if (gfState.isOpen) requestAnimationFrame(drawGoogleFinanceChart);
  });
}
