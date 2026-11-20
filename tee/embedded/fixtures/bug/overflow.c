/* Seeded defect for the static-analysis check: writes past the end of a buffer. */
void fill(void)
{
    char buf[8];
    for (int i = 0; i <= 8; i++) buf[i] = 0;
    (void)buf;
}
