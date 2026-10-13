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
    wtox_vtcp_close();
}

EMSCRIPTEN_KEEPALIVE
static int wtox_research_start_internal(const uint8_t *external_key) {
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
    Tox_Err_New new_err = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing testing_err = TOX_ERR_NEW_TESTING_OK;
    wtox_research_tox = tox_new_testing(opts, &new_err, &testing, &testing_err);
    tox_options_free(opts);
    if (!wtox_research_tox || new_err != TOX_ERR_NEW_OK ||
        testing_err != TOX_ERR_NEW_TESTING_OK) {
        wtox_research_stop();
        return -3;
    }
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
    return wtox_research_start_internal(NULL);
}
/* Strict public-key-only interface. Key bytes never include private material. */
EMSCRIPTEN_KEEPALIVE
int wtox_research_start_with_relay_public_key(const uint8_t *key, size_t len) {
    if (!key || len != CRYPTO_PUBLIC_KEY_SIZE) return -1;
    return wtox_research_start_internal(key);
}

EMSCRIPTEN_KEEPALIVE
int wtox_research_tick(void) {
    if (!wtox_research_tox) return -1;
    tox_iterate(wtox_research_tox, NULL);
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
