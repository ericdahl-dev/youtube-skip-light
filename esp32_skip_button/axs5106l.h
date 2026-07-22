#ifndef AXS5106L_H
#define AXS5106L_H

// Pure parse for the AXS5106L capacitive touch controller (Waveshare
// ESP32-S3-Touch-LCD-1.47, I2C addr 0x63). Host-testable: no I2C/Wire here —
// the caller reads AXS5106L_REPORT_LEN bytes from register 0x01 and hands the
// buffer to axs5106l_parse(). Report layout (from the ChipSourceTek part /
// reference drivers): data[1] = finger count; each point is 6 bytes at
// 2 + i*6 as [status, x_hi, x_lo, y_hi, y_lo, pressure], X/Y are 12-bit with
// the coordinate high nibble in the low 4 bits of x_hi/y_hi (status flags in
// the high nibble, masked off).

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AXS5106L_I2C_ADDR   0x63
#define AXS5106L_TOUCH_REG  0x01
#define AXS5106L_ID_REG     0x08
#define AXS5106L_REPORT_LEN 14
#define AXS5106L_MAX_POINTS 2

typedef struct { uint16_t x, y; } axs_point_t;

typedef struct {
    uint8_t     count;                       // fingers the controller reports (data[1])
    uint8_t     points_len;                  // points actually decoded (<= AXS5106L_MAX_POINTS)
    axs_point_t points[AXS5106L_MAX_POINTS];
} axs_touch_t;

// Parse a 14-byte AXS5106L touch report (register 0x01 read) into *out.
// Returns 0 on success; -1 if buf==NULL, out==NULL, or len < AXS5106L_REPORT_LEN.
int axs5106l_parse(const uint8_t *buf, size_t len, axs_touch_t *out);

#ifdef __cplusplus
}
#endif

#endif // AXS5106L_H
