/*
 * Standalone genuine pinned c-toxcore DHT bootstrap node, CI ONLY.
 * Original tox_iterate + OS UDP; wraps Network_Funcs to enforce 127.0.0.1.
 * No peers' keys, no fake DHT responses, no public listener.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
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

static const Network *host_net=NULL;
static volatile sig_atomic_t alive=1;
static void quit(int sig){(void)sig;alive=0;}
static bool local(const IP_Port *p){
    return p && net_family_is_ipv4(p->ip.family) &&
        p->ip.ip.v4.uint32==get_ip4_loopback().uint32;
}
static int local_bind(void *ctx,Socket sock,const IP_Port *port){
    (void)ctx;
    if(!port || !net_family_is_ipv4(port->ip.family)){errno=EACCES;return -1;}
    IP_Port restricted=*port;
    restricted.ip.ip.v4=get_ip4_loopback();
    return host_net->funcs->bind(host_net->obj,sock,&restricted);
}
static int local_sendto(void *ctx,Socket sock,const uint8_t *data,
                        size_t n,const IP_Port *dest){
    (void)ctx;
    if(!local(dest)){errno=EACCES;return -1;}
    return host_net->funcs->sendto(host_net->obj,sock,data,n,dest);
}
static int local_connect(void *ctx,Socket sock,const IP_Port *dest){
    (void)ctx;
    if(!local(dest)){errno=EACCES;return -1;}
    return host_net->funcs->connect(host_net->obj,sock,dest);
}
int main(int argc,char **argv){
    if(argc!=2 || sodium_init()<0)return 2;
    errno=0;
    char *end=NULL;
    const unsigned long n=strtoul(argv[1],&end,10);
    if(errno || !end || *end || n<1025 || n>65535)return 2;
    const Tox_System base=tox_default_system();
    if(!base.ns || !base.ns->funcs)return 3;
    host_net=base.ns;
    Network_Funcs callbacks=*host_net->funcs;
    callbacks.bind=local_bind;
    callbacks.sendto=local_sendto;
    callbacks.connect=local_connect;
    const Network local_ns={.funcs=&callbacks,.obj=NULL};
    Tox_System system=base;
    system.ns=&local_ns;
    Tox_Options_Testing testing={.operating_system=&system};
    Tox_Err_Options_New oerr=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options=tox_options_new(&oerr);
    if(!options || oerr!=TOX_ERR_OPTIONS_NEW_OK)return 4;
    tox_options_set_udp_enabled(options,true);
    tox_options_set_ipv6_enabled(options,false);
    tox_options_set_local_discovery_enabled(options,false);
    tox_options_set_start_port(options,(uint16_t)n);
    tox_options_set_end_port(options,(uint16_t)n);
    tox_options_set_experimental_disable_dns(options,true);
    Tox_Err_New err=TOX_ERR_NEW_OK;
    Tox_Err_New_Testing terr=TOX_ERR_NEW_TESTING_OK;
    Tox *tox=tox_new_testing(options,&err,&testing,&terr);
    tox_options_free(options);
    if(!tox || err!=TOX_ERR_NEW_OK || terr!=TOX_ERR_NEW_TESTING_OK){
        if(tox)tox_kill(tox);
        return 5;
    }
    uint8_t public_dht[TOX_PUBLIC_KEY_SIZE];
    tox_self_get_dht_id(tox,public_dht);
    printf("READY ");
    for(size_t i=0;i<sizeof(public_dht);++i)printf("%02x",public_dht[i]);
    printf("\n");fflush(stdout);
    sodium_memzero(public_dht,sizeof(public_dht));
    signal(SIGTERM,quit);
    signal(SIGINT,quit);
    const struct timespec pause_time={.tv_sec=0,.tv_nsec=12000000};
    while(alive){
        tox_iterate(tox,NULL);
        nanosleep(&pause_time,NULL);
    }
    tox_kill(tox);
    return 0;
}
