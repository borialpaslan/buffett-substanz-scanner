# Warren Buffett Substanz- & Insolvenzmasse-Scanner (DAX 40 · BIST 30 · S&P 500)

Täglicher Value-Investing-Scanner für **🇩🇪 Deutschland (DAX 40)**, **🇹🇷 Türkei (BIST 30)** und **🇺🇸 USA (S&P 500)** nach dem Substanz- und Liquidationswert-Prinzip von Benjamin Graham & Warren Buffett.

🌐 **Live auf Google Hosting:** [https://buffett-scanner-2026.web.app](https://buffett-scanner-2026.web.app)

## Features

- **4 umschaltbare Substanz-Bewertungsmodi**:
  1. **Netto-Insolvenzmasse (Standard)**: `(Materielles Anlagevermögen + Umlaufvermögen inkl. Cash − Alle Verbindlichkeiten) ≥ Marktkapitalisierung`
  2. **Strenger Netto-Wert**: `(Materielles Anlagevermögen + Liquide Mittel − Alle Verbindlichkeiten) ≥ Marktkapitalisierung`
  3. **Brutto-Substanz**: `(Materielles Anlagevermögen + Liquide Mittel) ≥ Marktkapitalisierung`
  4. **Klassischer Buchwert (KBV ≤ 1,0)**: `Eigenkapital ≥ Marktkapitalisierung`
- **Zukunfts- & Qualitäts-Check (Value-Trap-Warnsystem)**:
  - Automatischer 0–100 Punkte Score aus Gewinnwachstum (YoY), Free Cashflow, Eigenkapitalrendite (ROE), Gewinnmarge, Nettoverschuldung/EBITDA und 200-Tage-Kurstrend.
- **100 % Client-Side Realtime-Charts**:
  - Direkter Browser-WebSocket-Stream (`wss://streamer.finance.yahoo.com/`) mit Live-Liniendiagrammen in der Tabelle.
  - Interaktive **Google-Finance-Chartanalyse** (`1 T`, `5 T`, `1 M`, `6 M`, `seit Jahresbeginn`, `1 J`, `5 J`, `MAX`) mit Bereichs-/Kerzendiagramm, Volumen-Balken, GD 20 und Substanzwert-Linie.
- **Mobile-Optimiert**: Automatische Card-Ansicht auf Smartphones inkl. Touch-Fadenkreuz.

## Lokal starten

```bash
npm install
npm start
```

Öffnet den lokalen Server unter `http://localhost:3000`.
