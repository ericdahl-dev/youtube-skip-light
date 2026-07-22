// YouTube Skip Light — content script
//
// - Watches for the ad Skip button
// - Reports availability to the service worker (badge + ESP32 lights)
// - Skips when told to, by the popup or by any ESP32 button
//
// No HTTP requests are made from here. YouTube is served over HTTPS and Chrome
// blocks plain-HTTP fetches from a content script on an HTTPS page as mixed
// content ("requested an insecure resource 'http://skipbutton.local/poll'").
// All ESP32 traffic goes through background.js, which is exempt.

console.log("[skip-light] content script v1.7 loaded — no page-context HTTP");

const TICK_MS = 300;
const ESP32_RETRY_MS = 15000; // how often to re-check the ESP32s while idle

let skipAvailable = false;
let lastReported = null; // last state sent to the service worker
let esp32Online = false;
let lastEsp32Attempt = 0;

// Which detection tier last matched: 1 = known class, 2 = class/id contains
// "skip", 3 = button text/aria says skip, null = nothing found. Anything above
// 1 means YouTube has renamed things and the known selectors need updating.
let matchTier = null;
let warnedTier = 0;

// Tier 1: exact class names, current and recent. Cheap and unambiguous.
const KNOWN_SELECTORS =
  ".ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern";

// Tier 3: the word "skip" in the languages this is most likely to run in.
// Matched against button text and aria-label.
const SKIP_WORDS = [
  "skip", "ignorer", "überspringen", "uberspringen", "saltar", "salta",
  "pular", "overslaan", "hoppa över", "пропустить", "スキップ", "跳过",
  "略過", "건너뛰기", "تخطي",
];

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Tiers 2 and 3 guess, so require something button-shaped. Stops a stray match
// on a 1px spacer or a full-bleed overlay from becoming a real mouse click.
function isButtonSized(el) {
  const r = el.getBoundingClientRect();
  return r.width >= 40 && r.width <= 400 && r.height >= 16 && r.height <= 120;
}

// The ad overlay is the ONLY place we're willing to click. Restricting the
// search here is what makes the fuzzy tiers safe — "skip" appears in plenty of
// other YouTube UI ("Skip navigation"), and a trusted click on the wrong
// element is a real click on whatever sits under it.
function adContainer() {
  const player = document.querySelector(".html5-video-player");
  if (!player) return null;
  return player.classList.contains("ad-showing") ? player : null;
}

function findSkipButton() {
  const root = adContainer();

  if (!root) {
    // A player that exists but isn't showing an ad: nothing to find.
    if (document.querySelector(".html5-video-player")) {
      matchTier = null;
      return null;
    }
    // No player element at all means YouTube restructured the page. Fall back
    // to a document-wide search, but tier 1 only — the exact class names are
    // specific enough to be safe without the ad-overlay guard.
    const el = document.querySelector(KNOWN_SELECTORS);
    if (isVisible(el)) {
      matchTier = 1;
      return el;
    }
    matchTier = null;
    return null;
  }

  // Tier 1 — known class names.
  const known = root.querySelector(KNOWN_SELECTORS);
  if (isVisible(known)) {
    matchTier = 1;
    return known;
  }

  const candidates = root.querySelectorAll('button, [role="button"]');

  // Tier 2 — class or id mentions "skip". Survives renames that keep the word,
  // which every rename so far has (ytp-ad-skip-button -> ytp-skip-ad-button,
  // and the current button also carries id="skip-button:NN").
  for (const c of candidates) {
    const cls = c.getAttribute("class") || ""; // not .className: SVG gives an object
    const hay = `${cls} ${c.id || ""}`.toLowerCase();
    if (hay.includes("skip") && isVisible(c) && isButtonSized(c)) {
      matchTier = 2;
      return c;
    }
  }

  // Tier 3 — the button says "skip" in some language.
  for (const c of candidates) {
    const txt = `${c.textContent || ""} ${c.getAttribute("aria-label") || ""}`.toLowerCase();
    if (SKIP_WORDS.some((w) => txt.includes(w)) && isVisible(c) && isButtonSized(c)) {
      matchTier = 3;
      return c;
    }
  }

  matchTier = null;
  return null;
}

// YouTube gates the Skip button on event.isTrusted, so nothing dispatched from
// JavaScript works — not btn.click(), not a full synthetic pointer sequence.
// Seeking the ad's video past its end doesn't work either: ads stream over MSE
// with only a few seconds buffered, so a long seek lands outside the buffered
// range and collapses the media element (duration NaN, readyState 0).
//
// So we hand the button's viewport coordinates to the service worker, which
// drives a real OS-level click through the debugger API / CDP.
function clickSkip() {
  const btn = findSkipButton();
  if (!isVisible(btn)) return false;

  // Belt and braces: findSkipButton already refuses to look outside an ad, but
  // this is the call that produces a real mouse click, so check again here.
  const player = document.querySelector(".html5-video-player");
  if (!player || !player.classList.contains("ad-showing")) return false;

  const r = btn.getBoundingClientRect();
  // CDP wants CSS pixels relative to the viewport — exactly what a client rect is.
  send({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2 });

  // Deliberately NOT clearing state here: the click is asynchronous and may
  // fail. Let the tick clear it when the button actually disappears, so the
  // lights always reflect reality rather than intent.
  return true;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function updateState(available) {
  skipAvailable = available;

  // Surface selector rot the first time each tier is needed.
  if (available && matchTier > 1 && matchTier > warnedTier) {
    warnedTier = matchTier;
    console.warn(
      `[skip-light] Skip button found via fallback tier ${matchTier}. ` +
        `YouTube likely renamed its classes — update KNOWN_SELECTORS in content.js.`
    );
  }

  if (available === lastReported) return;
  lastReported = available;

  // Service worker owns both the badge and the ESP32 lights.
  send({ type: "skipState", available });
}

function pollEsp32() {
  lastEsp32Attempt = Date.now();
  send({ type: "esp32Poll" }).then((res) => {
    if (!res) return;
    esp32Online = res.online;
    if (res.pressed) clickSkip();
  });
}

// Popup asks for state / requests a skip
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getState") {
    sendResponse({ available: skipAvailable, esp32Online, matchTier });
  } else if (msg.type === "clickSkip") {
    sendResponse({ clicked: clickSkip() });
  }
  return false;
});

const observer = new MutationObserver(() => {
  updateState(isVisible(findSkipButton()));
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true });

setInterval(() => {
  updateState(isVisible(findSkipButton()));

  // Only poll for a physical press while THIS tab has a skip available. /poll is
  // read-once on each ESP32, so a tab polling with no ad on screen could consume
  // a press meant for the tab that has one.
  if (skipAvailable) {
    pollEsp32();
  } else if (Date.now() - lastEsp32Attempt > ESP32_RETRY_MS) {
    pollEsp32(); // keeps the popup's connection status fresh
  }
}, TICK_MS);
