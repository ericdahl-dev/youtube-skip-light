// YouTube Skip Light — content script
//
// - Watches for the ad Skip button
// - Reports a MODE to the service worker (badge + ESP32 lights)
// - Acts on a press when the service worker routes one here
//
// The button is context-dependent. What a press does depends on what is on
// screen at the moment it arrives:
//
//   skip  ad on screen with a live Skip button  -> trusted click on Skip
//   back  a watch page with no ad               -> history.back()
//         a Short (ad or not)                   -> youtube.com home
//   idle  anything else                         -> press dropped
//
// The board holds the mode only to pick a color; this side decides what a
// press MEANS, because this side is the only one that can see the page.
//
// No HTTP requests are made from here. YouTube is served over HTTPS and Chrome
// blocks plain-HTTP fetches from a content script on an HTTPS page as mixed
// content ("requested an insecure resource 'http://skipbutton.local/poll'").
// All ESP32 traffic goes through background.js, which is exempt.

console.log("[skip-light] content script v2.2 loaded — no page-context HTTP");

const TICK_MS = 300;
const ESP32_RETRY_MS = 15000; // how often to re-check the ESP32s while idle

let skipAvailable = false;
let mode = "idle";
let lastReported = null; // last mode sent to the service worker
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
  // Tier 1 — exact known class names, searched document-wide. Detection must be
  // permissive: a missed ad simply fails to light, which defeats the feature.
  // These class names are specific enough to be safe without an ad-container
  // guard — they matched reliably throughout testing, and clickSkip() re-checks
  // ad-showing before it ever issues a real click, so a stray tier-1 match can
  // light the badge but can never produce an errant click.
  const known = document.querySelector(KNOWN_SELECTORS);
  if (isVisible(known)) {
    matchTier = 1;
    return known;
  }

  // Tiers 2-3 GUESS, so they are confined to the ad overlay — a fuzzy match on
  // the wrong element would become a real mouse click on whatever sits under it.
  const root = adContainer();
  if (!root) {
    matchTier = null;
    return null;
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
// A press is consumed destructively: the ESP32 clears pressPending as soon as
// /poll hands it over, so if the click that follows fails there is nothing left
// to retry from and the tap is simply lost. That is the "I tapped and nothing
// happened, so I tapped again" failure. Retry here, where we still know a press
// was asked for.
//
// Success is judged by outcome, not by the click reporting ok — a dispatch can
// succeed and still miss. Attaching the debugger raises Chrome's "started
// debugging this browser" infobar, which shrinks the viewport and reflows the
// player, so coordinates captured before the attach can point at empty space by
// the time the click lands. Hence: re-measure the button every attempt, and
// treat "the button is gone" as the only proof it worked.
const CLICK_ATTEMPTS = 3;
const CLICK_SETTLE_MS = 350;

let clickInFlight = false;

async function clickSkip() {
  if (clickInFlight) return false; // one press at a time; don't double-skip
  clickInFlight = true;

  try {
    for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt++) {
      const btn = findSkipButton();

      // Gone: either an earlier attempt landed, or the ad ended on its own.
      if (!isVisible(btn)) return attempt > 1;

      // Belt and braces: findSkipButton already refuses to look outside an ad,
      // but this is the call that produces a real mouse click, so check again.
      const player = document.querySelector(".html5-video-player");
      if (!player || !player.classList.contains("ad-showing")) return attempt > 1;

      // Measured fresh each pass. CDP wants CSS pixels relative to the
      // viewport — exactly what a client rect is.
      const r = btn.getBoundingClientRect();
      const res = await send({
        type: "trustedClick",
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      });
      if (!res) return false; // service worker gone; nothing to retry into

      if (!res.ok) {
        console.warn(`[skip-light] click attempt ${attempt} failed to dispatch`);
      }

      await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS));
    }

    // Deliberately NOT clearing skip state here: the tick clears it when the
    // button actually disappears, so the lights reflect reality, not intent.
    const landed = !isVisible(findSkipButton());
    if (!landed) {
      console.warn(`[skip-light] Skip still present after ${CLICK_ATTEMPTS} attempts`);
    }
    return landed;
  } finally {
    clickInFlight = false;
  }
}

// Reloading the extension (chrome://extensions, or an update) orphans every
// content script already running in an open tab: the code keeps ticking, but
// its chrome.runtime is dead and every sendMessage throws. Chrome does NOT
// re-inject into those tabs — only a navigation or tab reload does.
//
// Swallowing that error silently makes it look exactly like "the ad wasn't
// detected": no green light, no skip, nothing in the console. So say it once,
// loudly, and stop pretending we're connected.
let contextAlive = true;

function contextInvalidated(err) {
  const m = err?.message ?? String(err ?? "");
  return (
    m.includes("Extension context invalidated") ||
    m.includes("context invalidated") ||
    m.includes("Receiving end does not exist") ||
    m.includes("message port closed")
  );
}

function send(msg) {
  if (!contextAlive) return Promise.resolve(null);

  // Reading chrome.runtime.id throws once the context is gone.
  try {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
  } catch (err) {
    markOrphaned();
    return Promise.resolve(null);
  }

  return chrome.runtime.sendMessage(msg).catch((err) => {
    if (contextInvalidated(err)) markOrphaned();
    return null;
  });
}

function markOrphaned() {
  if (!contextAlive) return;
  contextAlive = false;
  esp32Online = false;
  console.warn(
    "[skip-light] This tab is running an ORPHANED content script — the " +
      "extension was reloaded underneath it. The lights and the physical " +
      "button will not work here. RELOAD THIS TAB to reconnect."
  );
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

  const next = currentMode();
  if (next === lastReported) return;
  lastReported = next;
  mode = next;

  // Service worker owns the badge, the ESP32 lights, and press routing.
  send({ type: "modeState", mode });
}

// The tick fires every TICK_MS and does NOT await this, so without a guard a
// poll that runs long simply stacks. When two of three boards were unreachable
// every poll burned the full timeout and ~7 piled up at once, which is enough
// concurrent connections to stall the board's WebServer for ~1 s — and a board
// stuck in server.handleClient() never samples its touch panel, so taps vanish.
// One in flight at a time makes a slow board cost a skipped tick, nothing more.
let pollInFlight = false;

// What a press should do right now.
//
// The ad checks come first and are deliberately conservative. An ad that is on
// screen but not yet skippable (the countdown, or an unskippable one) reports
// idle rather than back: a press there is almost certainly a mistimed skip, and
// answering it by navigating away mid-ad would be a genuinely nasty surprise.
//
// Paused counts as back. The distinction that matters is ad vs no-ad, not
// playing vs paused — a paused video is still a video you are sitting on.
function currentMode() {
  // A visible Skip button wins outright, and is checked FIRST.
  //
  // Do not be tempted to gate this on the player's ad-showing class. Detection
  // is deliberately permissive: tier 1 searches the whole document WITHOUT the
  // ad-showing guard, precisely because YouTube does not always set that class
  // when a Skip button is up. Checking ad-showing first therefore reports
  // "back" while a live Skip button sits on screen — and that is not merely the
  // wrong color on the board. A press in that state calls history.back() and
  // navigates away from the video instead of skipping the ad.
  if (skipAvailable) return "skip";

  // Shorts: back means "out of Shorts, to the home page", not the previous
  // Short. The button is an exit for a kid who scrolled in, so it must not
  // become a faster way to keep swiping. Checked before the ad guard on
  // purpose: a sponsored Short is still a Short, and the exit should work
  // there too.
  if (onShorts()) return "back";

  const player = document.querySelector(".html5-video-player");

  // An ad is up but has no Skip button yet: the countdown, or an unskippable
  // one. Deliberately idle rather than back — a press here is almost certainly
  // a mistimed skip, and answering it by navigating away mid-ad is a nasty
  // surprise.
  if (player && player.classList.contains("ad-showing")) return "idle";

  // Only a watch page. On the home page or a search results list there is no
  // "previous video" that a press would sensibly return to.
  if (!location.pathname.startsWith("/watch")) return "idle";
  if (!document.querySelector("video")) return "idle";

  // Nothing to go back TO: this tab was opened directly on the video, so
  // history.back() would do nothing and the light would be lying.
  if (history.length <= 1) return "idle";

  return "back";
}

function onShorts() {
  return location.pathname.startsWith("/shorts/") && !!document.querySelector("video");
}

// Navigating back is the whole point of back mode, and history.back() drives
// YouTube's own SPA router, so it lands on the previous video rather than doing
// a full page load.
//
// Shorts go home instead. history.back() there would usually land on the
// previous Short, which is the opposite of what the button is for.
function goBack() {
  if (onShorts()) {
    location.assign("https://www.youtube.com/");
    return true;
  }
  if (history.length <= 1) return false;
  history.back();
  return true;
}

function pollEsp32() {
  if (pollInFlight) return;
  pollInFlight = true;
  lastEsp32Attempt = Date.now();

  // Deliberately NOT acting on res.pressed here. Every YouTube tab polls, and
  // /poll is read-once, so whichever tab happened to ask first would consume a
  // press meant for another one. The service worker sees all tabs, so it picks
  // the right one and sends it a doPress. This tab just reports connectivity.
  // The mode rides along so a restarted service worker relearns it (see the
  // esp32Poll handler in background.js).
  send({ type: "esp32Poll", mode })
    .then((res) => {
      if (!res) return;
      esp32Online = res.online;
    })
    .finally(() => {
      pollInFlight = false;
    });
}

// Popup asks for state / requests a skip
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getState") {
    sendResponse({ available: skipAvailable, mode, esp32Online, matchTier });
    return false;
  }
  if (msg.type === "clickSkip") {
    clickSkip().then((clicked) => sendResponse({ clicked }));
    return true; // clickSkip retries, so the answer is async
  }
  // A physical press, routed here by the service worker. Re-read the mode
  // rather than trusting the one attached to the message: it was measured a
  // poll ago, and an ad can start or end in that window.
  if (msg.type === "doPress") {
    // Re-measure before deciding. currentMode() reads the cached skipAvailable,
    // which is up to one tick (300 ms) old — long enough for a Skip button to
    // have appeared, and acting on a stale read is exactly how a skip turns
    // into an accidental navigation.
    updateState(isVisible(findSkipButton()));
    const now = currentMode();
    if (now === "skip") {
      clickSkip().then((clicked) => sendResponse({ acted: clicked, mode: now }));
      return true;
    }
    if (now === "back") {
      sendResponse({ acted: goBack(), mode: now });
      return false;
    }
    sendResponse({ acted: false, mode: now });
    return false;
  }
  return false;
});

const observer = new MutationObserver(() => {
  updateState(isVisible(findSkipButton()));
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true });

setInterval(() => {
  updateState(isVisible(findSkipButton()));

  // Poll whenever this tab is armed for anything. Back mode means that is most
  // of the time you are watching, which is a real change in traffic: it used to
  // be a burst during ads only. Consuming another tab's press is no longer a
  // risk here, because this tab no longer acts on what it collects — see
  // pollEsp32.
  if (mode !== "idle") {
    pollEsp32();
  } else if (Date.now() - lastEsp32Attempt > ESP32_RETRY_MS) {
    pollEsp32(); // keeps the popup's connection status fresh
  }
}, TICK_MS);
