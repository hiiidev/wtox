/* Bounded native Tox event queue, consumed synchronously after tox_iterate.
 * All events are LOCAL to WASM; never cross to Cloudflare/Node by design.
 * ABI v1: type:u8 status:u8 friend:u32(BE) publicKey:32B len:u16(BE)
 *         payload:0..1372B
 * Overflow increments a visible counter; no silent overwrite.
 */
#define WTOX_EVT_LIMIT 32
#define WTOX_EVT_PAYLOAD 1372
#define WTOX_EVT_HEADER 40
typedef struct Wtox_Event {
    uint8_t type;
    uint8_t status;
    uint32_t number;
    uint8_t key[TOX_PUBLIC_KEY_SIZE];
    uint16_t len;
    uint8_t payload[WTOX_EVT_PAYLOAD];
} Wtox_Event;
static Wtox_Event wtox_events[WTOX_EVT_LIMIT];
static unsigned wtox_event_head, wtox_event_count;
static uint32_t wtox_event_dropped;

static void wtox_events_reset(void) {
    sodium_memzero(wtox_events, sizeof(wtox_events));
    wtox_event_head = 0;
    wtox_event_count = 0;
    wtox_event_dropped = 0;
}
static void wtox_add_event(uint8_t type, uint8_t status, uint32_t number,
                           const uint8_t *key, const uint8_t *payload, size_t len) {
    if (len > WTOX_EVT_PAYLOAD || (len > 0 && !payload) ||
        wtox_event_count >= WTOX_EVT_LIMIT) {
        if (wtox_event_dropped < UINT32_MAX) ++wtox_event_dropped;
        return;
    }
    unsigned tail = (wtox_event_head + wtox_event_count) % WTOX_EVT_LIMIT;
    Wtox_Event *evt = &wtox_events[tail];
    sodium_memzero(evt, sizeof(*evt));
    evt->type = type;
    evt->status = status;
    evt->number = number;
    evt->len = (uint16_t)len;
    if (key) memcpy(evt->key, key, TOX_PUBLIC_KEY_SIZE);
    if (len) memcpy(evt->payload, payload, len);
    ++wtox_event_count;
}
static void wtox_on_request(Tox *tox, const Tox_Public_Key key,
                            const uint8_t msg[], size_t len, void *data) {
    (void)tox; (void)data;
    wtox_add_event(1, 0, 0, key, msg, len);
}
static void wtox_on_message(Tox *tox, Tox_Friend_Number friend_no,
                            Tox_Message_Type type, const uint8_t msg[],
                            size_t len, void *data) {
    (void)tox; (void)data;
    if (type != TOX_MESSAGE_TYPE_NORMAL && type != TOX_MESSAGE_TYPE_ACTION) return;
    wtox_add_event(type == TOX_MESSAGE_TYPE_NORMAL ? 2 : 3,
                   0, friend_no, NULL, msg, len);
}
static void wtox_on_friend_status(Tox *tox, Tox_Friend_Number friend_no,
                                  Tox_Connection status, void *data) {
    (void)tox; (void)data;
    wtox_add_event(4, (uint8_t)status, friend_no, NULL, NULL, 0);
}
static void wtox_on_self_status(Tox *tox, Tox_Connection status, void *data) {
    (void)tox; (void)data;
    wtox_add_event(5, (uint8_t)status, 0, NULL, NULL, 0);
}
static void wtox_attach_event_callbacks(Tox *tox) {
    tox_callback_friend_request(tox, wtox_on_request);
    tox_callback_friend_message(tox, wtox_on_message);
    tox_callback_friend_connection_status(tox, wtox_on_friend_status);
    tox_callback_self_connection_status(tox, wtox_on_self_status);
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_event_next(uint8_t *out, size_t capacity) {
    if (!wtox_live) return -1;
    if (wtox_event_count == 0) return 0;
    if (!out) return -2;
    Wtox_Event *evt = &wtox_events[wtox_event_head];
    const size_t len = WTOX_EVT_HEADER + evt->len;
    if (capacity < len) return -2;
    out[0] = evt->type;
    out[1] = evt->status;
    out[2] = (uint8_t)(evt->number >> 24);
    out[3] = (uint8_t)(evt->number >> 16);
    out[4] = (uint8_t)(evt->number >> 8);
    out[5] = (uint8_t)(evt->number);
    memcpy(out + 6, evt->key, TOX_PUBLIC_KEY_SIZE);
    out[38] = (uint8_t)(evt->len >> 8);
    out[39] = (uint8_t)(evt->len);
    if (evt->len) memcpy(out + WTOX_EVT_HEADER, evt->payload, evt->len);
    sodium_memzero(evt, sizeof(*evt));
    wtox_event_head = (wtox_event_head + 1) % WTOX_EVT_LIMIT;
    --wtox_event_count;
    return (int)len;
}
EMSCRIPTEN_KEEPALIVE
uint32_t wtox_session_events_dropped(void) {
    if (!wtox_live) return 0;
    uint32_t count = wtox_event_dropped;
    wtox_event_dropped = 0;
    return count;
}
