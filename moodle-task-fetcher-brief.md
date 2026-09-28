# Moodle Task Fetcher - Projektbeschreibung

## 📋 Zusammenfassung

Ich möchte ein automatisiertes Tool bauen, das meine offenen Aufgaben und Kursmaterialien von meinem Moodle-Server (HTL Leonding) abruft und mir in einer übersichtlichen Form anzeigt. Ziel ist es, den Überblick über meine Schulaufgaben zu behalten und nie wieder eine Frist zu verpassen.

---

## 🎯 Aufgabenstellung

### **Hauptziel**
Ein CLI-Tool (Command-Line Interface) entwickeln, das:
- Automatisch RSS-Feeds von Moodle fetcht
- Offene/neue Aufgaben extrahiert und filtert
- Diese übersichtlich anzeigt (mit Titel, Fälligkeitsdatum, Kurs)
- Optional: Tägliche Erinnerungen per Terminal oder E-Mail sendet

---

## 🔧 Technische Details

### **Moodle-Konfiguration**
```
Moodle URL: https://edufs.edu.htl-leonding.ac.at/moodle
RSS Token: <REDACTED-TOKEN>
User-ID: <REDACTED-USER-ID>
```

### **RSS-Feed-Struktur**
- User-Feed: `{MOODLE_URL}/rss/user.php?id={USER_ID}&token={TOKEN}`
- Kurs-Feeds: `{MOODLE_URL}/rss/course.php?id={COURSE_ID}&token={TOKEN}`

---

## 📦 Anforderungen

### **Muss haben (MVP)**
1. ✅ **RSS-Feed Parser**
   - Fetcht Moodle RSS-Feeds mit Token
   - Parst XML in lesbare Daten

2. ✅ **Aufgaben-Extraktion**
   - Extrahiert: Titel, Beschreibung, Fälligkeitsdatum, Kurs, Link
   - Filtert: Nur neue/offene Aufgaben

3. ✅ **CLI-Output**
   - Schöne Terminal-Ausgabe
   - Tabellen-Format oder Liste
   - Sortiert nach Deadline (nächste zuerst)

4. ✅ **Konfigurationsmanagement**
   - `.env` Datei für Credentials (nicht im Code hardcoden!)
   - Umgebungsvariablen: `MOODLE_URL`, `MOODLE_TOKEN`, `MOODLE_USER_ID`

5. ✅ **Apple Reminders Integration** (macOS)
   - Automatisch: Neue Aufgaben zur "Reminders" App hinzufügen
   - Mit Fälligkeitsdatum synchen
   - Liste: "Schulaufgaben" (wird automatisch erstellt wenn nicht vorhanden)
   - AppleScript via `osascript` Command ausführen
   - Fehlerbehandlung wenn Reminders App nicht läuft

### **Schön zu haben**
- ✨ Farbige Terminal-Ausgabe (Rot für überfällig, Gelb für bald fällig)
- ✨ JSON-Export (für Weiterverarbeitung)
- ✨ Unterscheidung: Neue vs. ausstehende Aufgaben
- ✨ Cron-Job für tägliche Reminders (mit `node-cron`)
- ✨ macOS Notifications wenn neue Aufgabe hinzugefügt
- ✨ Sync in umgekehrte Richtung: "Erledigt" in Reminders → auch in Moodle abhaken (optional)

---

## 📥 Input / Output

### **Input**
- Moodle RSS-Feed URLs (via Environment Variables)
- Token-basierte Authentifizierung

### **Output**

**Terminal-Ausgabe Beispiel:**
```
╔════════════════════════════════════════════════════════════════╗
║                    📚 DEINE OFFENEN AUFGABEN                   ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║ 🔴 ÜBERFÄLLIG                                                  ║
║   Mathe Hausaufgabe 5                                          ║
║   Kurs: 4AHIF Mathematik                                       ║
║   Fällig: 26.09.2026 (1 Tag überfällig)                        ║
║   Link: [Aufgabe anzeigen]                                     ║
║                                                                ║
║ 🟡 BALD FÄLLIG (< 3 Tage)                                      ║
║   Englisch Essay                                               ║
║   Kurs: 4AHIF English                                          ║
║   Fällig: 30.09.2026 (in 2 Tagen)                              ║
║                                                                ║
║ 🟢 NOCH ZEIT (> 3 Tage)                                        ║
║   Informatik Projekt                                           ║
║   Kurs: 4AHIF Informatik                                       ║
║   Fällig: 05.10.2026 (in 7 Tagen)                              ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

Insgesamt: 3 offene Aufgaben | Zuletzt aktualisiert: 28.09.2026 14:32
```

---

## 🛠️ Tech-Stack (Empfehlung)

- **Sprache:** Node.js / JavaScript (oder Python - deine Wahl)
- **RSS Parser:** `rss-parser` (npm) oder `feedparser` 
- **HTTP-Requests:** `axios` oder `node-fetch`
- **CLI Output:** `chalk` (Farben), `table` (Tabellen) oder `cli-table3`
- **Config:** `dotenv` (für `.env` Datei)
- **macOS Reminders:** `osascript` (native, kein npm-Package nötig)
  - Via `child_process.exec()` AppleScript ausführen
- **Optional - Automation:** `node-cron` (für tägliche Tasks)

---

## 📋 Deliverables

1. **moodle-task-fetcher.js** - Hauptscript
2. **.env.example** - Template für Konfiguration
3. **package.json** - Abhängigkeiten
4. **README.md** - Anleitung zum Setup und Nutzen
5. **GitHub-Repo** - Ready to push

---

## 🚀 Nutzung (Final)

```bash
# Setup
npm install
cp .env.example .env
# → .env ausfüllen mit Token & URL

# Einmalig ausführen
node moodle-task-fetcher.js
# → Zeigt Aufgaben im Terminal
# → Fügt neue Aufgaben zu Reminders App hinzu

# Optional: Tägliche Automatisierung
npm run schedule
# → Läuft täglich z.B. um 08:00 Uhr
# → Syncht automatisch Reminders App

# Manuelle Sync mit Reminders
node moodle-task-fetcher.js --sync-reminders
```

### **Was passiert automatisch:**
1. Moodle RSS fetchen ✅
2. Neue Aufgaben im Terminal anzeigen ✅
3. Zu Reminders App "Schulaufgaben" hinzufügen ✅
4. Duplikate vermeiden (nur neue Aufgaben) ✅
5. Mit Fälligkeitsdatum & Notification ✅

---

## 📝 Zusätzliche Infos

- **Zielplattform:** macOS (Linux kompatibel)
- **Portfolio-Projekt:** Ja - für Tech-Bewerbungen (Dynatrace, Cineplexx)
- **Zeitrahmen:** 1-2 Tage Entwicklung

---

## 🍎 **Apple Reminders Integration (Details)**

### **Wie es funktioniert:**
```javascript
// AppleScript via osascript wird ausgeführt:
const addTaskToReminders = (title, dueDate, description) => {
  const applescript = `
    tell application "Reminders"
      set remindersList to list "Schulaufgaben"
      make new reminder at end of remindersList with properties {
        name: "${title}",
        body: "${description}",
        due date: date "${dueDate}"
      }
      activate
    end tell
  `;
  
  exec(`osascript -e '${applescript}'`, (err) => {
    if (err) console.error("Reminders Error:", err);
    else console.log("✅ Zu Reminders hinzugefügt: " + title);
  });
};
```

### **Features:**
- ✅ Automatische Liste "Schulaufgaben" erstellen
- ✅ Mit Fälligkeitsdatum (iCloud syncht automatisch)
- ✅ Aufgabenbeschreibung inkludieren
- ✅ Fehlerbehandlung wenn App nicht läuft
- ✅ Duplikate vermeiden (Tracking bereits hinzugefügter Tasks)

### **Überprüfung:**
Nach dem ersten Run schaue in deine **macOS Reminders App**:
- Neue Liste: "Schulaufgaben" sollte auftauchen
- Alle neuen Aufgaben dort synchen
- Auf anderen Geräten via iCloud verfügbar

---

## ⚠️ Wichtig

- **Sicherheit:** Token & Credentials NIE in Git committen
- **Error-Handling:** Netzwerkfehler, ungültige Tokens abfangen
- **Logging:** Infos über Fetch-Erfolg/-Fehler ausgeben
- **Testing:** Mit echtem Moodle-Feed testen

---

**Status:** Bereit für Claude Code! 🚀
