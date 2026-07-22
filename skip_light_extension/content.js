// YouTube Skip Light — content script
//
// - Watches for the ad Skip button
// - Reports availability to the service worker (badge + ESP32 LED)
// - Clicks Skip when told to, by either the popup button or the ESP32 button
//
// No HTTP requests are made from here. YouTube is served over HTTPS and Chrome
// blocks plain-HTTP fetches from a content script on an HTTPS page as mixed
// content ("requested an insecure resource 'http://skipbutton.local/poll'").
// All ESP32 traffic goes through background.js, which is exempt.

console.log("[skip-light] content script v1.6 loaded — no page-context HTTP");

const TICK_MS = 300;
const ESP32_RETRY_MS = 15000; // how often to re-check the ESP32 while idle

let skipAvailable = false;
let lastReported = null; // last state sent to the service worker
let esp32Online = false;
let lastEsp32Attempt = 0;

function findSkipButton() {
  // YouTube renames these classes occasionally; this covers current + recent names.
  return document.querySelector(
    ".ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern"
  );
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// YouTube gates the Skip button on event.isTrusted, so nothing dispatched from
// JavaScript works — not btn.click(), not a full synthetic pointer sequence.
// Seeking the ad's video past its end doesn't work either: ads stream over MSE
// with only a few seconds buffered, so a long seek lands outside the buffered
// range and collapses the media element (duration NaN, readyState 0).
//
// So we hand the button's viewport coordinates to the service worker, which
// drives a real OS-level click through the debugger API / CDP.
//
// The ad-showing guard is load-bearing: the player reuses ONE <video> and one
// set of controls for ads and your actual video.
function clickSkip() {
  const btn = findSkipButton();
  if (!isVisible(btn)) return false;

  const player = document.querySelector(".html5-video-player");
  if (!player || !player.classList.contains("ad-showing")) return false;

  const r = btn.getBoundingClientRect();
  // CDP wants CSS pixels relative to the viewport — exactly what a client rect is.
  send({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2 });

  // Deliberately NOT calling updateState(false) here: the click is asynchronous
  // and may fail. Let the 300ms tick clear the badge when the button actually
  // disappears, so the light always reflects reality rather than intent.
  return true;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function updateState(available) {
  skipAvailable = available;
  if (available === lastReported) return;
  lastReported = available;

  // Service worker owns both the badge and the ESP32 LED.
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
    sendResponse({ available: skipAvailable, esp32Online });
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
  // read-once on the ESP32, so a tab polling with no ad on screen could consume
  // a press meant for the tab that does have one.
  if (skipAvailable) {
    pollEsp32();
  } else if (Date.now() - lastEsp32Attempt > ESP32_RETRY_MS) {
    pollEsp32(); // keeps the popup's connection status fresh
  }
}, TICK_MS);
