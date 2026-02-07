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
const flagDate = args.find((a) => a.startsWith("--date="));
const targetDate = flagDate ? flagDate.split("=")[1] : new Date().toISOString().slice(0, 10);

// --- Open DB (read-only) ---
if (!fs.existsSync(DB_PATH)) {
  console.error("Wispr Flow database not found at:", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// --- Queries ---
const rows = db
  .prepare(
    `SELECT
      transcriptEntityId,
      formattedText,
      asrText,
      timestamp,
      app,
      url,
      numWords,
      duration,
      language,
      conversationId
    FROM History
    WHERE date(timestamp) = ?
      AND isArchived = 0
      AND (formattedText IS NOT NULL AND formattedText != '')
    ORDER BY timestamp ASC`
  )
  .all(targetDate);

if (rows.length === 0) {
  console.log(`No Wispr Flow dictations found for ${targetDate}.`);
  process.exit(0);
}

// --- Aggregate Stats ---
const totalDictations = rows.length;
const totalWords = rows.reduce((sum, r) => sum + (r.numWords || 0), 0);
const totalDuration = rows.reduce((sum, r) => sum + (r.duration || 0), 0);

// App breakdown
const appMap = {};
for (const r of rows) {
  const bundleId = r.app || "Unknown";
  const appName = friendlyAppName(bundleId);
  if (!appMap[appName]) appMap[appName] = { count: 0, words: 0, bundleId };
  appMap[appName].count++;
  appMap[appName].words += r.numWords || 0;
}
const appsSorted = Object.entries(appMap).sort((a, b) => b[1].count - a[1].count);

// Hourly activity
const hourMap = {};
for (const r of rows) {
  const hour = new Date(r.timestamp).getHours();
  hourMap[hour] = (hourMap[hour] || 0) + 1;
}
const peakHour = Object.entries(hourMap).sort((a, b) => b[1] - a[1])[0];

// Group transcripts by conversation/app for topic extraction
const transcriptsByApp = {};
for (const r of rows) {
  const appName = friendlyAppName(r.app || "Unknown");
  if (!transcriptsByApp[appName]) transcriptsByApp[appName] = [];
  transcriptsByApp[appName].push(r.formattedText);
}

// Timeline blocks (group by hour)
const timelineBlocks = [];
const hourGroups = {};
for (const r of rows) {
  const hour = new Date(r.timestamp).getHours();
  if (!hourGroups[hour]) hourGroups[hour] = [];
  hourGroups[hour].push(r);
}
for (const [hour, entries] of Object.entries(hourGroups).sort((a, b) => a[0] - b[0])) {
  const h = parseInt(hour);
  const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
  const apps = [...new Set(entries.map((e) => friendlyAppName(e.app || "Unknown")))];
  const words = entries.reduce((s, e) => s + (e.numWords || 0), 0);
  const snippets = entries
    .filter((e) => e.formattedText && e.formattedText.length > 20)
    .slice(0, 2)
    .map((e) => truncate(e.formattedText, 100));
  timelineBlocks.push({ label, count: entries.length, apps, words, snippets });
}

// --- Output ---
if (flagHTML) {
  const html = generateHTML({
    targetDate,
    totalDictations,
    totalWords,
    totalDuration,
    appsSorted,
    peakHour,
    timelineBlocks,
    transcriptsByApp,
  });
  const outPath = path.join(os.homedir(), `Desktop/wispr-recap-${targetDate}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`HTML recap saved to: ${outPath}`);
} else {
  printCLI({
    targetDate,
    totalDictations,
    totalWords,
    totalDuration,
    appsSorted,
    peakHour,
    timelineBlocks,
    transcriptsByApp,
  });
}

db.close();

// --- Helpers ---

function appIconURL(bundleId) {
  // Map bundle IDs to macOS App Store icon URLs (high-res)
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
  // Try to extract last component
  const parts = bundleId.split(".");
  return parts[parts.length - 1].replace(/-/g, " ");
}

function truncate(str, len) {
  if (!str) return "";
  const clean = str.replace(/\n/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "..." : clean;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function barChart(value, max, width = 20) {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function printCLI(data) {
  const {
    targetDate,
    totalDictations,
    totalWords,
    totalDuration,
    appsSorted,
    peakHour,
    timelineBlocks,
    transcriptsByApp,
  } = data;

  const dayName = new Date(targetDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  console.log(`\n# Wispr Flow Daily Recap — ${dayName}\n`);

  // Overview
  console.log("## Overview\n");
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Dictations | ${totalDictations} |`);
  console.log(`| Total words | ${totalWords.toLocaleString()} |`);
  console.log(`| Voice time | ${formatDuration(totalDuration)} |`);
  console.log(
    `| Peak hour | ${peakHour ? `${formatHour(parseInt(peakHour[0]))} (${peakHour[1]} dictations)` : "N/A"} |`
  );
  console.log();

  // App breakdown
  console.log("## Apps Used\n");
  const maxCount = appsSorted[0]?.[1].count || 1;
  for (const [name, stats] of appsSorted) {
    const pct = Math.round((stats.count / totalDictations) * 100);
    console.log(
      `${barChart(stats.count, maxCount, 15)} **${name}** — ${stats.count} dictations (${pct}%) · ${stats.words} words`
    );
  }
  console.log();

  // Timeline
  console.log("## Timeline\n");
  for (const block of timelineBlocks) {
    console.log(
      `### ${block.label} — ${block.count} dictations · ${block.words} words`
    );
    console.log(`Apps: ${block.apps.join(", ")}`);
    if (block.snippets.length > 0) {
      for (const s of block.snippets) {
        console.log(`> "${s}"`);
      }
    }
    console.log();
  }

  // Transcript digest per app
  console.log("## What You Worked On\n");
  for (const [appName, transcripts] of Object.entries(transcriptsByApp)) {
    console.log(`### ${appName} (${transcripts.length} dictations)\n`);
    // Show representative samples
    const samples = transcripts
      .filter((t) => t.length > 30)
      .slice(0, 5)
      .map((t) => `- "${truncate(t, 150)}"`);
    if (samples.length > 0) {
      console.log(samples.join("\n"));
    }
    console.log();
  }
}

function formatHour(h) {
  return h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
}

function generateHTML(data) {
  const {
    targetDate,
    totalDictations,
    totalWords,
    totalDuration,
    appsSorted,
    peakHour,
    timelineBlocks,
    transcriptsByApp,
  } = data;

  const dayName = new Date(targetDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const appCards = appsSorted
    .map(([name, stats]) => {
      const pct = Math.round((stats.count / totalDictations) * 100);
      const iconUrl = appIconURL(stats.bundleId);
      const iconHTML = iconUrl
        ? `<img class="app-icon" src="${iconUrl}" alt="${name}" onerror="this.style.display='none'">`
        : `<div class="app-icon app-icon-fallback">${name.charAt(0)}</div>`;
      return `
      <div class="app-card">
        <div class="app-header">
          ${iconHTML}
          <div class="app-header-text">
            <div class="app-name">${name}</div>
            <div class="app-stats">${stats.count} dictations · ${stats.words} words · ${pct}%</div>
          </div>
        </div>
        <div class="app-bar-wrap">
          <div class="app-bar" style="width: ${pct}%"></div>
        </div>
      </div>`;
    })
    .join("\n");

  const timelineItems = timelineBlocks
    .map((block) => {
      const snippetHTML = block.snippets
        .map((s) => `<div class="snippet">"${escapeHTML(s)}"</div>`)
        .join("\n");
      return `
      <div class="timeline-block">
        <div class="time-label">${block.label}</div>
        <div class="time-body">
          <div class="time-stats">${block.count} dictations · ${block.words} words · ${block.apps.join(", ")}</div>
          ${snippetHTML}
        </div>
      </div>`;
    })
    .join("\n");

  const topicSections = Object.entries(transcriptsByApp)
    .map(([appName, transcripts]) => {
      const samples = transcripts
        .filter((t) => t.length > 30)
        .slice(0, 5)
        .map((t) => `<li>"${escapeHTML(truncate(t, 150))}"</li>`)
        .join("\n");
      return `
      <div class="topic-section">
        <h3>${escapeHTML(appName)} <span class="count">${transcripts.length}</span></h3>
        <ul>${samples}</ul>
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
<title>Wispr Flow Recap — ${escapeHTML(dayName)}</title>
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
    max-width: 700px;
    margin: 0 auto;
    line-height: 1.5;
    font-size: 1.125rem;
  }
  @media (min-width: 640px) {
    body { padding: 64px 32px; font-size: 1.25rem; }
  }

  /* Header */
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
  .subtitle {
    color: var(--text-muted);
    font-size: 0.95rem;
    margin-bottom: 40px;
    line-height: 1.5;
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 48px;
  }
  @media (min-width: 640px) {
    .stats-grid { grid-template-columns: repeat(4, 1fr); }
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

  /* App Cards */
  .app-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 8px;
    backdrop-filter: blur(8px);
  }
  .app-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .app-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .app-icon-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-light);
    color: var(--accent);
    font-family: var(--font-serif);
    font-size: 1.2rem;
    font-weight: 400;
  }
  .app-header-text { flex: 1; min-width: 0; }
  .app-name {
    font-weight: 600;
    font-size: 0.95rem;
    margin-bottom: 2px;
    color: var(--text);
  }
  .app-bar-wrap {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .app-bar {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    min-width: 4px;
    transition: width 0.6s ease;
  }
  .app-stats {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  /* Timeline */
  .timeline-block {
    display: flex;
    gap: 20px;
    margin-bottom: 0;
    padding: 20px 0;
    border-bottom: 1px solid var(--border);
  }
  .timeline-block:first-child { padding-top: 0; }
  .timeline-block:last-child { border-bottom: none; }
  .time-label {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--accent);
    min-width: 56px;
    padding-top: 3px;
    letter-spacing: 0.04em;
  }
  .time-body { flex: 1; }
  .time-stats {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .snippet {
    font-size: 0.85rem;
    color: var(--text);
    padding: 8px 12px;
    background: var(--surface2);
    border-left: 3px solid var(--border);
    border-radius: 0 8px 8px 0;
    margin-top: 6px;
    font-style: italic;
    line-height: 1.45;
  }

  /* Topics */
  .topic-section { margin-bottom: 28px; }
  .topic-section h3 {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    font-weight: 400;
    margin-bottom: 10px;
    color: var(--text);
  }
  .topic-section .count {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--text-muted);
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    background: var(--accent-light);
    padding: 2px 8px;
    border-radius: 999px;
    vertical-align: middle;
    position: relative;
    top: -2px;
  }
  .topic-section ul {
    padding-left: 0;
    list-style: none;
  }
  .topic-section li {
    font-size: 0.9rem;
    color: var(--text-muted);
    margin-bottom: 6px;
    line-height: 1.5;
    padding-left: 16px;
    position: relative;
  }
  .topic-section li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 10px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.5;
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
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--text-muted);
    text-align: center;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="label-mono">Daily Recap</div>
  <h1>${escapeHTML(dayName)}</h1>
  <div class="subtitle">Your voice, distilled — powered by Wispr Flow</div>

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
      <div class="stat-value">${peakHour ? formatHour(parseInt(peakHour[0])) : "N/A"}</div>
      <div class="stat-label">Peak Hour</div>
    </div>
  </div>

  <div class="section">
    <h2>Apps</h2>
    ${appCards}
  </div>

  <div class="section">
    <h2>Timeline</h2>
    ${timelineItems}
  </div>

  <div class="section">
    <h2>What You Worked On</h2>
    ${topicSections}
  </div>

  <div class="footer">
    <button class="share-btn" onclick="generateShareImage()">Share</button>
    <div class="footer-links">Generated by <a href="https://lttlmg.ht/wisprflow">Wispr Flow</a> Daily Recap · <a href="https://github.com/cathrynlavery/wispr-flow-recap">GitHub</a> · <a href="https://founder.codes">founder.codes</a></div>
  </div>

  <!-- Share Card (off-screen, rendered to image) -->
  <div class="share-card" id="shareCard">
    <div>
      <div class="sc-top">
        <div class="sc-brand">Wispr Flow</div>
        <div class="sc-type">Daily Recap</div>
      </div>
      <div class="sc-title">${escapeHTML(dayName)}</div>
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
  const shareText = "I spoke ${totalWords.toLocaleString()} words across ${appsSorted.length} apps today using @WisprFlow";
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
    a.download = "wispr-recap-${targetDate}.png";
    a.click();
  }

  async function shareOnX() {
    if (shareBlob && navigator.canShare && navigator.canShare({ files: [new File([shareBlob], "recap.png", { type: "image/png" })] })) {
      await navigator.share({ text: shareText, files: [new File([shareBlob], "wispr-recap.png", { type: "image/png" })] });
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

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
