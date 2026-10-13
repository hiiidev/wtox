/*
 * Test-only injected Network_Funcs for pinned c-toxcore v0.2.23.
 *
 * The installed Network blocks every OS socket/DNS/UDP operation. Only a
 * single fake IPv4 TCP stream handle is possible, and it forwards to the
 * previously validated in-WASM virtual TCP FIFO.
 *
 * This is NOT part of the real browser identity/session API, not a live
 * Tox relay, and does not connect to any external network.
 */
#include <errno.h>
#include <sys/socket.h>
#include <toxcore/net.h>
#include <toxcore/tox_private.h>
#include <toxcore/crypto_core.h>
#include <toxcore/TCP_common.h>

#define WTOX_PROBE_SOCKET 0x5754
typedef struct Wtox_Probe {
    uint32_t sockets;
    uint32_t connects;
    uint32_t sends;
    uint32_t recvs;
    uint32_t closes;
} Wtox_Probe;

static bool probe_valid(Socket sock) {
    return net_socket_to_native(sock) == WTOX_PROBE_SOCKET;
}
static Socket probe_socket(void *context, int domain, int type, int protocol) {
    Wtox_Probe *p = (Wtox_Probe *)context;
    if (p && p->sockets == 0 && domain == TOX_AF_INET && type == TOX_SOCK_STREAM &&
        protocol == TOX_PROTO_TCP) {
        ++p->sockets;
        return net_socket_from_native(WTOX_PROBE_SOCKET);
    }
    errno = EAFNOSUPPORT;
    return net_invalid_socket();
}
static int probe_close(void *context, Socket sock) {
    if (!context || !probe_valid(sock)) { errno = EBADF; return -1; }
    ++((Wtox_Probe *)context)->closes;
    wtox_vtcp_close();
    return 0;
}
static int probe_connect(void *context, Socket sock, const IP_Port *addr) {
    if (!context || !probe_valid(sock) || !addr ||
        !net_family_is_ipv4(addr->ip.family) ||
        addr->port != net_htons(33445)) {
        errno = EACCES; return -1;
    }
    ++((Wtox_Probe *)context)->connects;
    if (wtox_vtcp_begin() != 0) { errno = EALREADY; return -1; }
    errno = EINPROGRESS;
    return -1;
}
static int probe_send(void *context, Socket sock, const uint8_t *bytes, size_t len) {
    if (!context || !probe_valid(sock) || !bytes || !len) { errno = EINVAL; return -1; }
    ++((Wtox_Probe *)context)->sends;
    int n = wtox_vtcp_send(bytes, len);
    if (n == -11) { errno = EWOULDBLOCK; return -1; }
    if (n < 0) { errno = ENOTCONN; return -1; }
    return n;
}
static int probe_recv(void *context, Socket sock, uint8_t *bytes, size_t len) {
    if (!context || !probe_valid(sock) || !bytes || !len) { errno = EINVAL; return -1; }
    ++((Wtox_Probe *)context)->recvs;
    int n = wtox_vtcp_recv(bytes, len);
    if (n == -11) { errno = EWOULDBLOCK; return -1; }
    if (n < 0) { errno = ENOTCONN; return -1; }
    return n;
}
static int probe_nonblock(void *context, Socket sock, bool enable) {
    if (!context || !probe_valid(sock) || !enable) { errno = EINVAL; return -1; }
    return 0;
}
static int probe_recvbuf(void *context, Socket sock) {
    if (!context || !probe_valid(sock)) { errno = EBADF; return -1; }
    return WTOX_VTCP_LIMIT - wtox_vtcp_rx_free();
}
static Socket probe_accept(void *context, Socket sock) {
    (void)context; (void)sock;
    errno = ENOTSUP;
    return net_invalid_socket();
}
static int probe_bind(void *context, Socket sock, const IP_Port *addr) {
    (void)context; (void)sock; (void)addr;
    errno = ENOTSUP; return -1;
}
static int probe_listen(void *context, Socket sock, int backlog) {
    (void)context; (void)sock; (void)backlog;
    errno = ENOTSUP; return -1;
}
static int probe_recvfrom(void *context, Socket sock, uint8_t *buf, size_t len, IP_Port *addr) {
    (void)context; (void)sock; (void)buf; (void)len; (void)addr;
    errno = ENOTSUP; return -1;
}
static int probe_sendto(void *context, Socket sock, const uint8_t *buf,
                        size_t len, const IP_Port *addr) {
    (void)context; (void)sock; (void)buf; (void)len; (void)addr;
    errno = ENOTSUP; return -1;
}
static int probe_getsockopt(void *context, Socket sock, int level, int option,
                            void *value, size_t *length) {
    (void)context; (void)sock; (void)level; (void)option; (void)value; (void)length;
    errno = ENOTSUP; return -1;
}
static int probe_setsockopt(void *context, Socket sock, int level, int option,
                            const void *value, size_t length) {
    (void)context; (void)sock; (void)level; (void)option; (void)value; (void)length;
    errno = ENOTSUP; return -1;
}
static int probe_getaddrinfo(void *context, const Memory *mem,
                             const char *addr, int family, int protocol,
                             IP_Port **addrs) {
    (void)context; (void)mem; (void)addr; (void)family; (void)protocol;
    if (addrs) *addrs = NULL;
    return -1; /* no OS DNS or arbitrary hostname lookup */
}
static int probe_freeaddrinfo(void *context, const Memory *mem, IP_Port *addrs) {
    (void)context; (void)mem; (void)addrs;
    return 0;
}
static const Network_Funcs wtox_probe_funcs = {
    .close = probe_close,
    .accept = probe_accept,
    .bind = probe_bind,
    .listen = probe_listen,
    .connect = probe_connect,
    .recvbuf = probe_recvbuf,
    .recv = probe_recv,
    .recvfrom = probe_recvfrom,
    .send = probe_send,
    .sendto = probe_sendto,
    .socket = probe_socket,
    .socket_nonblock = probe_nonblock,
    .getsockopt = probe_getsockopt,
    .setsockopt = probe_setsockopt,
    .getaddrinfo = probe_getaddrinfo,
    .freeaddrinfo = probe_freeaddrinfo,
};

EMSCRIPTEN_KEEPALIVE
int wtox_network_injection_probe(uint32_t results[6]) {
    if (!results || wtox_live != NULL || sodium_init() < 0) return -1;
    memset(results, 0, 6 * sizeof(uint32_t));
    wtox_vtcp_reset();
    Wtox_Probe counter = {0};
    Network custom_network = { .funcs = &wtox_probe_funcs, .obj = &counter };
    Tox_System custom_system = tox_default_system();
    custom_system.ns = &custom_network;
    Tox_Options_Testing testing = { .operating_system = &custom_system };
    Tox_Err_Options_New options_error = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options = tox_options_new(&options_error);
    if (!options || options_error != TOX_ERR_OPTIONS_NEW_OK) return -2;
    tox_options_set_udp_enabled(options, false);
    tox_options_set_local_discovery_enabled(options, false);
    tox_options_set_ipv6_enabled(options, false);
    Tox_Err_New create_error = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing testing_error = TOX_ERR_NEW_TESTING_OK;
    Tox *tox = tox_new_testing(options, &create_error, &testing, &testing_error);
    tox_options_free(options);
    if (!tox || create_error != TOX_ERR_NEW_OK ||
        testing_error != TOX_ERR_NEW_TESTING_OK) {
        if (tox) tox_kill(tox);
        return -3;
    }
    if (tox_get_system(tox)->ns != &custom_network) {
        tox_kill(tox);
        return -4;
    }

    /* Prove the actual network object owned by an original Tox instance
       dispatches to custom native callbacks. No real native socket used. */
    const Network *installed = tox_get_system(tox)->ns;
    Socket socket = ns_socket(installed, TOX_AF_INET, TOX_SOCK_STREAM, TOX_PROTO_TCP);
    if (!probe_valid(socket)) { tox_kill(tox); return -5; }

    IP_Port addr = {0}; /* synthetic TEST-NET only; no OS networking */
    addr.ip.family = net_family_ipv4();
    addr.port = net_htons(33445);
    if (ns_connect(installed, socket, &addr) != -1 ||
        errno != EINPROGRESS || wtox_vtcp_state() != WTOX_VTCP_CONNECTING) {
        tox_kill(tox); return -6;
    }
    const uint8_t payload[5] = {0, 1, 127, 128, 255};
    if (ns_send(installed, socket, payload, sizeof(payload)) != -1 ||
        errno != EWOULDBLOCK) { tox_kill(tox); return -7; }
    if (wtox_vtcp_connected() != 0) { tox_kill(tox); return -8; }
    if (ns_send(installed, socket, payload, sizeof(payload)) != sizeof(payload)) {
        tox_kill(tox); return -9;
    }
    uint8_t peek[5] = {0};
    if (wtox_vtcp_tx_peek(peek, sizeof(peek)) != sizeof(peek) ||
        memcmp(payload, peek, sizeof(peek)) != 0 ||
        wtox_vtcp_tx_consume(sizeof(peek)) != 0) {
        tox_kill(tox); return -10;
    }
    uint8_t output[5] = {0};
    if (ns_recv(installed, socket, output, sizeof(output)) != -1 ||
        errno != EWOULDBLOCK) { tox_kill(tox); return -11; }
    if (wtox_vtcp_rx_push(payload, sizeof(payload)) != sizeof(payload) ||
        ns_recv(installed, socket, output, sizeof(output)) != sizeof(payload) ||
        memcmp(payload, output, sizeof(payload)) != 0) {
        tox_kill(tox); return -12;
    }
    /* Real Toxcore event loop still works when its Network is injected. */
    tox_iterate(tox, NULL);
    if (ns_close(installed, socket) != 0) { tox_kill(tox); return -13; }
    results[0] = counter.sockets;
    results[1] = counter.connects;
    results[2] = counter.sends;
    results[3] = counter.recvs;
    results[4] = counter.closes;
    results[5] = (uint32_t)tox_self_get_connection_status(tox);
    tox_kill(tox);
    wtox_vtcp_reset();
    return 0;
}

/*
 * Stage 2: prove original c-toxcore's TCP relay code originates the fake
 * connect and sends its own handshake bytes through the injected Network.
 *
 * The hostname is the IANA documentation-only IPv4 address 198.51.100.7,
 * NEVER passed to an OS socket. Any DNS/UDP/system-socket request fails shut.
 * This is not proof that a real relay accepted or authenticated a handshake.
 */
EMSCRIPTEN_KEEPALIVE
int wtox_network_relay_dial_probe(uint32_t results[8]) {
    if (!results || wtox_live || sodium_init() < 0) return -1;
    memset(results, 0, 8 * sizeof(uint32_t));
    wtox_vtcp_reset();
    Wtox_Probe counter = {0};
    Network ns = { .funcs = &wtox_probe_funcs, .obj = &counter };
    Tox_System system = tox_default_system();
    system.ns = &ns;
    Tox_Options_Testing testing = { .operating_system = &system };
    Tox_Err_Options_New options_error = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options = tox_options_new(&options_error);
    if (!options || options_error != TOX_ERR_OPTIONS_NEW_OK) return -2;
    tox_options_set_udp_enabled(options, false);
    tox_options_set_local_discovery_enabled(options, false);
    tox_options_set_ipv6_enabled(options, false);
    tox_options_set_experimental_disable_dns(options, true);
    Tox_Err_New create_error = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing testing_error = TOX_ERR_NEW_TESTING_OK;
    Tox *tox = tox_new_testing(options, &create_error, &testing, &testing_error);
    tox_options_free(options);
    if (!tox || create_error != TOX_ERR_NEW_OK ||
        testing_error != TOX_ERR_NEW_TESTING_OK) {
        if (tox) tox_kill(tox);
        wtox_vtcp_reset();
        return -3;
    }
    /* One synthetic DHT relay key. It is NOT a known or contacted relay. */
    uint8_t public_key[TOX_PUBLIC_KEY_SIZE];
    for (size_t i = 0; i < sizeof(public_key); ++i) {
        public_key[i] = (uint8_t)(i + 1);
    }
    Tox_Err_Bootstrap bootstrap_error = TOX_ERR_BOOTSTRAP_OK;
    const bool added = tox_add_tcp_relay(tox, "198.51.100.7", 33445,
                                          public_key, &bootstrap_error);
    results[0] = counter.sockets;
    results[1] = counter.connects;
    results[2] = counter.sends;
    results[3] = counter.recvs;
    results[4] = counter.closes;
    results[5] = (uint32_t)added;
    results[6] = (uint32_t)bootstrap_error;
    results[7] = (uint32_t)wtox_vtcp_tx_pending();
    if (!added || bootstrap_error != TOX_ERR_BOOTSTRAP_OK) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -4;
    }
    if (counter.sockets != 1 || counter.connects != 1 ||
        wtox_vtcp_state() != WTOX_VTCP_CONNECTING) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -5;
    }
    /* Simulate only the async gateway's TCP connect confirmation. */
    if (wtox_vtcp_connected() != 0) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -6;
    }
    for (unsigned i = 0; i < 5; ++i) {
        tox_iterate(tox, NULL);
        if (wtox_vtcp_tx_pending() > 0) break;
    }
    const int pending = wtox_vtcp_tx_pending();
    results[2] = counter.sends;
    results[3] = counter.recvs;
    results[4] = counter.closes;
    results[7] = (uint32_t)pending;
    /* Real Tox TCP relay handshake is produced locally, but NO remote peer
       is ever contacted and no handshake or peer connection is verified. */
    const int status = pending > 0 && counter.sends > 0 ? 0 : -7;
    tox_kill(tox);
    wtox_vtcp_reset();
    sodium_memzero(public_key, sizeof(public_key));
    return status;
}

/*
 * Stage 3: exercise the real Tox TCP client's inbound handshake reader with
 * deliberately invalid synthetic relay data. No real TCP server exists.
 * mode 0: fragmented/incomplete ciphertext (must remain pending)
 * mode 1: full-size malformed ciphertext (must reject and disconnect)
 * mode 2: two fragments that together make malformed ciphertext (reject)
 *
 * TCP_SERVER_HANDSHAKE_SIZE is pinned to the original v0.2.23 constant:
 * nonce 24 + public key 32 + nonce 24 + MAC 16 = 96 bytes.
 * Test data is synthetic and cannot authenticate as a valid relay.
 */
#define WTOX_FAKE_SERVER_HANDSHAKE_SIZE (24 + 32 + 24 + 16)
EMSCRIPTEN_KEEPALIVE
int wtox_network_relay_rejection_probe(uint32_t mode, uint32_t results[10]) {
    if (!results || mode > 2 || wtox_live || sodium_init() < 0) return -1;
    memset(results, 0, 10 * sizeof(uint32_t));
    wtox_vtcp_reset();
    Wtox_Probe counter = {0};
    Network ns = { .funcs = &wtox_probe_funcs, .obj = &counter };
    Tox_System system = tox_default_system();
    system.ns = &ns;
    Tox_Options_Testing testing = { .operating_system = &system };
    Tox_Err_Options_New opt_error = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options = tox_options_new(&opt_error);
    if (!options || opt_error != TOX_ERR_OPTIONS_NEW_OK) return -2;
    tox_options_set_udp_enabled(options, false);
    tox_options_set_ipv6_enabled(options, false);
    tox_options_set_local_discovery_enabled(options, false);
    tox_options_set_experimental_disable_dns(options, true);
    Tox_Err_New err = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing testing_err = TOX_ERR_NEW_TESTING_OK;
    Tox *tox = tox_new_testing(options, &err, &testing, &testing_err);
    tox_options_free(options);
    if (!tox || err != TOX_ERR_NEW_OK || testing_err != TOX_ERR_NEW_TESTING_OK) {
        if (tox) tox_kill(tox);
        wtox_vtcp_reset();
        return -3;
    }
    uint8_t key[TOX_PUBLIC_KEY_SIZE];
    for (size_t i = 0; i < sizeof(key); ++i) key[i] = (uint8_t)(i + 1);
    Tox_Err_Bootstrap bootstrap_err = TOX_ERR_BOOTSTRAP_OK;
    const bool added = tox_add_tcp_relay(tox, "198.51.100.7", 33445, key, &bootstrap_err);
    sodium_memzero(key, sizeof(key));
    if (!added || bootstrap_err != TOX_ERR_BOOTSTRAP_OK ||
        counter.sockets != 1 || counter.connects != 1 ||
        wtox_vtcp_connected() != 0) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -4;
    }

    /* Run original Tox TCP handshake generator. Its locally produced
       client bytes remain confined to the virtual TX FIFO. */
    for (unsigned i = 0; i < 8 && counter.sends == 0; ++i) tox_iterate(tox, NULL);
    const int outbound = wtox_vtcp_tx_pending();
    if (outbound <= 0 || counter.sends == 0) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -5;
    }
    uint8_t invalid[WTOX_FAKE_SERVER_HANDSHAKE_SIZE];
    memset(invalid, 0xa5, sizeof(invalid));

    const size_t first = mode == 0 ? 17 : mode == 2 ? 31 : sizeof(invalid);
    if (wtox_vtcp_rx_push(invalid, first) != (int)first) {
        tox_kill(tox);
        wtox_vtcp_reset();
        return -6;
    }
    /* Toxcore's read_tcp_packet must not consume an incomplete frame. */
    tox_iterate(tox, NULL);
    const int recvs_after_first = (int)counter.recvs;
    const int buffered_after_first = WTOX_VTCP_LIMIT - wtox_vtcp_rx_free();
    if (mode == 2) {
        const size_t remaining = sizeof(invalid) - first;
        if (wtox_vtcp_rx_push(invalid + first, remaining) != (int)remaining) {
            tox_kill(tox);
            wtox_vtcp_reset();
            return -7;
        }
    }
    for (unsigned i = 0; i < 12; ++i) tox_iterate(tox, NULL);

    const int rx_remaining = WTOX_VTCP_LIMIT - wtox_vtcp_rx_free();
    const Tox_Connection connection = tox_self_get_connection_status(tox);
    results[0] = counter.sockets;
    results[1] = counter.connects;
    results[2] = counter.sends;
    results[3] = counter.recvs;
    results[4] = counter.closes;
    results[5] = (uint32_t)buffered_after_first;
    results[6] = (uint32_t)rx_remaining;
    results[7] = (uint32_t)connection;
    results[8] = (uint32_t)recvs_after_first;
    results[9] = (uint32_t)outbound;
    int code;
    if (mode == 0) {
        code = buffered_after_first == 17 && rx_remaining == 17 &&
            counter.recvs == 0 && counter.closes == 0 &&
            connection == TOX_CONNECTION_NONE ? 0 : -8;
    } else {
        code = counter.recvs > 0 && rx_remaining == 0 &&
            counter.closes > 0 && connection == TOX_CONNECTION_NONE &&
            (mode == 1 || (recvs_after_first == 0 && buffered_after_first == 31))
            ? 0 : -9;
    }
    sodium_memzero(invalid, sizeof(invalid));
    tox_kill(tox);
    wtox_vtcp_reset();
    return code;
}

/* Offline, test-only original Tox TCP cryptographic response. No OS I/O.
 * mode 0=valid, 1=fragmented valid, 2=wrong relay private key,
 * 3=valid ciphertext with tampered MAC. Never enables production networking.
 */
EMSCRIPTEN_KEEPALIVE
int wtox_network_relay_authenticated_probe(uint32_t mode, uint32_t result[10]) {
    if (!result || mode > 3 || wtox_live || sodium_init() < 0) return -1;
    memset(result, 0, 10 * sizeof(uint32_t));
    wtox_vtcp_reset();
    Wtox_Probe counter = {0};
    Network ns = { .funcs = &wtox_probe_funcs, .obj = &counter };
    Tox_System system = tox_default_system();
    system.ns = &ns;
    Tox_Options_Testing testing = { .operating_system = &system };
    Tox_Err_Options_New opt_err = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts = tox_options_new(&opt_err);
    if (!opts || opt_err != TOX_ERR_OPTIONS_NEW_OK) return -2;
    tox_options_set_udp_enabled(opts, false);
    tox_options_set_local_discovery_enabled(opts, false);
    tox_options_set_ipv6_enabled(opts, false);
    tox_options_set_experimental_disable_dns(opts, true);
    Tox_Err_New new_err = TOX_ERR_NEW_OK;
    Tox_Err_New_Testing test_err = TOX_ERR_NEW_TESTING_OK;
    Tox *tox = tox_new_testing(opts, &new_err, &testing, &test_err);
    tox_options_free(opts);
    if (!tox || new_err != TOX_ERR_NEW_OK || test_err != TOX_ERR_NEW_TESTING_OK) {
        if (tox) tox_kill(tox);
        wtox_vtcp_reset();
        return -3;
    }

    uint8_t relay_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
    uint8_t reply_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
    uint8_t relay_public[CRYPTO_PUBLIC_KEY_SIZE] = {0};
    uint8_t ephemeral_secret[CRYPTO_SECRET_KEY_SIZE] = {0};
    uint8_t shared[CRYPTO_SHARED_KEY_SIZE] = {0};
    uint8_t plain[TCP_HANDSHAKE_PLAIN_SIZE] = {0};
    uint8_t response[TCP_SERVER_HANDSHAKE_SIZE] = {0};
    uint8_t request[TCP_CLIENT_HANDSHAKE_SIZE] = {0};
    int code = 0;

    randombytes_buf(relay_secret, sizeof(relay_secret));
    crypto_derive_public_key(relay_public, relay_secret);
    Tox_Err_Bootstrap bootstrap_err = TOX_ERR_BOOTSTRAP_OK;
    if (!tox_add_tcp_relay(tox, "198.51.100.7", 33445,
                           relay_public, &bootstrap_err) ||
        bootstrap_err != TOX_ERR_BOOTSTRAP_OK ||
        counter.sockets != 1 || counter.connects != 1 ||
        wtox_vtcp_connected() != 0) {
        code = -4;
        goto cleanup;
    }
    for (unsigned i = 0; i < 8 && wtox_vtcp_tx_pending() == 0; ++i)
        tox_iterate(tox, NULL);
    if (wtox_vtcp_tx_pending() != TCP_CLIENT_HANDSHAKE_SIZE ||
        wtox_vtcp_tx_peek(request, sizeof(request)) != sizeof(request) ||
        wtox_vtcp_tx_consume(sizeof(request)) != 0) {
        code = -5;
        goto cleanup;
    }

    /* Authenticate the original Tox client hello with the test relay's
       matching long-term private key (or an intentionally wrong key). */
    if (mode == 2) randombytes_buf(reply_secret, sizeof(reply_secret));
    else memcpy(reply_secret, relay_secret, sizeof(reply_secret));
    if (encrypt_precompute(request, reply_secret, shared) != 0) {
        code = -6;
        goto cleanup;
    }
    randombytes_buf(ephemeral_secret, sizeof(ephemeral_secret));
    crypto_derive_public_key(plain, ephemeral_secret);
    randombytes_buf(plain + CRYPTO_PUBLIC_KEY_SIZE, CRYPTO_NONCE_SIZE);
    randombytes_buf(response, CRYPTO_NONCE_SIZE);
    const int encrypted_len = encrypt_data_symmetric(
        system.mem, shared, response, plain, sizeof(plain),
        response + CRYPTO_NONCE_SIZE);
    if (encrypted_len != (int)(sizeof(response) - CRYPTO_NONCE_SIZE)) {
        code = -7;
        goto cleanup;
    }
    if (mode == 3) response[sizeof(response) - 1] ^= 1;
    const size_t first = mode == 1 ? 23 : sizeof(response);
    if (wtox_vtcp_rx_push(response, first) != (int)first) {
        code = -8;
        goto cleanup;
    }
    tox_iterate(tox, NULL);
    const uint32_t first_recvs = counter.recvs;
    const int first_rx = WTOX_VTCP_LIMIT - wtox_vtcp_rx_free();
    if (mode == 1) {
        if (wtox_vtcp_rx_push(response + first, sizeof(response) - first)
            != (int)(sizeof(response) - first)) {
            code = -9;
            goto cleanup;
        }
    }
    for (unsigned i = 0; i < 8; ++i) tox_iterate(tox, NULL);
    result[0] = counter.sockets;
    result[1] = counter.connects;
    result[2] = counter.sends;
    result[3] = counter.recvs;
    result[4] = counter.closes;
    result[5] = first_recvs;
    result[6] = (uint32_t)first_rx;
    result[7] = (uint32_t)(WTOX_VTCP_LIMIT - wtox_vtcp_rx_free());
    result[8] = (uint32_t)wtox_vtcp_state();
    result[9] = (uint32_t)tox_self_get_connection_status(tox);
    if (counter.recvs < 1 || result[7] != 0 ||
        result[9] != TOX_CONNECTION_NONE ||
        (mode == 1 && (first_recvs != 0 || first_rx != 23))) {
        code = -10;
    } else if (mode <= 1) {
        if (counter.closes != 0 || wtox_vtcp_state() != WTOX_VTCP_OPEN)
            code = -11;
    } else {
        if (counter.closes == 0 || wtox_vtcp_state() == WTOX_VTCP_OPEN)
            code = -12;
    }

cleanup:
    sodium_memzero(relay_secret, sizeof(relay_secret));
    sodium_memzero(reply_secret, sizeof(reply_secret));
    sodium_memzero(ephemeral_secret, sizeof(ephemeral_secret));
    sodium_memzero(shared, sizeof(shared));
    sodium_memzero(plain, sizeof(plain));
    sodium_memzero(response, sizeof(response));
    sodium_memzero(request, sizeof(request));
    tox_kill(tox);
    wtox_vtcp_reset();
    return code;
}
