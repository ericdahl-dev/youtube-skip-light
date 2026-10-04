// ESP32 YouTube Skip Button Indicator
//
// - Onboard RGB LED / screen shows what the button will do right now
// - A press is queued for the browser extension, which decides what it means
//
// The board is deliberately ignorant of YouTube. It holds a MODE, set by the
// extension, and that mode drives exactly two things: what color to show, and
// whether a press is worth queueing at all. It never learns what "skip" or
// "back" do — the extension is the only side that can see the page, so it
// interprets the press when it collects it. Adding a mode later is a one-line
// change here and all the real work over there.
//
// Endpoints:
//   GET /mode?m=skip|back|idle -> extension reports what the button should do
//   GET /skip?state=1|0        -> legacy alias: 1 = skip mode, 0 = idle
//   GET /poll                  -> extension polls; "1" once after a press
//   GET /                      -> human-readable status page
//
// Builds for either board; pins come from the core's variant header where
// available, so add a board by adding an #elif rather than editing the logic.
//
//   Adafruit QT Py ESP32-S3   NeoPixel GPIO 39 (power GPIO 38), BOOT GPIO 0
//     FQBN esp32:esp32:adafruit_qtpy_esp32s3_n4r2
//     Optional external button on A0 (GPIO 18) to GND.
//
//   ESP32-S3 Super Mini       WS2812 GPIO 48, BOOT GPIO 0
//     FQBN esp32:esp32:esp32s3
//     Optional external button on GPIO 4 to GND.
//
// LED colors:
//   off        = idle, nothing to act on
//   green      = Skip is available, press the button
//   blue       = back mode: a press goes back a video, OR (before any mode is
//                set) still connecting to WiFi. They cannot overlap: no mode
//                arrives until the network is up.
//   red        = WiFi lost
//   purple     = OTA update in progress
//
// Runs the low-power profile unconditionally (WiFi modem sleep on, LED dim).
// It roughly halves idle current for battery use, and costs up to ~100 ms of
// extra latency per request — invisible here, since the extension polls every
// 300 ms regardless.

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include "secrets.h"
#include "skip_display.h"

// ---- Board-adaptive pins -----------------------------------------------
#ifdef HAS_TOUCH_DISPLAY
  // Waveshare ESP32-S3-Touch-LCD-1.47: the screen IS the indicator and the
  // touch panel IS the button. No RGB LED on this board — GPIO 38 is the
  // panel's SCK here, so writing "the LED pin" would fight the display.
  #define EXT_BTN_PIN 1  // spare broken-out pin; optional physical button
#elif defined(PIN_NEOPIXEL)
  // Adafruit variants (QT Py) define these in pins_arduino.h.
  #define LED_DATA_PIN PIN_NEOPIXEL
  #define EXT_BTN_PIN  A0  // GPIO 4 isn't broken out on the QT Py
#else
  // Generic ESP32-S3 dev boards (Super Mini) put the WS2812 on GPIO 48.
  #define LED_DATA_PIN 48
  #define EXT_BTN_PIN  4
#endif

const int BOOT_BTN_PIN = 0;  // onboard BOOT button, all boards

// ---- Device identity ---------------------------------------------------
// Each board needs its OWN mDNS name. Two boards answering to "skipbutton"
// means skipbutton.local resolves to whichever replies first, and that flips
// between reboots — the extension would light one board while polling another.
//
// Board 1 keeps the plain name; others get a suffix. Override at build time:
//   --build-property compiler.cpp.extra_flags=-DDEVICE_INDEX=2
// A number, not a string, so there are no quotes to escape through the build.
#ifndef DEVICE_INDEX
#define DEVICE_INDEX 1
#endif

char deviceHost[24];

void buildDeviceHost() {
  if (DEVICE_INDEX <= 1) {
    snprintf(deviceHost, sizeof(deviceHost), "skipbutton");
  } else {
    snprintf(deviceHost, sizeof(deviceHost), "skipbutton%d", (int)DEVICE_INDEX);
  }
}

// Onboard pixels are bright; this is easily visible indoors and gentle on a
// battery. Raise it if the light needs to catch your eye across a room.
const uint8_t LED_BRIGHTNESS = 20;

WebServer server(80);

// What the button will do if it is pressed right now.
//
// The firmware deliberately knows nothing about what these MEAN. It needs a
// mode only to pick a color and to decide whether a press is worth queueing.
// The extension is the only thing that can see the page, so it decides what an
// arriving press actually does — which is why adding a mode later costs no
// firmware change at all.
enum ButtonMode {
  MODE_IDLE = 0,  // nothing to act on; presses are dropped
  MODE_SKIP = 1,  // ad on screen with a live Skip button
  MODE_BACK = 2,  // a watch page, no ad: the press navigates back
};

// Held as an int, not a ButtonMode. The .ino preprocessor hoists generated
// prototypes above this file's own declarations, so an enum-typed parameter
// gets declared before the enum exists and fails to compile. The constants
// above still give every assignment and comparison a name.
int buttonMode = MODE_IDLE;
bool pressPending = false;

const char *modeName(int m) {
  switch (m) {
    case MODE_SKIP: return "skip";
    case MODE_BACK: return "back";
    default:        return "idle";
  }
}

// Debounce, tracked per button so either can trigger a press
struct Button {
  int pin;
  unsigned long lastDebounce;
  int lastReading;
  int stableState;
};

Button buttons[] = {
  {BOOT_BTN_PIN, 0, HIGH, HIGH},
  {EXT_BTN_PIN, 0, HIGH, HIGH},
};
const size_t BUTTON_COUNT = sizeof(buttons) / sizeof(buttons[0]);
const unsigned long DEBOUNCE_MS = 50;

// On screenless boards these drive the onboard RGB pixel. On the touch-LCD
// board they're no-ops and the panel carries the same information, so callers
// don't need to care which board they're on.
void setLed(uint8_t r, uint8_t g, uint8_t b) {
#ifdef HAS_TOUCH_DISPLAY
  (void)r; (void)g; (void)b;
#else
  rgbLedWrite(LED_DATA_PIN, r, g, b);
#endif
}

void showMode() {
#ifdef HAS_TOUCH_DISPLAY
  char status[40];
  if (WiFi.status() == WL_CONNECTED) {
    snprintf(status, sizeof(status), "%s", WiFi.localIP().toString().c_str());
  } else {
    snprintf(status, sizeof(status), "wifi down");
  }
  display_render((int)buttonMode, status);
#else
  switch (buttonMode) {
    case MODE_SKIP:
      setLed(0, LED_BRIGHTNESS, 0);  // green — the urgent one
      break;
    case MODE_BACK:
      // Blue, matching the blue field the touch board shows, so the two kinds
      // of board describe the same state the same way.
      //
      // NOTE: connectWifi() also shows blue on these screenless boards. The two
      // never overlap in practice — no mode is set until WiFi is up — but if a
      // steady blue is ever ambiguous to you, change the connecting color, not
      // this one.
      setLed(0, 0, LED_BRIGHTNESS);
      break;
    default:
      setLed(0, 0, 0);
      break;
  }
#endif
}

void setMode(int next) {
  if (next == buttonMode) return;
  buttonMode = next;
  showMode();
  Serial.printf("mode: %s\n", modeName(buttonMode));

  // Leaving idle-or-skip for anything else invalidates a queued press: it was
  // aimed at whatever was on screen a moment ago, and acting on it now would
  // fire at the wrong target.
  if (buttonMode == MODE_IDLE) pressPending = false;
}

// Legacy endpoint. An older extension only knows about skip-or-nothing, so
// keep answering it: state=1 means skip, state=0 means idle. Newer builds call
// /mode instead. Cheap to keep, and it means a half-updated pair still works.
void handleSkip() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (server.hasArg("state")) {
    setMode(server.arg("state") == "1" ? MODE_SKIP : MODE_IDLE);
  }
  server.send(200, "text/plain", "ok");
}

// GET /mode?m=skip|back|idle
void handleMode() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (server.hasArg("m")) {
    String m = server.arg("m");
    if (m == "skip") {
      setMode(MODE_SKIP);
    } else if (m == "back") {
      setMode(MODE_BACK);
    } else {
      setMode(MODE_IDLE);
    }
  }
  server.send(200, "text/plain", modeName(buttonMode));
}

void handlePoll() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (pressPending) {
    pressPending = false;
    server.send(200, "text/plain", "1");
  } else {
    server.send(200, "text/plain", "0");
  }
}

void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String body = "YouTube Skip Button\n";
  body += "host: " + String(deviceHost) + ".local\n";
  body += "ip: " + WiFi.localIP().toString() + "\n";
  body += "rssi: " + String(WiFi.RSSI()) + " dBm\n";
  // Which access point, not just how strong. On a multi-AP network the useful
  // question is never "is the signal weak" but "weak to WHICH radio" — the
  // board may be holding onto a distant AP while a closer one sits unused.
  body += "ssid: " + WiFi.SSID() + "\n";
  body += "bssid: " + WiFi.BSSIDstr() + "\n";
  body += "channel: " + String(WiFi.channel()) + "\n";
  body += "mode: " + String(modeName(buttonMode)) + "\n";
  body += "uptime: " + String(millis() / 1000) + "s\n";
#ifdef HAS_TOUCH_DISPLAY
  body += "touchPresses: " + String(display_touch_presses()) + "\n";
  body += "touchZeros: " + String(display_touch_zeros()) + "\n";
#endif
  server.send(200, "text/plain", body);
}

// GET /scan — every AP visible FROM THE BOARD, strongest first.
//
// This is the measurement that actually settles a multi-AP question. RSSI on
// the status page says how well the current link is doing; this says whether a
// better one was available all along. A closer AP listed here with a much
// stronger RSSI than the associated one means the board simply never roamed.
//
// Blocks for a couple of seconds and briefly disturbs the link, so it is a
// deliberate diagnostic, never something the extension should poll.
void handleScan() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  int n = WiFi.scanNetworks(false /* async */, true /* show hidden */);
  String body = "visible APs from the board (strongest first)\n";
  body += "associated: " + WiFi.BSSIDstr() + " ch" + String(WiFi.channel()) +
          " " + String(WiFi.RSSI()) + " dBm\n\n";

  if (n <= 0) {
    body += "(none found)\n";
  } else {
    for (int i = 0; i < n; i++) {
      // scanNetworks already returns results sorted by descending RSSI.
      body += String(WiFi.RSSI(i)) + " dBm  ch" + String(WiFi.channel(i)) +
              "  " + WiFi.BSSIDstr(i) + "  " + WiFi.SSID(i);
      if (WiFi.BSSIDstr(i) == WiFi.BSSIDstr()) body += "   <== associated";
      body += "\n";
    }
  }

  WiFi.scanDelete();  // the results list is heap-allocated; don't leak it
  server.send(200, "text/plain", body);
}

// ---- OTA ---------------------------------------------------------------
//
// Requires a partition scheme with two app slots — build with
// PartitionScheme=min_spiffs. The board's default (tinyuf2_noota) has a single
// 2.7 MB app partition and OTA silently has nowhere to write.
//
// LED during an update: purple = receiving, red = failed. On success the board
// reboots and returns to its normal colors.
void setupOta() {
  ArduinoOTA.setHostname(deviceHost);
  ArduinoOTA.setPassword(OTA_PASSWORD);

  ArduinoOTA.onStart([]() {
    setLed(LED_BRIGHTNESS, 0, LED_BRIGHTNESS);  // purple
#ifdef HAS_TOUCH_DISPLAY
    display_message("UPDATE", "receiving...", 0xF81F);  // magenta
#endif
    Serial.println("OTA: start");
  });
  ArduinoOTA.onEnd([]() {
    setLed(0, 0, 0);
    Serial.println("OTA: done, rebooting");
  });
  ArduinoOTA.onError([](ota_error_t err) {
    setLed(LED_BRIGHTNESS, 0, 0);  // red
    Serial.printf("OTA: error %u\n", err);
  });

  ArduinoOTA.begin();
  Serial.println("OTA ready on skipbutton.local:3232");
}

void connectWifi() {
  setLed(0, 0, LED_BRIGHTNESS);  // blue while connecting
#ifdef HAS_TOUCH_DISPLAY
  display_message("WiFi", WIFI_SSID, 0x001F);  // blue
#endif
  WiFi.mode(WIFI_STA);
  // Modem sleep halves idle current but lets the WiFi stack stall the main loop
  // for tens of ms at a time — worse on a weak signal. On the touch board that
  // starves the I2C touch poll and drops taps, so keep the radio awake there;
  // its backlight dwarfs any sleep savings anyway. Battery boards keep sleep on.
#ifdef HAS_TOUCH_DISPLAY
  WiFi.setSleep(false);
#else
  WiFi.setSleep(true);
#endif
  // Pick the STRONGEST access point, not the first one heard.
  //
  // The ESP32 default is WIFI_FAST_SCAN, which stops at the first AP matching
  // the SSID and connects to it — fine with one router, actively harmful with
  // several, because "first heard" has nothing to do with "nearest". Measured
  // on this network before the fix: associated at -88 dBm while an AP with the
  // same SSID sat on the SAME CHANNEL at -51 dBm, ignored. That is ~37 dB, and
  // -88 is squarely in the range where the WiFi stack stalls the main loop and
  // taps on the glass get dropped.
  //
  // ALL_CHANNEL_SCAN costs roughly a second of extra connect time, once, at
  // boot. Worth it.
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  showMode();
}

void setup() {
  Serial.begin(115200);
  buildDeviceHost();

#ifdef NEOPIXEL_POWER
  // The QT Py gates the NeoPixel's supply behind a separate pin. Without this
  // the LED stays dark no matter what you write to the data pin.
  pinMode(NEOPIXEL_POWER, OUTPUT);
  digitalWrite(NEOPIXEL_POWER, NEOPIXEL_POWER_ON);
#endif

  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);
  pinMode(EXT_BTN_PIN, INPUT_PULLUP);
  setLed(0, 0, 0);

#ifdef HAS_TOUCH_DISPLAY
  display_begin();
#endif

  connectWifi();

  setupOta();

  if (MDNS.begin(deviceHost)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("mDNS: http://%s.local\n", deviceHost);
  } else {
    Serial.println("mDNS failed; use the IP above in the extension");
  }

  server.on("/", handleRoot);
  server.on("/skip", handleSkip);
  server.on("/mode", handleMode);
  server.on("/scan", handleScan);
  server.on("/poll", handlePoll);
  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  ArduinoOTA.handle();
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost; reconnecting");
    setLed(LED_BRIGHTNESS, 0, 0);  // red
#ifdef HAS_TOUCH_DISPLAY
    display_message("WiFi", "reconnecting", 0xF800);  // red
#endif
    WiFi.disconnect();
    connectWifi();
  }

#ifdef HAS_TOUCH_DISPLAY
  // Tapping the glass is the same gesture as pressing the button. Guarded by
  // the mode so a stray tap with nothing on screen can't queue a stale press.
  if (display_touched() && buttonMode != MODE_IDLE) {
    pressPending = true;
    Serial.printf("Touch -> queueing %s\n", modeName(buttonMode));
  }
#endif

  // Debounced read; register a press on the HIGH -> LOW edge of either button
  for (size_t i = 0; i < BUTTON_COUNT; i++) {
    Button& btn = buttons[i];
    int reading = digitalRead(btn.pin);
    if (reading != btn.lastReading) {
      btn.lastDebounce = millis();
    }
    if (millis() - btn.lastDebounce > DEBOUNCE_MS) {
      if (reading != btn.stableState) {
        btn.stableState = reading;
        if (btn.stableState == LOW && buttonMode != MODE_IDLE) {
          pressPending = true;
          Serial.printf("Button (GPIO %d) pressed -> queueing %s\n",
                        btn.pin, modeName(buttonMode));
        }
      }
    }
    btn.lastReading = reading;
  }
}
