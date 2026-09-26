import React, { useState, useMemo, useEffect } from 'react';
import rawData from './data/gasolio_mase.json';
import { fmtIt, calculateSurcharge, priceBracket, isPriceInBracket, getWeekMeta, toISODateString, getProvisionalMonth } from './utils/calculation';

// Componente Plotly ottimizzato per Vite
import Plotly from 'plotly.js-dist-min';
import createPlotlyComponent from 'react-plotly.js/factory';
const Plot = createPlotlyComponent(Plotly);

// Locale italiano per Plotly: il bundle `plotly.js-dist-min` non include i file di
// localizzazione, quindi senza registrazione la formattazione delle date (mesi/giorni
// sugli assi, slider e hover) usa il default "en-US" e mostra "Jan 2022", "Jul 2022", ecc.
// Definizione allineata al locale ufficiale `plotly-locale-it.js` di plotly.js.
Plotly.register({
  moduleType: "locale",
  name: "it",
  dictionary: {
    "Click to enter Plot title": "Clicca per inserire un titolo al grafico"
  },
  format: {
    days: ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"],
    shortDays: ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"],
    months: [
      "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
      "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"
    ],
    shortMonths: ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
    date: "%d/%m/%Y",
    decimal: ",",
    thousands: "."
  }
});

// Locale condiviso dai grafici: mesi e giorni in italiano.
// NB: va passato in `config.locale`, non in `layout.locale`: in Plotly 4 l'attributo
// di layout è deprecato e viene ignorato, mentre la formattazione legge `gd._context.locale`.
const plotlyLocale = "it";

import { 
  Sliders, TrendingUp, BarChart3, Search, 
  Calculator, BookOpen, ExternalLink, CheckCircle2,
  RotateCcw, Info, ChevronDown, ChevronUp, Hourglass
} from 'lucide-react';

const priceTypeOptions = {
  pompa: "Prezzo Globale (alla pompa)",
  imponibile: "Prezzo Imponibile (SENZA IVA con Accise)",
  netto: "Prezzo Netto Industriale (SENZA IVA e ACCISE)"
};

const priceKeys = {
  pompa: "prezzo_pompa",
  imponibile: "imponibile",
  netto: "netto"
};

// Interpreta un importo digitato in formato italiano ("2,100" / "2.100" / "2.1") -> numero
const parseItAmount = (raw) => {
  const cleaned = String(raw).replace(/\s/g, "");
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const n = parseFloat(normalized);
  return isNaN(n) ? null : n;
};

export default function App() {
  const weeklyList = useMemo(() => rawData.weekly_history || [], []);
  const monthlyList = useMemo(() => rawData.monthly_history || [], []);
  const annualDict = useMemo(() => rawData.annual_averages || {}, []);

  // --- CALCOLO LIMITE MASSIMO DATA REALE (Ultima Domenica Rilevata) ---
  const { maxAvailDateISO, defaultMonthStartISO } = useMemo(() => {
    if (!weeklyList.length) {
      const today = new Date();
      const iso = toISODateString(today);
      return { maxAvailDateISO: iso, defaultMonthStartISO: iso };
    }
    const lastMeta = getWeekMeta(weeklyList[weeklyList.length - 1].data);
    const endISO = lastMeta.obsEndISO; // Es: 2026-08-30 (Domenica)
    const [y, m] = endISO.split("-");
    
    // Inizio del mese relativo all'ultima domenica
    const startOfMonthISO = `${y}-${m}-01`;

    return {
      maxAvailDateISO: endISO,
      defaultMonthStartISO: startOfMonthISO
    };
  }, [weeklyList]);

  // --- STATO REATTIVO PRINCIPALE ---
  const [priceType, setPriceType] = useState(() => {
    const p = new URLSearchParams(window.location.search).get("price_type");
    return p && priceTypeOptions[p] ? p : "pompa";
  });
  
  const [fuelWeight, setFuelWeight] = useState(() => {
    const w = parseInt(new URLSearchParams(window.location.search).get("weight"), 10);
    return !isNaN(w) && w >= 1 && w <= 100 ? w : 30;
  });

  // Periodo Target (Base)
  const [targetMode, setTargetMode] = useState("Anno solare"); // "Anno solare", "Singolo Mese", "Range personalizzato"
  const [selYear, setSelYear] = useState("2025");

  // Calcolo indice di default per "Singolo Mese": Dicembre dell'ultimo anno solare consolidato
  const defaultTargetMonthIdx = useMemo(() => {
    if (!monthlyList.length) return 0;
    const reversedMonthly = [...monthlyList].reverse();
    const annualYears = Object.keys(annualDict).map(Number).filter((y) => !isNaN(y));
    const maxConsolidatedYear = annualYears.length > 0 ? Math.max(...annualYears) : 2025;
    const decIdx = reversedMonthly.findIndex((m) => m.anno === maxConsolidatedYear && m.mese === 12);
    if (decIdx !== -1) return decIdx;
    const fallbackIdx = reversedMonthly.findIndex((m) => m.mese === 12);
    return fallbackIdx !== -1 ? fallbackIdx : 0;
  }, [monthlyList, annualDict]);

  const [selTargetMonthIdx, setSelTargetMonthIdx] = useState(defaultTargetMonthIdx);
  const [tgtStartDate, setTgtStartDate] = useState("2025-01-01");
  const [tgtEndDate, setTgtEndDate] = useState("2025-12-31");

  const handleTargetModeChange = (newMode) => {
    setTargetMode(newMode);
    if (newMode === "Singolo Mese") {
      setSelTargetMonthIdx(defaultTargetMonthIdx);
    }
  };

  // Granularità del grafico trend Surcharge
  const [trendGranularity, setTrendGranularity] = useState("Mensile");

  // Tab attivo nella sezione archivio MASE (in fondo)
  const [archiveTab, setArchiveTab] = useState("chart");

  // Matrice a scaglioni: vista estesa a tutte le righe (condivisibile via URL ?matrice=full)
  const [matrixExpanded, setMatrixExpanded] = useState(() => {
    return new URLSearchParams(window.location.search).get("matrice") === "full";
  });

  // --- STATO QUICK LOOKUP ---
  const [lookupMode, setLookupMode] = useState("Intervallo Date");
  const [lkStartDate, setLkStartDate] = useState(() => defaultMonthStartISO);
  const [lkEndDate, setLkEndDate] = useState(() => maxAvailDateISO);
  const [lkYear, setLkYear] = useState("2025");
  const [lkMonthIdx, setLkMonthIdx] = useState(0);
  const [lkWeekIdx, setLkWeekIdx] = useState(0);
  const [lkExactDate, setLkExactDate] = useState(() => maxAvailDateISO);

  // Aggiorna le date di lookup all'avvio
  useEffect(() => {
    if (maxAvailDateISO) {
      setLkEndDate(maxAvailDateISO);
      setLkExactDate(maxAvailDateISO);
      setLkStartDate(defaultMonthStartISO);
    }
  }, [maxAvailDateISO, defaultMonthStartISO]);

  // --- STATO LABORATORIO DI CALCOLO & SIMULATORE COMPLETO ---
  const [labPriceType, setLabPriceType] = useState(() => priceType);
  const [labWeight, setLabWeight] = useState(() => fuelWeight);

  // Colonna 1: Base di Partenza (Target)
  const [labTargetMode, setLabTargetMode] = useState("Anno solare"); // "Anno solare", "Singolo Mese", "Range personalizzato", "Valore Libero"
  const [labTargetYear, setLabTargetYear] = useState("2025");
  const [labTargetMonthIdx, setLabTargetMonthIdx] = useState(0);
  const [labTargetStartDate, setLabTargetStartDate] = useState("2025-01-01");
  const [labTargetEndDate, setLabTargetEndDate] = useState("2025-12-31");
  const [labCustomBasePrice, setLabCustomBasePrice] = useState(1.650);

  // Colonna 2: Periodo da Valutare (Rilevazione)
  const [labEvalMode, setLabEvalMode] = useState("Mese Storico"); // "Mese Storico", "Settimana", "Valore Libero"
  const [labEvalMonthIdx, setLabEvalMonthIdx] = useState(0); // 0 = ultimo mese consolidato
  const [labEvalWeekIdx, setLabEvalWeekIdx] = useState(0); // 0 = ultima settimana
  const [labCustomEvalPrice, setLabCustomEvalPrice] = useState(1.628);

  // Buffer di digitazione dei due campi prezzo (per mostrare 3 decimali a riposo, "2,100")
  const [labBaseDraft, setLabBaseDraft] = useState(null);
  const [labEvalDraft, setLabEvalDraft] = useState(null);

  // Sincronizzazione parametri URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("price_type", priceType);
    params.set("weight", fuelWeight.toString());
    if (matrixExpanded) {
      params.set("matrice", "full");
    } else {
      params.delete("matrice");
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }, [priceType, fuelWeight, matrixExpanded]);

  const activeKey = priceKeys[priceType];

  // Data ultima rilevazione MASE per l'header
  const lastUpdateDateStr = useMemo(() => {
    if (!weeklyList.length) return "N/D";
    const raw = weeklyList[weeklyList.length - 1].data;
    const parts = raw.split("-");
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return raw;
  }, [weeklyList]);

  // --- CALCOLO PREZZO TARGET (ANNO, MESE O RANGE PERSONALIZZATO) ---
  const { targetPrice, targetPricePompa, targetPriceNetto, targetLabel, targetEndDate } = useMemo(() => {
    if (targetMode === "Anno solare") {
      const row = annualDict[selYear] || {};
      return {
        targetPrice: row[activeKey] || 1.650,
        targetPricePompa: row.prezzo_pompa || 1.650,
        targetPriceNetto: row.netto || 0.720,
        targetLabel: `Media Anno ${selYear}`,
        targetEndDate: new Date(Number(selYear), 11, 31)
      };
    } else if (targetMode === "Singolo Mese") {
      const reversedMonthly = [...monthlyList].reverse();
      const record = reversedMonthly[selTargetMonthIdx] || reversedMonthly[0];
      const y = record?.anno || 2025;
      const m = record?.mese || 1;
      return {
        targetPrice: record ? record[activeKey] : 1.650,
        targetPricePompa: record ? record.prezzo_pompa : 1.650,
        targetPriceNetto: record ? record.netto : 0.720,
        targetLabel: `Media ${record?.nome_mese} ${y}`,
        targetEndDate: new Date(y, m, 0)
      };
    } else {
      // Range Personalizzato (da / a)
      const matched = weeklyList.filter((item) => {
        const meta = getWeekMeta(item.data);
        return meta.obsEndISO >= tgtStartDate && meta.obsStartISO <= tgtEndDate;
      });

      const [sY, sM, sD] = tgtStartDate.split("-");
      const [eY, eM, eD] = tgtEndDate.split("-");
      const label = `Media ${sD}/${sM}/${sY.slice(2)} - ${eD}/${eM}/${eY.slice(2)}`;

      if (matched.length === 0) {
        return {
          targetPrice: 1.650,
          targetPricePompa: 1.650,
          targetPriceNetto: 0.720,
          targetLabel: label,
          targetEndDate: new Date(tgtEndDate)
        };
      }

      const count = matched.length;
      return {
        targetPrice: matched.reduce((acc, r) => acc + r[activeKey], 0) / count,
        targetPricePompa: matched.reduce((acc, r) => acc + r.prezzo_pompa, 0) / count,
        targetPriceNetto: matched.reduce((acc, r) => acc + r.netto, 0) / count,
        targetLabel: label,
        targetEndDate: new Date(tgtEndDate)
      };
    }
  }, [targetMode, selYear, selTargetMonthIdx, tgtStartDate, tgtEndDate, activeKey, annualDict, monthlyList, weeklyList]);


  // --- CALCOLO DEI 3 RIFERIMENTI OPERATIVI LIVE ---
  const liveData = useMemo(() => {
    // 1. Ultimo Mese Consolidato
    let monthPrice = 0;
    let monthTitle = "N/D";
    let monthDelta = 0;
    let monthSurcharge = 0;

    if (monthlyList.length > 0) {
      const lastM = monthlyList[monthlyList.length - 1];
      monthPrice = lastM[activeKey] || 0;
      monthTitle = `${lastM.nome_mese} ${lastM.anno}`;
      const res = calculateSurcharge(targetPrice, monthPrice, fuelWeight);
      monthDelta = res.deltaPct;
      monthSurcharge = res.surchargePct;
    }

    // 2. Mese Corrente (Provvisorio) - logica condivisa con il Simulatore (unica fonte di verità)
    let hasProvisional = false;
    let provPrice = 0;
    let provTitle = "N/D";
    let provCount = 0;
    let provDelta = 0;
    let provSurcharge = 0;

    const provisional = getProvisionalMonth(weeklyList, monthlyList, activeKey);
    if (provisional) {
      hasProvisional = true;
      provCount = provisional.count;
      provTitle = provisional.title;
      provPrice = provisional.price;
      const res = calculateSurcharge(targetPrice, provPrice, fuelWeight);
      provDelta = res.deltaPct;
      provSurcharge = res.surchargePct;
    }

    // 3. Ultima Settimana Rilevata
    let weekPrice = 0;
    let weekTitle = "N/D";
    let weekSub = "";
    let weekDelta = 0;
    let weekSurcharge = 0;

    if (weeklyList.length > 0) {
      const lastW = weeklyList[weeklyList.length - 1];
      weekPrice = lastW[activeKey] || 0;
      const meta = getWeekMeta(lastW.data);
      if (meta.isoWeek && meta.isoYear) {
        weekTitle = `week ${String(meta.isoWeek).padStart(2, "0")}/${String(meta.isoYear).slice(-2)}`;
      }
      const s = meta.obsStart;
      const e = meta.obsEnd;
      if (s && e) {
        const sStr = `${String(s.getDate()).padStart(2, "0")}/${String(s.getMonth() + 1).padStart(2, "0")}`;
        const eStr = `${String(e.getDate()).padStart(2, "0")}/${String(e.getMonth() + 1).padStart(2, "0")}`;
        weekSub = `${sStr} - ${eStr}`;
      }
      const res = calculateSurcharge(targetPrice, weekPrice, fuelWeight);
      weekDelta = res.deltaPct;
      weekSurcharge = res.surchargePct;
    }

    return {
      monthPrice,
      monthTitle,
      monthDelta,
      monthSurcharge,
      hasProvisional,
      provPrice,
      provTitle,
      provCount,
      provDelta,
      provSurcharge,
      weekPrice,
      weekTitle,
      weekSub,
      weekDelta,
      weekSurcharge
    };
  }, [monthlyList, weeklyList, activeKey, targetPrice, fuelWeight]);

  // --- RIGHE MATRICE A SCAGLIONI (PASSI DA 0,5% CON PARTENZA DA 0,00% A SALIRE) ---
  // Fasce discrete al millesimo di euro (0,001 €): l'estremo inferiore di ogni scaglione
  // riparte esattamente da +0,001 € rispetto all'estremo superiore dello scaglione precedente.
  const bracketRows = useMemo(() => {
    const { monthPrice, hasProvisional, provPrice, weekPrice, monthSurcharge, provSurcharge, weekSurcharge } = liveData;

    const surcharges = [monthSurcharge, weekSurcharge];
    if (hasProvisional) surcharges.push(provSurcharge);

    const maxSur = Math.max(...surcharges, 4.0);
    const lowerBound = 0.0;
    // Base 41 righe (0,00% -> 20,00%): si estende solo se un riferimento cade oltre il 20%
    const upperBound = Math.max(20.0, Math.ceil((maxSur + 0.75) * 2) / 2);

    const steps = [];
    for (let s = lowerBound; s <= upperBound + 0.001; s = Number((s + 0.5).toFixed(2))) {
      steps.push(s);
    }

    return steps.reduce((rows, s) => {
      // Il minimo di ogni riga è incatenato al massimo della precedente (+0,001 €)
      const prevMax = rows.length > 0 ? rows[rows.length - 1].pMax : null;
      const [pMin, pMax] = priceBracket(targetPrice, s, fuelWeight, prevMax);
      const isBase = Math.abs(s) < 0.0001;
      rows.push({
        s,
        pMin,
        pMax,
        isBase,
        matchMonth: isPriceInBracket(monthPrice, pMin, pMax),
        matchWeek: isPriceInBracket(weekPrice, pMin, pMax),
        matchProv: hasProvisional && isPriceInBracket(provPrice, pMin, pMax)
      });
      return rows;
    }, []);
  }, [liveData, targetPrice, fuelWeight]);

  // --- FINESTRA DI DEFAULT MATRICE: RIGHE DEI RIFERIMENTI ± 2 SCAGLIONI ---
  const matrixWindow = useMemo(() => {
    const anchorIdxs = [];
    bracketRows.forEach((row, idx) => {
      if (row.matchMonth || row.matchWeek || row.matchProv) anchorIdxs.push(idx);
    });
    if (anchorIdxs.length === 0) return { start: 0, end: bracketRows.length - 1 };
    return {
      start: Math.max(0, Math.min(...anchorIdxs) - 2),
      end: Math.min(bracketRows.length - 1, Math.max(...anchorIdxs) + 2)
    };
  }, [bracketRows]);

  // Conteggio righe fuori finestra e visibilità effettiva (tutte se espanso o se non c'è nulla da nascondere)
  const matrixHiddenCount = bracketRows.length - (matrixWindow.end - matrixWindow.start + 1);
  const matrixShowAll = matrixExpanded || matrixHiddenCount === 0;

  // --- DATI PER GRAFICO TREND SURCHARGE (Post Periodo Target) ---
  const surchargeTrendData = useMemo(() => {
    const points = [];
    if (trendGranularity === "Mensile") {
      monthlyList.forEach((row) => {
        const rowDate = new Date(row.anno, row.mese, 0);
        if (rowDate > targetEndDate) {
          const dPompaPct = ((row.prezzo_pompa - targetPricePompa) / targetPricePompa) * 100;
          const surPompa = dPompaPct * (fuelWeight / 100.0);
          const dNettoPct = ((row.netto - targetPriceNetto) / targetPriceNetto) * 100;
          const surNetto = dNettoPct * (fuelWeight / 100.0);
          points.push({
            label: `${row.nome_mese.slice(0, 3)} ${row.anno}`,
            surPompa,
            surNetto
          });
        }
      });
    } else {
      weeklyList.forEach((row) => {
        const meta = getWeekMeta(row.data);
        if (meta.obsEnd > targetEndDate) {
          const dPompaPct = ((row.prezzo_pompa - targetPricePompa) / targetPricePompa) * 100;
          const surPompa = dPompaPct * (fuelWeight / 100.0);
          const dNettoPct = ((row.netto - targetPriceNetto) / targetPriceNetto) * 100;
          const surNetto = dNettoPct * (fuelWeight / 100.0);
          points.push({
            label: `week ${String(meta.isoWeek).padStart(2, '0')}/${String(meta.isoYear).slice(-2)}`,
            surPompa,
            surNetto
          });
        }
      });
    }
    return points;
  }, [trendGranularity, monthlyList, weeklyList, targetEndDate, targetPricePompa, targetPriceNetto, fuelWeight]);

  // --- DATI QUICK LOOKUP ---
  const lookupResult = useMemo(() => {
    if (lookupMode === "Intervallo Date") {
      const matched = weeklyList.filter((item) => {
        const meta = getWeekMeta(item.data);
        return meta.obsEndISO >= lkStartDate && meta.obsStartISO <= lkEndDate;
      });
      if (matched.length === 0) return null;
      const count = matched.length;
      return {
        pompa: matched.reduce((acc, r) => acc + r.prezzo_pompa, 0) / count,
        imponibile: matched.reduce((acc, r) => acc + r.imponibile, 0) / count,
        netto: matched.reduce((acc, r) => acc + r.netto, 0) / count,
        accisa: matched.reduce((acc, r) => acc + r.accisa, 0) / count,
        iva: matched.reduce((acc, r) => acc + r.iva, 0) / count,
        detailText: `Media calcolata su ${count} rilevazioni settimanali nel range selezionato.`
      };
    } else if (lookupMode === "Anno solare") {
      const res = annualDict[lkYear] || {};
      return {
        pompa: res.prezzo_pompa || 0,
        imponibile: res.imponibile || 0,
        netto: res.netto || 0,
        accisa: res.accisa || 0,
        iva: res.iva || 0,
        detailText: `Dato aggregato annuale ufficiale MASE per l'anno ${lkYear}`
      };
    } else if (lookupMode === "Singolo Mese") {
      const reversed = [...monthlyList].reverse();
      const m = reversed[lkMonthIdx] || reversed[0];
      return {
        pompa: m.prezzo_pompa,
        imponibile: m.imponibile,
        netto: m.netto,
        accisa: m.accisa,
        iva: m.iva,
        detailText: `Dato consolidato mensile ufficiale MASE per ${m.nome_mese} ${m.anno}`
      };
    } else if (lookupMode === "Settimana Specifica") {
      const reversed = [...weeklyList].reverse();
      const w = reversed[lkWeekIdx] || reversed[0];
      const meta = getWeekMeta(w.data);
      return {
        pompa: w.prezzo_pompa,
        imponibile: w.imponibile,
        netto: w.netto,
        accisa: w.accisa,
        iva: w.iva,
        detailText: `Rilevazione ufficiale ministeriale: ${meta.label}`
      };
    } else {
      // Data Esatta (Giorno)
      let matched = weeklyList.find((w) => {
        const meta = getWeekMeta(w.data);
        return lkExactDate >= meta.obsStartISO && lkExactDate <= meta.obsEndISO;
      }) || weeklyList[weeklyList.length - 1];
      const meta = getWeekMeta(matched.data);
      const [y, m, d] = lkExactDate.split("-");
      return {
        pompa: matched.prezzo_pompa,
        imponibile: matched.imponibile,
        netto: matched.netto,
        accisa: matched.accisa,
        iva: matched.iva,
        detailText: `Giorno richiesto: ${d}/${m}/${y} • Rilevazione MASE di riferimento in vigore: ${meta.label}`
      };
    }
  }, [lookupMode, lkStartDate, lkEndDate, lkYear, lkMonthIdx, lkWeekIdx, lkExactDate, weeklyList, monthlyList, annualDict]);

  const labActiveKey = priceKeys[labPriceType] || "prezzo_pompa";

  // Mese in corso provvisorio (media delle settimane non ancora consolidate) per la base selezionata nel laboratorio
  const labProvisional = useMemo(() => {
    return getProvisionalMonth(weeklyList, monthlyList, labActiveKey);
  }, [weeklyList, monthlyList, labActiveKey]);

  // Calcolo Prezzo Base (Target) del Laboratorio
  const { labBasePrice, labTargetLabel } = useMemo(() => {
    if (labTargetMode === "Valore Libero") {
      return {
        labBasePrice: labCustomBasePrice,
        labTargetLabel: "Valore personalizzato"
      };
    }
    if (labTargetMode === "Anno solare") {
      const p = annualDict[labTargetYear]?.[labActiveKey] || 0;
      return {
        labBasePrice: Number(p.toFixed(3)),
        labTargetLabel: `Media Anno ${labTargetYear}`
      };
    }
    if (labTargetMode === "Singolo Mese") {
      const reversed = [...monthlyList].reverse();
      const m = reversed[labTargetMonthIdx];
      const p = m?.[labActiveKey] || 0;
      return {
        labBasePrice: Number(p.toFixed(3)),
        labTargetLabel: m ? `${m.nome_mese} ${m.anno}` : ""
      };
    }
    if (labTargetMode === "Range personalizzato") {
      const start = new Date(labTargetStartDate);
      const end = new Date(labTargetEndDate);
      const matched = weeklyList.filter((r) => {
        const d = new Date(r.data);
        return d >= start && d <= end;
      });
      const p = matched.length > 0 ? (matched.reduce((acc, r) => acc + (r[labActiveKey] || 0), 0) / matched.length) : 0;
      const [sY, sM, sD] = labTargetStartDate.split("-");
      const [eY, eM, eD] = labTargetEndDate.split("-");
      return {
        labBasePrice: Number(p.toFixed(3)),
        labTargetLabel: `Media ${sD}/${sM}/${sY?.slice(-2)} - ${eD}/${eM}/${eY?.slice(-2)}`
      };
    }
    return { labBasePrice: labCustomBasePrice, labTargetLabel: "" };
  }, [labTargetMode, labTargetYear, labTargetMonthIdx, labTargetStartDate, labTargetEndDate, labCustomBasePrice, labActiveKey, annualDict, monthlyList, weeklyList]);

  // Calcolo Prezzo Rilevato del Laboratorio
  const { labEvalPrice, labEvalLabel } = useMemo(() => {
    if (labEvalMode === "Valore Libero") {
      return {
        labEvalPrice: labCustomEvalPrice,
        labEvalLabel: "Valore personalizzato"
      };
    }
    if (labEvalMode === "Mese Storico") {
      const reversed = [...monthlyList].reverse();
      const m = reversed[labEvalMonthIdx];
      const p = m?.[labActiveKey] || 0;
      return {
        labEvalPrice: Number(p.toFixed(3)),
        labEvalLabel: m ? `${m.nome_mese} ${m.anno}` : ""
      };
    }
    if (labEvalMode === "Settimana") {
      const reversed = [...weeklyList].reverse();
      const w = reversed[labEvalWeekIdx];
      const p = w?.[labActiveKey] || 0;
      const meta = w ? getWeekMeta(w.data) : null;
      return {
        labEvalPrice: Number(p.toFixed(3)),
        labEvalLabel: meta ? `Settimana ${meta.weekNumber}/${meta.yearShort} (${meta.subText})` : ""
      };
    }
    if (labEvalMode === "Mese Provvisorio") {
      if (!labProvisional) {
        return {
          labEvalPrice: labCustomEvalPrice,
          labEvalLabel: "Nessun mese in corso provvisorio disponibile"
        };
      }
      return {
        labEvalPrice: Number(labProvisional.price.toFixed(3)),
        labEvalLabel: `${labProvisional.title} - provvisorio (${labProvisional.count} rilevazioni)`
      };
    }
    return { labEvalPrice: labCustomEvalPrice, labEvalLabel: "" };
  }, [labEvalMode, labEvalMonthIdx, labEvalWeekIdx, labCustomEvalPrice, labActiveKey, monthlyList, weeklyList, labProvisional]);

  // Calcolo Risultato Surcharge nel Laboratorio
  const labResult = useMemo(() => {
    const { deltaPct: lDeltaPct, surchargePct: lSurPct } = calculateSurcharge(labBasePrice, labEvalPrice, labWeight);
    const lStep = Math.round(lSurPct * 2) / 2;
    const [pMin, pMax] = priceBracket(labBasePrice, lStep, labWeight);
    return { lDeltaPct, lSurPct, lStep, pMin, pMax };
  }, [labBasePrice, labEvalPrice, labWeight]);

  // Funzione per copiare istantaneamente i parametri del contratto principale nel laboratorio
  const syncWithContract = () => {
    setLabPriceType(priceType);
    setLabWeight(fuelWeight);
    setLabTargetMode(targetMode);
    setLabTargetYear(selYear);
    setLabTargetMonthIdx(selTargetMonthIdx);
    setLabTargetStartDate(tgtStartDate);
    setLabTargetEndDate(tgtEndDate);
    if (targetPrice > 0) {
      setLabCustomBasePrice(Number(targetPrice.toFixed(3)));
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans pb-16 antialiased selection:bg-sky-500 selection:text-white">
      
      {/* 1. TOP BAR BRAND (PULITA, ISTITUZIONALE E AUTOREVOLE) */}
      <header className="bg-white border-b border-slate-200/90 shadow-xs sticky top-0 z-50 font-titillium">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-row items-center justify-between gap-4">
          <div className="flex flex-col justify-center">
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 leading-tight">
              FUEL SURCHARGE ITALIA
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <img 
                src="https://upload.wikimedia.org/wikipedia/commons/0/00/Emblem_of_Italy.svg" 
                alt="Repubblica Italiana" 
                className="w-4 h-4 object-contain opacity-95 shrink-0"
              />
              <span className="text-xs font-semibold text-slate-600 tracking-normal">
                Dati Ufficiali MASE (DGSAIE) • Ultimo aggiornamento: {lastUpdateDateStr}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 pt-4 md:pt-6 space-y-6">

        {/* 1. PANNELLO PARAMETRI DI BASE */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5 pb-3 border-b border-slate-100">
            <Sliders className="w-5 h-5 text-sky-600" />
            <h2 className="font-bold text-slate-800 text-base md:text-lg">
              PARAMETRI BASELINE
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Colonna Sinistra: Parametri Economici */}
            <div className="space-y-4">
              {/* Base di Prezzo Ministeriale */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Tipologia Prezzo Ministeriale
                </label>
                <select
                  value={priceType}
                  onChange={(e) => setPriceType(e.target.value)}
                  className="w-full h-[42px] bg-slate-50 border border-slate-300 rounded-xl px-3.5 font-semibold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none text-sm"
                >
                  {Object.entries(priceTypeOptions).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Incidenza Costo Gasolio */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Incidenza costo gasolio (%)
                </label>
                <select
                  value={fuelWeight}
                  onChange={(e) => setFuelWeight(Number(e.target.value))}
                  className="w-full h-[42px] bg-slate-50 border border-slate-300 rounded-xl px-3.5 font-semibold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none text-sm"
                >
                  {Array.from({ length: 100 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}%</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Colonna Destra: Riferimento Temporale Target */}
            <div className="space-y-4">
              {/* Modalità Periodo Base */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Modalità Periodo Baseline
                </label>
                <select
                  value={targetMode}
                  onChange={(e) => handleTargetModeChange(e.target.value)}
                  className="w-full h-[42px] bg-slate-50 border border-slate-300 rounded-xl px-3.5 font-semibold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none text-sm"
                >
                  <option value="Anno solare">Media Annuale</option>
                  <option value="Singolo Mese">Media Mensile</option>
                  <option value="Range personalizzato">Media Intervallo Personalizzato (da/a)</option>
                </select>
              </div>

              {/* Periodo Target Specifico */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  {targetMode === "Anno solare" && "Baseline di Riferimento"}
                  {targetMode === "Singolo Mese" && "Mese Storico di Riferimento:"}
                  {targetMode === "Range personalizzato" && "Intervallo Date di Riferimento:"}
                </label>
                {targetMode === "Anno solare" && (
                  <select
                    value={selYear}
                    onChange={(e) => setSelYear(e.target.value)}
                    className="w-full h-[42px] bg-sky-50/60 border border-sky-200 rounded-xl px-3.5 font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none text-sm shadow-xs transition-colors"
                  >
                    {Object.keys(annualDict).sort((a,b) => b - a).map((y) => (
                      <option key={y} value={y}>Media Anno {y} ({fmtIt(annualDict[y]?.[activeKey] || 0)} €/L)</option>
                    ))}
                  </select>
                )}

                {targetMode === "Singolo Mese" && (
                  <select
                    value={selTargetMonthIdx}
                    onChange={(e) => setSelTargetMonthIdx(Number(e.target.value))}
                    className="w-full h-[42px] bg-sky-50/90 border border-sky-300 rounded-xl px-3.5 font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none text-sm shadow-xs transition-colors"
                  >
                    {[...monthlyList].reverse().map((m, idx) => (
                      <option key={`tgt-${m.anno}-${m.mese}`} value={idx}>
                        {m.nome_mese} {m.anno} ({fmtIt(m[activeKey])} €/L)
                      </option>
                    ))}
                  </select>
                )}

                {targetMode === "Range personalizzato" && (
                  <div className="grid grid-cols-2 gap-2">
                    <input 
                      type="date"
                      max={maxAvailDateISO}
                      value={tgtStartDate}
                      onChange={(e) => setTgtStartDate(e.target.value)}
                      className="w-full h-[42px] bg-sky-50/90 border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none shadow-xs transition-colors"
                    />
                    <input 
                      type="date"
                      max={maxAvailDateISO}
                      value={tgtEndDate}
                      onChange={(e) => setTgtEndDate(e.target.value)}
                      className="w-full h-[42px] bg-sky-50/90 border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none shadow-xs transition-colors"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 2. LA STANZA OPERATIVA DEL FUEL SURCHARGE */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm space-y-6">
          
          <div>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="font-bold text-slate-900 text-lg md:text-xl">
                  QUADRO FUEL SURCHARGE ATTUALE
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Adeguamento tariffario calcolato sulle rilevazioni ministeriali attuali rispetto alla baseline di {fmtIt(targetPrice, 3)} €/L ({targetLabel}).
                </p>
              </div>
            </div>

            {/* I 3 CARD OPERATIVI */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-5">
              
              {/* 1. Ultimo Mese Consolidato */}
              <div className="bg-sky-50/60 text-slate-900 rounded-2xl p-5 border border-sky-200 shadow-xs h-full flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold tracking-wider text-slate-700 uppercase mb-1.5">
                    MENSILE CONSOLIDATO
                  </div>
                  <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <span>{liveData.monthTitle}</span>
                    <Info className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  </div>
                  <div className={`text-3xl md:text-4xl font-black tracking-tight my-2.5 ${
                    liveData.monthSurcharge > 0.0001 ? 'text-red-700' : 'text-slate-900'
                  }`}>
                    {fmtIt(liveData.monthSurcharge, 2, true)} %
                  </div>
                </div>
                <div className="pt-3 border-t border-sky-200 text-xs text-slate-600 space-y-1">
                  <div className="flex justify-between">
                    <span>Prezzo Medio:</span>
                    <b className="text-slate-600 font-semibold">{fmtIt(liveData.monthPrice, 3)} €/L</b>
                  </div>
                  <div className="flex justify-between">
                    <span>Variazione Prezzo (Δ):</span>
                    <b className="text-slate-600 font-semibold">{fmtIt(liveData.monthDelta, 2, true)}%</b>
                  </div>
                  <div className="text-xs text-slate-900 pt-1 flex items-start gap-1.5 min-h-[2rem]">
                    <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                    <span className="font-bold">convenzionalmente valido per la fatturazione del mese successivo</span>
                  </div>
                </div>
              </div>

              {/* 2. Ultima Settimana Consolidata */}
              <div className="bg-white text-slate-900 rounded-2xl p-5 border border-slate-200 shadow-xs h-full flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold tracking-wider text-slate-700 uppercase mb-1.5">
                    SETTIMANALE
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {liveData.weekTitle} {liveData.weekSub && `(${liveData.weekSub})`}
                  </div>
                  <div className="text-3xl md:text-4xl font-black tracking-tight my-2.5 text-slate-900">
                    {fmtIt(liveData.weekSurcharge, 2, true)} %
                  </div>
                </div>
                <div className="pt-3 border-t border-slate-200 text-xs text-slate-600 space-y-1">
                  <div className="flex justify-between">
                    <span>Prezzo Medio:</span>
                    <b className="text-slate-600 font-semibold">{fmtIt(liveData.weekPrice, 3)} €/L</b>
                  </div>
                  <div className="flex justify-between">
                    <span>Variazione Prezzo (Δ):</span>
                    <b className="text-slate-600 font-semibold">{fmtIt(liveData.weekDelta, 2, true)}%</b>
                  </div>
                  <div className="min-h-[2rem] pt-1" aria-hidden="true"></div>
                </div>
              </div>

              {/* 3. Mese in Corso (Stima Provvisoria) */}
              <div className="bg-white text-slate-900 rounded-2xl p-5 border border-slate-200 shadow-xs h-full flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold tracking-wider text-slate-700 uppercase mb-1.5">
                    MENSILE PROVVISORIO
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {liveData.hasProvisional ? (
                      <><span className="whitespace-nowrap">{liveData.provTitle} <Hourglass className="inline-block w-3.5 h-3.5 text-slate-400 align-[-2px]" /></span> ({liveData.provCount} rilevazioni)</>
                    ) : "Nessun dato provvisorio"}
                  </div>
                  {liveData.hasProvisional ? (
                    <div className="text-3xl md:text-4xl font-black tracking-tight my-2.5 text-slate-900">
                      {fmtIt(liveData.provSurcharge, 2, true)} %
                    </div>
                  ) : (
                    <div className="text-2xl font-bold text-slate-400 my-4">
                      —
                    </div>
                  )}
                </div>
                <div className="pt-3 border-t border-slate-200 text-xs text-slate-600 space-y-1">
                  {liveData.hasProvisional ? (
                    <>
                      <div className="flex justify-between">
                        <span>Media Parziale:</span>
                        <b className="text-slate-600 font-semibold">{fmtIt(liveData.provPrice, 3)} €/L</b>
                      </div>
                      <div className="flex justify-between">
                        <span>Variazione Prezzo (Δ):</span>
                        <b className="text-slate-600 font-semibold">{fmtIt(liveData.provDelta, 2, true)}%</b>
                      </div>
                      <div className="min-h-[2rem] pt-1" aria-hidden="true"></div>
                    </>
                  ) : (
                    <div className="text-[11px] text-slate-500 min-h-[2rem] pt-1 flex items-center">
                      Tutte le settimane del mese sono già state consolidate.
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* MATRICE A SCAGLIONI CONTRATTUALE */}
          <div className="pt-4 border-t border-slate-100">
            <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
              <div>
                <h4 className="font-bold text-slate-800 text-base">
                  MATRICE A SCAGLIONI
                </h4>
                <p className="text-xs text-slate-500">
                  Scaglioni Fuel Surcharge (step 0,50%) calcolati rispetto alla baseline di {fmtIt(targetPrice, 3)} €/L ({targetLabel}).
                </p>
              </div>
              {matrixHiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setMatrixExpanded((v) => !v)}
                  aria-expanded={matrixShowAll}
                  aria-controls="matrice-scaglioni-body"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-xl transition-all shadow-2xs cursor-pointer"
                >
                  {matrixShowAll
                    ? <ChevronUp className="w-3.5 h-3.5 text-slate-700" />
                    : <ChevronDown className="w-3.5 h-3.5 text-slate-700" />}
                  {matrixShowAll
                    ? "Comprimi Matrice"
                    : "Espandi Matrice"}
                </button>
              )}
            </div>

            <div className="overflow-x-auto md:overflow-x-visible rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs md:text-sm border-collapse min-w-[650px]">
                <thead className="shadow-xs">
                  <tr className="bg-slate-100 text-slate-700 text-xs uppercase tracking-wider border-b border-slate-200">
                    <th rowSpan="2" className="py-1.5 px-3 font-bold align-top border-r border-slate-200/80 bg-slate-100">
                      Fascia Prezzo Gasolio
                    </th>
                    <th rowSpan="2" className="py-1.5 px-3 font-bold text-center align-top border-r border-slate-200/80 bg-slate-100">
                      Fuel Surcharge
                    </th>
                    <th colSpan="3" className="py-1.5 px-3 font-bold text-center border-b border-slate-200 bg-slate-100">
                      Riferimenti Rilevati
                    </th>
                  </tr>
                  <tr className="bg-slate-50 text-slate-600 text-[11px] font-semibold border-b border-slate-200">
                    <th className="py-1 px-3 text-center align-top border-r border-slate-200/60 w-1/5 bg-slate-50">
                      <div>MENSILE CONSOLIDATO</div>
                      <div className="text-[11px] font-semibold text-slate-600">{liveData.monthTitle}</div>
                    </th>
                    <th className="py-1 px-3 text-center align-top border-r border-slate-200/60 w-1/5 bg-slate-50">
                      <div>SETTIMANALE</div>
                      <div className="text-[11px] font-semibold text-slate-600">{liveData.weekTitle}</div>
                    </th>
                    <th className="py-1 px-3 text-center align-top w-1/5 bg-slate-50">
                      <div>MENSILE PROVVISORIO</div>
                      <div className="text-[11px] font-semibold text-slate-600">
                        {liveData.hasProvisional ? (
                          <><span className="whitespace-nowrap">{liveData.provTitle} <Hourglass className="inline-block w-3 h-3 text-slate-400 align-[-2px]" /></span> <span className="whitespace-nowrap">({liveData.provCount} rilevazioni)</span></>
                        ) : (
                          "—"
                        )}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody id="matrice-scaglioni-body" className="divide-y divide-slate-100 bg-white">
                  {bracketRows.map((row, idx) => {
                    const isHidden = !matrixShowAll && (idx < matrixWindow.start || idx > matrixWindow.end);
                    return (
                    <tr 
                      key={idx} 
                      className={`transition-colors hover:bg-slate-50/80${isHidden ? " hidden print:table-row" : ""}`}
                    >
                      <td className="py-1.5 px-3 border-r border-slate-100 text-slate-800">
                        da {fmtIt(row.pMin, 3)} € a {fmtIt(row.pMax, 3)} €
                      </td>
                      <td className="py-1.5 px-3 text-center font-bold border-r border-slate-100">
                        <span className="inline-block px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-800 font-semibold">
                          {fmtIt(row.s, 2, true)} %
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-center border-r border-slate-100">
                        {row.matchMonth ? (
                          <span className="font-bold text-slate-900 inline-flex items-center gap-1">
                            <span className="text-slate-400 font-normal">←</span> {fmtIt(liveData.monthPrice, 3)} €/L
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 px-3 text-center border-r border-slate-100">
                        {row.matchWeek ? (
                          <span className="font-bold text-slate-900 inline-flex items-center gap-1">
                            <span className="text-slate-400 font-normal">←</span> {fmtIt(liveData.weekPrice, 3)} €/L
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 px-3 text-center">
                        {row.matchProv ? (
                          <span className="font-bold text-slate-900 inline-flex items-center gap-1">
                            <span className="text-slate-400 font-normal">←</span> {fmtIt(liveData.provPrice, 3)} €/L
                          </span>
                        ) : null}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </section>

        {/* 3. ANALISI DEL FUEL SURCHARGE (TREND BI-CURVA & SIMULATORE) */}
        <div className="space-y-6">
          
          {/* Grafico Trend Surcharge (A tutta larghezza) */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
                <div>
                  <h4 className="font-bold text-slate-900 text-base flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-sky-600" />
                    Trend Storico Fuel Surcharge (%)
                  </h4>
                  <p className="text-xs text-slate-500">
                    Evoluzione percentuale post-base ({targetLabel}): confronto tra Base Pompa e Base Netto Industriale.
                  </p>
                </div>
                <div className="inline-flex rounded-xl bg-slate-100 p-1 self-start sm:self-auto shrink-0 border border-slate-200">
                  {["Mensile", "Settimanale"].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setTrendGranularity(g)}
                      className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                        trendGranularity === g
                          ? 'bg-white text-sky-800 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              {surchargeTrendData.length > 0 ? (
                <div className="w-full h-[380px] mt-2">
                  <Plot
                    data={[
                      {
                        x: surchargeTrendData.map((d) => d.label),
                        y: surchargeTrendData.map((d) => d.surPompa),
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'Base Pompa',
                        line: { color: '#2563eb', width: 2.2 },
                        marker: { size: 4.5, color: '#1d4ed8' },
                        hovertemplate: 'Base Pompa: %{y:.2f}%<extra></extra>'
                      },
                      {
                        x: surchargeTrendData.map((d) => d.label),
                        y: surchargeTrendData.map((d) => d.surNetto),
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'Base Netto Industriale',
                        line: { color: '#f59e0b', width: 2.2, dash: 'dot' },
                        marker: { size: 4.5, color: '#d97706' },
                        hovertemplate: 'Base Netto: %{y:.2f}%<extra></extra>'
                      }
                    ]}
                    layout={{
                      autosize: true,
                      margin: { l: 45, r: 15, t: 25, b: 50 },
                      xaxis: { title: "Periodo Rilevato", tickangle: -45, automargin: true },
                      yaxis: { title: "Percentuale Surcharge (%)", ticksuffix: '%' },
                      legend: { orientation: 'h', y: 1.12, x: 0 },
                      hovermode: 'x unified',
                      shapes: [
                        {
                          type: 'line',
                          x0: 0,
                          x1: 1,
                          xref: 'paper',
                          y0: 0,
                          y1: 0,
                          line: { color: '#94a3b8', width: 1.5, dash: 'dash' }
                        }
                      ]
                    }}
                    useResizeHandler={true}
                    style={{ width: '100%', height: '100%' }}
                    config={{ displayModeBar: false, responsive: true }}
                  />
                </div>
              ) : (
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-8 text-center text-sky-800 text-sm mt-4">
                  Il Periodo Base selezionato ({targetLabel}) coincide con i dati più recenti disponibili. Seleziona un Periodo Base antecedente (es. Anno 2025) per osservare il trend nel tempo.
                </div>
              )}
            </div>
          </section>

          {/* Laboratorio di Calcolo & Simulatore Completo (A tutta larghezza) */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
              <div>
                <h4 className="font-bold text-slate-900 text-base md:text-lg flex items-center gap-2">
                  <Calculator className="w-5 h-5 text-sky-600" />
                  Simulatore
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  Confronta liberamente qualsiasi periodo storico MASE o simula scenari ipotetici con valori personalizzati.
                </p>
              </div>
              <button
                type="button"
                onClick={syncWithContract}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-sky-800 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-xl transition-all shadow-2xs self-start sm:self-auto cursor-pointer"
                title="Copia i parametri del contratto principale impostati in cima alla pagina"
              >
                <RotateCcw className="w-3.5 h-3.5 text-sky-600" />
                Copia parametri da sopra
              </button>
            </div>

            {/* Layout a 3 Colonne Simmetriche (Target | Rilevazione | Risultato) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
              
              {/* COLONNA 1: BASE DI PARTENZA (TARGET) - 4 cols */}
              <div className="lg:col-span-4 bg-slate-50/70 border border-slate-200/90 rounded-2xl p-4 flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      1. Base di Partenza (Target)
                    </span>
                    {labTargetMode === "Valore Libero" && (
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">
                        Libero
                      </span>
                    )}
                  </div>

                  {/* Modalità Target */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Modalità Periodo Target:
                    </label>
                    <select
                      value={labTargetMode}
                      onChange={(e) => setLabTargetMode(e.target.value)}
                      className="w-full h-[38px] bg-white border border-slate-300 rounded-xl px-3 font-semibold text-xs text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    >
                      <option value="Anno solare">Anno solare</option>
                      <option value="Singolo Mese">Singolo Mese</option>
                      <option value="Range personalizzato">Range personalizzato (da / a)</option>
                      <option value="Valore Libero">Valore Libero (manuale)</option>
                    </select>
                  </div>

                  {/* Selettore Specifico Target */}
                  {labTargetMode === "Anno solare" && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Anno Solare:
                      </label>
                      <select
                        value={labTargetYear}
                        onChange={(e) => setLabTargetYear(e.target.value)}
                        className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      >
                        {Object.keys(annualDict).sort((a,b) => b - a).map((y) => (
                          <option key={`lab-y-${y}`} value={y}>
                            Media Anno {y} ({fmtIt(annualDict[y]?.[labActiveKey] || 0)} €/L)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {labTargetMode === "Singolo Mese" && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Mese Storico:
                      </label>
                      <select
                        value={labTargetMonthIdx}
                        onChange={(e) => setLabTargetMonthIdx(Number(e.target.value))}
                        className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      >
                        {[...monthlyList].reverse().map((m, idx) => (
                          <option key={`lab-tgt-m-${m.anno}-${m.mese}`} value={idx}>
                            {m.nome_mese} {m.anno} ({fmtIt(m[labActiveKey])} €/L)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {labTargetMode === "Range personalizzato" && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Intervallo Date:
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <input 
                          type="date"
                          max={maxAvailDateISO}
                          value={labTargetStartDate}
                          onChange={(e) => setLabTargetStartDate(e.target.value)}
                          className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-2 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                        <input 
                          type="date"
                          max={maxAvailDateISO}
                          value={labTargetEndDate}
                          onChange={(e) => setLabTargetEndDate(e.target.value)}
                          className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-2 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  {labTargetMode === "Valore Libero" && (
                    <div className="p-2.5 bg-amber-50/70 border border-amber-200/70 rounded-xl text-[11px] text-amber-900">
                      Modalità manuale attiva. Digita direttamente il prezzo base nella casella sottostante.
                    </div>
                  )}
                </div>

                {/* Prezzo Base Effettivo (Editabile) */}
                <div className="pt-3 border-t border-slate-200">
                  <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Prezzo Base Effettivo (€/L):
                  </label>
                  <input 
                    type="text" 
                    inputMode="decimal"
                    autoComplete="off"
                    value={labBaseDraft ?? fmtIt(labTargetMode === "Valore Libero" ? labCustomBasePrice : labBasePrice, 3)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setLabBaseDraft(raw);
                      const val = parseItAmount(raw);
                      if (val !== null) {
                        setLabCustomBasePrice(val);
                        setLabTargetMode("Valore Libero");
                      }
                    }}
                    onBlur={() => setLabBaseDraft(null)}
                    className="w-full h-[42px] bg-white border border-slate-300 rounded-xl px-3.5 text-sm font-black text-slate-900 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                  <div className="mt-1 text-[11px] text-slate-500 truncate">
                    Rif: <span className="font-semibold text-slate-700">{labTargetLabel}</span>
                  </div>
                </div>
              </div>

              {/* COLONNA 2: RILEVAZIONE DA VALUTARE - 4 cols */}
              <div className="lg:col-span-4 bg-slate-50/70 border border-slate-200/90 rounded-2xl p-4 flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      2. Rilevazione da Valutare
                    </span>
                    {labEvalMode === "Valore Libero" && (
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">
                        Libero
                      </span>
                    )}
                  </div>

                  {/* Modalità Rilevazione */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Tipo Rilevazione:
                    </label>
                    <select
                      value={labEvalMode}
                      onChange={(e) => setLabEvalMode(e.target.value)}
                      className="w-full h-[38px] bg-white border border-slate-300 rounded-xl px-3 font-semibold text-xs text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    >
                      <option value="Mese Provvisorio" disabled={!labProvisional}>
                        {labProvisional
                          ? `Mese in corso provvisorio (${labProvisional.title})`
                          : "Mese in corso provvisorio (non disponibile)"}
                      </option>
                      <option value="Mese Storico">Mese (consolidato)</option>
                      <option value="Settimana">Settimana</option>
                      <option value="Valore Libero">Valore libero (manuale)</option>
                    </select>
                  </div>

                  {/* Selettore Specifico Rilevazione */}
                  {labEvalMode === "Mese Storico" && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Mese di Rilevazione:
                      </label>
                      <select
                        value={labEvalMonthIdx}
                        onChange={(e) => setLabEvalMonthIdx(Number(e.target.value))}
                        className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      >
                        {[...monthlyList].reverse().map((m, idx) => (
                          <option key={`lab-eval-m-${m.anno}-${m.mese}`} value={idx}>
                            {m.nome_mese} {m.anno} — {fmtIt(m[labActiveKey])} €/L
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {labEvalMode === "Settimana" && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Settimana di Rilevazione:
                      </label>
                      <select
                        value={labEvalWeekIdx}
                        onChange={(e) => setLabEvalWeekIdx(Number(e.target.value))}
                        className="w-full h-[38px] bg-white border border-sky-300 rounded-xl px-3 text-xs font-bold text-sky-950 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      >
                        {[...weeklyList].reverse().map((w, idx) => {
                          const meta = getWeekMeta(w.data);
                          return (
                            <option key={`lab-eval-w-${w.data}`} value={idx}>
                              Settimana {meta.weekNumber}/{meta.yearShort} ({fmtIt(w[labActiveKey])} €/L) • {meta.subText}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  {labEvalMode === "Valore Libero" && (
                    <div className="p-2.5 bg-amber-50/70 border border-amber-200/70 rounded-xl text-[11px] text-amber-900">
                      Modalità manuale attiva. Digita direttamente il prezzo da valutare nella casella sottostante.
                    </div>
                  )}
                </div>

                {/* Prezzo Rilevato Effettivo (Editabile) */}
                <div className="pt-3 border-t border-slate-200">
                  <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Prezzo Rilevato Effettivo (€/L):
                  </label>
                  <input 
                    type="text" 
                    inputMode="decimal"
                    autoComplete="off"
                    value={labEvalDraft ?? fmtIt(labEvalMode === "Valore Libero" ? labCustomEvalPrice : labEvalPrice, 3)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setLabEvalDraft(raw);
                      const val = parseItAmount(raw);
                      if (val !== null) {
                        setLabCustomEvalPrice(val);
                        setLabEvalMode("Valore Libero");
                      }
                    }}
                    onBlur={() => setLabEvalDraft(null)}
                    className="w-full h-[42px] bg-white border border-slate-300 rounded-xl px-3.5 text-sm font-black text-slate-900 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                  <div className="mt-1 text-[11px] text-slate-500 truncate">
                    Rif: <span className="font-semibold text-slate-700">{labEvalLabel}</span>
                  </div>
                </div>
              </div>

              {/* COLONNA 3: PARAMETRI & RISULTATO - 4 cols */}
              <div className="lg:col-span-4 flex flex-col justify-between space-y-4">
                
                {/* Parametri di calcolo */}
                <div className="bg-slate-50/70 border border-slate-200/90 rounded-2xl p-4 space-y-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700 block">
                    3. Parametri di Calcolo
                  </span>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Base Ministeriale:
                    </label>
                    <select
                      value={labPriceType}
                      onChange={(e) => setLabPriceType(e.target.value)}
                      className="w-full h-[38px] bg-white border border-slate-300 rounded-xl px-3 text-xs font-semibold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    >
                      {Object.entries(priceTypeOptions).map(([k, v]) => (
                        <option key={`lab-pt-${k}`} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Incidenza Gasolio (%):
                    </label>
                    <select
                      value={labWeight}
                      onChange={(e) => setLabWeight(Number(e.target.value))}
                      className="w-full h-[38px] bg-white border border-slate-300 rounded-xl px-3 text-xs font-bold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                    >
                      {Array.from({ length: 100 }, (_, i) => i + 1).map((n) => (
                        <option key={`lab-w-${n}`} value={n}>{n}%</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Card Risultato Surcharge uniformata */}
                <div className="bg-slate-100/90 text-slate-900 rounded-2xl p-4.5 border border-slate-300 shadow-xs flex flex-col justify-center flex-1">
                  <div>
                    <div className="text-xs font-bold tracking-wider text-slate-500 uppercase mb-1">
                      Fuel Surcharge
                    </div>
                    <div className="text-3xl md:text-4xl font-black tracking-tight text-slate-500 my-1">
                      {fmtIt(labResult.lSurPct, 2, true)} %
                    </div>
                  </div>
                </div>

              </div>

            </div>
          </section>

        </div>

        {/* 4. ARCHIVIO STORICO E CONSULTAZIONE MASE (2 TAB) */}
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="flex border-b border-slate-200 bg-slate-50 overflow-x-auto">
            <button
              onClick={() => setArchiveTab("chart")}
              className={`flex items-center gap-2 px-5 py-3.5 text-xs md:text-sm font-bold whitespace-nowrap transition-all border-b-2 ${
                archiveTab === "chart"
                  ? 'border-sky-600 text-sky-700 bg-white shadow-xs'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/80'
              }`}
            >
              <BarChart3 className="w-4 h-4" />
              Andamento Storico Prezzi Gasolio
            </button>
            <button
              onClick={() => setArchiveTab("lookup")}
              className={`flex items-center gap-2 px-5 py-3.5 text-xs md:text-sm font-bold whitespace-nowrap transition-all border-b-2 ${
                archiveTab === "lookup"
                  ? 'border-sky-600 text-sky-700 bg-white shadow-xs'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/80'
              }`}
            >
              <Search className="w-4 h-4" />
              Consultazione Libera Prezzi
            </button>
          </div>

          <div className="p-5 md:p-6">
            
            {/* TAB 1: GRAFICO STORICO PREZZI PLOTLY */}
            {archiveTab === "chart" && (
              <div>
                <h4 className="font-bold text-slate-800 text-sm md:text-base mb-1">
                  Evoluzione Prezzo Gasolio Auto Italia (Rilevazioni Settimanali MASE)
                </h4>
                <p className="text-xs text-slate-500 mb-4">Grafico interattivo delle 4 componenti con range-slider e filtri rapidi.</p>

                <div className="w-full h-[450px]">
                  <Plot
                    data={[
                      {
                        x: weeklyList.map((r) => r.data),
                        y: weeklyList.map((r) => r.prezzo_pompa),
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Alla Pompa',
                        line: { color: '#2563eb', width: 2 }
                      },
                      {
                        x: weeklyList.map((r) => r.data),
                        y: weeklyList.map((r) => r.imponibile),
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Imponibile (no IVA)',
                        line: { color: '#6366f1', width: 1.5, dash: 'dot' }
                      },
                      {
                        x: weeklyList.map((r) => r.data),
                        y: weeklyList.map((r) => r.netto),
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Netto Industriale',
                        line: { color: '#f59e0b', width: 1.8 }
                      },
                      {
                        x: weeklyList.map((r) => r.data),
                        y: weeklyList.map((r) => r.accisa),
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Accisa',
                        line: { color: '#10b981', width: 1.5 }
                      }
                    ]}
                    layout={{
                      autosize: true,
                      margin: { l: 45, r: 15, t: 30, b: 35 },
                      xaxis: {
                        title: "Data Rilevazione",
                        range: [
                          weeklyList.length > 0
                            ? `${Number(weeklyList[weeklyList.length - 1].data.split("-")[0]) - 5}-${weeklyList[weeklyList.length - 1].data.slice(5)}`
                            : "2021-01-01",
                          weeklyList.length > 0 ? weeklyList[weeklyList.length - 1].data : "2026-12-31"
                        ],
                        rangeselector: {
                          buttons: [
                            { count: 1, label: '1 Anno', step: 'year', stepmode: 'backward' },
                            { count: 3, label: '3 Anni', step: 'year', stepmode: 'backward' },
                            { count: 5, label: '5 Anni', step: 'year', stepmode: 'backward' },
                            { step: 'all', label: 'Tutto' }
                          ],
                          bgcolor: '#f1f5f9',
                          activecolor: '#0284c7'
                        },
                        rangeslider: { visible: true, thickness: 0.07 }
                      },
                      yaxis: { title: "Euro al Litro (€/L)" },
                      legend: { orientation: 'h', y: 1.12, x: 0 },
                      hovermode: 'x unified',
                      font: { family: 'sans-serif', size: 11 }
                    }}
                    useResizeHandler={true}
                    style={{ width: '100%', height: '100%' }}
                    config={{ displayModeBar: false, responsive: true, locale: plotlyLocale }}
                  />
                </div>
              </div>
            )}

            {/* TAB 2: CONSULTAZIONE LIBERA PREZZI (A 5 VIE) */}
            {archiveTab === "lookup" && (
              <div className="space-y-4">
                <h4 className="font-bold text-slate-800 text-sm md:text-base">
                  Consultazione Rilevazioni Ufficiali MASE Gasolio Auto
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50 border border-slate-200 p-4 rounded-xl">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                      Criterio di Ricerca:
                    </label>
                    <select
                      value={lookupMode}
                      onChange={(e) => setLookupMode(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 font-semibold text-slate-800 text-sm"
                    >
                      <option value="Intervallo Date">Intervallo Date (da / a)</option>
                      <option value="Anno solare">Anno solare</option>
                      <option value="Singolo Mese">Singolo Mese</option>
                      <option value="Settimana Specifica">Settimana Specifica</option>
                      <option value="Data Esatta">Data Esatta (Giorno)</option>
                    </select>
                  </div>

                  <div className="md:col-span-2 flex flex-col md:flex-row gap-3 items-end">
                    {lookupMode === "Intervallo Date" && (
                      <>
                        <div className="flex-1 w-full">
                          <label className="block text-xs font-semibold text-slate-600 mb-1">Data Inizio:</label>
                          <input 
                            type="date" 
                            max={maxAvailDateISO}
                            value={lkStartDate} 
                            onChange={(e) => setLkStartDate(e.target.value)}
                            className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-semibold"
                          />
                        </div>
                        <div className="flex-1 w-full">
                          <label className="block text-xs font-semibold text-slate-600 mb-1">Data Fine:</label>
                          <input 
                            type="date" 
                            max={maxAvailDateISO}
                            value={lkEndDate} 
                            onChange={(e) => setLkEndDate(e.target.value)}
                            className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-semibold"
                          />
                        </div>
                      </>
                    )}

                    {lookupMode === "Anno solare" && (
                      <div className="flex-1 w-full">
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Anno Solare:</label>
                        <select
                          value={lkYear}
                          onChange={(e) => setLkYear(e.target.value)}
                          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold"
                        >
                          {Object.keys(annualDict).sort((a,b) => b - a).map((y) => (
                            <option key={`lk-${y}`} value={y}>{y}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {lookupMode === "Singolo Mese" && (
                      <div className="flex-1 w-full">
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Mese:</label>
                        <select
                          value={lkMonthIdx}
                          onChange={(e) => setLkMonthIdx(Number(e.target.value))}
                          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold"
                        >
                          {[...monthlyList].reverse().map((m, idx) => (
                            <option key={`lkm-${m.anno}-${m.mese}`} value={idx}>
                              {m.nome_mese} {m.anno}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {lookupMode === "Settimana Specifica" && (
                      <div className="flex-1 w-full">
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Settimana:</label>
                        <select
                          value={lkWeekIdx}
                          onChange={(e) => setLkWeekIdx(Number(e.target.value))}
                          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold"
                        >
                          {[...weeklyList].reverse().map((w, idx) => (
                            <option key={`lkw-${w.data}`} value={idx}>
                              {getWeekMeta(w.data).label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {lookupMode === "Data Esatta" && (
                      <div className="flex-1 w-full">
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Data Viaggio / Documento:</label>
                        <input 
                          type="date" 
                          max={maxAvailDateISO}
                          value={lkExactDate} 
                          onChange={(e) => setLkExactDate(e.target.value)}
                          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-semibold"
                        />
                      </div>
                    )}
                  </div>
                </div>

                {lookupResult ? (
                  <div className="space-y-3">
                    <div className="text-xs text-slate-500 font-medium">
                      <b>Dettaglio:</b> {lookupResult.detailText}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                      <div className="bg-white border border-slate-200 p-3.5 rounded-xl text-center flex flex-col justify-center min-h-[92px]">
                        <div className="text-xs font-semibold text-slate-500 uppercase">Prezzo Pompa</div>
                        <div className="text-xl font-black text-blue-700 mt-1">{fmtIt(lookupResult.pompa, 3)} €/L</div>
                      </div>
                      <div className="bg-white border border-slate-200 p-3.5 rounded-xl text-center flex flex-col justify-center min-h-[92px]">
                        <div className="text-xs font-semibold text-slate-500 uppercase">Imponibile (no IVA)</div>
                        <div className="text-xl font-black text-slate-900 mt-1">{fmtIt(lookupResult.imponibile, 3)} €/L</div>
                      </div>
                      <div className="bg-white border border-slate-200 p-3.5 rounded-xl text-center flex flex-col justify-center min-h-[92px]">
                        <div className="text-xs font-semibold text-slate-500 uppercase">Netto Industriale</div>
                        <div className="text-xl font-black text-slate-900 mt-1">{fmtIt(lookupResult.netto, 3)} €/L</div>
                      </div>
                      <div className="bg-white border border-slate-200 p-3.5 rounded-xl text-center flex flex-col justify-center min-h-[92px]">
                        <div className="text-xs font-semibold text-slate-500 uppercase">Accisa</div>
                        <div className="text-xl font-black text-slate-900 mt-1">{fmtIt(lookupResult.accisa, 4)} €/L</div>
                      </div>
                      <div className="bg-white border border-slate-200 p-3.5 rounded-xl text-center flex flex-col justify-center min-h-[92px]">
                        <div className="text-xs font-semibold text-slate-500 uppercase">IVA</div>
                        <div className="text-xl font-black text-slate-900 mt-1">{fmtIt(lookupResult.iva, 3)} €/L</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-red-600 text-sm font-bold">Nessun dato trovato per la selezione.</div>
                )}
              </div>
            )}

          </div>
        </section>

        {/* 5. NOTA METODOLOGICA & GUIDA ALL'UTILIZZO (2 COLONNE) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs leading-relaxed text-slate-700">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-2">
            <h5 className="font-bold text-slate-900 uppercase text-xs tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
              <BookOpen className="w-4 h-4 text-sky-600" />
              Metodologia e Formule di Calcolo
            </h5>
            <ul className="space-y-2 list-disc list-inside text-slate-600">
              <li>
                <b>Variazione Prezzo Gasolio (Δ%):</b> Calcola lo scostamento tra prezzo rilevato e prezzo baseline: <code className="bg-slate-100 px-1 py-0.5 rounded">Δ% = ((P_attuale - P_baseline) / P_baseline) × 100</code>
              </li>
              <li>
                <b>Incidenza Costo Gasolio (%):</b> Il Fuel Surcharge finale è ottenuto moltiplicando la variazione per l'incidenza pattuita (default 30%, tabelle indicative costi MIT).
              </li>
              <li>
                <b>Matrice a Scaglioni (Step 0,50%):</b> Ogni scaglione tariffario copre una fascia centrata di ±0,25%, calcolata tramite formula inversa dal Prezzo Baseline. Le fasce sono discrete a scatti di 0,001 € (millesimo): l'estremo inferiore riparte da +0,001 € rispetto all'estremo superiore dello scaglione precedente, quindi il prezzo di confine appartiene sempre alla fascia inferiore.
              </li>
              <li>
                <b>Tipologie di Prezzo:</b> Le variazioni su <i>Pompa</i> e <i>Imponibile</i> sono matematicamente identiche al centesimo (IVA 22% costante). Il <i>Netto Industriale</i> isola la materia prima pura escludendo l'accisa.
              </li>
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-2">
            <h5 className="font-bold text-slate-900 uppercase text-xs tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
              <CheckCircle2 className="w-4 h-4 text-sky-600" />
              Parametri di Default, Interattività e Fonti
            </h5>
            <ul className="space-y-2 list-disc list-inside text-slate-600">
              <li>
                <b>Configurazione all'Avvio:</b> Pre-impostata su <i>Prezzo Globale (alla pompa)</i>, <i>Incidenza 30%</i> e <i>Baseline Media Anno 2025</i>.
              </li>
              <li>
                <b>Link Condivisibili (URL Query):</b> Qualsiasi parametro impostato viene sincronizzato nell'URL del browser per poter condividere preventivi pre-configurati.
              </li>
              <li>
                <b>Automazione Dati Ufficiali:</b> I dati provengono direttamente dal <i>Ministero dell'Ambiente e della Sicurezza Energetica (DGSAIE)</i>, aggiornati ogni martedì tramite automazione CI/CD.
              </li>
            </ul>
          </div>
        </section>

      </main>

      {/* FOOTER ISTITUZIONALE */}
      <footer className="mt-12 text-center text-xs text-slate-500">
        Fonte Dati Ufficiali:{" "}
        <a 
          href="https://sisen.mase.gov.it/dgsaie/prezzi-settimanali-carburanti" 
          target="_blank" 
          rel="noreferrer"
          className="text-sky-600 font-bold hover:underline inline-flex items-center gap-0.5"
        >
          Ministero dell'Ambiente e della Sicurezza Energetica (DGSAIE) <ExternalLink className="w-3 h-3" />
        </a>
        <div className="text-[11px] text-slate-400 mt-1">
          Fuel Surcharge Italia • Indice di monitoraggio e simulazione adeguamento costo gasolio
        </div>
      </footer>

    </div>
  );
}