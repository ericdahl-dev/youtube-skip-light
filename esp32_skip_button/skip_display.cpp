#include "skip_display.h"

#ifdef HAS_TOUCH_DISPLAY

#include <Arduino.h>
#include <Wire.h>
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include "axs5106l.h"

// ---- Panel -----------------------------------------------------------------
// Waveshare ESP32-S3-Touch-LCD-1.47. The panel controller is a JD9853, but it
// takes the ST7789 command set, so LovyanGFX's Panel_ST7789 drives it directly.
//
// 172x320 visible inside 240x320 of controller RAM, hence offset_x = 34. Get
// that offset wrong and everything renders shifted with a colour band down one
// edge. Backlight is driven as a plain GPIO — Light_PWM/LEDC did not reliably
// drive it in a full build.
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7789 _panel;
  lgfx::Bus_SPI _bus;

public:
  LGFX() {
    {
      auto c = _bus.config();
      c.spi_host = SPI2_HOST;
      c.spi_mode = 0;
      c.freq_write = 40000000;
      c.freq_read = 16000000;
      c.pin_sclk = 38;
      c.pin_mosi = 39;
      c.pin_miso = -1;
      c.pin_dc = 45;
      c.dma_channel = SPI_DMA_CH_AUTO;
      _bus.config(c);
      _panel.setBus(&_bus);
    }
    {
      auto c = _panel.config();
      c.pin_cs = 21;
      c.pin_rst = 40;
      c.pin_busy = -1;
      c.memory_width = 240;
      c.memory_height = 320;
      c.panel_width = 172;
      c.panel_height = 320;
      c.offset_x = 34;
      c.offset_y = 0;
      c.invert = false;
      c.rgb_order = false;
      _panel.config(c);
    }
    setPanel(&_panel);
  }
};

#define TP_SDA 42
#define TP_SCL 41
#define TP_RST 47
#define LCD_BL 46

static LGFX s_lcd;

// Repaint only on change: a full fillScreen on every 300 ms tick would flicker.
static int s_lastSkip = -1;
static char s_lastStatus[40] = {0};

static bool s_fingerDown = false;

static void backlight_on(void) {
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, HIGH);
}

static bool axs_read(axs_touch_t *t) {
  Wire.beginTransmission(AXS5106L_I2C_ADDR);
  Wire.write(AXS5106L_TOUCH_REG);
  if (Wire.endTransmission(true) != 0) return false;  // STOP, then a fresh read
  uint8_t buf[AXS5106L_REPORT_LEN];
  int n = Wire.requestFrom((int)AXS5106L_I2C_ADDR, (int)AXS5106L_REPORT_LEN);
  if (n < AXS5106L_REPORT_LEN) return false;
  for (int i = 0; i < AXS5106L_REPORT_LEN; i++) buf[i] = Wire.read();
  return axs5106l_parse(buf, sizeof(buf), t) == 0;
}

// Centre a string horizontally at the given text size.
static void center_text(const char *s, int y, int size) {
  s_lcd.setTextSize(size);
  int w = s_lcd.textWidth(s);
  s_lcd.setCursor((s_lcd.width() - w) / 2, y);
  s_lcd.print(s);
}

void display_begin(void) {
  s_lcd.init();
  // Landscape: 320x172 instead of 172x320. The panel's validated orientation is
  // rotation 4 (the mirrored set); +1 turns it 90 degrees, which buys roughly
  // 3x the glyph size for "SKIP" since width is now the long axis.
  s_lcd.setRotation(5);
  backlight_on();

  s_lcd.fillScreen(TFT_BLACK);
  s_lcd.setTextColor(TFT_WHITE, TFT_BLACK);
  center_text("SKIP LIGHT", 55, 4);
  s_lcd.setTextColor(0x7BEF, TFT_BLACK);
  center_text("booting...", 110, 2);

  pinMode(TP_RST, OUTPUT);
  digitalWrite(TP_RST, LOW);
  delay(20);
  digitalWrite(TP_RST, HIGH);
  delay(80);
  Wire.begin(TP_SDA, TP_SCL);
  Wire.setClock(400000);

  Serial.printf("display: up (%dx%d)\n", (int)s_lcd.width(), (int)s_lcd.height());
}

void display_message(const char *line1, const char *line2, unsigned long color) {
  s_lastSkip = -1;  // force a repaint next time state is rendered
  const int h = s_lcd.height();
  s_lcd.fillScreen(TFT_BLACK);
  s_lcd.setTextColor((uint16_t)color, TFT_BLACK);
  center_text(line1, h / 2 - 40, 5);
  if (line2 && *line2) {
    s_lcd.setTextColor(0x7BEF, TFT_BLACK);
    center_text(line2, h / 2 + 15, 2);
  }
}

void display_render(bool skipAvailable, const char *status) {
  const int want = skipAvailable ? 1 : 0;
  if (want == s_lastSkip && status && strncmp(status, s_lastStatus, sizeof(s_lastStatus) - 1) == 0) {
    return;  // nothing changed
  }
  s_lastSkip = want;
  if (status) {
    strncpy(s_lastStatus, status, sizeof(s_lastStatus) - 1);
    s_lastStatus[sizeof(s_lastStatus) - 1] = '\0';
  }

  const int h = s_lcd.height();

  if (skipAvailable) {
    // Green field, black text — readable across a room and unmistakable.
    // Size 8 = 48x64 px glyphs, so "SKIP" is 192 px of the 320 px width.
    s_lcd.fillScreen(TFT_GREEN);
    s_lcd.setTextColor(TFT_BLACK, TFT_GREEN);
    center_text("SKIP", h / 2 - 55, 8);
    center_text("tap to skip", h / 2 + 25, 2);
  } else {
    s_lcd.fillScreen(TFT_BLACK);
    s_lcd.setTextColor(0x39E7, TFT_BLACK);  // dim grey
    center_text("no ad", h / 2 - 28, 4);
  }

  if (status && *status) {
    s_lcd.setTextColor(0x7BEF, skipAvailable ? TFT_GREEN : TFT_BLACK);
    s_lcd.setTextSize(1);
    int w = s_lcd.textWidth(status);
    s_lcd.setCursor((s_lcd.width() - w) / 2, s_lcd.height() - 14);
    s_lcd.print(status);
  }
}

bool display_touched(void) {
  axs_touch_t t;
  if (!axs_read(&t)) return false;

  const bool down = t.points_len > 0;
  const bool edge = down && !s_fingerDown;  // rising edge only: one tap, one press
  s_fingerDown = down;
  return edge;
}

#endif  // HAS_TOUCH_DISPLAY
