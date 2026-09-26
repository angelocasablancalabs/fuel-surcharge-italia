# AGENTS.md — Technical Constitution for AI Agents

This document defines the operational standards and constraints for AI agents collaborating on the **Fuel Surcharge Italia** codebase. Compliance with these rules is mandatory.

---

## 1. Stack & Core Commands

- **Stack:** React 19, Vite 8, Tailwind CSS v4, Plotly.js (`react-plotly.js`), Python 3.13 (`fetch_data.py`), Oxlint.
- **Data Source:** MASE Open Data stored in `src/data/gasolio_mase.json`.

| Action | Command | Purpose |
| :--- | :--- | :--- |
| **Dev Server** | `npm run dev` | Starts Vite local server |
| **Build** | `npm run build` | Production compilation (must exit code 0) |
| **Lint** | `npm run lint` | Oxlint fast static check |
| **ETL Pipeline** | `python fetch_data.py` | Fetches, validates, and normalizes MASE data |

---

## 2. Zero Unintended Regressions

> **"Preservare rigorosamente il funzionamento e il comportamento delle feature esistenti, A MENO CHE l'utente non richieda esplicitamente di modificarle, refattorizzarle o rimuoverle. Isolare le modifiche evitando danni collaterali a moduli non correlati."**

- Existing functionality (3-base calculations, 4 tabs, bracket matrix, URL param sync, ISO week calendar bounds) is mission-critical.
- Always isolate code modifications to the specific scope of the requested change.

---

## 3. Surgical Modification Protocol

- **Never perform full-file rewrites** for small or medium edits, especially on large components like `src/App.jsx` (>1,000 LOC).
- Use surgical, targeted chunk replacements (Search & Replace pattern).
- Keep diffs minimal, clean, and directly reviewable.
- Preserve existing comments, docstrings, and domain logic.

---

## 4. Modern Stack Compliance

- Follow modern 2026 idioms: React 19 hooks and concurrent conventions, Vite 8 ESM, Tailwind CSS v4 engine, Python 3.10+ type hints.
- Do not introduce deprecated libraries, obsolete patterns, or legacy CSS preprocessors.

---

## 5. Three-Tier Boundaries

### 🟢 ALWAYS
- Verify your changes with `npm run build` before considering any task complete.
- Respect and maintain configuration keys (`vite.config.js`, `.oxlintrc.json`, GitHub Actions).
- Update `PROGRESS.md` at the conclusion of every working session.

### 🟡 ASK FIRST
- Ask before adding new npm dependencies or external Python packages.
- Ask before altering the schema structure of `src/data/gasolio_mase.json`.
- Ask before modifying GitHub Actions workflow files (`.github/workflows/`).

### 🔴 NEVER
- Never commit secrets, credentials, API keys, or private tokens.
- Never commit `.env` files or machine-specific local files.
- Never perform unrequested mass refactoring or cosmetic overhauls on unrelated files.
