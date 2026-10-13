/*
 * Persistent, TEST-ONLY original Tox TCP client, driven by browser ticks.
 * The only permitted destination in the injected callbacks is an in-memory
 * synthetic TEST-NET-2 relay at 198.51.100.7:33445. No actual OS egress.
 * Do not enable this through the production identity worker or API.
 */
static Tox *wtox_research_tox = NULL;
static Wtox_Probe wtox_research_counters = {0};
static Network wtox_research_network = {0};
static Tox_System wtox_research_system = {0};
static uint8_t wtox_research_relay_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
static bool wtox_research_replied = false;
static bool wtox_research_external_relay = false;
static int wtox_research_route_id = -1;

/* Isolated test-only routed-data inbox. The normal Net_Crypto handler is
 * replaced ONLY after this research route is active; the instance is killed
 * after one test exchange and is never used for actual friend messages. */
#define WTOX_RESEARCH_ROUTE_MAX 128
static uint8_t wtox_research_route_rx[WTOX_RESEARCH_ROUTE_MAX] = {0};
static uint16_t wtox_research_route_rx_len = 0;
static bool wtox_research_capture_enabled = false;
/* Research-only native Net_Crypto; never override TCP_Connections callback. */
static int wtox_research_crypto_id = -1;
static bool wtox_research_crypto_online = false;
static uint32_t wtox_research_crypto_connects = 0;
static uint32_t wtox_research_crypto_disconnects = 0;
static uint8_t wtox_research_crypto_rx[WTOX_RESEARCH_ROUTE_MAX] = {0};
static uint16_t wtox_research_crypto_rx_len = 0;

/* A separate, real Messenger friend path. Never take over original callbacks.
 * Exists only in this ephemeral, single-peer, localhost research instance. */
static int wtox_research_friendcon_id = -1;
static bool wtox_research_friend_route_attached = false;
static bool wtox_research_friend_online = false;
static uint32_t wtox_research_friend_online_events = 0;
static uint32_t wtox_research_friend_offline_events = 0;
static uint32_t wtox_research_friend_messages = 0;
static uint32_t wtox_research_friend_dropped = 0;
static uint8_t wtox_research_friend_inbox[WTOX_RESEARCH_ROUTE_MAX] = {0};
static uint16_t wtox_research_friend_inbox_len = 0;

/* Genuine Tox friend requests are accepted ONLY by original Onion_Client.
 * A TCP Relay connection alone cannot deliver a request or discover a peer.
 * This bounded inbox records original tox_callback_friend_request events;
 * it is NEVER populated by test-side peer-key injection or fake packets. */
static uint8_t wtox_research_request_sender[TOX_PUBLIC_KEY_SIZE] = {0};
static uint8_t wtox_research_request_message[WTOX_RESEARCH_ROUTE_MAX] = {0};
static uint16_t wtox_research_request_length = 0;
static uint32_t wtox_research_request_received = 0;
static uint32_t wtox_research_request_dropped = 0;
static bool wtox_research_request_pending = false;
static void wtox_research_on_friend_request(Tox *tox,
                                             const uint8_t *public_key,
                                             const uint8_t *message,
                                             size_t length, void *userdata) {
    (void)userdata;
    if (tox != wtox_research_tox || !public_key || !message ||
        length == 0 || length > WTOX_RESEARCH_ROUTE_MAX ||
        wtox_research_request_length != 0) {
        ++wtox_research_request_dropped;
        return;
    }
    memcpy(wtox_research_request_sender, public_key, TOX_PUBLIC_KEY_SIZE);
    memcpy(wtox_research_request_message, message, length);
    wtox_research_request_length = (uint16_t)length;
    ++wtox_research_request_received;
}

static void wtox_research_on_friend_status(Tox *tox, Tox_Friend_Number number,
                                           Tox_Connection status, void *unused) {
    (void)unused;
    if (tox != wtox_research_tox || wtox_research_friendcon_id < 0 ||
        number != 0) return;
    wtox_research_friend_online = status != TOX_CONNECTION_NONE;
    if (wtox_research_friend_online) ++wtox_research_friend_online_events;
    else ++wtox_research_friend_offline_events;
}
static void wtox_research_on_friend_message(Tox *tox, Tox_Friend_Number number,
                                            Tox_Message_Type type,
                                            const uint8_t *message, size_t len,
                                            void *unused) {
    (void)unused;
    if (tox != wtox_research_tox || number != 0 ||
        wtox_research_friendcon_id < 0 || type != TOX_MESSAGE_TYPE_NORMAL ||
        !message || len == 0 || len > WTOX_RESEARCH_ROUTE_MAX ||
        wtox_research_friend_inbox_len != 0) {
        ++wtox_research_friend_dropped;
        return;
    }
    memcpy(wtox_research_friend_inbox, message, len);
    wtox_research_friend_inbox_len = (uint16_t)len;
    ++wtox_research_friend_messages;
}

static int wtox_research_crypto_status(void *obj, int id, bool online, void *userdata) {
    (void)userdata;
    if (obj != &wtox_research_counters || id != 0) return -1;
    wtox_research_crypto_online = online;
    if (online) ++wtox_research_crypto_connects;
    else ++wtox_research_crypto_disconnects;
    return 0;
}
static int wtox_research_crypto_data(void *obj, int id, const uint8_t *packet,
                                      uint16_t length, void *userdata) {
    (void)userdata;
    if (obj != &wtox_research_counters || id != 0 || !packet ||
        length < 2 || length > WTOX_RESEARCH_ROUTE_MAX ||
        packet[0] != PACKET_ID_RANGE_LOSSLESS_CUSTOM_START ||
        wtox_research_crypto_rx_len != 0) return -1;
    memcpy(wtox_research_crypto_rx, packet + 1, length - 1);
    wtox_research_crypto_rx_len = length - 1;
    return 0;
}

static int wtox_research_route_capture(void *object, int crypt_connection_id,
                                       const uint8_t *packet, uint16_t length,
                                       void *userdata) {
    (void)userdata;
    if (object != &wtox_research_counters || crypt_connection_id != 0 ||
        !wtox_research_capture_enabled || !packet || length == 0 ||
        length > WTOX_RESEARCH_ROUTE_MAX || wtox_research_route_rx_len != 0)
        return -1;
    memcpy(wtox_research_route_rx, packet, length);
    wtox_research_route_rx_len = length;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void wtox_research_stop(void) {
    if (wtox_research_tox) {
        Tox *old = wtox_research_tox;
        wtox_research_tox = NULL;
        tox_kill(old);
    }
    sodium_memzero(wtox_research_relay_secret, sizeof(wtox_research_relay_secret));
    sodium_memzero(&wtox_research_counters, sizeof(wtox_research_counters));
    wtox_research_network.funcs = NULL;
    wtox_research_network.obj = NULL;
    wtox_research_replied = false;
    wtox_research_external_relay = false;
    wtox_research_route_id = -1;
    wtox_research_capture_enabled = false;
    wtox_research_route_rx_len = 0;
    sodium_memzero(wtox_research_route_rx, sizeof(wtox_research_route_rx));
    wtox_research_crypto_id = -1;
    wtox_research_crypto_online = false;
    wtox_research_crypto_connects = 0;
    wtox_research_crypto_disconnects = 0;
    wtox_research_crypto_rx_len = 0;
    sodium_memzero(wtox_research_crypto_rx, sizeof(wtox_research_crypto_rx));
    wtox_research_friendcon_id = -1;
    wtox_research_friend_route_attached = false;
    wtox_research_friend_online = false;
    wtox_research_friend_online_events = 0;
    wtox_research_friend_offline_events = 0;
    wtox_research_friend_messages = 0;
    wtox_research_friend_dropped = 0;
    wtox_research_friend_inbox_len = 0;
    sodium_memzero(wtox_research_friend_inbox, sizeof(wtox_research_friend_inbox));
    sodium_memzero(wtox_research_request_sender, sizeof(wtox_research_request_sender));
    sodium_memzero(wtox_research_request_message, sizeof(wtox_research_request_message));
    wtox_research_request_length = 0;
    wtox_research_request_received = 0;
    wtox_research_request_dropped = 0;
    wtox_research_request_pending = false;
    wtox_vtcp_close();
}

EMSCRIPTEN_KEEPALIVE
static int wtox_research_start_internal(const uint8_t *external_key,
                                         const uint8_t *saved, size_t saved_len) {
    if (wtox_live || wtox_research_tox || sodium_init() < 0) return -1;
    wtox_research_stop();
    wtox_research_network.funcs = &wtox_probe_funcs;
    wtox_research_network.obj = &wtox_research_counters;
    wtox_research_system = tox_default_system();
    wtox_research_system.ns = &wtox_research_network;
    Tox_Options_Testing testing = { .operating_system = &wtox_research_system };
    Tox_Err_Options_New opts_err = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts = tox_options_new(&opts_err);
    if (!opts || opts_err != TOX_ERR_OPTIONS_NEW_OK) {
        if (opts) tox_options_free(opts);
        wtox_research_stop();
        return -2;
    }
    tox_options_set_udp_enabled(opts, false);
    tox_options_set_local_discovery_enabled(opts, false);
    tox_options_set_ipv6_enabled(opts, false);
    tox_options_set_experimental_disable_dns(opts, true);
    if (saved != NULL) {
        if (saved_len == 0 || saved_len > MAX_RAW_SAVEDATA ||
            !tox_options_set_savedata_data(opts, saved, saved_len)) {
            tox_options_free(opts);
            wtox_research_stop();
            return -5;
        }
        tox_options_set_savedata_type(opts, TOX_SAVEDATA_TYPE_TOX_SAVE);
    }
    Tox_Err_New new_err = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing testing_err = TOX_ERR_NEW_TESTING_OK;
    wtox_research_tox = tox_new_testing(opts, &new_err, &testing, &testing_err);
    tox_options_free(opts);
    if (!wtox_research_tox || new_err != TOX_ERR_NEW_OK ||
        testing_err != TOX_ERR_NEW_TESTING_OK) {
        wtox_research_stop();
        return -3;
    }
    tox_callback_friend_request(wtox_research_tox,
                                wtox_research_on_friend_request);
    uint8_t public_key[CRYPTO_PUBLIC_KEY_SIZE] = {0};
    if (external_key) {
        /* Real fixture's private key is Node-owned and is never imported. */
        memcpy(public_key, external_key, CRYPTO_PUBLIC_KEY_SIZE);
        wtox_research_external_relay = true;
    } else {
        randombytes_buf(wtox_research_relay_secret, sizeof(wtox_research_relay_secret));
        crypto_derive_public_key(public_key, wtox_research_relay_secret);
    }
    Tox_Err_Bootstrap error = TOX_ERR_BOOTSTRAP_OK;
    const bool added = tox_add_tcp_relay(
        wtox_research_tox, "198.51.100.7", 33445, public_key, &error);
    sodium_memzero(public_key, sizeof(public_key));
    if (!added || error != TOX_ERR_BOOTSTRAP_OK ||
        wtox_research_counters.sockets != 1 ||
        wtox_research_counters.connects != 1 ||
        wtox_vtcp_state() != WTOX_VTCP_CONNECTING) {
        wtox_research_stop();
        return -4;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_start(void) {
    return wtox_research_start_internal(NULL, NULL, 0);
}
/* Strict public-key-only interface. Key bytes never include private material. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_start_with_relay_public_key(const uint8_t *key, size_t len) {
    if (!key || len != CRYPTO_PUBLIC_KEY_SIZE) return -1;
    return wtox_research_start_internal(key, NULL, 0);
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_tick(void) {
    if (!wtox_research_tox) return -1;
    tox_iterate(wtox_research_tox, NULL);
    if (wtox_research_friendcon_id >= 0 && !wtox_research_friend_route_attached &&
        !wtox_research_request_pending) {
        Friend_Connections *fr_c = wtox_research_tox->m->fr_c;
        const int crypto_id = friend_connection_crypt_connection_id(
            fr_c, wtox_research_friendcon_id);
        if (crypto_id >= 0) {
            /* One friend and one Relay only; the first native Net_Crypto
             * connection owns TCP_Connections slot zero. */
            if (crypto_id != 0 ||
                add_tcp_number_relay_connection(
                    nc_get_tcp_c(wtox_research_tox->m->net_crypto),
                    0, 0) != 0) return -2;
            wtox_research_friend_route_attached = true;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_stats(uint32_t out[9]) {
    if (!wtox_research_tox || !out) return -1;
    out[0] = wtox_research_counters.sockets;
    out[1] = wtox_research_counters.connects;
    out[2] = wtox_research_counters.sends;
    out[3] = wtox_research_counters.recvs;
    out[4] = wtox_research_counters.closes;
    out[5] = (uint32_t)wtox_vtcp_tx_pending();
    out[6] = (uint32_t)(WTOX_VTCP_LIMIT - wtox_vtcp_rx_free());
    out[7] = (uint32_t)wtox_vtcp_state();
    out[8] = (uint32_t)tox_self_get_connection_status(wtox_research_tox);
    return 0;
}

/* A local, authenticated reply can be generated only ONCE and only from
 * an actual original client hello. The secret never leaves native WASM.
 * JS may send this synthetic response through a loopback test transport.
 */
EMSCRIPTEN_KEEPALIVE
int wtox_research_make_reply(uint32_t mode, uint8_t reply[TCP_SERVER_HANDSHAKE_SIZE],
                             size_t capacity) {
    if (!wtox_research_tox || wtox_research_replied ||
        wtox_research_external_relay || mode > 2 || !reply ||
        capacity < TCP_SERVER_HANDSHAKE_SIZE ||
        wtox_vtcp_state() != WTOX_VTCP_OPEN ||
        wtox_vtcp_tx_pending() < TCP_CLIENT_HANDSHAKE_SIZE) return -1;
    uint8_t hello[TCP_CLIENT_HANDSHAKE_SIZE] = {0};
    uint8_t remote_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
    uint8_t temporary_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
    uint8_t shared[CRYPTO_SHARED_KEY_SIZE] = {0};
    uint8_t plain[TCP_HANDSHAKE_PLAIN_SIZE] = {0};
    int code = -2;
    if (wtox_vtcp_tx_peek(hello, sizeof(hello)) != sizeof(hello)) goto cleanup;
    if (mode == 1) randombytes_buf(remote_secret, sizeof(remote_secret));
    else memcpy(remote_secret, wtox_research_relay_secret, sizeof(remote_secret));
    if (encrypt_precompute(hello, remote_secret, shared) != 0) goto cleanup;
    randombytes_buf(temporary_secret, sizeof(temporary_secret));
    crypto_derive_public_key(plain, temporary_secret);
    randombytes_buf(plain + CRYPTO_PUBLIC_KEY_SIZE, CRYPTO_NONCE_SIZE);
    randombytes_buf(reply, CRYPTO_NONCE_SIZE);
    if (encrypt_data_symmetric(wtox_research_system.mem, shared, reply,
            plain, sizeof(plain), reply + CRYPTO_NONCE_SIZE)
        != TCP_SERVER_HANDSHAKE_SIZE - CRYPTO_NONCE_SIZE) goto cleanup;
    if (mode == 2) reply[TCP_SERVER_HANDSHAKE_SIZE - 1] ^= 1;
    wtox_research_replied = true;
    code = TCP_SERVER_HANDSHAKE_SIZE;
cleanup:
    sodium_memzero(hello, sizeof(hello));
    sodium_memzero(remote_secret, sizeof(remote_secret));
    sodium_memzero(temporary_secret, sizeof(temporary_secret));
    sodium_memzero(shared, sizeof(shared));
    sodium_memzero(plain, sizeof(plain));
    if (code < 0) sodium_memzero(reply, capacity);
    return code;
}


/* Research ONLY: ask original c-toxcore TCP_Connections to issue its OWN
 * encrypted ROUTING_REQUEST for one synthetic peer public key. The Relay
 * must already be connected and authenticated. Never report the real
 * Tox friend connection as online on this basis. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_add_route(const uint8_t *peer_key, size_t len) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        !peer_key || len != CRYPTO_PUBLIC_KEY_SIZE ||
        wtox_research_route_id != -1 || wtox_vtcp_state() != WTOX_VTCP_OPEN)
        return -1;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    if (!tcp_c || tcp_connected_relays_count(tcp_c) != 1) return -2;
    const int connection = new_tcp_connection_to(tcp_c, peer_key, 0);
    if (connection < 0) return -3;
    wtox_research_route_id = connection;
    if (add_tcp_number_relay_connection(tcp_c, connection, 0) != 0) {
        wtox_research_route_id = -1;
        kill_tcp_connection_to(tcp_c, connection);
        return -4;
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_research_route_online_count(void) {
    if (!wtox_research_tox || wtox_research_route_id < 0) return -1;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    if (!tcp_c) return -1;
    return (int)tcp_connection_to_online_tcp_relays(tcp_c, wtox_research_route_id);
}

/* Research-only: after a synthetic route notification, redirect the
 * TCP_Connections data callback to this bounded fixture inbox. Net_Crypto
 * normally owns this callback, so this is deliberately NOT a client API. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_enable_route_capture(void) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        wtox_research_route_id < 0 || wtox_research_capture_enabled ||
        wtox_research_route_online_count() != 1 ||
        wtox_vtcp_state() != WTOX_VTCP_OPEN) return -1;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    if (!tcp_c) return -2;
    set_packet_tcp_connection_callback(tcp_c, wtox_research_route_capture,
                                       &wtox_research_counters);
    wtox_research_capture_enabled = true;
    return 0;
}

/* This is original TCP_Connections framing, NOT tox_friend_send_message.
 * The Relay decrypts this transport payload; it is not end-to-end secret. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_send_route_packet(const uint8_t *payload, size_t length) {
    if (!wtox_research_tox || !wtox_research_capture_enabled ||
        wtox_research_route_id < 0 || !payload ||
        length == 0 || length > WTOX_RESEARCH_ROUTE_MAX ||
        wtox_research_route_online_count() != 1 ||
        wtox_vtcp_state() != WTOX_VTCP_OPEN) return -1;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    if (!tcp_c) return -2;
    return send_packet_tcp_connection(tcp_c, wtox_research_route_id,
                                      payload, (uint16_t)length);
}

/* 0: no data yet; >0: received length; negative: invalid call.
 * Both previous and unused inbox bytes are scrubbed after copying. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_take_route_packet(uint8_t *out, size_t capacity) {
    if (!wtox_research_tox || !wtox_research_capture_enabled || !out ||
        capacity < WTOX_RESEARCH_ROUTE_MAX) return -1;
    if (!wtox_research_route_rx_len) return 0;
    const int copied = wtox_research_route_rx_len;
    memcpy(out, wtox_research_route_rx, wtox_research_route_rx_len);
    sodium_memzero(wtox_research_route_rx, sizeof(wtox_research_route_rx));
    wtox_research_route_rx_len = 0;
    return copied;
}

/* Test-only public DHT key used by independently running Chromium clients
 * when registering reciprocal routes. No secret key is exported. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_get_dht_public(uint8_t out[CRYPTO_PUBLIC_KEY_SIZE]) {
    if (!wtox_research_tox || !wtox_research_external_relay || !out) return -1;
    tox_self_get_dht_id(wtox_research_tox, out);
    return 0;
}

/* Native TCP connection status, not Tox friend connection status. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_connected_relays(void) {
    if (!wtox_research_tox || !wtox_research_external_relay) return -1;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    if (!tcp_c) return -1;
    return (int)tcp_connected_relays_count(tcp_c);
}

/* Public Net_Crypto real key is separate from the DHT routing key. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_get_crypto_public(uint8_t *out, size_t len) {
    if (!wtox_research_tox || !wtox_research_external_relay || !out ||
        len != CRYPTO_PUBLIC_KEY_SIZE) return -1;
    memcpy(out, nc_get_self_public_key(wtox_research_tox->m->net_crypto), len);
    return 0;
}

/* Native cookie request, crypto handshake, original network handler. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_begin_crypto(const uint8_t *real_pk, const uint8_t *dht_pk,
                                size_t len) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        !real_pk || !dht_pk || len != CRYPTO_PUBLIC_KEY_SIZE ||
        wtox_research_route_id != -1 || wtox_research_crypto_id != -1 ||
        wtox_research_capture_enabled || wtox_vtcp_state() != WTOX_VTCP_OPEN)
        return -1;
    Net_Crypto *c = wtox_research_tox->m->net_crypto;
    TCP_Connections *tcp_c = nc_get_tcp_c(c);
    if (!tcp_c || tcp_connected_relays_count(tcp_c) != 1) return -2;
    const int id = new_crypto_connection(c, real_pk, dht_pk);
    if (id != 0) return -3; /* exactly one isolated research connection */
    wtox_research_crypto_id = id;
    if (connection_status_handler(c, id, wtox_research_crypto_status,
                                  &wtox_research_counters, 0) != 0 ||
        connection_data_handler(c, id, wtox_research_crypto_data,
                                &wtox_research_counters, 0) != 0 ||
        add_tcp_number_relay_connection(tcp_c, 0, 0) != 0) return -4;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_research_crypto_status_get(uint32_t out[4]) {
    if (!wtox_research_tox || wtox_research_crypto_id < 0 || !out) return -1;
    out[0] = wtox_research_crypto_online ? 1 : 0;
    out[1] = wtox_research_crypto_connects;
    out[2] = wtox_research_crypto_disconnects;
    TCP_Connections *tcp_c = nc_get_tcp_c(wtox_research_tox->m->net_crypto);
    out[3] = tcp_connection_to_online_tcp_relays(tcp_c, 0);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_research_crypto_send(const uint8_t *payload, size_t length) {
    if (!wtox_research_tox || wtox_research_crypto_id != 0 ||
        !wtox_research_crypto_online || !payload || length == 0 ||
        length >= WTOX_RESEARCH_ROUTE_MAX) return -1;
    uint8_t packet[WTOX_RESEARCH_ROUTE_MAX] = {0};
    packet[0] = PACKET_ID_RANGE_LOSSLESS_CUSTOM_START;
    memcpy(packet + 1, payload, length);
    const int64_t id = write_cryptpacket(wtox_research_tox->m->net_crypto,
                          wtox_research_crypto_id, packet,
                          (uint16_t)(length + 1), false);
    sodium_memzero(packet, sizeof(packet));
    return id >= 0 ? 0 : -2;
}
EMSCRIPTEN_KEEPALIVE
int wtox_research_crypto_recv(uint8_t *out, size_t capacity) {
    if (!wtox_research_tox || wtox_research_crypto_id != 0 || !out ||
        capacity < WTOX_RESEARCH_ROUTE_MAX) return -1;
    if (!wtox_research_crypto_rx_len) return 0;
    const int n = wtox_research_crypto_rx_len;
    memcpy(out, wtox_research_crypto_rx, n);
    sodium_memzero(wtox_research_crypto_rx, sizeof(wtox_research_crypto_rx));
    wtox_research_crypto_rx_len = 0;
    return n;
}

/* Real native Messenger friend path for two isolated Chromium clients.
 * Only their PUBLIC Tox and DHT keys cross the test orchestrator. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_add_native_friend(const uint8_t *real_pk,
                                     const uint8_t *dht_pk, size_t len) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        wtox_research_friendcon_id >= 0 || wtox_research_crypto_id >= 0 ||
        wtox_research_route_id >= 0 || wtox_research_capture_enabled ||
        !real_pk || !dht_pk || len != CRYPTO_PUBLIC_KEY_SIZE ||
        wtox_vtcp_state() != WTOX_VTCP_OPEN) return -1;
    uint8_t self_pk[TOX_PUBLIC_KEY_SIZE] = {0};
    tox_self_get_public_key(wtox_research_tox, self_pk);
    const bool invalid = memcmp(self_pk, real_pk, sizeof(self_pk)) == 0;
    sodium_memzero(self_pk, sizeof(self_pk));
    if (invalid) return -2;
    Tox_Err_Friend_Add error = TOX_ERR_FRIEND_ADD_OK;
    const Tox_Friend_Number number =
        tox_friend_add_norequest(wtox_research_tox, real_pk, &error);
    if (error != TOX_ERR_FRIEND_ADD_OK || number != 0) return -3;
    const int friendcon_id =
        getfriend_conn_id_pk(wtox_research_tox->m->fr_c, real_pk);
    if (friendcon_id != 0) return -4;
    wtox_research_friendcon_id = friendcon_id;
    tox_callback_friend_connection_status(wtox_research_tox,
                                           wtox_research_on_friend_status);
    tox_callback_friend_message(wtox_research_tox,
                                 wtox_research_on_friend_message);
    /* This is only local test peer discovery: production clients must
     * obtain DHT keys from their normal onion/DHT transport. */
    set_dht_temp_pk(wtox_research_tox->m->fr_c, friendcon_id, dht_pk, NULL);
    return 0;
}

/* The status here is ORIGINAL tox_friend_get_connection_status, not
 * a synthetic Relay route count or low-level crypto-online flag. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_native_friend_stats(uint32_t out[6]) {
    if (!wtox_research_tox || wtox_research_friendcon_id < 0 || !out)
        return -1;
    Tox_Err_Friend_Query error = TOX_ERR_FRIEND_QUERY_OK;
    const Tox_Connection status =
        tox_friend_get_connection_status(wtox_research_tox, 0, &error);
    if (error != TOX_ERR_FRIEND_QUERY_OK) return -2;
    out[0] = (uint32_t)status;
    out[1] = wtox_research_friend_online_events;
    out[2] = wtox_research_friend_offline_events;
    out[3] = wtox_research_friend_messages;
    out[4] = wtox_research_friend_dropped;
    out[5] = wtox_research_friend_route_attached ? 1 : 0;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_native_send_text(const uint8_t *message, size_t len,
                                    uint32_t *id_out) {
    if (!wtox_research_tox || wtox_research_friendcon_id < 0 ||
        !wtox_research_friend_route_attached ||
        !wtox_research_friend_online || !message || !id_out ||
        len == 0 || len > WTOX_RESEARCH_ROUTE_MAX) return -1;
    Tox_Err_Friend_Send_Message error = TOX_ERR_FRIEND_SEND_MESSAGE_OK;
    Tox_Friend_Message_Id id = tox_friend_send_message(
        wtox_research_tox, 0, TOX_MESSAGE_TYPE_NORMAL, message, len, &error);
    if (error != TOX_ERR_FRIEND_SEND_MESSAGE_OK) return -(int)error - 10;
    *id_out = id;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_native_take_message(uint8_t *out, size_t capacity) {
    if (!wtox_research_tox || wtox_research_friendcon_id < 0 ||
        !out || capacity < WTOX_RESEARCH_ROUTE_MAX) return -1;
    if (!wtox_research_friend_inbox_len) return 0;
    const int len = wtox_research_friend_inbox_len;
    memcpy(out, wtox_research_friend_inbox, len);
    sodium_memzero(wtox_research_friend_inbox,
                   sizeof(wtox_research_friend_inbox));
    wtox_research_friend_inbox_len = 0;
    return len;
}

/* Encrypted standard ToxEncryptSave research backup. Never return raw
 * original c-toxcore savedata or long-term secret keys to JavaScript. */
EMSCRIPTEN_KEEPALIVE
size_t wtox_research_savedata_encrypted_size(void) {
    if (!wtox_research_tox || !wtox_research_external_relay) return 0;
    const size_t raw = tox_get_savedata_size(wtox_research_tox);
    return raw > 0 && raw <= MAX_RAW_SAVEDATA
      ? raw + TOX_PASS_ENCRYPTION_EXTRA_LENGTH : 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_research_export_encrypted(const uint8_t *password, size_t password_len,
                                   uint8_t *out, size_t capacity,
                                   size_t *written) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        !valid_password(password, password_len) || !out || !written)
        return -1;
    *written = 0;
    const size_t total = wtox_research_savedata_encrypted_size();
    if (!total || capacity < total) return -2;
    const size_t raw_len = total - TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *raw = (uint8_t *)malloc(raw_len);
    if (!raw) return -3;
    tox_get_savedata(wtox_research_tox, raw);
    Tox_Err_Encryption error = TOX_ERR_ENCRYPTION_OK;
    const bool ok = tox_pass_encrypt(raw, raw_len, password, password_len,
                                      out, &error);
    sodium_memzero(raw, raw_len);
    free(raw);
    if (!ok || error != TOX_ERR_ENCRYPTION_OK) {
        sodium_memzero(out, capacity);
        return -4;
    }
    *written = total;
    return 0;
}

/* Restore a new original tox_new_testing from authenticated standard
 * encrypted .tox, injecting ONLY our synthetic test Network_Funcs.
 * A wrong password/corrupted backup must not create a live Tox instance. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_start_with_relay_encrypted(
    const uint8_t *relay_key, size_t relay_key_len,
    const uint8_t *backup, size_t backup_len,
    const uint8_t *password, size_t password_len) {
    if (wtox_research_tox || wtox_live || !relay_key ||
        relay_key_len != CRYPTO_PUBLIC_KEY_SIZE || !backup ||
        !valid_password(password, password_len) ||
        backup_len <= TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        backup_len > MAX_RAW_SAVEDATA + TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        sodium_init() < 0) return -1;
    if (!tox_is_data_encrypted(backup)) return -2;
    const size_t raw_len = backup_len - TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *raw = (uint8_t *)malloc(raw_len);
    if (!raw) return -3;
    Tox_Err_Decryption err = TOX_ERR_DECRYPTION_OK;
    const bool ok = tox_pass_decrypt(backup, backup_len, password,
                                     password_len, raw, &err);
    int ret = -4;
    if (ok && err == TOX_ERR_DECRYPTION_OK)
        ret = wtox_research_start_internal(relay_key, raw, raw_len);
    sodium_memzero(raw, raw_len);
    free(raw);
    return ret;
}

/* Reconnect the already-persisted friend WITHOUT another add_norequest:
 * assert one real friend with the exact saved peer identity public key. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_resume_saved_friend(const uint8_t *real_pk,
                                      const uint8_t *dht_pk, size_t len) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        wtox_research_friendcon_id >= 0 || wtox_research_crypto_id >= 0 ||
        wtox_research_route_id >= 0 || !real_pk || !dht_pk ||
        len != CRYPTO_PUBLIC_KEY_SIZE || wtox_vtcp_state() != WTOX_VTCP_OPEN)
        return -1;
    if (tox_self_get_friend_list_size(wtox_research_tox) != 1) return -2;
    uint32_t friend_no = UINT32_MAX;
    tox_self_get_friend_list(wtox_research_tox, &friend_no);
    if (friend_no != 0) return -3;
    uint8_t restored_pk[TOX_PUBLIC_KEY_SIZE] = {0};
    Tox_Err_Friend_Get_Public_Key err = TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK;
    const bool good = tox_friend_get_public_key(wtox_research_tox, 0,
                                                restored_pk, &err);
    const bool match = good && err == TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK &&
                       sodium_memcmp(restored_pk, real_pk, len) == 0;
    sodium_memzero(restored_pk, sizeof(restored_pk));
    if (!match) return -4;
    const int friendcon_id =
        getfriend_conn_id_pk(wtox_research_tox->m->fr_c, real_pk);
    if (friendcon_id != 0) return -5;
    wtox_research_friendcon_id = friendcon_id;
    tox_callback_friend_connection_status(wtox_research_tox,
                                           wtox_research_on_friend_status);
    tox_callback_friend_message(wtox_research_tox,
                                 wtox_research_on_friend_message);
    set_dht_temp_pk(wtox_research_tox->m->fr_c, friendcon_id, dht_pk, NULL);
    return 0;
}

/* Stage-25 request gate: genuine original public Tox ID (38 bytes, with
 * nospam and checksum). This API does not expose the secret identity key. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_get_tox_address(uint8_t *out, size_t capacity) {
    if (!wtox_research_tox || !out || capacity != TOX_ADDRESS_SIZE) return -1;
    tox_self_get_address(wtox_research_tox, out);
    return 0;
}

/* The original tox_friend_add queues a real friend request. NO manual
 * DHT discovery is injected and NO delivery/online success is implied.
 * Without bootstrap/Onion nodes, the request must remain pending. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_queue_tox_id_request(const uint8_t *address,
                                       size_t address_len,
                                       const uint8_t *message,
                                       size_t message_len) {
    if (!wtox_research_tox || !wtox_research_external_relay ||
        !address || address_len != TOX_ADDRESS_SIZE || !message ||
        message_len == 0 || message_len > WTOX_RESEARCH_ROUTE_MAX ||
        wtox_research_friendcon_id >= 0 ||
        wtox_research_crypto_id >= 0 || wtox_research_route_id >= 0 ||
        wtox_research_capture_enabled) return -1;
    Tox_Err_Friend_Add err = TOX_ERR_FRIEND_ADD_OK;
    Tox_Friend_Number number = tox_friend_add(
        wtox_research_tox, address, message, message_len, &err);
    if (err != TOX_ERR_FRIEND_ADD_OK || number != 0)
        return -10 - (int)err;
    const int friendcon = getfriend_conn_id_pk(
        wtox_research_tox->m->fr_c, address);
    if (friendcon != 0) return -20;
    wtox_research_friendcon_id = friendcon;
    wtox_research_request_pending = true;
    tox_callback_friend_connection_status(wtox_research_tox,
                                           wtox_research_on_friend_status);
    tox_callback_friend_message(wtox_research_tox,
                                 wtox_research_on_friend_message);
    /* Deliberately DO NOT call set_dht_temp_pk or synthesize a route. */
    return 0;
}

/* A status of 0 here means there is no online friend. In particular,
 * "queued" is NOT "request delivered" or "request accepted". */
EMSCRIPTEN_KEEPALIVE
int wtox_research_tox_request_status(uint32_t out[7]) {
    if (!wtox_research_tox || !out) return -1;
    out[0] = (uint32_t)tox_self_get_friend_list_size(wtox_research_tox);
    out[1] = wtox_research_request_pending ? 1 : 0;
    out[2] = 0;
    if (out[0] != 0) {
        Tox_Err_Friend_Query err = TOX_ERR_FRIEND_QUERY_OK;
        out[2] = (uint32_t)tox_friend_get_connection_status(
            wtox_research_tox, 0, &err);
        if (err != TOX_ERR_FRIEND_QUERY_OK) return -2;
    }
    out[3] = wtox_research_friend_online_events;
    out[4] = wtox_research_friend_route_attached ? 1 : 0;
    out[5] = wtox_research_request_received;
    out[6] = wtox_research_request_dropped;
    return 0;
}

/* Returns zero when no original Tox request callback has fired. The test
 * runner does NOT fabricate these events. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_take_real_friend_request(uint8_t *sender,
                                            uint8_t *message,
                                            size_t capacity) {
    if (!wtox_research_tox || !sender || !message ||
        capacity < WTOX_RESEARCH_ROUTE_MAX) return -1;
    if (!wtox_research_request_length) return 0;
    const int length = (int)wtox_research_request_length;
    memcpy(sender, wtox_research_request_sender, TOX_PUBLIC_KEY_SIZE);
    memcpy(message, wtox_research_request_message, (size_t)length);
    sodium_memzero(wtox_research_request_sender, sizeof(wtox_research_request_sender));
    sodium_memzero(wtox_research_request_message, sizeof(wtox_research_request_message));
    wtox_research_request_length = 0;
    return length;
}
