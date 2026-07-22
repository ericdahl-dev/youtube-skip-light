// ESP32 YouTube Skip Button Indicator
//
// - Onboard RGB LED lights green when a skippable ad's Skip button is available
// - Physical button press tells the browser extension to click Skip
//
// Endpoints:
//   GET /skip?state=1|0  -> extension reports skip availability
//   GET /poll            -> extension polls; returns "1" once after a button press
//   GET /                -> human-readable status page
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
//   off    = idle, no skippable ad
//   green  = Skip is available, press the button
//   blue   = connecting to WiFi
//   red    = WiFi lost
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

bool skipAvailable = false;
bool pressPending = false;

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

void showSkipState() {
#ifdef HAS_TOUCH_DISPLAY
  char status[40];
  if (WiFi.status() == WL_CONNECTED) {
    snprintf(status, sizeof(status), "%s", WiFi.localIP().toString().c_str());
  } else {
    snprintf(status, sizeof(status), "wifi down");
  }
  display_render(skipAvailable, status);
#else
  if (skipAvailable) {
    setLed(0, LED_BRIGHTNESS, 0);  // green
  } else {
    setLed(0, 0, 0);  // off
  }
#endif
}

void handleSkip() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (server.hasArg("state")) {
    bool next = server.arg("state") == "1";
    if (next != skipAvailable) {
      skipAvailable = next;
      showSkipState();
      Serial.printf("skip available: %s\n", skipAvailable ? "yes" : "no");
    }
    if (!skipAvailable) {
      pressPending = false;  // ad ended / skip consumed; clear any stale press
    }
  }
  server.send(200, "text/plain", "ok");
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
  body += "skipAvailable: " + String(skipAvailable ? "1" : "0") + "\n";
  body += "uptime: " + String(millis() / 1000) + "s\n";
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
  WiFi.setSleep(true);  // modem sleep; see header note
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  showSkipState();
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
  // skipAvailable so a stray tap with no ad on screen can't queue a stale press.
  if (display_touched() && skipAvailable) {
    pressPending = true;
    Serial.println("Touch -> queueing skip");
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
        if (btn.stableState == LOW && skipAvailable) {
          pressPending = true;
          Serial.printf("Button (GPIO %d) pressed -> queueing skip\n", btn.pin);
        }
      }
    }
    btn.lastReading = reading;
  }
}
