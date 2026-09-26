"""Scarica, valida e normalizza i prezzi ufficiali MASE del gasolio auto per il frontend React."""

import json
import ssl
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL_WEEKLY = "https://sisen.mase.gov.it/dgsaie/api/v1/weekly-prices/report/export?type=ALL&format=JSON&lang=it"
URL_MONTHLY = "https://sisen.mase.gov.it/dgsaie/api/v1/monthly-prices/export?format=JSON&lang=it"
OUTPUT_FILE = Path("src/data/gasolio_mase.json")


class DataValidationError(ValueError):
    """Il MASE ha restituito dati incompleti o incoerenti."""


def fetch_json_with_retry(url: str, max_retries: int = 3, delay_sec: int = 4) -> list[dict]:
    """Scarica un elenco JSON con retry automatico in caso di instabilità dei server ministeriali."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; FuelSurchargeItalia/2.0)"}
    request = urllib.request.Request(url, headers=headers)
    context = ssl.create_default_context()

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(request, context=context, timeout=35) as response:
                if response.status != 200:
                    raise RuntimeError(f"Errore HTTP {response.status}")
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
                raise DataValidationError("Formato payload non valido dal server MASE.")
            return payload
        except Exception as exc:
            print(f"⚠️ [Tentativo {attempt}/{max_retries}] Errore durante il download da {url}: {exc}")
            if attempt < max_retries:
                time.sleep(delay_sec * attempt)
            else:
                raise RuntimeError(f"Impossibile raggiungere il MASE dopo {max_retries} tentativi.") from exc


def parse_float(value: str | float | int | None, field_name: str) -> float:
    """Converte un valore MASE da €/1.000 L a €/L."""
    if value is None or str(value).strip() == "":
        raise DataValidationError(f"Campo MASE mancante: {field_name}.")
    try:
        parsed = round(float(str(value).replace(",", ".")) / 1000.0, 4)
    except (TypeError, ValueError) as exc:
        raise DataValidationError(f"Valore MASE non valido per {field_name}: {value!r}.") from exc
    if parsed <= 0:
        raise DataValidationError(f"Valore MASE non positivo per {field_name}: {value!r}.")
    return parsed


def is_gasolio_auto(row: dict) -> bool:
    return str(row.get("CODICE_PRODOTTO", "")).strip() == "2" or row.get("NOME_PRODOTTO") == "Gasolio auto"


def validate_price_components(pompa: float, netto: float, accisa: float, iva: float) -> None:
    """Verifica l'identità base con tolleranza realistica di arrotondamento ministeriale."""
    if abs(pompa - (netto + accisa + iva)) > 0.005:
        print(f"⚠️ Avviso scarto arrotondamento MASE: Pompa {pompa} vs Somma {round(netto+accisa+iva, 4)}")


def normalize_price_row(row: dict, date_value: str | None = None) -> dict:
    pompa = parse_float(row.get("PREZZO"), "PREZZO")
    accisa = parse_float(row.get("ACCISA"), "ACCISA")
    iva = parse_float(row.get("IVA"), "IVA")
    netto = parse_float(row.get("NETTO"), "NETTO")
    validate_price_components(pompa, netto, accisa, iva)
    result = {
        "prezzo_pompa": pompa,
        "imponibile": round(netto + accisa, 4),
        "netto": netto,
        "accisa": accisa,
        "iva": iva,
    }
    if date_value is not None:
        try:
            datetime.strptime(date_value, "%Y-%m-%d")
        except (TypeError, ValueError) as exc:
            raise DataValidationError(f"DATA_RILEVAZIONE non valida: {date_value!r}.") from exc
        result["data"] = date_value
    return result


def ensure_unique(rows: list[dict], fields: tuple[str, ...], label: str) -> None:
    keys = [tuple(row[field] for field in fields) for row in rows]
    if len(keys) != len(set(keys)):
        raise DataValidationError(f"Il MASE ha restituito {label} duplicati.")


def process_data() -> None:
    print("🚀 [1/3] Connessione ai server MASE in corso...")
    raw_weekly = fetch_json_with_retry(URL_WEEKLY)
    raw_monthly = fetch_json_with_retry(URL_MONTHLY)
    print(f"📦 Ricevuti {len(raw_weekly)} record settimanali e {len(raw_monthly)} mensili.")

    weekly_history = [
        normalize_price_row(row, row.get("DATA_RILEVAZIONE"))
        for row in raw_weekly if is_gasolio_auto(row)
    ]
    weekly_history.sort(key=lambda item: item["data"])
    ensure_unique(weekly_history, ("data",), "rilevazioni settimanali")

    monthly_history = []
    annual_history = {}
    for row in raw_monthly:
        if not is_gasolio_auto(row):
            continue
        try:
            month_code, year = int(row.get("CODICE_MESE", 0)), int(row.get("ANNO", 0))
        except (TypeError, ValueError) as exc:
            raise DataValidationError(f"Anno o codice mese MASE non validi: {row!r}.") from exc
        if year < 1990:
            raise DataValidationError(f"Anno MASE non valido: {year}.")

        item = {"anno": year, **normalize_price_row(row)}
        if month_code == 13:
            if str(year) in annual_history:
                raise DataValidationError(f"Media annuale MASE duplicata per {year}.")
            annual_history[str(year)] = item
        elif 1 <= month_code <= 12:
            month_name = row.get("NOME_MESE")
            if not isinstance(month_name, str) or not month_name.strip():
                raise DataValidationError(f"NOME_MESE mancante per {month_code}/{year}.")
            item.update({"mese": month_code, "nome_mese": month_name.strip()})
            monthly_history.append(item)

    monthly_history.sort(key=lambda item: (item["anno"], item["mese"]))
    ensure_unique(monthly_history, ("anno", "mese"), "rilevazioni mensili")
    
    if len(weekly_history) < 100 or len(monthly_history) < 24 or len(annual_history) < 5:
        raise DataValidationError("Serie storica incompleta: aggiornamento annullato per protezione.")

    output_data = {
        "metadata": {
            "source": "MASE - Ministero dell'Ambiente e della Sicurezza Energetica (DGSAIE)",
            "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "product": "Gasolio auto",
            "unit": "EUR/L",
            "weekly_count": len(weekly_history),
            "monthly_count": len(monthly_history),
            "annual_count": len(annual_history),
        },
        "annual_averages": annual_history,
        "monthly_history": monthly_history,
        "weekly_history": weekly_history,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = OUTPUT_FILE.with_suffix(".tmp")
    temporary_file.write_text(json.dumps(output_data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_file.replace(OUTPUT_FILE)

    print("✅ [2/3] Elaborazione e validazione completate con successo!")
    print(f"📊 Gasolio Auto: {len(weekly_history)} settimane, {len(monthly_history)} mesi, {len(annual_history)} medie annuali.")
    print(f"💾 [3/3] File salvato in: {OUTPUT_FILE.resolve()}")


if __name__ == "__main__":
    process_data()