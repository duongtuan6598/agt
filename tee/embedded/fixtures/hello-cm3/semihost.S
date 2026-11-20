    .syntax unified
    .thumb
    .global semihost
    .thumb_func
semihost:               @ r0 = operation, r1 = argument (AAPCS) -> result in r0
    bkpt 0xAB
    bx lr
