# Accountable &bull; Resilience & Momentum Habit Tracker

A local-first, distraction-free web application to track recovery and accountability with a **continuous resilience curve** instead of an all-or-nothing streak counter.

---

## Key Features

1. **Continuous Momentum Score (Model A)**
   * Avoids the "what-the-hell" streak trap: a bad day is treated as a **dip**, not an instant wipeout to zero.
   * Recovery is steady: consecutive clean days rebuild momentum back towards 100%.
   * 3-Tier Graded Status:
     * 🟢 **Clean / Victorious (100%)**: Gains positive momentum.
     * 🟡 **Close Call / Minor Slip (50%)**: Pauses or causes a slight dip while acknowledging urge management.
     * 🔴 **Relapse (0%)**: Causes a distinct dip, retaining the majority of your accumulated baseline progress.

2. **Contribution Heat Map & Rapid Backfilling**
   * GitHub-style interactive calendar grid for the past 52 weeks or specific calendar years.
   * **Rapid Manual Entry**: Click any square, press `1` (Clean), `2` (Minor), `3` (Relapse), and hit `Enter` to save and advance automatically to the next day.
   * **Batch Fill Tool**: Populate weeks or months of past clean streaks with one click, then edit specific relapse days as needed.

3. **Client-Side Excel (.xlsx) Export with Graphs**
   * Uses local `ExcelJS` (no server or network required).
   * **Sheet 1 (Dashboard & KPIs)**: Summary stats + an **embedded high-resolution PNG snapshot of your momentum chart**.
   * **Sheet 2 (Daily Logs)**: Complete chronological log with formatted columns, weekday names, adherence %, resilience %, and personal notes/triggers.

4. **100% Local & Private**
   * Zero servers, zero analytics, zero network requests.
   * All dependencies (`Chart.js` and `ExcelJS`) are vendor-bundled inside the folder.
   * Works offline directly via `file://`.
   * Data persists in your browser's `localStorage`.
   * Includes one-click **JSON Backup** and **JSON Restore** buttons.

---

## How to Run

Simply **double-click** `index.html` or open it in any web browser (Chrome, Safari, Firefox, Edge, etc.):

```bash
open index.html
```

---

## Keyboard Shortcuts (Inside Day Modal)
* `1`: Mark as Clean / Victorious
* `2`: Mark as Close Call / Minor Slip
* `3`: Mark as Relapse
* `Enter`: Save and jump to the next day
* `Esc`: Close modal
* `t`: Log today (from main view)
