# Task Aggregator Phase 2 - Teams Integration

## 📋 Zusammenfassung

Erweiterung des bestehenden Moodle-Task-Fetchers: Zusätzlich zu Moodle sollen jetzt auch **Microsoft Teams Tasks** (To Do) automatisch in die **Apple Reminders App** synchen. Ziel ist eine zentrale Stelle für alle Schulaufgaben (Moodle + Teams).

---

## 🎯 Aufgabenstellung

### **Hauptziel**
Vorhandenes Script erweitern um:
- **Teams Tasks fetchen** (Microsoft Graph API)
- **Mit Moodle-Tasks zusammenführen** (Aggregieren)
- **Duplikate vermeiden** (gleiche Aufgabe 2x? → nur 1x)
- **Alles zu Apple Reminders synchen**

---

## 🔧 Technische Details

### **Input-Quellen (Phase 2)**
```
1. Moodle RSS Feeds (schon implementiert) ✅
2. Microsoft Teams Tasks (NEU!) 🆕
   - Microsoft Graph API: /me/todo/lists/*/tasks
   - Token-basiert (OAuth 2.0)
```

### **Microsoft Graph API Endpoints**
```
GET /me/todo/lists                    # Alle Task-Listen
GET /me/todo/lists/{listId}/tasks     # Tasks einer Liste
GET /me/tasks                         # (Alternative: Outlook Tasks)
```

### **Authentifizierung**
```env
# Teams / Microsoft Graph
TEAMS_CLIENT_ID=xxx
TEAMS_CLIENT_SECRET=xxx
TEAMS_TENANT_ID=xxx

# Existing (Phase 1)
MOODLE_URL=https://edufs.edu.htl-leonding.ac.at/moodle
MOODLE_TOKEN=<REDACTED - mit `--login` selbst erzeugen>
MOODLE_USER_ID=<REDACTED - wird von `--login` gesetzt>
```

---

## 📦 Anforderungen

### **Muss haben (MVP)**

1. ✅ **Microsoft Graph Token Management**
   - OAuth 2.0 Authentication Flow
   - Token refresh handling
   - Error handling bei Token-Ablauf

2. ✅ **Teams Tasks Fetching**
   - Alle Task-Listen des Users abrufen
   - Alle Tasks aus jeder Liste fetchen
   - Parsing: Titel, Beschreibung, Due Date, Status

3. ✅ **Task Aggregation**
   - Moodle + Teams Tasks kombinieren
   - Deduplizierung: gleiche Tasks nur 1x hinzufügen
   - Matching-Logik: gleicher Titel + ähnlicher Fälligkeitstag = Duplikat
   - Filtern: Nur offene/nicht-abgeschlossene Tasks

4. ✅ **Apple Reminders Sync (erweitert)**
   - Alle aggregierten Tasks zu Reminders hinzufügen
   - Mit Quelle taggen (z.B. "Moodle: ...", "Teams: ...")
   - Duplikat-Check: Task nicht 2x hinzufügen

5. ✅ **CLI Output (erweitert)**
   - Schöne Übersicht: Quelle | Titel | Fällig | Status
   - Unterscheidung: Moodle vs Teams vs Duplikate
   - Statistik: "X von Moodle, Y von Teams, Z Duplikate erkannt"

6. ✅ **Logging & Debugging**
   - Welche Tasks gefetcht wurden
   - Welche als Duplikate erkannt wurden
   - Welche zu Reminders hinzugefügt wurden
   - Errors & Warnings

### **Schön zu haben**
- ✨ Task Status sync (wenn in Teams als "erledigt" markiert, auch in Reminders?)
- ✨ Priorisierung nach Fälligkeitsdatum
- ✨ Config-Option: nur bestimmte Teams-Listen synchen
- ✨ Verbose Mode für Debugging
- ✨ Dry-run Mode (zeigt was synchen würde, macht es aber nicht)

---

## 📥 Input / Output

### **Input**
- Moodle RSS Feeds (via Environment Variables) — schon funktionierend
- Microsoft Teams Tasks (via Graph API) — NEU
- Credentials in `.env`

### **Output**

**Terminal-Ausgabe Beispiel:**
```
╔════════════════════════════════════════════════════════════════╗
║              📚 TASK AGGREGATOR - ALLE AUFGABEN               ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║ 🔴 ÜBERFÄLLIG                                                  ║
║   [Moodle] Mathe Hausaufgabe 5                                 ║
║   Fällig: 26.09.2026 (1 Tag überfällig)                        ║
║                                                                ║
║ 🟡 BALD FÄLLIG (< 3 Tage)                                      ║
║   [Teams] Englisch Essay                                       ║
║   Fällig: 30.09.2026 (in 2 Tagen)                              ║
║                                                                ║
║ 🟢 NOCH ZEIT (> 3 Tage)                                        ║
║   [Moodle] Informatik Projekt                                  ║
║   Fällig: 05.10.2026 (in 7 Tagen)                              ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

📊 STATISTIK:
  Moodle Tasks: 5
  Teams Tasks:  3
  Duplikate erkannt: 1
  → Total hinzugefügt zu Reminders: 7

⏱️ Zuletzt aktualisiert: 28.09.2026 14:32
```

---

## 🛠️ Tech-Stack (Erweiterung)

**Bestehend (Phase 1):**
- Node.js / JavaScript
- `rss-parser`, `axios`, `chalk`, `dotenv`, `osascript`

**Neu hinzukommen (Phase 2):**
- `@azure/identity` (Microsoft Auth)
- `@microsoft/microsoft-graph-client` (Graph API Client)
- `crypto` (für String-Matching/Dedup)

```json
{
  "dependencies": {
    "rss-parser": "^3.13.0",
    "axios": "^1.6.0",
    "chalk": "^4.1.2",
    "dotenv": "^16.0.0",
    "@azure/identity": "^3.3.0",
    "@microsoft/microsoft-graph-client": "^3.0.0"
  }
}
```

---

## 📋 Deliverables

1. **task-aggregator.js** - Erweitertes Hauptscript
   - Moodle RSS fetchen ✅
   - Teams Tasks fetchen 🆕
   - Aggregieren & Deduplizieren 🆕
   - Zu Reminders synchen ✅

2. **.env.example** - Update mit Teams Credentials
   ```env
   # Phase 1 (Moodle)
   MOODLE_URL=...
   MOODLE_TOKEN=...
   MOODLE_USER_ID=...

   # Phase 2 (Teams)
   TEAMS_CLIENT_ID=...
   TEAMS_CLIENT_SECRET=...
   TEAMS_TENANT_ID=...
   ```

3. **deduplicate.js** - Utility für Duplikat-Erkennung
   - String-Matching (Titel ähnlichkeit)
   - Date-Matching (Fälligkeitsdatum ±1 Tag)
   - Source-Tagging

4. **utils/teams-auth.js** - Microsoft Graph Authentication
   - OAuth 2.0 Token Management
   - Token Refresh Handling

5. **Updated README.md**
   - Microsoft App Registration Setup
   - Schritt für Schritt Anleitung
   - Troubleshooting für Graph API Errors

6. **GitHub Repo** - Push-ready

---

## 🚀 Nutzung (Final)

```bash
# Setup (One-time)
npm install
cp .env.example .env
# → .env ausfüllen mit Moodle + Teams Credentials

# Run
node task-aggregator.js
# → Fetcht Moodle + Teams
# → Dedupliziert
# → Syncht zu Reminders
# → Zeigt schöne Übersicht

# Options
node task-aggregator.js --dry-run     # Zeigt was würde synchen, macht es aber nicht
node task-aggregator.js --verbose     # Ausführliches Logging
node task-aggregator.js --moodle-only # Nur Moodle (ohne Teams)
```

---

## 📝 Deduplizierungs-Logik

Zwei Tasks gelten als **Duplikat** wenn:
```
1. Titel ähnlich (Levenshtein Distance < 3)
   z.B. "Mathe Hausaufgabe 5" == "Mathe Hausaufgabe 5"

2. UND Fälligkeitsdatum ±1 Tag ähnlich
   z.B. 26.09.2026 == 26.09.2026

3. DANN: Task nur 1x hinzufügen, aber mit Tag:
   "[Moodle + Teams] Mathe Hausaufgabe 5"
```

---

## ⚙️ Microsoft Graph Setup (Voraussetzung)

**Der User muss einmalig:**
1. Azure Portal öffnen
2. App registrieren (Name: "Task Aggregator")
3. Client Secret erstellen
4. Permissions setzen: `Tasks.Read`, `Tasks.ReadWrite`
5. Client ID + Secret + Tenant ID in `.env` eintragen

**Script wird:**
- Token automatisch abrufen (via credentials)
- Token refreshen wenn abgelaufen
- Error handling bei API-Calls

---

## 🔐 Security & Error Handling

- ✅ Credentials NIEMALS in Code (nur `.env`)
- ✅ Token Refresh automatisch
- ✅ API Rate Limiting beachten (Microsoft throttling)
- ✅ Netzwerkfehler abfangen & retry
- ✅ Invalid Tokens → Clear & Re-auth prompt
- ✅ Parsing Errors → Skip mit Warning, continue

---

## 📊 Testing & Validation

**Vor dem Deploy testen:**
1. ✅ Moodle Fetch funktioniert (schon von Phase 1)
2. ✅ Teams Auth funktioniert (Token flow)
3. ✅ Teams Tasks Fetch funktioniert
4. ✅ Deduplizierung funktioniert (Test mit 5 Tasks)
5. ✅ Reminders Sync funktioniert
6. ✅ Duplikate werden nicht 2x hinzugefügt

**Beispiel Test-Cases:**
```javascript
// Test 1: Gleiche Task von Moodle + Teams
const task1 = { title: "Mathe", due: "26.09.2026", source: "moodle" };
const task2 = { title: "Mathe", due: "26.09.2026", source: "teams" };
// → Sollte nur 1x zu Reminders hinzugefügt werden

// Test 2: Ähnliche aber unterschiedliche Tasks
const task3 = { title: "Englisch Essay", due: "30.09.2026", source: "moodle" };
const task4 = { title: "Englisch Essay", due: "01.10.2026", source: "teams" };
// → Sollte beide hinzufügen (unterschiedliche Daten)
```

---

## 🎯 Architektur Diagramm

```
┌──────────────────────────────────────────────────────┐
│          task-aggregator.js (Main)                   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────────────┐        ┌──────────────────┐   │
│  │  Moodle Fetcher │        │   Teams Fetcher  │   │
│  │  (RSS Parser)   │        │  (Graph API)     │   │
│  └────────┬────────┘        └────────┬─────────┘   │
│           │                          │              │
│           └──────────────┬───────────┘              │
│                          │                          │
│                    ┌─────▼──────┐                   │
│                    │ Aggregator │                   │
│                    │ + Dedupe    │                   │
│                    └─────┬──────┘                   │
│                          │                          │
│                    ┌─────▼──────────┐              │
│                    │ Apple Reminders│              │
│                    │  (osascript)   │              │
│                    └────────────────┘              │
│                                                    │
└──────────────────────────────────────────────────────┘
```

---

## 📝 Zusätzliche Infos

- **Zielplattform:** macOS (mit Teams Desktop App)
- **Voraussetzung:** Moodle-Script von Phase 1 schon funktionierend
- **Zeitrahmen:** 2-3 Tage Entwicklung
- **Portfolio-Projekt:** Ja — noch beeindruckender mit Multi-API Integration!

---

## ⚠️ Wichtig

- **Azure App Registration nötig** (User muss einmalig machen)
- **Token Management** — automatisch aber error-handling wichtig
- **Rate Limiting** — Microsoft Graph hat limits, beachten
- **Deduplizierung** — kritisch damit keine Duplikate entstehen
- **Testing** — ausführlich testen vor Production!

---

**Status:** Bereit für Claude Code Phase 2! 🚀

**Vorbedingung:** Phase 1 (Moodle) muss funktionieren ✅
