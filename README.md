# LinkedIn Profile Visitor

A Chrome extension that reads a list of LinkedIn URLs from a text file, visits each profile with human-like scrolling and random wait times, scrapes the **About** section and **current positions**, and exports everything as a CSV.

---

## Features

- Upload any `.txt` file containing LinkedIn URLs — one per line, mixed with other content is fine
- Skips non-profile URLs (company pages, job listings, feed, etc.)
- Visits each profile with randomised wait times and natural scroll behaviour to avoid detection
- Extracts:
  - Full **About** section (clicks "see more" automatically)
  - All **current positions** per profile: company name + URL, title, location, and work description
  - Supports people with multiple simultaneous current roles
- Exports a **CSV** with one row per current position
- Badge on the extension icon shows live progress, errors, and download-ready state
- Pinned tab + on-page banner while running so you know not to close it
- Survives browser restarts mid-run (state and queue are fully persisted)
- 8-minute watchdog catches stalled visits; partial results are always downloadable

---

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder

---

## Usage

1. Click the extension icon
2. Upload a `.txt` file containing LinkedIn profile URLs
3. Optionally adjust the min/max wait time between visits (default 45–180 s)
4. Click **Start Visiting**
5. A background tab opens and begins working — keep Chrome running, screen lock is fine, minimising is fine
6. The badge shows `visited/total` in blue while running
7. When done (or stopped), the badge turns green with a `↓` — click **Download CSV** in the popup

> **Don't close the pinned tab** while a run is active. The blue banner on the page is a reminder.

---

## CSV format

| Column | Description |
|---|---|
| `profile_url` | The LinkedIn `/in/` URL |
| `scraped_at` | ISO 8601 timestamp |
| `about` | Full About section text |
| `company_name` | Current employer name |
| `company_url` | LinkedIn company page URL (if linked) |
| `title` | Job title / role |
| `location` | Work location (if listed) |
| `description` | Role description text |

Profiles with multiple current positions produce multiple rows (one per position), with `profile_url`, `scraped_at`, and `about` repeated on each row.

Profiles where no current positions were found still produce one row with the About text and empty position columns.

---

## Detection avoidance

- Random wait between visits, weighted toward the middle of the configured range (default 45–180 s)
- Smooth, eased scrolling with jitter and occasional back-scrolls to mimic reading
- Random pauses while scrolling (0.8–12 s)
- Visits run in a background tab — no mouse movement or window-focus changes
- Does not use headless Chrome or any bot-specific request headers

---

## Badge states

| Badge | Meaning |
|---|---|
| `7/20` blue | Running — 7 of 20 profiles visited |
| `!` red | A visit stalled or an error occurred |
| `↓` green | Run complete — results ready to download |
| *(empty)* | Idle |

---

## Known limitations

- Relies on LinkedIn's current DOM structure — if LinkedIn changes their HTML significantly, selectors may need updating
- Only extracts **current** positions (those with "Present" end date)
- Does not log in — you must already be signed in to LinkedIn in Chrome
- Intensive Chrome timer throttling (background tabs hidden 5+ min) can slow individual visits; keep the Chrome window visible for best results

---

## File structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — queue management, alarms, badge, CSV generation trigger |
| `content.js` | Injected into LinkedIn pages — scraping + human-like scroll behaviour |
| `popup.html/css/js` | Extension popup UI |
| `icons/` | Extension icons at 16/32/48/128 px |
