/* Minimal Cortex-M3 firmware used to check the embedded toolchain in the sealed box.
   It computes a checksum, prints it through semihosting and exits with success. */
#include <stdint.h>

int semihost(int op, const void *arg); /* semihost.S: bkpt 0xAB with r0 = op, r1 = arg */

static void print(const char *s) { semihost(0x04, s); }                 /* SYS_WRITE0 */
static void stop(int ok) { semihost(0x18, (const void *)(ok ? 0x20026 : 0x20023)); } /* SYS_EXIT */

static const uint8_t table[] = { 0x41, 0x47, 0x54, 0x01, 0x02, 0x03, 0x04, 0x05 };

static uint16_t fletcher16(const uint8_t *data, unsigned n)
{
    uint16_t a = 0, b = 0;
    for (unsigned i = 0; i < n; i++) {
        a = (uint16_t)((a + data[i]) % 255u);
        b = (uint16_t)((b + a) % 255u);
    }
    return (uint16_t)((b << 8) | a);
}

static void hex16(char *out, uint16_t v)
{
    const char *d = "0123456789abcdef";
    for (int i = 3; i >= 0; i--) { out[i] = d[v & 0xFu]; v >>= 4; }
    out[4] = '\0';
}

int main(void)
{
    char buf[5];
    hex16(buf, fletcher16(table, sizeof table));
    print("AGT firmware OK crc=");
    print(buf);
    print("\n");
    stop(1);
    for (;;) { }
}
