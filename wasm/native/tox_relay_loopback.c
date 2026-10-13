/*
 * Local test-only ORIGINAL c-toxcore TCP_Server executable.
 * The actual Tox TCP authentication, routing and packet forwarding is in
 * unmodified pinned upstream TCP_server.c. This harness merely configures
 * a loopback-only Network_Funcs bind and executes its event loop.
 *
 * Never start this standalone server as a public relay or on production VPS.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <sodium.h>
#include "toxcore/tox_private.h"
#include "toxcore/TCP_server.h"
#include "toxcore/network.h"
#include "toxcore/logger.h"
#include "toxcore/mono_time.h"

static volatile sig_atomic_t running = 1;
static const Network *os_network_source = NULL;

static void stop_signal(int sig)
{
    (void)sig;
    running = 0;
}

/* Only the bind operation is changed. Every other callback remains the
 * pinned original system implementation, preserving genuine TCP_Server. */
static int loopback_only_bind(void *context, Socket sock, const IP_Port *requested)
{
    (void)context;
    if (os_network_source == NULL || requested == NULL ||
        !net_family_is_ipv4(requested->ip.family)) return -1;
    IP_Port restricted = *requested;
    restricted.ip.ip.v4 = get_ip4_loopback();
    return os_network_source->funcs->bind(os_network_source->obj, sock, &restricted);
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: tox-relay-loopback PORT\n");
        return 2;
    }
    char *end = NULL;
    errno = 0;
    const unsigned long num = strtoul(argv[1], &end, 10);
    if (errno || !end || *end || num < 1025 || num > 65535 ||
        sodium_init() < 0) return 2;
    const uint16_t port = (uint16_t)num;
    uint8_t secret[crypto_box_SECRETKEYBYTES];
    randombytes_buf(secret, sizeof(secret));

    const Tox_System system = tox_default_system();
    if (!system.ns || !system.ns->funcs || !system.mem || !system.rng) {
        sodium_memzero(secret, sizeof(secret));
        return 3;
    }
    os_network_source = system.ns;
    Network_Funcs functions = *system.ns->funcs;
    functions.bind = loopback_only_bind;
    const Network loopback = { .funcs = &functions, .obj = NULL };
    Logger *logger = logger_new(system.mem);
    Mono_Time *clock = mono_time_new(system.mem, NULL, NULL);
    if (!logger || !clock) {
        if (clock) mono_time_free(system.mem, clock);
        if (logger) logger_kill(logger);
        sodium_memzero(secret, sizeof(secret));
        return 4;
    }
    TCP_Server *server = new_tcp_server(logger, system.mem, system.rng,
                                          &loopback, false, 1, &port,
                                          secret, NULL, NULL);
    sodium_memzero(secret, sizeof(secret));
    if (!server || tcp_server_listen_count(server) != 1) {
        if (server) kill_tcp_server(server);
        mono_time_free(system.mem, clock);
        logger_kill(logger);
        return 5;
    }
    const uint8_t *public_key = tcp_server_public_key(server);
    printf("READY ");
    for (size_t i = 0; i < crypto_box_PUBLICKEYBYTES; ++i)
        printf("%02x", public_key[i]);
    putchar('\n');
    fflush(stdout);

    signal(SIGTERM, stop_signal);
    signal(SIGINT, stop_signal);
    const struct timespec pause_time = { .tv_sec = 0, .tv_nsec = 10000000 };
    while (running) {
        mono_time_update(clock);
        do_tcp_server(server, clock);
        nanosleep(&pause_time, NULL);
    }

    kill_tcp_server(server);
    mono_time_free(system.mem, clock);
    logger_kill(logger);
    return 0;
}
