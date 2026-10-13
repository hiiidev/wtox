/*
 * Stage 25b: real first-contact Onion friend request through original
 * c-toxcore DHT. Three independent native Tox identities run in one
 * disposable Linux process. They bootstrap against a separate local
 * DHT node; no peer DHT key is injected into Friend_Connections.
 *
 * Unlike previous protocol shims, this uses ONLY public tox_bootstrap,
 * tox_friend_add, tox_callback_friend_request, tox_friend_add_norequest,
 * friend-online callbacks, and actual friend text. No synthetic events.
 *
 * The Network_Funcs bind and sendto callbacks are constrained to the OS
 * loopback address. There is no external UDP access or production service.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sodium.h>
#include "toxcore/tox.h"
#include "toxcore/tox_private.h"
#include "toxcore/network.h"

#define MAX_SECONDS 100
static const Network *host_network = NULL;
static Tox *alice = NULL, *bob = NULL, *bootstrap_node = NULL;
static uint32_t received_requests = 0, online_a = 0, online_b = 0;
static uint32_t recv_a = 0, recv_b = 0;
static uint32_t callback_errors = 0;
static bool accepted = false;
static const uint8_t greeting[] = "Stage25 original DHT Onion friend request";
static const uint8_t from_a[] = "Stage25 message A to B";
static const uint8_t from_b[] = "Stage25 message B to A";

static bool local_address(const IP_Port *address)
{
    if (!address || !net_family_is_ipv4(address->ip.family)) return false;
    const IP4 loopback = get_ip4_loopback();
    return memcmp(&address->ip.ip.v4, &loopback, sizeof(loopback)) == 0;
}
static int only_loopback_bind(void *unused, Socket sock, const IP_Port *requested)
{
    (void)unused;
    if (!requested || !net_family_is_ipv4(requested->ip.family)) {
        errno=EACCES; return -1;
    }
    IP_Port address = *requested;
    address.ip.ip.v4 = get_ip4_loopback();
    return host_network->funcs->bind(host_network->obj, sock, &address);
}
static int only_loopback_sendto(void *unused, Socket sock, const uint8_t *data,
                                size_t length, const IP_Port *dest)
{
    (void)unused;
    if (!local_address(dest)) { errno=EACCES; return -1; }
    return host_network->funcs->sendto(host_network->obj,sock,data,length,dest);
}
static int only_loopback_connect(void *unused, Socket sock, const IP_Port *dest)
{
    (void)unused;
    if (!local_address(dest)) {errno=EACCES;return -1;}
    return host_network->funcs->connect(host_network->obj,sock,dest);
}
static void on_request(Tox *tox, const uint8_t *sender,
                       const uint8_t *message, size_t length, void *user_data)
{
    (void)user_data;
    uint8_t expected[TOX_PUBLIC_KEY_SIZE];
    if (tox!=bob || sender==NULL || message==NULL ||
        length!=sizeof(greeting)-1 ||
        memcmp(message,greeting,length)!=0 || received_requests!=0) {
        ++callback_errors; return;
    }
    tox_self_get_public_key(alice,expected);
    if (sodium_memcmp(sender,expected,sizeof(expected))!=0) {
        ++callback_errors; return;
    }
    Tox_Err_Friend_Add error=TOX_ERR_FRIEND_ADD_OK;
    const Tox_Friend_Number friend_number =
        tox_friend_add_norequest(bob,sender,&error);
    if (friend_number!=0 || error!=TOX_ERR_FRIEND_ADD_OK) {
        ++callback_errors;return;
    }
    ++received_requests;
    accepted=true;
    printf("REQUEST_RECEIVED_ORIGINAL\n");
    fflush(stdout);
}
static void on_friend_status(Tox *tox, Tox_Friend_Number id,
                             Tox_Connection connection, void *unused)
{
    (void)unused;
    if (id!=0) {++callback_errors;return;}
    if (connection!=TOX_CONNECTION_NONE) {
        if (tox==alice) ++online_a;
        else if (tox==bob) ++online_b;
        else ++callback_errors;
    }
}
static void on_message(Tox *tox, Tox_Friend_Number number,
                       Tox_Message_Type type, const uint8_t *message,
                       size_t length, void *unused)
{
    (void)unused;
    if (number!=0 || type!=TOX_MESSAGE_TYPE_NORMAL || !message) {
        ++callback_errors;return;
    }
    const uint8_t *expected = tox==alice ? from_b : from_a;
    const size_t expected_len = tox==alice ? sizeof(from_b)-1 : sizeof(from_a)-1;
    if ((tox!=alice && tox!=bob) || length!=expected_len ||
        memcmp(message,expected,length)!=0) {
        ++callback_errors;return;
    }
    if (tox==alice) ++recv_a;
    else ++recv_b;
}
static Tox *create_native(uint16_t port, const Tox_System *system)
{
    Tox_Err_Options_New oerr=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts=tox_options_new(&oerr);
    if (!opts || oerr!=TOX_ERR_OPTIONS_NEW_OK) {
        if(opts)tox_options_free(opts);
        return NULL;
    }
    tox_options_set_udp_enabled(opts,true);
    tox_options_set_ipv6_enabled(opts,false);
    tox_options_set_local_discovery_enabled(opts,false);
    tox_options_set_start_port(opts,port);
    tox_options_set_end_port(opts,port);
    tox_options_set_experimental_disable_dns(opts,true);
    Tox_Options_Testing testing={.operating_system=system};
    Tox_Err_New new_error=TOX_ERR_NEW_OK;
    Tox_Err_New_Testing test_error=TOX_ERR_NEW_TESTING_OK;
    Tox *tox=tox_new_testing(opts,&new_error,&testing,&test_error);
    tox_options_free(opts);
    if (new_error!=TOX_ERR_NEW_OK ||
        test_error!=TOX_ERR_NEW_TESTING_OK) {
        if(tox)tox_kill(tox);
        return NULL;
    }
    return tox;
}
static bool add_bootstrap(Tox *to, uint16_t port, const uint8_t *key)
{
    Tox_Err_Bootstrap err=TOX_ERR_BOOTSTRAP_OK;
    const bool ok=tox_bootstrap(to,"127.0.0.1",port,key,&err);
    return ok && err==TOX_ERR_BOOTSTRAP_OK;
}
static bool friend_online(Tox *tox)
{
    Tox_Err_Friend_Query err=TOX_ERR_FRIEND_QUERY_OK;
    const Tox_Connection conn=tox_friend_get_connection_status(tox,0,&err);
    return err==TOX_ERR_FRIEND_QUERY_OK && conn!=TOX_CONNECTION_NONE;
}
static uint64_t clock_ms(void)
{
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC,&time);
    return (uint64_t)time.tv_sec*1000 + (uint64_t)time.tv_nsec/1000000;
}
static uint16_t parse_port(const char *arg)
{
    if (!arg || !*arg) return 0;
    char *end=NULL;
    errno=0;
    unsigned long v=strtoul(arg,&end,10);
    return errno||!end||*end||v<1025||v>65535 ? 0 : (uint16_t)v;
}
int main(int argc, char **argv)
{
    if (argc!=4 || sodium_init()<0) return 2;
    const uint16_t port0=parse_port(argv[1]);
    const uint16_t port1=parse_port(argv[2]);
    const uint16_t port2=parse_port(argv[3]);
    if (!port0||!port1||!port2 ||
        port0==port1||port0==port2||port1==port2) return 2;

    const Tox_System base=tox_default_system();
    if (!base.ns || !base.ns->funcs || !base.mem || !base.rng) return 3;
    host_network=base.ns;
    Network_Funcs limited=*host_network->funcs;
    limited.bind=only_loopback_bind;
    limited.sendto=only_loopback_sendto;
    limited.connect=only_loopback_connect;
    const Network restricted={.funcs=&limited,.obj=NULL};
    Tox_System system=base;
    system.ns=&restricted;
    int code=4;
    bootstrap_node=create_native(port0,&system);
    alice=create_native(port1,&system);
    bob=create_native(port2,&system);
    if (!bootstrap_node || !alice || !bob) goto done;
    uint8_t bootstrap_pk[TOX_PUBLIC_KEY_SIZE]={0};
    tox_self_get_dht_id(bootstrap_node,bootstrap_pk);
    uint8_t a_pk[TOX_PUBLIC_KEY_SIZE],b_pk[TOX_PUBLIC_KEY_SIZE];
    tox_self_get_public_key(alice,a_pk);
    tox_self_get_public_key(bob,b_pk);
    if (sodium_memcmp(bootstrap_pk,a_pk,TOX_PUBLIC_KEY_SIZE)==0 ||
        sodium_memcmp(bootstrap_pk,b_pk,TOX_PUBLIC_KEY_SIZE)==0 ||
        sodium_memcmp(a_pk,b_pk,TOX_PUBLIC_KEY_SIZE)==0) goto done;
    /* Each client knows only the independent bootstrap's DHT identity.
       Neither client receives the OTHER CLIENT's DHT key. */
    if (!add_bootstrap(alice,port0,bootstrap_pk) ||
        !add_bootstrap(bob,port0,bootstrap_pk)) goto done;
    tox_callback_friend_request(bob,on_request);
    tox_callback_friend_connection_status(alice,on_friend_status);
    tox_callback_friend_connection_status(bob,on_friend_status);
    tox_callback_friend_message(alice,on_message);
    tox_callback_friend_message(bob,on_message);
    const uint64_t start=clock_ms();
    bool sent=false, messages_sent=false;
    int phase=0;
    code=5;
    const struct timespec pause_time={.tv_sec=0,.tv_nsec=12000000};
    while (clock_ms()-start < MAX_SECONDS*1000U) {
        tox_iterate(bootstrap_node,NULL);
        tox_iterate(alice,NULL);
        tox_iterate(bob,NULL);
        if (callback_errors) {code=6;break;}
        if (!sent && tox_self_get_connection_status(alice)!=TOX_CONNECTION_NONE &&
                     tox_self_get_connection_status(bob)!=TOX_CONNECTION_NONE) {
            uint8_t address[TOX_ADDRESS_SIZE];
            tox_self_get_address(bob,address);
            uint8_t bad[TOX_ADDRESS_SIZE];
            memcpy(bad,address,sizeof(bad));
            bad[TOX_ADDRESS_SIZE-1]^=1;
            Tox_Err_Friend_Add bad_err=TOX_ERR_FRIEND_ADD_OK;
            const uint32_t invalid=tox_friend_add(
                alice,bad,greeting,sizeof(greeting)-1,&bad_err);
            if (invalid!=UINT32_MAX || bad_err==TOX_ERR_FRIEND_ADD_OK ||
                tox_self_get_friend_list_size(alice)!=0) {
                code=7;break;
            }
            Tox_Err_Friend_Add err=TOX_ERR_FRIEND_ADD_OK;
            const Tox_Friend_Number id=tox_friend_add(
                alice,address,greeting,sizeof(greeting)-1,&err);
            if (id!=0 || err!=TOX_ERR_FRIEND_ADD_OK) {
                code=8;break;
            }
            sent=true;
            phase=1;
            puts("REQUEST_QUEUED_ORIGINAL");fflush(stdout);
        }
        if (accepted && !messages_sent && friend_online(alice) &&
            friend_online(bob) && online_a && online_b) {
            Tox_Err_Friend_Send_Message ea=TOX_ERR_FRIEND_SEND_MESSAGE_OK;
            Tox_Err_Friend_Send_Message eb=TOX_ERR_FRIEND_SEND_MESSAGE_OK;
            tox_friend_send_message(alice,0,TOX_MESSAGE_TYPE_NORMAL,
                from_a,sizeof(from_a)-1,&ea);
            tox_friend_send_message(bob,0,TOX_MESSAGE_TYPE_NORMAL,
                from_b,sizeof(from_b)-1,&eb);
            if(ea!=TOX_ERR_FRIEND_SEND_MESSAGE_OK ||
               eb!=TOX_ERR_FRIEND_SEND_MESSAGE_OK) {
                code=9;break;
            }
            messages_sent=true;
            phase=2;
        }
        if (messages_sent && recv_a==1 && recv_b==1 &&
            received_requests==1 && callback_errors==0) {
            printf("PASS DHT_ONION_REQUEST=1 ACCEPTED=1 TEXT_A=1 TEXT_B=1 BOOTSTRAP=1 ELAPSED_MS=%llu\n",
                   (unsigned long long)(clock_ms()-start));
            fflush(stdout);
            code=0;break;
        }
        nanosleep(&pause_time,NULL);
    }
    if (code!=0) {
        fprintf(stderr,
            "FAIL stage25b code=%d phase=%d req=%u accept=%d online_a=%u online_b=%u recv_a=%u recv_b=%u errors=%u self_a=%d self_b=%d\n",
            code,phase,received_requests,accepted,online_a,online_b,
            recv_a,recv_b,callback_errors,
            tox_self_get_connection_status(alice),
            tox_self_get_connection_status(bob));
    }
done:
    if (bob)tox_kill(bob);
    if (alice)tox_kill(alice);
    if (bootstrap_node)tox_kill(bootstrap_node);
    return code;
}
