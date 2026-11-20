#include <stdint.h>

extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack;
int main(void);

void Reset_Handler(void)
{
    uint32_t *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata) *dst++ = *src++;
    for (dst = &_sbss; dst < &_ebss; dst++) *dst = 0;
    main();
    for (;;) { }
}

static void Default_Handler(void) { for (;;) { } }

__attribute__((section(".isr_vector"), used))
static const void *const vectors[16] = {
    &_estack, (const void *)Reset_Handler, (const void *)Default_Handler, (const void *)Default_Handler,
};
