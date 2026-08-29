const btn = document.getElementById("skipBtn");
const statusEl = document.getElementById("status");
const warnEl = document.getElementById("warn");

let activeTabId = null;

function render(state) {
  if (state?.available) {
    btn.disabled = false;
    btn.classList.add("available");
    btn.textContent = "Skip Ad";
  } else {
    btn.disabled = true;
    btn.classList.remove("available");
    btn.textContent = "No ad";
  }
  // Tier > 1 means the known class names stopped matching and a fuzzy fallback
  // carried it. Still works, but it's the early warning that YouTube renamed
  // things — surfaced here so it's noticed before it fails outright.
  if (state && state.matchTier > 1) {
    warnEl.textContent = `\u26a0 detection fallback (tier ${state.matchTier}) \u2014 update selectors`;
    warnEl.style.display = "block";
  } else {
    warnEl.style.display = "none";
  }

  if (!state) {
    statusEl.textContent = "Open a YouTube tab";
  } else if (state.esp32Online) {
    const n = state.esp32Count || 1;
    statusEl.textContent = `ESP32: ${n} connected`;
  } else {
    statusEl.textContent = "ESP32: not found (virtual mode)";
  }
}

function refresh() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return render(null);
    activeTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, { type: "getState" }, (state) => {
      if (chrome.runtime.lastError) return render(null);
      // The service worker owns the ESP32 connection, so ask it rather than
      // the content script, whose copy only refreshes when it polls.
      chrome.runtime.sendMessage({ type: "esp32Status" }, (status) => {
        render({
          ...state,
          esp32Online: status?.esp32Online ?? false,
          esp32Count: status?.count ?? 0,
          matchTier: state?.matchTier ?? null,
        });
      });
    });
  });
}

btn.addEventListener("click", () => {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "clickSkip" }, () => refresh());
});

refresh();
setInterval(refresh, 500);
