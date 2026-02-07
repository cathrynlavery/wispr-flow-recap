#!/usr/bin/env node

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- Config ---
const DB_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Wispr Flow/flow.sqlite"
);

const args = process.argv.slice(2);
const flagHTML = args.includes("--html");
const flagMonth = args.find((a) => a.startsWith("--month="));

// Compute month range (first day to last day)
function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0); // day 0 of next month = last day of this month
  return {
    start: firstDay.toISOString().slice(0, 10),
    end: lastDay.toISOString().slice(0, 10),
    year,
    month,
    label: firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    shortLabel: firstDay.toLocaleDateString("en-US", { month: "short" }),
    daysInMonth: lastDay.getDate(),
  };
}

const targetMonth = flagMonth
  ? flagMonth.split("=")[1]
  : new Date().toISOString().slice(0, 7);
const monthRange = getMonthRange(targetMonth);

// --- Open DB (read-only) ---
if (!fs.existsSync(DB_PATH)) {
  console.error("Wispr Flow database not found at:", DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// --- Query all rows for the month ---
const rows = db
  .prepare(
    `SELECT
      transcriptEntityId,
      formattedText,
      timestamp,
      app,
      url,
      numWords,
      duration,
      conversationId
    FROM History
    WHERE date(timestamp) >= ? AND date(timestamp) <= ?
      AND isArchived = 0
      AND (formattedText IS NOT NULL AND formattedText != '')
    ORDER BY timestamp ASC`
  )
  .all(monthRange.start, monthRange.end);

if (rows.length === 0) {
  console.log(`No Wispr Flow dictations found for ${monthRange.label}.`);
  process.exit(0);
}

// --- Aggregate ---
const totalDictations = rows.length;
const totalWords = rows.reduce((sum, r) => sum + (r.numWords || 0), 0);
const totalDuration = rows.reduce((sum, r) => sum + (r.duration || 0), 0);
const uniqueApps = new Set(rows.map((r) => r.app).filter(Boolean)).size;

// Daily breakdown
const dayMap = {};
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
for (const r of rows) {
  const day = r.timestamp.slice(0, 10);
  if (!dayMap[day]) dayMap[day] = { count: 0, words: 0, duration: 0, apps: new Set() };
  dayMap[day].count++;
  dayMap[day].words += r.numWords || 0;
  dayMap[day].duration += r.duration || 0;
  if (r.app) dayMap[day].apps.add(r.app);
}

// Fill all days of the month
const allDays = [];
for (let d = 1; d <= monthRange.daysInMonth; d++) {
  const key = `${monthRange.year}-${String(monthRange.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(key + "T12:00:00");
  const data = dayMap[key] || { count: 0, words: 0, duration: 0, apps: new Set() };
  allDays.push({
    date: key,
    dayOfWeek: dt.getDay(),
    dayName: dayNames[dt.getDay()],
    dayNum: d,
    count: data.count,
    words: data.words,
    duration: data.duration,
    appCount: data.apps.size,
  });
}

// Busiest day
const busiestDay = allDays.reduce((best, d) => (d.count > best.count ? d : best), allDays[0]);

// Day-of-week aggregate (Mon-Sun)
const dowAggregate = [0, 0, 0, 0, 0, 0, 0]; // Sun=0 .. Sat=6
for (const d of allDays) {
  dowAggregate[d.dayOfWeek] += d.count;
}

// Reorder to Mon-Sun for display
const dowLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dowValues = [
  dowAggregate[1], dowAggregate[2], dowAggregate[3],
  dowAggregate[4], dowAggregate[5], dowAggregate[6], dowAggregate[0],
];

// Week-by-week breakdown
function getWeekOfMonth(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const dayOfMonth = d.getDate();
  // ISO-style: week starts Monday
  const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  const firstDow = firstOfMonth.getDay(); // 0=Sun
  const adjustedFirst = firstDow === 0 ? 6 : firstDow - 1; // Mon=0
  return Math.floor((dayOfMonth - 1 + adjustedFirst) / 7);
}

const weekMap = {};
for (const d of allDays) {
  const wIdx = getWeekOfMonth(d.date);
  if (!weekMap[wIdx]) weekMap[wIdx] = { count: 0, words: 0, apps: new Set(), startDate: d.date };
  weekMap[wIdx].count += d.count;
  weekMap[wIdx].words += d.words;
  // collect unique apps from dayMap
  const dm = dayMap[d.date];
  if (dm) {
    for (const a of dm.apps) weekMap[wIdx].apps.add(a);
  }
}

const weeksSorted = Object.entries(weekMap)
  .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
  .map(([idx, data]) => {
    const startD = new Date(data.startDate + "T12:00:00");
    const label = `Week of ${startD.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return {
      label,
      count: data.count,
      words: data.words,
      appCount: data.apps.size,
    };
  });

// App breakdown (whole month)
const appMap = {};
for (const r of rows) {
  const bundleId = r.app || "Unknown";
  const appName = friendlyAppName(bundleId);
  if (!appMap[appName]) appMap[appName] = { count: 0, words: 0, bundleId };
  appMap[appName].count++;
  appMap[appName].words += r.numWords || 0;
}
const appsSorted = Object.entries(appMap).sort((a, b) => b[1].count - a[1].count);

// Hourly heatmap (aggregate across month)
const hourMap = {};
for (const r of rows) {
  const hour = new Date(r.timestamp).getHours();
  hourMap[hour] = (hourMap[hour] || 0) + 1;
}
const peakHour = Object.entries(hourMap).sort((a, b) => b[1] - a[1])[0];

// Active days count (for daily averages)
const activeDays = allDays.filter((d) => d.count > 0).length;
const avgDictationsPerDay = activeDays > 0 ? Math.round(totalDictations / activeDays) : 0;
const avgWordsPerDay = activeDays > 0 ? Math.round(totalWords / activeDays) : 0;

// --- Output ---
const data = {
  monthRange,
  totalDictations,
  totalWords,
  totalDuration,
  uniqueApps,
  allDays,
  weeksSorted,
  appsSorted,
  hourMap,
  peakHour,
  busiestDay,
  dowLabels,
  dowValues,
  activeDays,
  avgDictationsPerDay,
  avgWordsPerDay,
};

if (flagHTML) {
  const html = generateHTML(data);
  const outPath = path.join(os.homedir(), `Desktop/wispr-monthly-${targetMonth}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`Monthly HTML recap saved to: ${outPath}`);
} else {
  printCLI(data);
}

db.close();

// ===================== HELPERS =====================

function appIconURL(bundleId) {
  const icons = {
    "dev.warp.Warp-Stable": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/4e/30/a3/4e30a3c6-4e6a-8b3e-2c43-1e5e1392da38/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.apple.Safari": "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/e4/90/f7/e490f720-05f3-da66-87b5-2c24d2039027/AppIcon-0-0-85-220-0-0-4-0-2x-P3.png/128x128bb.png",
    "com.google.Chrome": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/43/81/fa/4381faed-2d0d-c3a8-9692-faab4f3c7197/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.tinyspeck.slackmacgap": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/4c/d2/e3/4cd2e362-0499-89c7-a1f5-1708b8b0b9f3/AppIcon-85-220-0-4-2x-sRGB.png/128x128bb.png",
    "com.microsoft.VSCode": "https://code.visualstudio.com/assets/images/code-stable.png",
    "com.todesktop.230313mzl4w4u92": "https://cursor.sh/apple-touch-icon.png",
    "com.apple.MobileSMS": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/09/63/1e/09631eff-b2e2-0279-c9ba-221c84bc8a74/AppIcon-0-1x_U007emarketing-0-0-0-10-0-0-85-220-0.png/128x128bb.png",
    "com.apple.mail": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/b7/1c/6b/b71c6b5b-db47-6dab-2f24-7b79e2413b64/AppIcon-0-0-85-220-0-0-4-0-2x.png/128x128bb.png",
    "com.openai.chat": "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/a8/2e/4d/a82e4d68-dc3a-a762-6e07-e6e1be5e01a8/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.superhuman.electron": "https://superhuman.com/favicon-196x196.png",
    "com.figma.Desktop": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/41/31/8e/41318ea1-7be2-2aaa-07ae-3c3a1e0a04c3/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "md.obsidian": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/6e/1f/34/6e1f34cb-a1f9-4f67-e8d3-1a8d7bb5f1d2/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "notion.id": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/f4/67/94/f467940c-9b4b-7a71-f1e6-f4a43aef3de5/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "company.thebrowser.Browser": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/4f/0f/bd/4f0fbd2a-fd34-56d2-35c2-9b1f51db38fc/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "net.shinyfrog.bear": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/88/de/a5/88dea5c5-6ca2-72c4-fb51-c7563eb06b60/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.hnc.Discord": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/77/3c/3f/773c3fe3-7f3c-ed1f-8c4c-8dab2a55f040/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.spotify.client": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/ae/5e/44/ae5e4464-5965-67e6-66ba-6e06b19b19e9/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "us.zoom.xos": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/47/a6/72/47a672c6-4261-d5cf-3acb-dd62ce0d9788/AppIcon-85-220-0-4-2x.png/128x128bb.png",
    "com.codeium.windsurf": "https://codeium.com/favicon.png",
    "com.linear": "https://linear.app/favicon-128.png",
  };
  return icons[bundleId] || null;
}

function friendlyAppName(bundleId) {
  if (!bundleId) return "Unknown";
  const map = {
    "dev.warp.Warp-Stable": "Warp",
    "com.apple.Safari": "Safari",
    "com.google.Chrome": "Chrome",
    "com.tinyspeck.slackmacgap": "Slack",
    "com.microsoft.VSCode": "VS Code",
    "com.todesktop.230313mzl4w4u92": "Cursor",
    "com.linear": "Linear",
    "com.apple.MobileSMS": "Messages",
    "com.apple.mail": "Mail",
    "com.apple.Notes": "Notes",
    "com.openai.chat": "ChatGPT",
    "com.superhuman.electron": "Superhuman",
    "com.figma.Desktop": "Figma",
    "com.apple.finder": "Finder",
    "com.apple.Terminal": "Terminal",
    "md.obsidian": "Obsidian",
    "notion.id": "Notion",
    "com.codeium.windsurf": "Windsurf",
    "company.thebrowser.Browser": "Arc",
    "net.shinyfrog.bear": "Bear",
    "com.hnc.Discord": "Discord",
    "com.spotify.client": "Spotify",
    "us.zoom.xos": "Zoom",
  };
  if (map[bundleId]) return map[bundleId];
  const parts = bundleId.split(".");
  return parts[parts.length - 1].replace(/-/g, " ");
}

function truncate(str, len) {
  if (!str) return "";
  const clean = str.replace(/\n/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "..." : clean;
}

function formatDuration(seconds) {
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function barChart(value, max, width = 20) {
  const filled = Math.round((value / max) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function formatHour(h) {
  return h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ===================== CLI =====================

function printCLI(data) {
  const {
    monthRange, totalDictations, totalWords, totalDuration, uniqueApps,
    weeksSorted, appsSorted, peakHour, busiestDay,
    activeDays, avgDictationsPerDay, avgWordsPerDay,
  } = data;

  const busiestDayLabel = new Date(busiestDay.date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  console.log(`\n# Wispr Flow Monthly Recap — ${monthRange.label}\n`);

  // Overview
  console.log("## Overview\n");
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Dictations | ${totalDictations} |`);
  console.log(`| Total words | ${totalWords.toLocaleString()} |`);
  console.log(`| Voice time | ${formatDuration(totalDuration)} |`);
  console.log(`| Apps used | ${uniqueApps} |`);
  console.log(`| Busiest day | ${busiestDayLabel} (${busiestDay.count} dictations) |`);
  console.log(`| Peak hour | ${peakHour ? `${formatHour(parseInt(peakHour[0]))} (${peakHour[1]} total)` : "N/A"} |`);
  console.log();

  // Week-by-week
  console.log("## Week by Week\n");
  const maxWeekCount = Math.max(...weeksSorted.map((w) => w.count), 1);
  for (const w of weeksSorted) {
    if (w.count === 0) {
      console.log(`${barChart(0, maxWeekCount, 15)} ${w.label} — no dictations`);
    } else {
      console.log(
        `${barChart(w.count, maxWeekCount, 15)} **${w.label}** — ${w.count} dictations · ${w.words} words · ${w.appCount} apps`
      );
    }
  }
  console.log();

  // App breakdown
  console.log("## Apps Used\n");
  const maxAppCount = appsSorted[0]?.[1].count || 1;
  for (const [name, stats] of appsSorted) {
    const pct = Math.round((stats.count / totalDictations) * 100);
    console.log(
      `${barChart(stats.count, maxAppCount, 15)} **${name}** — ${stats.count} dictations (${pct}%) · ${stats.words} words`
    );
  }
  console.log();

  // Daily averages
  console.log(
    `Daily average (across ${activeDays} active days): ${avgDictationsPerDay} dictations · ${avgWordsPerDay.toLocaleString()} words\n`
  );
}

// ===================== HTML =====================

function generateHTML(data) {
  const {
    monthRange, totalDictations, totalWords, totalDuration, uniqueApps,
    weeksSorted, appsSorted, hourMap, peakHour, busiestDay,
    dowLabels, dowValues,
    activeDays, avgDictationsPerDay, avgWordsPerDay,
  } = data;

  const busiestDayLabel = new Date(busiestDay.date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  // Week chart bars
  const maxWeekCount = Math.max(...weeksSorted.map((w) => w.count), 1);
  const weekBars = weeksSorted
    .map((w) => {
      const pct = Math.round((w.count / maxWeekCount) * 100);
      return `
      <div class="week-col">
        <div class="week-value">${w.count > 0 ? w.count : ""}</div>
        <div class="week-bar-wrap">
          <div class="week-bar" style="height: ${Math.max(pct, 2)}%"></div>
        </div>
        <div class="week-label">${escapeHTML(w.label)}</div>
        <div class="week-sublabel">${w.words > 0 ? w.words.toLocaleString() + "w" : "-"}</div>
      </div>`;
    })
    .join("\n");

  // Day-of-week heatmap (Mon-Sun)
  const maxDowCount = Math.max(...dowValues, 1);
  const dowCells = dowLabels
    .map((label, i) => {
      const count = dowValues[i];
      const intensity = Math.round((count / maxDowCount) * 100);
      const opacity = count > 0 ? 0.15 + (intensity / 100) * 0.85 : 0.04;
      const textColor = opacity > 0.5 ? "#f5f4ed" : "var(--text)";
      const labelColor = opacity > 0.5 ? "rgba(245,244,237,0.7)" : "var(--text-muted)";
      return `
      <div class="dow-cell" style="background: rgba(45, 45, 45, ${opacity})">
        <div class="dow-num" style="color: ${textColor}">${count > 0 ? count : ""}</div>
        <div class="dow-label" style="color: ${labelColor}">${label}</div>
      </div>`;
    })
    .join("\n");

  // Hourly heatmap
  const maxHourCount = Math.max(...Object.values(hourMap), 1);
  const hourCells = [];
  for (let h = 6; h <= 23; h++) {
    const count = hourMap[h] || 0;
    const intensity = Math.round((count / maxHourCount) * 100);
    const opacity = count > 0 ? 0.15 + (intensity / 100) * 0.85 : 0.04;
    const textColor = opacity > 0.5 ? "#f5f4ed" : "var(--text)";
    const labelColor = opacity > 0.5 ? "rgba(245,244,237,0.7)" : "var(--text-muted)";
    hourCells.push(
      `<div class="hour-cell" style="background: rgba(45, 45, 45, ${opacity})" title="${formatHour(h)}: ${count} dictations">
        <div class="hour-num" style="color: ${textColor}">${count > 0 ? count : ""}</div>
        <div class="hour-label" style="color: ${labelColor}">${h % 3 === 0 ? formatHour(h) : ""}</div>
      </div>`
    );
  }

  // App cards with icons
  const appCards = appsSorted
    .map(([name, stats]) => {
      const pct = Math.round((stats.count / totalDictations) * 100);
      const iconUrl = appIconURL(stats.bundleId);
      const iconHTML = iconUrl
        ? `<img class="app-icon" src="${iconUrl}" alt="${escapeHTML(name)}" onerror="this.style.display='none'">`
        : `<div class="app-icon app-icon-fallback">${escapeHTML(name.charAt(0))}</div>`;
      return `
      <div class="app-card">
        <div class="app-header">
          ${iconHTML}
          <div class="app-header-text">
            <div class="app-name">${escapeHTML(name)}</div>
            <div class="app-stats">${stats.count} dictations · ${stats.words.toLocaleString()} words · ${pct}%</div>
          </div>
        </div>
        <div class="app-bar-wrap">
          <div class="app-bar" style="width: ${pct}%"></div>
        </div>
      </div>`;
    })
    .join("\n");

  const top3Apps = appsSorted.slice(0, 3).map(([name, stats]) => {
    const pct = Math.round((stats.count / totalDictations) * 100);
    return `<div class="sc-app">
        <div class="sc-app-name">${escapeHTML(name)}</div>
        <div class="sc-app-bar-wrap"><div class="sc-app-bar" style="width: ${pct}%"></div></div>
        <div class="sc-app-pct">${pct}%</div>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wispr Flow Monthly Recap — ${escapeHTML(monthRange.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f4ed;
    --surface: rgba(255, 255, 255, 0.6);
    --surface2: rgba(255, 255, 255, 0.85);
    --border: rgba(135, 139, 134, 0.12);
    --text: #0b0d0b;
    --text-muted: #52534e;
    --accent: #f34e3f;
    --accent-light: rgba(243, 78, 63, 0.12);
    --font-sans: "Inter", system-ui, -apple-system, sans-serif;
    --font-serif: "Instrument Serif", "Times New Roman", serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    padding: 48px 24px;
    max-width: 760px;
    margin: 0 auto;
    line-height: 1.5;
    font-size: 1.125rem;
  }
  @media (min-width: 640px) {
    body { padding: 64px 32px; font-size: 1.25rem; }
  }

  .label-mono {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.6rem;
    background: var(--accent-light);
    border-radius: 999px;
    margin-bottom: 16px;
  }
  h1 {
    font-family: var(--font-serif);
    font-size: 2.5rem;
    font-weight: 400;
    line-height: 1.15;
    color: var(--text);
    margin-bottom: 6px;
    font-style: italic;
  }
  .subtitle { color: var(--text-muted); font-size: 0.95rem; margin-bottom: 40px; }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 48px;
  }
  @media (min-width: 640px) {
    .stats-grid { grid-template-columns: repeat(3, 1fr); }
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    backdrop-filter: blur(8px);
  }
  .stat-value {
    font-family: var(--font-serif);
    font-size: 2rem;
    font-weight: 400;
    color: var(--text);
    line-height: 1.1;
    margin-bottom: 4px;
  }
  .stat-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }

  /* Section Headings */
  h2 {
    font-family: var(--font-serif);
    font-size: 1.75rem;
    font-weight: 400;
    margin-bottom: 20px;
    color: var(--text);
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .section { margin-bottom: 48px; }

  /* Week Chart */
  .week-chart {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    height: 200px;
    padding: 16px 0;
  }
  .week-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    height: 100%;
  }
  .week-value {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-muted);
    min-height: 16px;
  }
  .week-bar-wrap {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .week-bar {
    width: 100%;
    max-width: 80px;
    background: #2d2d2d;
    border-radius: 6px 6px 2px 2px;
    min-height: 2px;
    transition: height 0.6s ease;
  }
  .week-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--text);
    text-align: center;
    line-height: 1.3;
  }
  .week-sublabel {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    color: var(--text-muted);
  }

  /* Day-of-week heatmap */
  .dow-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
    margin-top: 8px;
  }
  .dow-cell {
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 14px 8px;
    min-height: 64px;
  }
  .dow-num {
    font-family: var(--font-serif);
    font-size: 1.1rem;
    font-weight: 400;
    font-style: italic;
    margin-bottom: 2px;
  }
  .dow-label {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* Hour Heatmap */
  .hour-grid {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 4px;
    margin-top: 8px;
  }
  @media (min-width: 640px) {
    .hour-grid { grid-template-columns: repeat(18, 1fr); }
  }
  .hour-cell {
    aspect-ratio: 1;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 32px;
  }
  .hour-num {
    font-family: var(--font-serif);
    font-size: 0.85rem;
    font-weight: 400;
    font-style: italic;
  }
  .hour-label {
    font-family: var(--font-mono);
    font-size: 0.45rem;
    letter-spacing: 0.06em;
  }

  /* App Cards */
  .app-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 8px;
    backdrop-filter: blur(8px);
  }
  .app-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .app-icon { width: 40px; height: 40px; border-radius: 10px; object-fit: cover; flex-shrink: 0; }
  .app-icon-fallback {
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-light); color: var(--accent);
    font-family: var(--font-serif); font-size: 1.2rem;
    width: 40px; height: 40px; border-radius: 10px;
  }
  .app-header-text { flex: 1; min-width: 0; }
  .app-name { font-weight: 600; font-size: 0.95rem; margin-bottom: 2px; color: var(--text); }
  .app-bar-wrap { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .app-bar { height: 100%; background: var(--accent); border-radius: 2px; min-width: 4px; }
  .app-stats { font-family: var(--font-mono); font-size: 0.65rem; color: var(--text-muted); letter-spacing: 0.04em; }

  /* Daily average */
  .daily-avg {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
    text-align: center;
    margin-bottom: 48px;
  }
  .daily-avg strong {
    color: var(--text);
    font-weight: 600;
  }

  /* Share */
  .share-btn {
    font-family: var(--font-mono); font-size: 0.65rem; font-weight: 500;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--accent); background: var(--accent-light);
    border: none; border-radius: 999px; padding: 8px 16px;
    cursor: pointer; transition: background 0.2s; margin-bottom: 16px;
  }
  .share-btn:hover { background: rgba(243, 78, 63, 0.2); }

  /* Share Card (off-screen, captured by html2canvas) */
  .share-card {
    position: absolute; left: -9999px; top: 0;
    width: 1200px; height: 630px;
    background: var(--bg); padding: 56px 64px;
    display: flex; flex-direction: column;
    justify-content: space-between;
    font-family: var(--font-sans);
  }
  .sc-top { display: flex; justify-content: space-between; align-items: center; }
  .sc-brand {
    font-family: var(--font-mono); font-size: 14px; font-weight: 500;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent);
  }
  .sc-type {
    font-family: var(--font-mono); font-size: 13px; font-weight: 500;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted);
  }
  .sc-title {
    font-family: var(--font-serif); font-size: 52px; font-weight: 400;
    font-style: italic; color: var(--text); line-height: 1.15; margin-top: 8px;
  }
  .sc-stats { display: flex; gap: 24px; margin-top: 4px; }
  .sc-stat {
    background: rgba(255,255,255,0.6); border: 1px solid rgba(135,139,134,0.12);
    border-radius: 16px; padding: 20px 28px; flex: 1; text-align: center;
  }
  .sc-num {
    font-family: var(--font-serif); font-size: 44px; font-weight: 400;
    color: var(--text); line-height: 1.1;
  }
  .sc-label {
    font-family: var(--font-mono); font-size: 11px; font-weight: 500;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.14em;
    margin-top: 4px;
  }
  .sc-apps { display: flex; flex-direction: column; gap: 10px; }
  .sc-app { display: flex; align-items: center; gap: 14px; }
  .sc-app-name {
    font-family: var(--font-sans); font-size: 16px; font-weight: 600;
    color: var(--text); min-width: 100px; text-align: right;
  }
  .sc-app-bar-wrap {
    flex: 1; height: 12px; background: rgba(135,139,134,0.08);
    border-radius: 6px; overflow: hidden;
  }
  .sc-app-bar { height: 100%; background: #2d2d2d; border-radius: 6px; }
  .sc-app-pct {
    font-family: var(--font-mono); font-size: 14px; color: var(--text-muted);
    min-width: 40px;
  }

  /* Share Modal */
  .share-modal {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
    z-index: 1000; align-items: center; justify-content: center;
  }
  .share-modal.open { display: flex; }
  .share-modal-inner {
    background: #fff; border-radius: 20px; padding: 24px;
    max-width: 680px; width: 90%; box-shadow: 0 24px 48px rgba(0,0,0,0.2);
    position: relative;
  }
  .share-modal-inner img {
    width: 100%; border-radius: 12px;
    border: 1px solid rgba(135,139,134,0.12);
  }
  .modal-close {
    position: absolute; top: -12px; right: -12px;
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--text); color: #fff; border: none;
    font-size: 18px; cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  }
  .share-actions {
    display: flex; gap: 10px; margin-top: 16px; justify-content: center;
  }
  .share-action-btn {
    font-family: var(--font-mono); font-size: 0.7rem; font-weight: 500;
    letter-spacing: 0.08em; text-transform: uppercase;
    padding: 10px 20px; border-radius: 999px; cursor: pointer;
    border: none; transition: background 0.2s; display: flex;
    align-items: center; gap: 8px;
  }
  .share-action-btn.primary {
    background: var(--accent); color: #fff;
  }
  .share-action-btn.primary:hover { background: #e04435; }
  .share-action-btn.secondary {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
  }
  .share-action-btn.secondary:hover { background: #edece5; }
  .share-action-btn svg { width: 14px; height: 14px; }

  /* Footer */
  .footer {
    margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 0.6rem; color: var(--text-muted);
    text-align: center; letter-spacing: 0.1em; text-transform: uppercase;
  }
  .footer a {
    color: var(--accent); text-decoration: underline;
    text-underline-offset: 3px; text-decoration-thickness: 1px;
  }
</style>
</head>
<body>
  <div class="label-mono">Monthly Recap</div>
  <h1>${escapeHTML(monthRange.label)}</h1>
  <div class="subtitle">Your month in voice — powered by Wispr Flow</div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${totalDictations}</div>
      <div class="stat-label">Dictations</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalWords.toLocaleString()}</div>
      <div class="stat-label">Words</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formatDuration(totalDuration)}</div>
      <div class="stat-label">Voice Time</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${uniqueApps}</div>
      <div class="stat-label">Apps</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${escapeHTML(busiestDayLabel)}</div>
      <div class="stat-label">Best Day</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${peakHour ? formatHour(parseInt(peakHour[0])) : "N/A"}</div>
      <div class="stat-label">Peak Hour</div>
    </div>
  </div>

  <div class="daily-avg">
    Daily average across <strong>${activeDays}</strong> active days: <strong>${avgDictationsPerDay}</strong> dictations · <strong>${avgWordsPerDay.toLocaleString()}</strong> words
  </div>

  <div class="section">
    <h2>Week by Week</h2>
    <div class="week-chart">
      ${weekBars}
    </div>
  </div>

  <div class="section">
    <h2>Day of Week</h2>
    <div class="dow-grid">
      ${dowCells}
    </div>
  </div>

  <div class="section">
    <h2>Hour by Hour</h2>
    <div class="hour-grid">
      ${hourCells.join("\n")}
    </div>
  </div>

  <div class="section">
    <h2>Apps</h2>
    ${appCards}
  </div>

  <div class="footer">
    <button class="share-btn" onclick="generateShareImage()">Share</button>
    <div class="footer-links">Generated by <a href="https://lttlmg.ht/wisprflow">Wispr Flow</a> Monthly Recap · <a href="https://github.com/cathrynlavery/wispr-flow-recap">GitHub</a> · <a href="https://founder.codes">founder.codes</a></div>
  </div>

  <!-- Share Card (off-screen, rendered to image) -->
  <div class="share-card" id="shareCard">
    <div>
      <div class="sc-top">
        <div class="sc-brand">Wispr Flow</div>
        <div class="sc-type">Monthly Recap</div>
      </div>
      <div class="sc-title">${escapeHTML(monthRange.label)}</div>
    </div>
    <div class="sc-stats">
      <div class="sc-stat"><div class="sc-num">${totalDictations}</div><div class="sc-label">Dictations</div></div>
      <div class="sc-stat"><div class="sc-num">${totalWords.toLocaleString()}</div><div class="sc-label">Words</div></div>
      <div class="sc-stat"><div class="sc-num">${formatDuration(totalDuration)}</div><div class="sc-label">Voice Time</div></div>
    </div>
    <div class="sc-apps">${top3Apps}</div>
  </div>

  <!-- Share Modal -->
  <div class="share-modal" id="shareModal">
    <div class="share-modal-inner">
      <button class="modal-close" onclick="closeShareModal()">&times;</button>
      <img id="shareImg" />
      <div class="share-actions">
        <button class="share-action-btn primary" onclick="downloadShareImage()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        <button class="share-action-btn secondary" onclick="shareOnX()">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          Share on X
        </button>
      </div>
    </div>
  </div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script>
  const shareText = "My ${escapeHTML(monthRange.label)} in voice: ${totalDictations} dictations across ${uniqueApps} apps with @WisprFlow";
  let shareBlob = null;

  async function generateShareImage() {
    const btn = document.querySelector(".share-btn");
    btn.textContent = "...";
    const card = document.getElementById("shareCard");
    card.style.left = "0"; card.style.top = "0"; card.style.position = "fixed"; card.style.zIndex = "-1";
    try {
      const canvas = await html2canvas(card, { scale: 2, backgroundColor: "#f5f4ed", width: 1200, height: 630, useCORS: true });
      card.style.left = "-9999px"; card.style.position = "absolute"; card.style.zIndex = "";
      const dataUrl = canvas.toDataURL("image/png");
      document.getElementById("shareImg").src = dataUrl;
      canvas.toBlob(b => { shareBlob = b; });
      document.getElementById("shareModal").classList.add("open");
    } catch (e) { console.error(e); }
    btn.textContent = "Share";
  }

  function closeShareModal() {
    document.getElementById("shareModal").classList.remove("open");
  }

  function downloadShareImage() {
    const a = document.createElement("a");
    a.href = document.getElementById("shareImg").src;
    a.download = "wispr-monthly-recap.png";
    a.click();
  }

  async function shareOnX() {
    if (shareBlob && navigator.canShare && navigator.canShare({ files: [new File([shareBlob], "recap.png", { type: "image/png" })] })) {
      await navigator.share({ text: shareText, files: [new File([shareBlob], "wispr-monthly-recap.png", { type: "image/png" })] });
    } else {
      downloadShareImage();
      setTimeout(() => window.open("https://x.com/intent/tweet?text=" + encodeURIComponent(shareText), "_blank"), 500);
    }
  }

  document.getElementById("shareModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShareModal();
  });
</script>
</body>
</html>`;
}
