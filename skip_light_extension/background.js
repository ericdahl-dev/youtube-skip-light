// Virtual LED (extension badge), all ESP32 HTTP, and the trusted click.
//
// The ESP32 fetches live here, not in content.js, because YouTube is served
// over HTTPS and Chrome blocks plain-HTTP requests from a content script on an
// HTTPS page as mixed content. A service worker is not an HTTPS document, so
// it can talk to http://skipbutton.local freely (host_permissions covers CORS).

// Every board is lit, and a press from ANY of them skips. Each board must have
// its own mDNS name — two boards answering to "skipbutton" makes
// skipbutton.local resolve to whichever replies first, and it flips between
// reboots. Firmware sets this with -DDEVICE_INDEX=N.
//
// Add entries here AND to host_permissions in manifest.json. Unreachable
// entries are harmless: they just count as offline.
const ESP32_URLS = [
  "http://skipbutton.local",   // Waveshare Touch LCD 1.47
  "http://skipbutton2.local",  // QT Py ESP32-S3
  "http://skipbutton3.local",  // ESP32-S3 Super Mini
];

const ESP32_TIMEOUT_MS = 2000;

let onlineCount = 0;
let lastAvailable = false;

async function esp32(base, path) {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(ESP32_TIMEOUT_MS),
  });
  return (await res.text()).trim();
}

// Fan out to every board in parallel. One slow or absent board must not delay
// the others, so these are independent rather than sequential.
async function setEsp32Led(available) {
  const results = await Promise.all(
    ESP32_URLS.map(async (base) => {
      try {
        await esp32(base, `/skip?state=${available ? 1 : 0}`);
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
  if (wasAllOffline && onlineCount > 0) setEsp32Led(lastAvailable);

  return {
    online: onlineCount > 0,
    pressed: results.some((r) => r.pressed),
    count: onlineCount,
  };
}

function setBadge(tabId, available) {
  if (tabId == null) return;
  if (available) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
    chrome.action.setBadgeText({ tabId, text: "SKIP" });
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
  if (msg.type === "trustedClick") {
    const tabId = sender.tab?.id;
    if (tabId != null) trustedClick(tabId, msg.x, msg.y);
    return false;
  }

  if (msg.type === "skipState") {
    setBadge(sender.tab?.id, msg.available);
    lastAvailable = msg.available;
    setEsp32Led(msg.available);
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
