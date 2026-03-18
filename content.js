// content.js — injected into every linkedin.com page
// On profile pages: scrapes About + current Experience while doing human-like scrolling.
// On non-profile pages: skips immediately.

// ── Running banner ────────────────────────────────────────────────────────────
// Shown immediately on every page load while a scraping run is active.
// Tells the user not to close the tab and that unusual behavior is intentional.
(async () => {
  const { running } = await chrome.storage.local.get('running');
  if (!running) return;

  document.title = '\u2699 LPV \u2014 keep open';

  const bar = document.createElement('div');
  bar.id = 'lpv-notice';
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'background:#0a66c2', 'color:#fff',
    'padding:7px 16px',
    'font:600 12px/1.4 system-ui,sans-serif',
    'display:flex', 'align-items:center', 'gap:10px',
    'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    'pointer-events:none',           // let clicks pass through to the page
  ].join(';');
  bar.innerHTML =
    '<span style="font-size:15px">\u2699</span>' +
    '<span>LinkedIn Profile Visitor is running \u2014 ' +
    'this tab is being automated. Scrolling and clicks are intentional. ' +
    '<strong>Do not close this tab.</strong></span>';

  const attach = () => { if (!document.getElementById('lpv-notice')) document.body.prepend(bar); };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
})();

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────

  // Only /in/ paths are profile pages
  const PROFILE_RE = /linkedin\.com\/in\/[^/?#\s]+/;

  // ── Utilities ─────────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand  = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max + 1));

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  async function smoothScrollTo(targetY, duration) {
    const startY = window.scrollY;
    const distance = targetY - startY;
    if (Math.abs(distance) < 2) return;
    const startTime = performance.now();

    return new Promise((resolve) => {
      function step(now) {
        const elapsed  = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const jitter   = rand(-1.5, 1.5);
        window.scrollTo(0, startY + distance * easeInOut(progress) + jitter);
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  // Scroll element into view (with some offset so it's not flush to the top)
  async function scrollToElement(el) {
    const rect    = el.getBoundingClientRect();
    const targetY = Math.max(0, window.scrollY + rect.top - randInt(80, 160));
    await smoothScrollTo(targetY, rand(700, 1500));
    await sleep(randInt(400, 1000));
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  // Find a LinkedIn profile section by its h2 heading text.
  // LinkedIn puts sections in <section> or wraps them in a <div> with an id anchor nearby.
  function findSection(keyword) {
    const kw = keyword.toLowerCase();

    // Strategy 1: direct id match (LinkedIn sometimes puts id on the div, not the section)
    const byId = document.getElementById(kw) ||
                 document.querySelector(`[id="${kw}-section"]`);
    if (byId) return byId.closest('section') || byId;

    // Strategy 2: walk h2 elements looking for matching text
    for (const h2 of document.querySelectorAll('h2')) {
      if (h2.textContent.trim().toLowerCase().includes(kw)) {
        return h2.closest('section') ||
               h2.parentElement?.parentElement?.parentElement?.parentElement ||
               h2.parentElement;
      }
    }
    return null;
  }

  // Click all "see more" / "show more" buttons inside a container.
  async function expandAll(container) {
    const btns = container.querySelectorAll('button, a[role="button"]');
    for (const btn of btns) {
      const label = (btn.textContent + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
      if (label.includes('see more') || label.includes('show more')) {
        btn.click();
        await sleep(randInt(500, 1200));
      }
    }
  }

  // LinkedIn uses span[aria-hidden="true"] for visual text throughout the profile.
  // Visually-hidden spans (screen reader text) are skipped.
  function getAriaTexts(el) {
    const spans = el.querySelectorAll('span[aria-hidden="true"]');
    if (spans.length > 0) {
      return Array.from(spans)
        .map((s) => s.textContent.trim())
        .filter((t) => t.length > 0 && t !== '·' && t !== '•');
    }
    // Fallback to innerText line split
    return (el.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
  }

  function cleanText(t) {
    return t.replace(/\s+/g, ' ').trim();
  }

  // ── Text-line classifier (for experience items) ───────────────────────────────

  const MONTH_DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/i;
  const PRESENT_RE    = /\bPresent\b/;
  const DURATION_RE   = /\b\d+\s*(yr|mos?|year|month)/i;

  function classifyLine(text) {
    if (PRESENT_RE.test(text) || (MONTH_DATE_RE.test(text) && /[-–]/.test(text))) return 'date';
    if (DURATION_RE.test(text) && text.length < 35) return 'duration';
    // "Company Name · Employment type" — contains · but no date pattern
    if (text.includes('·') && !MONTH_DATE_RE.test(text)) return 'company_meta';
    // Short geographic text: "City, State" or work-mode keywords
    if (/^(Remote|On-site|Hybrid)$/.test(text)) return 'location';
    if (text.split(',').length === 2 && text.length < 55 && !/\d{4}/.test(text)) return 'location';
    return 'text';
  }

  // Extract title, location, description from a single-role experience list item.
  // company_meta and date/duration lines are skipped (handled by caller or irrelevant).
  function extractRoleFields(item) {
    const lines     = getAriaTexts(item);
    let title       = '';
    let location    = '';
    const descLines = [];
    let titleSet    = false;

    for (const line of lines) {
      const type = classifyLine(line);
      if (type === 'date' || type === 'duration' || type === 'company_meta') continue;
      if (type === 'location') { if (!location) location = line; continue; }
      if (!titleSet) { title = line; titleSet = true; continue; }
      if (line.length > 20) descLines.push(line);
    }

    return { title, location, description: descLines.join('\n').trim() };
  }

  // ── About scraping ────────────────────────────────────────────────────────────

  async function scrapeAbout() {
    const section = findSection('about');
    if (!section) return '';

    await scrollToElement(section);
    await sleep(randInt(1000, 2500));

    await expandAll(section);
    await sleep(randInt(300, 900));

    // Collect all aria-hidden texts, pick the longest (most likely the about body)
    const texts = getAriaTexts(section).filter((t) => t.length > 15);
    if (texts.length === 0) return '';

    // If there's a single dominant text, use it; otherwise join all
    const longest = texts.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (longest.length > 100) return cleanText(longest);
    return cleanText(texts.join(' '));
  }

  // ── Experience scraping ───────────────────────────────────────────────────────

  async function scrapeCurrentPositions() {
    const section = findSection('experience');
    if (!section) return [];

    await scrollToElement(section);
    await sleep(randInt(1000, 2500));

    // Click "Show all X experiences" link if present (LinkedIn hides older ones)
    for (const el of section.querySelectorAll('a, button')) {
      const txt = el.textContent.trim().toLowerCase();
      if ((txt.includes('show all') || txt.includes('see all')) && txt.includes('experience')) {
        el.click();
        await sleep(randInt(1500, 3000));
        break;
      }
    }

    const ul = section.querySelector('ul');
    if (!ul) return [];

    const topItems  = Array.from(ul.querySelectorAll(':scope > li'));
    const positions = [];

    for (const item of topItems) {
      // Only process items that contain a current (Present) role
      if (!PRESENT_RE.test(item.textContent)) continue;

      await scrollToElement(item);
      await sleep(randInt(600, 1800));

      const nestedUl = item.querySelector('ul');

      if (nestedUl) {
        // ── Grouped entry: multiple roles at the same company ──
        const companyAnchor = item.querySelector('a[href*="/company/"]');
        const company    = companyAnchor
          ? cleanText(companyAnchor.querySelector('span[aria-hidden="true"]')?.textContent || companyAnchor.textContent)
          : '';
        const companyUrl = companyAnchor ? companyAnchor.href.split('?')[0] : '';

        for (const sub of nestedUl.querySelectorAll(':scope > li')) {
          if (!PRESENT_RE.test(sub.textContent)) continue;

          // Scroll to and expand each sub-item description
          await scrollToElement(sub);
          await sleep(randInt(500, 1400));
          await expandAll(sub);

          const role = extractRoleFields(sub);
          positions.push({ company, companyUrl, ...role });
        }
      } else {
        // ── Single role at company ──
        await expandAll(item);

        const companyAnchor = item.querySelector('a[href*="/company/"]');
        let company    = '';
        let companyUrl = '';

        if (companyAnchor) {
          company    = cleanText(companyAnchor.querySelector('span[aria-hidden="true"]')?.textContent || companyAnchor.textContent);
          companyUrl = companyAnchor.href.split('?')[0];
        } else {
          // Fall back to company_meta line: "Company Name · Full-time"
          for (const line of getAriaTexts(item)) {
            if (classifyLine(line) === 'company_meta') {
              company = line.split('·')[0].trim();
              break;
            }
          }
        }

        const role = extractRoleFields(item);
        positions.push({ company, companyUrl, ...role });
      }
    }

    return positions;
  }

  // ── Filler human scrolling ────────────────────────────────────────────────────

  // Scroll from current position to targetPct of page height in a human-like way.
  async function humanScrollTo(targetPct) {
    const pageH  = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const target = pageH * targetPct;
    let pos      = window.scrollY;

    while (pos < target) {
      const next = Math.min(pos + rand(120, 380), target);
      await smoothScrollTo(next, rand(700, 2200));
      pos = next;

      if (Math.random() < 0.55) await sleep(randInt(600, 4500));

      // Occasional scroll-back
      if (Math.random() < 0.10) {
        const back = Math.max(0, pos - rand(60, 200));
        await smoothScrollTo(back, rand(400, 1000));
        pos = back;
        await sleep(randInt(500, 2000));
        const fwd = Math.min(pos + rand(100, 280), target);
        await smoothScrollTo(fwd, rand(500, 1400));
        pos = fwd;
      }

      if (Math.random() < 0.07) await sleep(randInt(3000, 10000));
    }
  }

  // ── Main ──────────────────────────────────────────────────────────────────────

  let running = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'start_behavior' || running) return;
    running = true;
    sendResponse({ ok: true });

    (async () => {
      try {
        // Non-profile page — skip immediately
        if (!PROFILE_RE.test(location.href)) {
          chrome.runtime.sendMessage({ type: 'behavior_complete', skipped: true });
          return;
        }

        // Page settle
        await sleep(randInt(2000, 5000));

        // ── 1. About ──
        const about = await scrapeAbout();
        await sleep(randInt(800, 2000));

        // Light natural scroll between sections
        const midTarget = Math.min(window.scrollY + rand(200, 500), 0.30);
        await humanScrollTo(0.20);
        await sleep(randInt(700, 2000));

        // ── 2. Experience ──
        const currentPositions = await scrapeCurrentPositions();
        await sleep(randInt(800, 2000));

        // ── 3. Continue reading the rest of the page ──
        await humanScrollTo(rand(0.70, 0.95));
        await sleep(randInt(1000, 3500));

        const data = {
          url: location.href,
          scrapedAt: new Date().toISOString(),
          about,
          currentPositions,
        };

        chrome.runtime.sendMessage({ type: 'behavior_complete', data });
      } catch (err) {
        console.error('[LPV] Scraping error:', err);
        chrome.runtime.sendMessage({ type: 'behavior_complete', skipped: true });
      } finally {
        running = false;
      }
    })();

    return true;
  });
})();
