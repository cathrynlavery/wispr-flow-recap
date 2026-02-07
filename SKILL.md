# Wispr Flow — Voice Recap

Use this skill when the user asks about their daily, weekly, or monthly activity, what they worked on, or wants a recap of their Wispr Flow dictation history. Trigger phrases include: "what did I do today", "daily recap", "weekly recap", "monthly recap", "wispr recap", "show me my flow stats", "what apps did I use", "how much did I dictate", "what did I work on this week", "what did I work on this month".

## What it does

Reads the local Wispr Flow SQLite database (`~/Library/Application Support/Wispr Flow/flow.sqlite`) and generates activity recaps.

### Daily Recap
- **Overview stats**: total dictations, words spoken, voice time, peak hour
- **App breakdown**: which apps were used for dictation, ranked by usage with percentages and icons
- **Timeline**: hour-by-hour activity with representative transcript snippets
- **Topic summary**: what was worked on, grouped by app with sample quotes

### Weekly Recap
- **Week overview**: total dictations, words, voice time, app count, busiest day, peak hour
- **Day-by-day chart**: visual bar chart of activity across the week
- **Hourly heatmap**: when you're most active across the week
- **App breakdown**: full week app usage with icons

### Monthly Recap
- **Month overview**: total dictations, words, voice time, app count, busiest day, peak hour
- **Daily average**: dictations and words per active day
- **Week-by-week chart**: visual bar chart of activity across weeks
- **Day-of-week heatmap**: which weekdays are most active
- **Hourly heatmap**: when you're most active across the month
- **App breakdown**: full month app usage with icons

## How to run

### Daily CLI recap (prints markdown)
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/daily-recap.js
```

### Daily HTML report (visual report saved to Desktop)
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/daily-recap.js --html
```

### Daily — specific date
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/daily-recap.js --date=2026-02-05
```

### Weekly CLI recap (current week, Mon–Sun)
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/weekly-recap.js
```

### Weekly HTML report
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/weekly-recap.js --html
```

### Weekly — specific week (pass any date in that week)
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/weekly-recap.js --week-of=2026-01-27
```

### Monthly CLI recap (current month)
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/monthly-recap.js
```

### Monthly HTML report
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/monthly-recap.js --html
```

### Monthly — specific month
```bash
node /Users/cathrynlavery/.agents/skills/wispr-flow/scripts/monthly-recap.js --month=2026-01
```

Combine flags: `--html --date=2026-02-05` or `--html --week-of=2026-01-27` or `--html --month=2026-01`

## After running

- For CLI output: display the markdown output directly to the user
- For HTML output: tell the user where the file was saved and offer to open it with `open <path>`
- After showing raw stats, provide a brief **AI summary**: synthesize the transcript snippets into 2-3 sentences describing what the user worked on, their communication patterns, and any notable themes
- If the user asks for both, run CLI first, then offer to also generate the HTML version
- HTML reports include a **Share** button that lets users share stats to X or copy for LinkedIn

## Design

HTML reports are styled to match the [founder.codes](https://founder.codes) design language:
- Warm beige background (#f5f4ed), Instrument Serif headings, Inter body, JetBrains Mono labels
- Coral accent (#f34e3f) for bars, badges, and links
- App icons from the Mac App Store
- Share button with X and LinkedIn options
- Footer links: [Wispr Flow affiliate](https://lttlmg.ht/wisprflow) · [GitHub](https://github.com/cathrynlavery/wispr-flow-recap) · [founder.codes](https://founder.codes)

## Dependencies

- `better-sqlite3` (already installed in `scripts/node_modules/`)
- Requires Wispr Flow desktop app to be installed with local history enabled
