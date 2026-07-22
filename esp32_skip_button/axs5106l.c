#include "axs5106l.h"

int axs5106l_parse(const uint8_t *buf, size_t len, axs_touch_t *out) {
    if (!buf || !out || len < AXS5106L_REPORT_LEN) return -1;

    uint8_t count = buf[1];
    out->count = count;

    uint8_t n = count < AXS5106L_MAX_POINTS ? count : AXS5106L_MAX_POINTS;
    out->points_len = n;

    for (uint8_t i = 0; i < n; i++) {
        size_t b = 2 + (size_t)i * 6;   // [status, x_hi, x_lo, y_hi, y_lo, pressure]
        out->points[i].x = (uint16_t)(((buf[b]     & 0x0F) << 8) | buf[b + 1]);
        out->points[i].y = (uint16_t)(((buf[b + 2] & 0x0F) << 8) | buf[b + 3]);
    }
    return 0;
}
