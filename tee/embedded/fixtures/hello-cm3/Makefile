CC = arm-none-eabi-gcc
CFLAGS = -mcpu=cortex-m3 -mthumb -O2 -Wall -Wextra -ffreestanding -nostdlib

firmware.elf: main.c startup.c semihost.S linker.ld
	$(CC) $(CFLAGS) -T linker.ld -o $@ main.c startup.c semihost.S

clean:
	rm -f firmware.elf
