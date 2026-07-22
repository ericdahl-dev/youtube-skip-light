const btn = document.getElementById("skipBtn");
const statusEl = document.getElementById("status");

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
