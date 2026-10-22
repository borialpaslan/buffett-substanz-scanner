const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const { getAllConstituents } = require('./indices');

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey']
});

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CACHE_FILE = path.join(DATA_DIR, 'latest-scan.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

let scanStatus = {
  isScanning: false,
  startedAt: null,
  completedAt: null,
  phase: 'idle',
  processed: 0,
  total: 0,
  currentSymbol: '',
  errorCount: 0,
  lastError: null
};

async function fetchExchangeRates() {
  const rates = {
    EUR: 1,
    USD: 1.08,
    TRY: 38.0,
    GBP: 0.85,
    CHF: 0.95
  };
  try {
    const fxQuotes = await yf.quote(['EURUSD=X', 'EURTRY=X', 'USDTRY=X', 'EURGBP=X', 'EURCHF=X']);
    const map = {};
    for (const q of fxQuotes) {
      if (q && q.symbol && q.regularMarketPrice) {
        map[q.symbol] = q.regularMarketPrice;
      }
    }
    if (map['EURUSD=X']) rates.USD = map['EURUSD=X'];
    if (map['EURTRY=X']) rates.TRY = map['EURTRY=X'];
    else if (map['USDTRY=X'] && rates.USD) rates.TRY = rates.USD * map['USDTRY=X'];
    if (map['EURGBP=X']) rates.GBP = map['EURGBP=X'];
    if (map['EURCHF=X']) rates.CHF = map['EURCHF=X'];
  } catch (err) {
    console.warn('FX-Abruf Warnung, nutze Fallback-Kurse:', err.message);
  }
  return rates;
}

function convertCurrency(amount, fromCur, toCur, ratesPerEUR) {
  if (amount == null || !Number.isFinite(amount)) return 0;
  const from = (fromCur || 'USD').toUpperCase();
  const to = (toCur || 'USD').toUpperCase();
  if (from === to) return amount;
  const fromRate = ratesPerEUR[from];
  const toRate = ratesPerEUR[to];
  if (!fromRate || !toRate) return amount;
  const inEUR = amount / fromRate;
  return inEUR * toRate;
}

async function fetchFinancialStatements(symbol) {
  let latestBS = null;
  let periodType = 'Jahresbilanz';
  let annualCurr = null;
  let annualPrev = null;

  try {
    // 1. Jahresabschlüsse (inkl. GuV & Cashflow für Jahresvergleich YoY)
    const ann = await yf.fundamentalsTimeSeries(symbol, {
      period1: '2023-01-01',
      module: 'all',
      type: 'annual'
    });
    if (Array.isArray(ann) && ann.length > 0) {
      const validAnn = ann.filter(x => x && (x.totalAssets || x.stockholdersEquity || x.totalRevenue || x.netIncome));
      if (validAnn.length > 0) {
        annualCurr = validAnn[validAnn.length - 1];
        annualPrev = validAnn.length >= 2 ? validAnn[validAnn.length - 2] : null;
        latestBS = annualCurr;
      }
    }
  } catch (_) {
    // Ignorieren
  }

  try {
    // 2. Aktuellste Quartalsbilanz für tagesaktuellere Substanzwerte
    const qtr = await yf.fundamentalsTimeSeries(symbol, {
      period1: '2025-06-01',
      module: 'balance-sheet',
      type: 'quarterly'
    });
    if (Array.isArray(qtr) && qtr.length > 0) {
      for (let i = qtr.length - 1; i >= 0; i--) {
        if (qtr[i] && (qtr[i].totalAssets || qtr[i].stockholdersEquity || qtr[i].tangibleBookValue)) {
          latestBS = qtr[i];
          periodType = 'Quartalsbilanz';
          break;
        }
      }
    }
  } catch (_) {
    // Nutze Jahresbilanz falls Quartalsbilanz nicht verfügbar
  }

  if (!latestBS && !annualCurr) return null;
  return {
    statement: latestBS || annualCurr,
    periodType,
    annualCurr: annualCurr || latestBS || {},
    annualPrev: annualPrev || {}
  };
}

function evaluateFutureOutlook({
  quote,
  revenue,
  prevRevenue,
  netIncome,
  prevNetIncome,
  operatingIncome,
  ebitda,
  operatingCashFlow,
  freeCashFlow,
  netDebt,
  bookValueTotal,
  totalLiabilities,
  totalAssets
}) {
  let score = 50; // Startwert 50 von 100
  const pros = [];
  const risks = [];

  // 1. Profitabilität & Gewinn-Entwicklung (GuV)
  const netMarginPct = revenue > 0 ? (netIncome / revenue) * 100 : null;
  const operatingMarginPct = revenue > 0 && operatingIncome != null ? (operatingIncome / revenue) * 100 : null;
  const roePct = bookValueTotal > 0 ? (netIncome / bookValueTotal) * 100 : null;

  let earningsGrowthPct = null;
  if (prevNetIncome && Math.abs(prevNetIncome) > 0 && netIncome != null) {
    earningsGrowthPct = ((netIncome - prevNetIncome) / Math.abs(prevNetIncome)) * 100;
  }

  let revenueGrowthPct = null;
  if (prevRevenue && prevRevenue > 0 && revenue > 0) {
    revenueGrowthPct = ((revenue - prevRevenue) / prevRevenue) * 100;
  }

  // Gewinn / Verlust Check
  if (netIncome < 0) {
    score -= 22;
    risks.push('Schreibt Verluste (Nettoverlust)');
  } else if (netIncome > 0) {
    score += 6;
  }

  // Gewinn-Wachstum YoY
  if (earningsGrowthPct != null) {
    if (earningsGrowthPct <= -20) {
      score -= 16;
      risks.push(`Gewinneinbruch (${earningsGrowthPct.toFixed(0)}% YoY)`);
    } else if (earningsGrowthPct < -5) {
      score -= 8;
      risks.push(`Gewinn rückläufig (${earningsGrowthPct.toFixed(0)}%)`);
    } else if (earningsGrowthPct >= 10) {
      score += 12;
      pros.push(`Gewinnwachstum (+${earningsGrowthPct.toFixed(0)}%)`);
    }
  }

  // Eigenkapitalrendite (ROE - Buffetts Kernkriterium)
  if (roePct != null) {
    if (roePct >= 12) {
      score += 14;
      pros.push(`Starke EK-Rendite (ROE ${roePct.toFixed(1)}%)`);
    } else if (roePct >= 7) {
      score += 5;
    } else if (roePct > 0 && roePct < 5) {
      score -= 10;
      risks.push(`Schwache EK-Rendite (ROE ${roePct.toFixed(1)}%)`);
    }
  }

  // Gewinnmarge
  if (netMarginPct != null) {
    if (netMarginPct >= 10) {
      score += 8;
      pros.push(`Hohe Marge (${netMarginPct.toFixed(1)}%)`);
    } else if (netMarginPct > 0 && netMarginPct < 3.5) {
      score -= 8;
      risks.push(`Dünne Marge (${netMarginPct.toFixed(1)}%)`);
    }
  }

  // 2. Cashflow-Qualität (Substanz-Aufbau vs. Substanz-Verbrennung)
  if (freeCashFlow != null && freeCashFlow !== 0) {
    if (freeCashFlow < 0) {
      score -= 14;
      risks.push('Negativer Free Cashflow (verbrennt Cash)');
    } else if (freeCashFlow > 0) {
      score += 12;
      pros.push('Positiver Free Cashflow');
    }
  } else if (operatingCashFlow != null && operatingCashFlow !== 0) {
    if (operatingCashFlow < 0) {
      score -= 14;
      risks.push('Operativer Cashflow negativ');
    } else {
      score += 8;
    }
  }

  // 3. Verschuldungsgrad (Net Debt / EBITDA)
  const netDebtToEbitda = ebitda > 0 && netDebt > 0 ? netDebt / ebitda : (netDebt <= 0 ? 0 : null);
  if (netDebtToEbitda != null) {
    if (netDebtToEbitda === 0) {
      score += 10;
      pros.push('Netto schuldenfrei (Cash > Finanzschulden)');
    } else if (netDebtToEbitda <= 2.5) {
      score += 6;
      pros.push(`Solide Verschuldung (${netDebtToEbitda.toFixed(1)}x EBITDA)`);
    } else if (netDebtToEbitda >= 4.5) {
      score -= 10;
      risks.push(`Hohe Schuldenlast (${netDebtToEbitda.toFixed(1)}x EBITDA)`);
    }
  } else if (totalAssets > 0 && totalLiabilities / totalAssets > 0.85) {
    score -= 6;
  }

  // 4. Kurs-Momentum (200-Tage-Trend) & Analysten-Prognose (EPS Forward vs Trailing)
  const trend200dPct = quote.twoHundredDayAverageChangePercent != null
    ? quote.twoHundredDayAverageChangePercent * 100
    : null;
  const perf52wPct = quote.fiftyTwoWeekChangePercent ?? null;

  if (trend200dPct != null) {
    if (trend200dPct <= -15) {
      score -= 8;
      risks.push(`Abwärtstrend (${trend200dPct.toFixed(0)}% ggü. 200T-Linie)`);
    } else if (trend200dPct >= 3) {
      score += 6;
      pros.push(`Positiver Trend (+${trend200dPct.toFixed(0)}% ü. 200T)`);
    }
  }

  if (quote.epsForward && quote.epsTrailingTwelveMonths && quote.epsTrailingTwelveMonths > 0) {
    const epsExpGrowth = ((quote.epsForward - quote.epsTrailingTwelveMonths) / quote.epsTrailingTwelveMonths) * 100;
    if (epsExpGrowth >= 15) {
      pros.push(`Analysten erwarten EPS-Anstieg (+${epsExpGrowth.toFixed(0)}%)`);
      score += 4;
    } else if (epsExpGrowth <= -15) {
      risks.push(`Erwarteter Gewinnrückgang (${epsExpGrowth.toFixed(0)}%)`);
      score -= 6;
    }
  }

  score = Math.max(5, Math.min(98, Math.round(score)));

  let futureRating = 'neutral';
  let futureLabel = 'Gemischt / Beobachten';
  if (score >= 65) {
    futureRating = 'strong';
    futureLabel = 'Zukunft Solide / Stark';
  } else if (score <= 42) {
    futureRating = 'critical';
    futureLabel = 'Kritisch / Value-Trap-Risiko';
  }

  return {
    futureScore: score,
    futureRating,
    futureLabel,
    pros,
    risks,
    netMarginPct,
    operatingMarginPct,
    roePct,
    earningsGrowthPct,
    revenueGrowthPct,
    netDebtToEbitda,
    trend200dPct,
    perf52wPct,
    analystRating: quote.averageAnalystRating || null
  };
}

function computeBuffettMetrics(item, quote, finData, fxRates) {
  const price = quote.regularMarketPrice;
  const marketCap = quote.marketCap;
  if (!price || !marketCap || marketCap <= 0) return null;

  const priceCurrency = (quote.currency || (item.country === 'DE' ? 'EUR' : item.country === 'TR' ? 'TRY' : 'USD')).toUpperCase();
  const finCurrency = (quote.financialCurrency || priceCurrency).toUpperCase();

  const bs = finData ? finData.statement : {};
  const annCurr = finData ? finData.annualCurr : {};
  const annPrev = finData ? finData.annualPrev : {};
  const conv = val => convertCurrency(val, finCurrency, priceCurrency, fxRates);

  // 1. Liquide Mittel
  const rawCashAndShortTerm =
    bs.cashCashEquivalentsAndShortTermInvestments ??
    bs.cashAndCashEquivalents ??
    bs.cashFinancial ??
    0;
  const rawCashOnly = bs.cashAndCashEquivalents ?? bs.cashFinancial ?? rawCashAndShortTerm;
  const liquidAssets = conv(rawCashAndShortTerm);
  const cashOnly = conv(rawCashOnly);

  // 2. Sachanlagen (Net PPE)
  const netPPE = conv(bs.netPPE ?? bs.properties ?? 0);

  // 3. Immaterielle Vermögenswerte & Goodwill
  const intangibles = conv(
    bs.goodwillAndOtherIntangibleAssets ??
      ((bs.goodwill || 0) + (bs.otherIntangibleAssets || 0))
  );

  // 4. Anlagevermögen (materiell)
  const rawNonCurrent = bs.totalNonCurrentAssets;
  const rawLongTermInv =
    bs.investmentsAndAdvances ??
    bs.longTermEquityInvestment ??
    bs.investmentinFinancialAssets ??
    bs.availableForSaleSecurities ??
    0;
  const longTermInvestments = conv(rawLongTermInv);

  let tangibleFixedAssets = 0;
  if (rawNonCurrent != null && rawNonCurrent > 0) {
    tangibleFixedAssets = Math.max(netPPE, conv(rawNonCurrent) - intangibles);
  } else {
    tangibleFixedAssets = netPPE + longTermInvestments;
  }

  // 5. Umlaufvermögen & Gesamtvermögen
  const currentAssets = conv(bs.currentAssets ?? rawCashAndShortTerm);
  const totalAssets = conv(
    bs.totalAssets ?? ((bs.totalNonCurrentAssets || 0) + (bs.currentAssets || 0))
  );

  // 6. Verbindlichkeiten & Schulden
  const totalDebt = conv(bs.totalDebt ?? annCurr.totalDebt ?? 0);
  const bookValueTotal = conv(
    bs.stockholdersEquity ??
      bs.commonStockEquity ??
      bs.totalEquityGrossMinorityInterest ??
      (quote.bookValue && quote.sharesOutstanding ? quote.bookValue * quote.sharesOutstanding : 0)
  );
  const totalLiabilities = conv(
    bs.totalLiabilitiesNetMinorityInterest ??
      (bs.totalAssets && bs.stockholdersEquity ? bs.totalAssets - bs.stockholdersEquity : bs.totalDebt || 0)
  );

  // 7. Netto-Insolvenzmasse
  let netLiquidationValue = 0;
  if (bs.tangibleBookValue != null) {
    netLiquidationValue = conv(bs.tangibleBookValue);
  } else if (bs.netTangibleAssets != null) {
    netLiquidationValue = conv(bs.netTangibleAssets);
  } else if (bookValueTotal !== 0) {
    netLiquidationValue = bookValueTotal - intangibles;
  } else if (totalAssets > 0) {
    netLiquidationValue = totalAssets - intangibles - totalLiabilities;
  }

  const netSubstanceValue = netLiquidationValue;
  const strictAssetCashNet = (tangibleFixedAssets + liquidAssets) - totalLiabilities;
  const grossAssetCash = tangibleFixedAssets + liquidAssets;
  const grossPPEAndCash = netPPE + liquidAssets;
  const classicBookValue = bookValueTotal;

  const netCoveragePct = (netSubstanceValue / marketCap) * 100;
  const strictNetCoveragePct = (strictAssetCashNet / marketCap) * 100;
  const grossCoveragePct = (grossAssetCash / marketCap) * 100;
  const ppeCashCoveragePct = (grossPPEAndCash / marketCap) * 100;
  const bookCoveragePct = (classicBookValue / marketCap) * 100;

  const priceToNetSubstance = netSubstanceValue > 0 ? marketCap / netSubstanceValue : null;
  const priceToStrictNet = strictAssetCashNet > 0 ? marketCap / strictAssetCashNet : null;
  const priceToGrossSubstance = grossAssetCash > 0 ? marketCap / grossAssetCash : null;
  const priceToBook = classicBookValue > 0 ? marketCap / classicBookValue : null;

  const netSubstancePerShare = price * (netSubstanceValue / marketCap);
  const grossSubstancePerShare = price * (grossAssetCash / marketCap);
  const bookValuePerShare = price * (classicBookValue / marketCap);

  const marketCapEUR = convertCurrency(marketCap, priceCurrency, 'EUR', fxRates);
  const netSubstanceEUR = convertCurrency(netSubstanceValue, priceCurrency, 'EUR', fxRates);

  // 8. GuV & Cashflow-Werte für Zukunfts- & Qualitäts-Check
  const revenue = conv(annCurr.totalRevenue ?? annCurr.operatingRevenue ?? 0);
  const prevRevenue = conv(annPrev.totalRevenue ?? annPrev.operatingRevenue ?? 0);
  const netIncome = conv(annCurr.netIncome ?? annCurr.netIncomeCommonStockholders ?? 0);
  const prevNetIncome = annPrev.netIncome != null ? conv(annPrev.netIncome) : null;
  const operatingIncome = annCurr.operatingIncome != null ? conv(annCurr.operatingIncome) : null;
  const ebitda = conv(annCurr.EBITDA ?? annCurr.normalizedEBITDA ?? 0);
  const operatingCashFlow = annCurr.operatingCashFlow != null ? conv(annCurr.operatingCashFlow) : null;
  const freeCashFlow = annCurr.freeCashFlow != null ? conv(annCurr.freeCashFlow) : null;
  const netDebt = conv(bs.netDebt ?? annCurr.netDebt ?? Math.max(0, totalDebt - liquidAssets));

  const outlook = evaluateFutureOutlook({
    quote,
    revenue,
    prevRevenue,
    netIncome,
    prevNetIncome,
    operatingIncome,
    ebitda,
    operatingCashFlow,
    freeCashFlow,
    netDebt,
    bookValueTotal,
    totalLiabilities,
    totalAssets
  });

  return {
    symbol: item.symbol,
    name: quote.longName || quote.shortName || item.name || item.symbol,
    country: item.country,
    index: item.index,
    indices: Array.isArray(item.indices) && item.indices.length > 0 ? item.indices : [item.index],
    currency: priceCurrency,
    financialCurrency: finCurrency,
    currencyConverted: priceCurrency !== finCurrency,
    price,
    openPrice: quote.regularMarketOpen ?? price,
    prevClose: quote.regularMarketPreviousClose ?? price,
    dayLow: quote.regularMarketDayLow ?? price,
    dayHigh: quote.regularMarketDayHigh ?? price,
    fiftyDayAvg: quote.fiftyDayAverage ?? price,
    twoHundredDayAvg: quote.twoHundredDayAverage ?? price,
    dayVolume: quote.regularMarketVolume ?? 0,
    changePercent: quote.regularMarketChangePercent ?? 0,
    marketCap,
    marketCapEUR,
    trailingPE: quote.trailingPE ?? null,
    forwardPE: quote.forwardPE ?? null,
    dividendYieldPct: quote.trailingAnnualDividendYield
      ? quote.trailingAnnualDividendYield * 100
      : (quote.dividendYield || 0),
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
    balanceSheetDate: bs.date ? new Date(bs.date).toISOString().slice(0, 10) : null,
    balanceSheetType: finData ? finData.periodType : 'Schätzung',
    // Bilanzposten
    liquidAssets,
    cashOnly,
    netPPE,
    longTermInvestments,
    tangibleFixedAssets,
    currentAssets,
    intangibles,
    totalAssets,
    totalLiabilities,
    totalDebt,
    netDebt,
    bookValueTotal,
    // GuV & Cashflow
    revenue,
    netIncome,
    operatingIncome,
    ebitda,
    operatingCashFlow,
    freeCashFlow,
    // Zukunfts- & Qualitäts-Check (Value-Trap-Schutz)
    futureScore: outlook.futureScore,
    futureRating: outlook.futureRating,
    futureLabel: outlook.futureLabel,
    futurePros: outlook.pros,
    futureRisks: outlook.risks,
    netMarginPct: outlook.netMarginPct,
    operatingMarginPct: outlook.operatingMarginPct,
    roePct: outlook.roePct,
    earningsGrowthPct: outlook.earningsGrowthPct,
    revenueGrowthPct: outlook.revenueGrowthPct,
    netDebtToEbitda: outlook.netDebtToEbitda,
    trend200dPct: outlook.trend200dPct,
    perf52wPct: outlook.perf52wPct,
    analystRating: outlook.analystRating,
    // Substanzwerte
    netSubstanceValue,
    netSubstanceEUR,
    strictAssetCashNet,
    grossAssetCash,
    grossPPEAndCash,
    classicBookValue,
    // Pro-Aktie-Werte
    netSubstancePerShare,
    grossSubstancePerShare,
    bookValuePerShare,
    // Deckungsgrade in %
    netCoveragePct,
    strictNetCoveragePct,
    grossCoveragePct,
    ppeCashCoveragePct,
    bookCoveragePct,
    // Multiples
    priceToNetSubstance,
    priceToStrictNet,
    priceToGrossSubstance,
    priceToBook,
    // Boolesche Treffer-Flags
    isNetLiquidationMatch: netCoveragePct >= 100,
    isStrictNetMatch: strictNetCoveragePct >= 100,
    isGrossAssetCashMatch: grossCoveragePct >= 100,
    isBookValueMatch: bookCoveragePct >= 100
  };
}

async function runDailyScan({ force = false } = {}) {
  ensureDirs();
  if (scanStatus.isScanning) {
    return getCachedScan();
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (
        existing &&
        existing.scanDate === todayStr &&
        Array.isArray(existing.stocks) &&
        existing.stocks.length > 580 &&
        existing.stocks[0].futureScore !== undefined &&
        Array.isArray(existing.stocks[0].indices)
      ) {
        return existing;
      }
    } catch (_) {
      // Cache neu aufbauen
    }
  }

  scanStatus = {
    isScanning: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    phase: 'Lade Index-Zusammensetzung & Wechselkurse...',
    processed: 0,
    total: 0,
    currentSymbol: '',
    errorCount: 0,
    lastError: null
  };

  try {
    const [constituents, fxRates] = await Promise.all([
      getAllConstituents(),
      fetchExchangeRates()
    ]);

    scanStatus.total = constituents.length;
    scanStatus.phase = 'Lade Echtzeit-Kurse & Marktkapitalisierungen (Batch)...';

    const quoteMap = new Map();
    const batchSize = 60;
    for (let i = 0; i < constituents.length; i += batchSize) {
      const batch = constituents.slice(i, i + batchSize).map(c => c.symbol);
      try {
        const quotes = await yf.quote(batch);
        for (const q of quotes) {
          if (q && q.symbol) {
            quoteMap.set(q.symbol, q);
          }
        }
      } catch (err) {
        scanStatus.errorCount++;
        scanStatus.lastError = err.message;
      }
    }

    scanStatus.phase = 'Analysiere Bilanzen, Cashflows & Zukunfts-Qualität...';
    const stocks = [];
    let cursor = 0;
    const concurrency = 20;

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < constituents.length) {
          const item = constituents[cursor++];
          scanStatus.currentSymbol = item.symbol;
          try {
            let quote = quoteMap.get(item.symbol);
            if (!quote) {
              quote = await yf.quote(item.symbol);
            }
            if (quote && quote.marketCap && quote.regularMarketPrice) {
              const finData = await fetchFinancialStatements(item.symbol);
              const metrics = computeBuffettMetrics(item, quote, finData, fxRates);
              if (metrics) {
                stocks.push(metrics);
              }
            }
          } catch (err) {
            scanStatus.errorCount++;
            scanStatus.lastError = `${item.symbol}: ${err.message}`;
          } finally {
            scanStatus.processed++;
          }
        }
      })
    );

    stocks.sort((a, b) => (b.netCoveragePct || 0) - (a.netCoveragePct || 0));

    const hasIdx = (s, idxName) =>
      Array.isArray(s.indices) ? s.indices.includes(idxName) : s.index === idxName;

    const summary = {
      totalScanned: stocks.length,
      byIndex: {
        'DAX 40': stocks.filter(s => hasIdx(s, 'DAX 40')).length,
        'MDAX': stocks.filter(s => hasIdx(s, 'MDAX')).length,
        'TecDAX': stocks.filter(s => hasIdx(s, 'TecDAX')).length,
        'Euro Stoxx 50': stocks.filter(s => hasIdx(s, 'Euro Stoxx 50')).length,
        'BIST 30': stocks.filter(s => hasIdx(s, 'BIST 30')).length,
        'Dow Jones': stocks.filter(s => hasIdx(s, 'Dow Jones')).length,
        'US Tech 100': stocks.filter(s => hasIdx(s, 'US Tech 100')).length,
        'S&P 500': stocks.filter(s => hasIdx(s, 'S&P 500')).length
      },
      matchesNetLiquidation: stocks.filter(s => s.isNetLiquidationMatch).length,
      matchesStrictNet: stocks.filter(s => s.isStrictNetMatch).length,
      matchesGrossAssetCash: stocks.filter(s => s.isGrossAssetCashMatch).length,
      matchesBookValue: stocks.filter(s => s.isBookValueMatch).length
    };

    const resultPayload = {
      scanDate: todayStr,
      scannedAt: new Date().toISOString(),
      nextScheduledScan: 'Täglich um 08:00 Uhr (lokale Zeit) + beim Start falls älter als heute',
      fxRatesPerEUR: fxRates,
      summary,
      stocks
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(resultPayload, null, 2), 'utf8');
    const historyFile = path.join(HISTORY_DIR, `${todayStr}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(resultPayload, null, 2), 'utf8');

    try {
      scanStatus.phase = 'Speichere echte 5-Jahres- & Intraday-Charts für alle Aktien...';
      const { buildAllChartsCache } = require('./build-charts-cache');
      await buildAllChartsCache();
    } catch (_) {}

    scanStatus.isScanning = false;
    scanStatus.completedAt = new Date().toISOString();
    scanStatus.phase = 'Abgeschlossen';
    return resultPayload;
  } catch (err) {
    scanStatus.isScanning = false;
    scanStatus.phase = 'Fehler';
    scanStatus.lastError = err.message;
    throw err;
  }
}

function getCachedScan() {
  ensureDirs();
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function getHistoryDates() {
  ensureDirs();
  try {
    return fs
      .readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function getScanByDate(dateStr) {
  const safe = String(dateStr).replace(/[^0-9-]/g, '');
  const file = path.join(HISTORY_DIR, `${safe}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function getScanStatus() {
  return scanStatus;
}

module.exports = {
  runDailyScan,
  getCachedScan,
  getHistoryDates,
  getScanByDate,
  getScanStatus
};
