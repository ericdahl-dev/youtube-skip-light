// Virtual LED (extension badge), all ESP32 HTTP, and the trusted click.
//
// The ESP32 fetches live here, not in content.js, because YouTube is served
// over HTTPS and Chrome blocks plain-HTTP requests from a content script on an
// HTTPS page as mixed content. A service worker is not an HTTPS document, so
// it can talk to http://skipbutton.local freely (host_permissions covers CORS).

// Every board is lit, and a press from ANY of them skips.
//
// IPs, not .local names. mDNS resolution from macOS proved unreliable in
// practice: measured 0/6 lookups of skipbutton.local completing (getaddrinfo
// hung past 5 s) while that same board answered its IP in 12-35 ms, 6/6.
//
// UNREACHABLE ENTRIES ARE NOT FREE. Both fan-outs below are Promise.all, so
// they wait for the slowest URL — a name that won't resolve costs the full
// ESP32_TIMEOUT_MS on every single poll. Two dead entries plus a 300 ms tick
// stacked polls ~7 deep, and 7 concurrent connections measurably stall the
// board's single-threaded WebServer for ~1 s. During that stall loop() sits in
// server.handleClient() and never samples the touch panel, so taps on the glass
// are silently dropped and you have to tap again.
//
// So: list only boards that actually exist, and give each a DHCP reservation
// so its address stays put. Add entries here AND to host_permissions in
// manifest.json. Each board still needs its own -DDEVICE_INDEX=N for mDNS/OTA.
const ESP32_URLS = [
  "http://192.168.0.81", // Waveshare Touch LCD 1.47
];

// The board answers in tens of milliseconds on a LAN; a second is ~30x headroom.
// Kept short deliberately, so a board that drops off stalls one tick, not seven.
const ESP32_TIMEOUT_MS = 1000;

let onlineCount = 0;
let lastMode = "idle";

// tabId -> "skip" | "back", for every YouTube tab currently armed. Idle tabs are
// deleted rather than stored, so the map doubles as the set of live candidates.
//
// This map is the whole reason press routing lives here. /poll is read-once on
// the board, so exactly one tab may act on a press — but every armed tab polls,
// and the one that happens to collect it is not necessarily the one you were
// looking at. Only the worker can see all the tabs, so only the worker can
// choose correctly.
const tabModes = new Map();

// A tab that navigates away or closes must not stay a candidate; otherwise a
// press could be routed into a dead tab and silently lost.
chrome.tabs.onRemoved.addListener((tabId) => tabModes.delete(tabId));

// Aggregate of every tab, which is what the board shows. Skip wins over back:
// an ad is time-limited and the reason you reach for the button, whereas back
// is available for as long as the video is.
function aggregateMode() {
  let sawBack = false;
  for (const m of tabModes.values()) {
    if (m === "skip") return "skip";
    if (m === "back") sawBack = true;
  }
  return sawBack ? "back" : "idle";
}

// Which tab a press belongs to.
//
// A skip is unambiguous — an ad is on screen and it is the only thing you could
// mean, so it wins wherever it is. Back is ambiguous whenever two videos are
// open, and the only sane reading of "go back" is the tab you are actually
// looking at. If the focused tab is not armed, a press is dropped rather than
// guessed at: navigating a background tab you cannot see is worse than nothing.
async function pickPressTarget() {
  for (const [tabId, m] of tabModes) {
    if (m === "skip") return { tabId, mode: "skip" };
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && tabModes.get(active.id) === "back") {
      return { tabId: active.id, mode: "back" };
    }
  } catch {
    /* no focused window (all minimized, or Chrome in the background) */
  }
  return null;
}

async function routePress() {
  const target = await pickPressTarget();
  if (!target) {
    console.log("[skip-light] press with no eligible tab — dropped");
    return;
  }
  try {
    await chrome.tabs.sendMessage(target.tabId, { type: "doPress", mode: target.mode });
  } catch (err) {
    // Orphaned content script, or the tab went away between the poll and now.
    console.warn("[skip-light] press routing failed —", err?.message);
  }
}

async function esp32(base, path) {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(ESP32_TIMEOUT_MS),
  });
  return (await res.text()).trim();
}

// Fan out to every board in parallel. One slow or absent board must not delay
// the others, so these are independent rather than sequential.
async function setEsp32Mode(mode) {
  const results = await Promise.all(
    ESP32_URLS.map(async (base) => {
      try {
        await esp32(base, `/mode?m=${encodeURIComponent(mode)}`);
        return true;
      } catch {
        return false;
      }
    })
  );
  onlineCount = results.filter(Boolean).length;
}

async function pollEsp32() {
  const results = await Promise.all(
    ESP32_URLS.map(async (base) => {
      try {
        const text = await esp32(base, "/poll");
        return { online: true, pressed: text === "1" };
      } catch {
        return { online: false, pressed: false };
      }
    })
  );

  const wasAllOffline = onlineCount === 0;
  onlineCount = results.filter((r) => r.online).length;

  // A board that just appeared (or rebooted) has a stale light; resync it.
  if (wasAllOffline && onlineCount > 0) setEsp32Mode(lastMode);

  const pressed = results.some((r) => r.pressed);
  if (pressed) routePress();

  return {
    online: onlineCount > 0,
    pressed,
    count: onlineCount,
  };
}

function setBadge(tabId, mode) {
  if (tabId == null) return;
  if (mode === "skip") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
    chrome.action.setBadgeText({ tabId, text: "SKIP" });
  } else if (mode === "back") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#64748b" });
    chrome.action.setBadgeText({ tabId, text: "BACK" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
}

// A real, OS-level mouse click at (x, y) in the tab's viewport.
//
// YouTube's Skip button checks event.isTrusted, which no dispatched JavaScript
// event can satisfy. Input.dispatchMouseEvent over CDP produces input that
// enters the browser the same way your mouse does, so it passes.
//
// We attach and detach around each click rather than holding the debugger open,
// so Chrome's "is debugging this browser" banner appears only for a moment.
async function trustedClick(tabId, x, y) {
  const target = { tabId };

  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    // Most common cause: DevTools is open on this tab. Only one debugger client
    // may attach at a time, and DevTools wins.
    console.warn("[skip-light] debugger attach failed —", err?.message);
    return false;
  }

  const base = { x, y, button: "left", clickCount: 1 };
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...base, type: "mouseMoved", buttons: 0,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...base, type: "mousePressed", buttons: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...base, type: "mouseReleased", buttons: 0,
    });
    return true;
  } catch (err) {
    console.warn("[skip-light] trusted click failed —", err?.message);
    return false;
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* tab closed mid-click; nothing to clean up */
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Report the outcome back. The ESP32 clears pressPending the moment it hands
  // the press over, so a click that fails here is the end of the road for that
  // press unless the caller learns it failed and tries again.
  if (msg.type === "trustedClick") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    trustedClick(tabId, msg.x, msg.y).then((ok) => sendResponse({ ok }));
    return true; // response is async
  }

  if (msg.type === "modeState") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      if (msg.mode === "idle") {
        tabModes.delete(tabId);
      } else {
        tabModes.set(tabId, msg.mode);
      }
    }
    setBadge(tabId, msg.mode);

    const agg = aggregateMode();
    if (agg !== lastMode) {
      lastMode = agg;
      setEsp32Mode(agg);
    }
    return false;
  }

  if (msg.type === "esp32Poll") {
    pollEsp32().then(sendResponse);
    return true; // response is async
  }

  if (msg.type === "esp32Status") {
    sendResponse({ esp32Online: onlineCount > 0, count: onlineCount });
    return false;
  }

  return false;
});
