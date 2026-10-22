// Vollständige Index-Listen für DAX 40 (DE), BIST 30 (Türkei) und S&P 500 (USA)

const DAX_40 = [
  { symbol: 'ADS.DE', name: 'adidas AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'AIR.DE', name: 'Airbus SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'ALV.DE', name: 'Allianz SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'BAS.DE', name: 'BASF SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'BAYN.DE', name: 'Bayer AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'BEI.DE', name: 'Beiersdorf AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'BMW.DE', name: 'Bayerische Motoren Werke AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'BNR.DE', name: 'Brenntag SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'CBK.DE', name: 'Commerzbank AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'CON.DE', name: 'Continental AG', country: 'DE', index: 'DAX 40' },
  { symbol: '1COV.DE', name: 'Covestro AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'DTG.DE', name: 'Daimler Truck Holding AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'DBK.DE', name: 'Deutsche Bank AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'DB1.DE', name: 'Deutsche Börse AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'DHL.DE', name: 'Deutsche Post AG (DHL Group)', country: 'DE', index: 'DAX 40' },
  { symbol: 'DTE.DE', name: 'Deutsche Telekom AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'EOAN.DE', name: 'E.ON SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'FRE.DE', name: 'Fresenius SE & Co. KGaA', country: 'DE', index: 'DAX 40' },
  { symbol: 'HNR1.DE', name: 'Hannover Rück SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'HEI.DE', name: 'Heidelberg Materials AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'HEN3.DE', name: 'Henkel AG & Co. KGaA', country: 'DE', index: 'DAX 40' },
  { symbol: 'IFX.DE', name: 'Infineon Technologies AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'MBG.DE', name: 'Mercedes-Benz Group AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'MRK.DE', name: 'Merck KGaA', country: 'DE', index: 'DAX 40' },
  { symbol: 'MTX.DE', name: 'MTU Aero Engines AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'MUV2.DE', name: 'Münchener Rückversicherungs-Gesellschaft AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'P911.DE', name: 'Dr. Ing. h.c. F. Porsche AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'PAH3.DE', name: 'Porsche Automobil Holding SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'QIA.DE', name: 'QIAGEN N.V.', country: 'DE', index: 'DAX 40' },
  { symbol: 'RHM.DE', name: 'Rheinmetall AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'RWE.DE', name: 'RWE AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'SAP.DE', name: 'SAP SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'SRT3.DE', name: 'Sartorius AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'SIE.DE', name: 'Siemens AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'ENR.DE', name: 'Siemens Energy AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'SHL.DE', name: 'Siemens Healthineers AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'SY1.DE', name: 'Symrise AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'VOW3.DE', name: 'Volkswagen AG', country: 'DE', index: 'DAX 40' },
  { symbol: 'VNA.DE', name: 'Vonovia SE', country: 'DE', index: 'DAX 40' },
  { symbol: 'ZAL.DE', name: 'Zalando SE', country: 'DE', index: 'DAX 40' }
];

const BIST_30 = [
  { symbol: 'AKBNK.IS', name: 'Akbank T.A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ALARK.IS', name: 'Alarko Holding A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ARCLK.IS', name: 'Arçelik A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ASELS.IS', name: 'Aselsan Elektronik Sanayi ve Ticaret A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ASTOR.IS', name: 'Astor Enerji A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'BIMAS.IS', name: 'BIM Birlesik Magazalar A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'BRSAN.IS', name: 'Borusan Birlesik Boru Fabrikalari A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'DOAS.IS', name: 'Dogus Otomotiv Servis ve Ticaret A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'EKGYO.IS', name: 'Emlak Konut Gayrimenkul Yatirim Ortakligi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ENKAI.IS', name: 'Enka Insaat ve Sanayi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'EREGL.IS', name: 'Eregli Demir ve Çelik Fabrikalari T.A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'FROTO.IS', name: 'Ford Otomotiv Sanayi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'GARAN.IS', name: 'Türkiye Garanti Bankasi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'GUBRF.IS', name: 'Gübre Fabrikalari T.A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'HEKTS.IS', name: 'Hektas Ticaret T.A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ISCTR.IS', name: 'Türkiye Is Bankasi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'KCHOL.IS', name: 'Koç Holding A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'KONTR.IS', name: 'Kontrolmatik Teknoloji Enerji ve Mühendislik A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'KOZAL.IS', name: 'Koza Altin Isletmeleri A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'KRDMD.IS', name: 'Kardemir Karabük Demir Çelik Sanayi ve Ticaret A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'MGROS.IS', name: 'Migros Ticaret A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'OYAKC.IS', name: 'Oyak Çimento Fabrikalari A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'PETKM.IS', name: 'Petkim Petrokimya Holding A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'PGSUS.IS', name: 'Pegasus Hava Tasimaciligi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'SAHOL.IS', name: 'Haci Ömer Sabanci Holding A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'SASA.IS', name: 'Sasa Polyester Sanayi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'SISE.IS', name: 'Türkiye Sise ve Cam Fabrikalari A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'TCELL.IS', name: 'Turkcell Iletisim Hizmetleri A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'THYAO.IS', name: 'Türk Hava Yollari A.O.', country: 'TR', index: 'BIST 30' },
  { symbol: 'TOASO.IS', name: 'Tofas Türk Otomobil Fabrikasi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'TTKOM.IS', name: 'Türk Telekomünikasyon A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'TUPRS.IS', name: 'Tüpras Türkiye Petrol Rafinerileri A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'ULKER.IS', name: 'Ülker Bisküvi Sanayi A.S.', country: 'TR', index: 'BIST 30' },
  { symbol: 'YKBNK.IS', name: 'Yapi ve Kredi Bankasi A.S.', country: 'TR', index: 'BIST 30' }
];

// Vollständige S&P 500 Liste (Ticker) als zuverlässige Basis + dynamischer Wikipedia-Abgleich
const SP500_TICKERS = [
  'MMM','AOS','ABT','ABBV','ACN','ADBE','AMD','AES','AFL','A','APD','ABNB','AKAM','ALB','ARE','ALGN','ALLE','LNT','ALL','GOOGL',
  'GOOG','MO','AMZN','AMCR','AEE','AEP','AXP','AIG','AMT','AWK','AMP','AME','AMGN','APH','ADI','AON','APA','APO','AAPL','AMAT',
  'APTV','ACGL','ADM','ANET','AJG','AIZ','T','ATO','ADSK','ADP','AZO','AVB','AVY','AXON','BKR','BALL','BAC','BAX','BDX','BRK-B',
  'BBY','TECH','BIIB','BLK','BX','BK','BA','BKNG','BSX','BMY','AVGO','BR','BRO','BF-B','BLDR','BG','BXP','CHRW','CDNS','CZR',
  'CPT','CPB','COF','CAH','KMX','CCL','CARR','CAT','CBOE','CBRE','CDW','COR','CNC','CNP','CF','CRL','SCHW','CHTR','CVX','CMG',
  'CB','CHD','CI','CINF','CTAS','CSCO','C','CFG','CLX','CME','CMS','KO','CTSH','CL','CMCSA','CAG','COP','ED','STZ','CEG','COO',
  'CPRT','GLW','CPAY','CTVA','CSGP','COST','CTRA','CRWD','CCI','CSX','CMI','CVS','DHR','DRI','DVA','DAY','DECK','DE','DELL','DAL',
  'DVN','DXCM','FANG','DLR','DG','DLTR','D','DPZ','DOV','DOW','DHI','DTE','DUK','DD','EMN','ETN','EBAY','ECL','EIX','EW','EA',
  'ELV','EMR','ENPH','ETR','EOG','EPAM','EQT','EFX','EQIX','EQR','ERIE','ESS','EL','EG','EVRG','ES','EXC','EXPE','EXPD','EXR',
  'XOM','FFIV','FDS','FICO','FAST','FRT','FDX','FIS','FITB','FSLR','FE','FI','F','FTNT','FTV','FOXA','FOX','BEN','FCX','GRMN',
  'IT','GE','GEHC','GEV','GEN','GNRC','GD','GIS','GM','GPC','GILD','GPN','GL','GDDY','GS','HAL','HIG','HAS','HCA','DOC','HSIC',
  'HSY','HPE','HLT','HOLX','HD','HON','HRL','HST','HWM','HPQ','HUBB','HUM','HBAN','HII','IBM','IEX','IDXX','ITW','INCY','IR',
  'PODD','INTC','ICE','IFF','IP','IPG','INTU','ISRG','IVZ','INVH','IQV','IRM','JBHT','JBL','JKHY','J','JNJ','JCI','JPM','K',
  'KVUE','KDP','KEY','KEYS','KMB','KIM','KMI','KKR','KLAC','KHC','KR','LHX','LH','LRCX','LW','LVS','LDOS','LEN','LII','LLY',
  'LIN','LYV','LKQ','LMT','L','LOW','LULU','LYB','MTB','MPC','MKTX','MAR','MMC','MLM','MAS','MA','MTCH','MKC','MCD','MCK',
  'MDT','MRK','META','MET','MTD','MGM','MCHP','MU','MSFT','MAA','MRNA','MHK','MOH','TAP','MDLZ','MPWR','MNST','MCO','MS','MOS',
  'MSI','MSCI','NDAQ','NTAP','NFLX','NEM','NWSA','NWS','NEE','NKE','NI','NDSN','NSC','NTRS','NOC','NCLH','NRG','NUE','NVDA','NVR',
  'NXPI','ORLY','OXY','ODFL','OMC','ON','OKE','ORCL','OTIS','PCAR','PKG','PLTR','PANW','PARA','PH','PAYX','PAYC','PYPL','PNR','PEP',
  'PFE','PCG','PM','PSX','PNW','PNC','POOL','PPG','PPL','PFG','PG','PGR','PLD','PRU','PEG','PTC','PSA','PHM','PWR','QCOM',
  'DGX','RL','RJF','RTX','O','REG','REGN','RF','RSG','RMD','RVTY','ROK','ROL','ROP','ROST','RCL','SPGI','CRM','SBAC','SLB',
  'STX','SRE','NOW','SHW','SPG','SWKS','SJM','SW','SNA','SOLV','SO','LUV','SWK','SBUX','STT','STLD','STE','SYK','SMCI','SYF',
  'SNPS','SYY','TMUS','TROW','TTWO','TPR','TRGP','TGT','TEL','TDY','TER','TSLA','TXN','TPL','TXT','TMO','TJX','TSCO','TT','TDG',
  'TRV','TRMB','TFC','TYL','TSN','USB','UBER','UDR','ULTA','UNP','UAL','UPS','URI','UNH','UHS','VLO','VTR','VLTO','VRSN','VRSK',
  'VZ','VRTX','VTRS','VICI','V','VST','VMC','WRB','GWW','WAB','WBA','WMT','DIS','WBD','WM','WAT','WEC','WFC','WELL','WST','WDC',
  'WY','WSM','WMB','WTW','WDAY','WYNN','XEL','XYL','YUM','ZBRA','ZBH','ZTS'
];

async function getSP500List() {
  try {
    const res = await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BuffettValueScanner/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      const tableMatch = html.match(/<table[^>]*id="constituents"[^>]*>([\s\S]*?)<\/table>/i);
      if (tableMatch) {
        const rows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
        const parsed = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
            m[1].replace(/<[^>]+>/g, '').trim()
          );
          if (cells.length >= 2 && cells[0]) {
            const sym = cells[0].replace(/\./g, '-');
            parsed.push({
              symbol: sym,
              name: cells[1] || sym,
              country: 'US',
              index: 'S&P 500'
            });
          }
        }
        if (parsed.length >= 450) {
          return parsed;
        }
      }
    }
  } catch (_) {
    // Fallback auf eingebaute Liste
  }
  return SP500_TICKERS.map(symbol => ({
    symbol,
    name: symbol,
    country: 'US',
    index: 'S&P 500'
  }));
}

async function getAllConstituents() {
  const sp500 = await getSP500List();
  return [...DAX_40, ...BIST_30, ...sp500];
}

module.exports = {
  DAX_40,
  BIST_30,
  SP500_TICKERS,
  getSP500List,
  getAllConstituents
};
