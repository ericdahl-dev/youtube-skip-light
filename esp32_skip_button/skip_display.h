#ifndef SKIP_DISPLAY_H
#define SKIP_DISPLAY_H

// 1.47" LCD + capacitive touch for the Waveshare ESP32-S3-Touch-LCD-1.47.
//
// Compiled only when HAS_TOUCH_DISPLAY is defined, so the screenless boards
// (QT Py, Super Mini) never pull in LovyanGFX. Build with:
//   --build-property compiler.cpp.extra_flags=-DHAS_TOUCH_DISPLAY
//
// Panel and touch pin config come from a known-good, validated-on-glass setup:
// JD9853 panel driven through LovyanGFX's ST7789 driver (compatible command
// set), AXS5106L touch over I2C at 0x63.

#include <stdbool.h>

// Panel + touch init, and paints the boot screen. Call early in setup().
void display_begin(void);

// Repaint for the current state. Cheap to call repeatedly — it only redraws
// when something actually changed.
void display_render(bool skipAvailable, const char *status);

// Full-screen message, for states with no skip involved (connecting, OTA).
void display_message(const char *line1, const char *line2, unsigned long color);

// True once per new finger-down. Returns false while a finger stays down, so
// one tap is one press.
bool display_touched(void);

#endif  // SKIP_DISPLAY_H
