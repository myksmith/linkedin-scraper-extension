// content.js — injected into every linkedin.com page
// Simulates human reading/scrolling behavior when triggered by the background worker.

(function () {
  'use strict';

  // ── Utilities ───────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }

  // Easing: ease-in-out cubic
  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // ── Smooth scroll ───────────────────────────────────────────────────────────

  // Scrolls from `fromY` to `toY` over `duration` ms with easing and micro-jitter.
  async function smoothScroll(fromY, toY, duration) {
    const start = performance.now();
    const distance = toY - fromY;

    return new Promise((resolve) => {
      function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeInOut(progress);

        // Micro-jitter: ±1–2 px to simulate trackpad/mouse imprecision
        const jitter = rand(-1.5, 1.5);
        window.scrollTo(0, fromY + distance * eased + jitter);

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  // ── Human browsing simulation ────────────────────────────────────────────────

  async function simulateHumanBrowsing() {
    const viewportH = window.innerHeight;

    // Wait for page to visually settle before touching scroll
    await sleep(randInt(1800, 5000));

    const pageH = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    // How far down we'll scroll (50 – 95 % of page)
    const scrollTarget = pageH * rand(0.50, 0.95);

    let pos = window.scrollY;

    // ── Main scroll loop ──
    while (pos < scrollTarget) {
      // Chunk size: simulates reading a section before scrolling on
      const chunkPx = rand(120, 380);
      const nextPos  = Math.min(pos + chunkPx, scrollTarget);

      // Scroll speed varies: slower = more careful reading
      const duration = rand(700, 2200);
      await smoothScroll(pos, nextPos, duration);
      pos = nextPos;

      // Reading pause (happens ~60 % of the time)
      if (Math.random() < 0.60) {
        await sleep(randInt(800, 5500));
      }

      // Occasional scroll-back (glancing at something again, ~12 %)
      if (Math.random() < 0.12) {
        const backPx  = rand(60, 220);
        const backPos = Math.max(0, pos - backPx);
        await smoothScroll(pos, backPos, rand(400, 1000));
        pos = backPos;
        await sleep(randInt(600, 2500));
        // Then continue forward
        const fwdPos = Math.min(backPos + rand(100, 300), scrollTarget);
        await smoothScroll(pos, fwdPos, rand(600, 1500));
        pos = fwdPos;
      }

      // Occasionally pause longer (simulating a distraction / re-read, ~8 %)
      if (Math.random() < 0.08) {
        await sleep(randInt(4000, 12000));
      }
    }

    // Linger at the bottom before handing off
    await sleep(randInt(1000, 4000));

    // Subtle scroll up to end — some users scroll back to top
    if (Math.random() < 0.20) {
      await smoothScroll(pos, 0, rand(800, 1800));
      await sleep(randInt(500, 2000));
    }
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  let behaviorRunning = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start_behavior' && !behaviorRunning) {
      behaviorRunning = true;
      sendResponse({ ok: true });

      simulateHumanBrowsing()
        .catch((err) => console.warn('[LPV content] scroll error:', err))
        .finally(() => {
          behaviorRunning = false;
          chrome.runtime.sendMessage({ type: 'behavior_complete' }).catch(() => {});
        });
    }
    return true;
  });
})();
