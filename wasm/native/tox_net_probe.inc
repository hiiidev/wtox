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
