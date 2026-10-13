/*
 * Single-stream synchronous virtual TCP research adapter.
 * NOT YET injected into toxcore's Network_Funcs.
 * No syscalls, hostname parsing or credentials in this WASM API.
 * All buffers are bound to one live socket and always wiped on close.
 * Return -11 for would-block, -2 for wrong state, -1 for invalid args.
 */
#define WTOX_VTCP_LIMIT (64 * 1024)
#define WTOX_VTCP_IDLE 0
#define WTOX_VTCP_CONNECTING 1
#define WTOX_VTCP_OPEN 2
#define WTOX_VTCP_CLOSED 3
#define WTOX_VTCP_FAILED 4

static uint8_t vtcp_rx[WTOX_VTCP_LIMIT], vtcp_tx[WTOX_VTCP_LIMIT];
static size_t vtcp_rx_len = 0, vtcp_tx_len = 0;
static int vtcp_state = WTOX_VTCP_IDLE;

EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_reset(void) {
    sodium_memzero(vtcp_rx, sizeof(vtcp_rx));
    sodium_memzero(vtcp_tx, sizeof(vtcp_tx));
    vtcp_rx_len = 0;
    vtcp_tx_len = 0;
    vtcp_state = WTOX_VTCP_IDLE;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_begin(void) {
    if (vtcp_state != WTOX_VTCP_IDLE && vtcp_state != WTOX_VTCP_CLOSED &&
        vtcp_state != WTOX_VTCP_FAILED) return -2;
    wtox_vtcp_reset();
    vtcp_state = WTOX_VTCP_CONNECTING;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_connected(void) {
    if (vtcp_state != WTOX_VTCP_CONNECTING) return -2;
    vtcp_state = WTOX_VTCP_OPEN;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_fail(void) {
    if (vtcp_state == WTOX_VTCP_IDLE) return -2;
    vtcp_rx_len = 0;
    vtcp_tx_len = 0;
    sodium_memzero(vtcp_rx, sizeof(vtcp_rx));
    sodium_memzero(vtcp_tx, sizeof(vtcp_tx));
    vtcp_state = WTOX_VTCP_FAILED;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_close(void) {
    if (vtcp_state == WTOX_VTCP_IDLE) return 0;
    vtcp_rx_len = 0;
    vtcp_tx_len = 0;
    sodium_memzero(vtcp_rx, sizeof(vtcp_rx));
    sodium_memzero(vtcp_tx, sizeof(vtcp_tx));
    vtcp_state = WTOX_VTCP_CLOSED;
    return 0;
}
/* Clean remote EOF retains RX bytes to drain before returning zero. */
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_peer_closed(void) {
    if (vtcp_state != WTOX_VTCP_OPEN) return -2;
    sodium_memzero(vtcp_tx, sizeof(vtcp_tx));
    vtcp_tx_len = 0;
    vtcp_state = WTOX_VTCP_CLOSED;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_state(void) { return vtcp_state; }

EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_send(const uint8_t *src, size_t length) {
    if (!src || !length || length > WTOX_VTCP_LIMIT) return -1;
    if (vtcp_state == WTOX_VTCP_CONNECTING) return -11;
    if (vtcp_state != WTOX_VTCP_OPEN) return -2;
    const size_t avail = WTOX_VTCP_LIMIT - vtcp_tx_len;
    if (!avail) return -11;
    const size_t copied = length < avail ? length : avail;
    memcpy(vtcp_tx + vtcp_tx_len, src, copied);
    vtcp_tx_len += copied;
    return (int)copied; /* explicit partial write semantics */
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_tx_pending(void) { return (int)vtcp_tx_len; }
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_tx_peek(uint8_t *out, size_t capacity) {
    if (!out || capacity == 0 || capacity > WTOX_VTCP_LIMIT) return -1;
    if (vtcp_state != WTOX_VTCP_OPEN) return -2;
    if (!vtcp_tx_len) return 0;
    const size_t copied = capacity < vtcp_tx_len ? capacity : vtcp_tx_len;
    memcpy(out, vtcp_tx, copied);
    return (int)copied;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_tx_consume(size_t length) {
    if (vtcp_state != WTOX_VTCP_OPEN) return -2;
    if (!length || length > vtcp_tx_len) return -1;
    memmove(vtcp_tx, vtcp_tx + length, vtcp_tx_len - length);
    vtcp_tx_len -= length;
    sodium_memzero(vtcp_tx + vtcp_tx_len, length);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_rx_free(void) {
    return (int)(WTOX_VTCP_LIMIT - vtcp_rx_len);
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_rx_push(const uint8_t *src, size_t length) {
    if (!src || !length || length > WTOX_VTCP_LIMIT) return -1;
    if (vtcp_state != WTOX_VTCP_OPEN) return -2;
    if (length > WTOX_VTCP_LIMIT - vtcp_rx_len) return -11;
    memcpy(vtcp_rx + vtcp_rx_len, src, length);
    vtcp_rx_len += length;
    return (int)length;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vtcp_recv(uint8_t *out, size_t capacity) {
    if (!out || !capacity || capacity > WTOX_VTCP_LIMIT) return -1;
    if (!vtcp_rx_len) {
        if (vtcp_state == WTOX_VTCP_CLOSED) return 0; /* EOF */
        if (vtcp_state == WTOX_VTCP_OPEN || vtcp_state == WTOX_VTCP_CONNECTING) return -11;
        return -2;
    }
    if (vtcp_state != WTOX_VTCP_OPEN && vtcp_state != WTOX_VTCP_CLOSED) return -2;
    const size_t copied = capacity < vtcp_rx_len ? capacity : vtcp_rx_len;
    memcpy(out, vtcp_rx, copied);
    memmove(vtcp_rx, vtcp_rx + copied, vtcp_rx_len - copied);
    vtcp_rx_len -= copied;
    sodium_memzero(vtcp_rx + vtcp_rx_len, copied);
    return (int)copied; /* explicit partial read semantics */
}
