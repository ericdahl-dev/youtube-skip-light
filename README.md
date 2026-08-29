# YouTube Skip Light

A Chrome extension that lights up when a YouTube ad's Skip button becomes
available, and skips it when you press a button — in the extension popup, or on
any of one or more ESP32 devices.

There is no auto-skip. Skipping always requires a deliberate action.

The ESP32s are optional. Without any, the extension badge is the light and the
popup button is the button.

---

## Supported boards

One sketch builds for all three. Pins come from the core's variant header where
possible, so adding a board means adding an `#elif`, not editing logic.

| Board | Indicator | Button | Notes |
|---|---|---|---|
| **Waveshare ESP32-S3-Touch-LCD-1.47** | 172×320 LCD | Touchscreen + BOOT | 16 MB flash, 8 MB octal PSRAM |
| **Adafruit QT Py ESP32-S3** | NeoPixel GPIO 39 | BOOT (GPIO 0) | GPIO 38 must be HIGH to power the pixel |
| **ESP32-S3 Super Mini** | WS2812 GPIO 48 | BOOT (GPIO 0) | No LED power pin |

Optional wired button: A0 (GPIO 18) on the QT Py, GPIO 4 on the Super Mini,
GPIO 1 on the Waveshare. Every button is in parallel — any of them queues a skip.

**LED colors** (screenless boards): off idle · green skip available · blue
connecting · red WiFi lost · purple OTA.

**Screen** (Waveshare): green "SKIP / tap to skip" when available, dim "no ad"
otherwise, IP along the bottom.

The firmware always runs the low-power profile (WiFi modem sleep on, LED dim).
That roughly halves idle current for battery use and costs up to ~100 ms per
request, which is invisible since the extension polls every 300 ms.

### Waveshare panel details

The panel controller is a **JD9853**, not the ST7789 that most published
pinouts for the similarly-named `ESP32-S3-LCD-1.47` claim — those pins are for a
different board and will not work here. It accepts the ST7789 command set, so
LovyanGFX's `Panel_ST7789` drives it.

| | Pin |
|---|---|
| SCK / MOSI / DC | 38 / 39 / 45 |
| CS / RST / Backlight | 21 / 40 / 46 |
| Touch (AXS5106L) SDA / SCL / RST | 42 / 41 / 47, I²C `0x63` |

172×320 visible inside 240×320 of controller RAM, hence `offset_x = 34`. Get
that wrong and everything renders shifted with a colour band down one edge.
Backlight is a plain GPIO — LovyanGFX's `Light_PWM`/LEDC did not reliably drive
it. Requires the **LovyanGFX** library.

---

## Building and flashing

Fill in `esp32_skip_button/secrets.h` first (copy `secrets.h.example`). The S3
has no 5 GHz radio — use a 2.4 GHz network.

Each board needs a unique mDNS name via `DEVICE_INDEX` (a number, so there are
no quotes to escape). Board 1 is `skipbutton.local`, board 2 is
`skipbutton2.local`, and so on.

**Waveshare (board 1, with screen):**
```sh
cd esp32_skip_button
arduino-cli compile --upload -p /dev/cu.usbmodem2101 \
  -b esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=min_spiffs \
  --build-property "compiler.cpp.extra_flags=-DHAS_TOUCH_DISPLAY" .
```

**QT Py (board 2):**
```sh
arduino-cli compile --upload -p /dev/cu.usbmodem2101 \
  -b esp32:esp32:adafruit_qtpy_esp32s3_n4r2:CDCOnBoot=cdc,PartitionScheme=min_spiffs \
  --build-property "compiler.cpp.extra_flags=-DDEVICE_INDEX=2" .
```

**Super Mini (board 3):**
```sh
arduino-cli compile --upload -p /dev/cu.usbmodem2101 \
  -b esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=4M,PartitionScheme=min_spiffs \
  --build-property "compiler.cpp.extra_flags=-DDEVICE_INDEX=3" .
```

`PartitionScheme=min_spiffs` is **required** — it's the OTA-capable table.
Board defaults (`tinyuf2_noota` on the QT Py) have a single app partition and
OTA silently has nowhere to write. `CDCOnBoot=cdc` makes `Serial` visible over
USB. Find your port with `arduino-cli board list`.

### Over-the-air updates

Once an OTA-capable partition table is flashed, no cable is needed — build with
the same flags plus `--output-dir`, then:

```sh
python3 ~/Library/Arduino15/packages/esp32/hardware/esp32/3.3.8/tools/espota.py \
  -i skipbutton2.local -p 3232 --auth=$OTA_PASSWORD \
  -f /tmp/out/esp32_skip_button.ino.bin
```

LED/screen goes purple while receiving, red on failure; the board reboots itself
on success.

### HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /` | Status (host, IP, RSSI, skip state, uptime) |
| `GET /skip?state=1\|0` | Extension reports skip availability; drives the light |
| `GET /poll` | Returns `1` **once** after a press, then `0` |

`/poll` is read-once, so a press can't be consumed twice. The firmware only
latches a press while `skipAvailable` is true, so idle presses are ignored.

---

## Installing the extension

`chrome://extensions` → Developer mode → **Load unpacked** →
`skip_light_extension/`. Accept the `debugger` permission.

**After any reload of the extension, close and reopen your YouTube tabs.**
Chrome orphans content scripts in open tabs on reload — the old script keeps
running its timers but its `chrome.*` APIs are dead, which looks exactly like
the extension being broken. The console banner (`[skip-light] content script
vX.Y loaded`) tells you which version a tab is running.

### Multiple boards

`ESP32_URLS` in `background.js` lists every board. All are lit together and a
press from any one skips. To add a board: add its URL there **and** a matching
entry in `host_permissions` in `manifest.json` (`skipbutton3.local` is already
authorised). Unreachable entries are harmless — they count as offline.

---

## How it works, and why

Three non-obvious constraints shaped this. All three cost real debugging time.

**1. YouTube's Skip button requires a trusted event.**
The button has a normal `click` listener, but it checks `event.isTrusted` and
ignores anything dispatched from JavaScript. `btn.click()` and a full synthetic
pointer sequence both do nothing. The extension drives a real OS-level click via
`chrome.debugger` and CDP `Input.dispatchMouseEvent`.

**2. Seeking past the ad doesn't work.**
Jumping the ad's `<video>` to its end fails because ads stream over MSE with
only a few seconds buffered. Seeking beyond the buffered range collapses the
media element (`duration: NaN`, `readyState: 0`) and the player stalls until it
rebuilds. Not tunable — the buffered range is smaller than the jump required.

**3. Content scripts can't reach the ESP32.**
YouTube is HTTPS, so a plain-HTTP `fetch` to `http://skipbutton.local` from
`content.js` is blocked as mixed content. All ESP32 traffic lives in
`background.js` — a service worker isn't an HTTPS document, so it's exempt.

### Files

| File | Role |
|---|---|
| `content.js` | Detects the Skip button, reports state, sends coordinates for a trusted click. No HTTP. |
| `background.js` | Badge, all ESP32 HTTP across all boards, and the CDP trusted click. |
| `popup.js` / `popup.html` | Virtual button and connection status. |
| `skip_display.cpp/h` | Waveshare LCD + touch UI (compiled only under `HAS_TOUCH_DISPLAY`). |
| `axs5106l.c/h` | AXS5106L touch report parser — pure, host-testable, no I²C. |

`content.js` polls `/poll` at 300 ms **only while that tab has a skip
available**, and otherwise checks reachability every 15 s. That matters twice
over: `/poll` is read-once, so a tab polling with no ad could swallow a press
meant for the tab that has one; and each poll now fans out to every board.

---

## Gotchas

**Every board needs a unique `DEVICE_INDEX`.** Two boards answering to
`skipbutton` makes `skipbutton.local` resolve to whichever replies first, and it
flips between reboots — the extension would light one board while polling
another. mDNS has no arbitration for duplicate names.

**DevTools open on a YouTube tab disables skipping.** Only one debugger client
can attach at a time and DevTools wins, so every click fails with
`attach failed`. Silent from the page; the reason prints in the service worker
console (`chrome://extensions` → **service worker**).

**Don't pulse DTR/RTS on an ESP32-S3 to "reset" it.** That pattern is the
bootloader entry sequence — the board lands in download mode with a blank screen
and silent serial, looking exactly like a crash. Use
`esptool --port X --after hard-reset flash-id`. Note native USB CDC
re-enumerates after a reset, so reopen the port rather than reusing the handle.

**USB vs battery can't be detected reliably.** `usb_serial_jtag_is_connected()`
would answer it, but only when the ESP-IDF USB Serial/JTAG driver is installed —
Arduino's `HWCDC` runs its own ISR, so the SOF tracking it depends on never runs
and it always returns true. The firmware just always runs low-power.

**The service worker sleeps after ~30 s idle.** Harmless — it wakes on each
message, and during an ad `content.js` messages it every 300 ms. The first press
after a long idle can be slow.

**`skipbutton.local` stalls on a cold DNS cache.** First requests after a boot
can time out, then everything works. If persistently unresolvable, hardcode IPs
in `ESP32_URLS` and `manifest.json`, with DHCP reservations.

**`secrets.h` holds your WiFi and OTA passwords in plaintext.** It's gitignored.
The OTA password matters more than it looks — a board on battery across the
house is flashable by anything on your LAN.

**YouTube renames the Skip button's CSS classes periodically.** `findSkipButton()`
degrades through three tiers rather than breaking outright:

1. Known exact class names (`.ytp-ad-skip-button` and friends)
2. Any button in the ad overlay whose class or id contains "skip" — survives
   renames that keep the word, which every rename so far has
3. Any button in the ad overlay whose text or `aria-label` says "skip" in one of
   ~15 languages

When a tier above 1 carries a match, the popup shows an amber
"detection fallback" warning and the console logs once. That's the cue to update
`KNOWN_SELECTORS` — it keeps working in the meantime, but on a guess.

**The tiers only ever search inside `.html5-video-player.ad-showing`**, and
tiers 2–3 additionally require a button-shaped element (40–400 × 16–120 px).
This matters because the extension issues a *real* OS-level click: a fuzzy match
on the wrong element would click whatever sits under it. Never widen the fuzzy
tiers to the whole document — "Skip navigation" alone would break it.
