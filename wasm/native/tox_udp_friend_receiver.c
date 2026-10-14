/*
 * Isolated first-contact receiver + independent bootstrap, original pinned
 * c-toxcore public API. Loopback-only OS UDP. Neither node knows browser's
 * public identity or DHT key before original Onion friend request arrives.
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

static const Network *host=NULL;
static volatile sig_atomic_t running=1;
static Tox *receiver=NULL;
static unsigned requests=0,online=0,received=0;
static unsigned sent=0;
static const uint8_t request_text[]="wTox stage25e original Onion browser request";
static const uint8_t browser_text[]="wTox browser original friend text";
static const uint8_t native_text[]="wTox native original friend reply";
static const uint8_t browser_text_after[]="wTox browser message after restored identity";
static const uint8_t native_text_after[]="wTox native reply after restored identity";
static void stop(int sig){(void)sig;running=0;}
static bool local(const IP_Port *ip){
    return ip && net_family_is_ipv4(ip->ip.family) &&
           ip->ip.ip.v4.uint32==get_ip4_loopback().uint32;
}
static int bind_local(void *unused,Socket socket,const IP_Port *address){
    (void)unused;
    if(!address || !net_family_is_ipv4(address->ip.family)){
        errno=EACCES;return -1;
    }
    IP_Port loop=*address;loop.ip.ip.v4=get_ip4_loopback();
    return host->funcs->bind(host->obj,socket,&loop);
}
static int send_local(void *unused,Socket socket,const uint8_t *data,
                      size_t len,const IP_Port *dest){
    (void)unused;
    if(!local(dest)){errno=EACCES;return -1;}
    return host->funcs->sendto(host->obj,socket,data,len,dest);
}
static int connect_local(void *unused,Socket socket,const IP_Port *dest){
    (void)unused;
    if(!local(dest)){errno=EACCES;return -1;}
    return host->funcs->connect(host->obj,socket,dest);
}
static Tox *start_node(uint16_t port,const Tox_System *system){
    Tox_Err_Options_New oe=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options=tox_options_new(&oe);
    if(!options || oe!=TOX_ERR_OPTIONS_NEW_OK)return NULL;
    tox_options_set_udp_enabled(options,true);
    tox_options_set_ipv6_enabled(options,false);
    tox_options_set_local_discovery_enabled(options,false);
    tox_options_set_experimental_disable_dns(options,true);
    tox_options_set_start_port(options,port);
    tox_options_set_end_port(options,port);
    Tox_Options_Testing testing={.operating_system=system};
    Tox_Err_New ne=TOX_ERR_NEW_OK;
    Tox_Err_New_Testing te=TOX_ERR_NEW_TESTING_OK;
    Tox *node=tox_new_testing(options,&ne,&testing,&te);
    tox_options_free(options);
    if(!node || ne!=TOX_ERR_NEW_OK || te!=TOX_ERR_NEW_TESTING_OK){
        if(node)tox_kill(node);
        return NULL;
    }
    return node;
}
static void request_cb(Tox *tox,const uint8_t *sender,
                       const uint8_t *message,size_t len,void *ignored){
    (void)ignored;
    if(tox!=receiver || !sender || !message ||
       len!=sizeof(request_text)-1 ||
       memcmp(message,request_text,len)!=0 || requests!=0){
        puts("ERROR invalid_request");fflush(stdout);running=0;return;
    }
    Tox_Err_Friend_Add err=TOX_ERR_FRIEND_ADD_OK;
    if(tox_friend_add_norequest(receiver,sender,&err)!=0 ||
       err!=TOX_ERR_FRIEND_ADD_OK){
        puts("ERROR failed_accept");fflush(stdout);running=0;return;
    }
    requests++;
    printf("REQUEST_RECEIVED ");
    for(int i=0;i<TOX_PUBLIC_KEY_SIZE;i++)printf("%02x",sender[i]);
    putchar('\n');fflush(stdout);
}
static void status_cb(Tox *tox,Tox_Friend_Number id,Tox_Connection state,
                      void *ignored){
    (void)ignored;
    if(tox!=receiver || id!=0)return;
    if(state!=TOX_CONNECTION_NONE){
        online++;
        puts("FRIEND_ONLINE");fflush(stdout);
    }
}
static void message_cb(Tox *tox,Tox_Friend_Number id,Tox_Message_Type type,
                       const uint8_t *message,size_t n,void *ignored){
    (void)ignored;
    const uint8_t *expected=received==0?browser_text:browser_text_after;
    const size_t expected_n=received==0?sizeof(browser_text)-1:
                                              sizeof(browser_text_after)-1;
    if(tox!=receiver || id!=0 || type!=TOX_MESSAGE_TYPE_NORMAL ||
       !message || n!=expected_n || memcmp(message,expected,n)!=0 ||
       received>=2){
        puts("ERROR invalid_text");fflush(stdout);running=0;return;
    }
    received++;
    puts("TEXT_RECEIVED");fflush(stdout);
}
static uint16_t port(const char *text){
    errno=0;char *end=NULL;
    unsigned long n=strtoul(text,&end,10);
    return errno||!end||*end||n<1025||n>65535?0:(uint16_t)n;
}
int main(int argc,char **argv){
    if(argc!=3 || sodium_init()<0)return 2;
    uint16_t bp=port(argv[1]),rp=port(argv[2]);
    if(!bp || !rp || bp==rp)return 2;
    Tox_System sys=tox_default_system();
    if(!sys.ns || !sys.ns->funcs)return 3;
    host=sys.ns;
    Network_Funcs methods=*host->funcs;
    methods.bind=bind_local;
    methods.sendto=send_local;
    methods.connect=connect_local;
    Network local_ns={.funcs=&methods,.obj=NULL};
    sys.ns=&local_ns;
    Tox *bootstrap=start_node(bp,&sys);
    receiver=start_node(rp,&sys);
    if(!bootstrap || !receiver){
        if(receiver)tox_kill(receiver);
        if(bootstrap)tox_kill(bootstrap);
        return 4;
    }
    uint8_t dht[TOX_PUBLIC_KEY_SIZE];
    uint8_t address[TOX_ADDRESS_SIZE];
    tox_self_get_dht_id(bootstrap,dht);
    tox_self_get_address(receiver,address);
    Tox_Err_Bootstrap be=TOX_ERR_BOOTSTRAP_OK;
    if(!tox_bootstrap(receiver,"127.0.0.1",bp,dht,&be) ||
       be!=TOX_ERR_BOOTSTRAP_OK){
        tox_kill(receiver);tox_kill(bootstrap);
        return 5;
    }
    tox_callback_friend_request(receiver,request_cb);
    tox_callback_friend_connection_status(receiver,status_cb);
    tox_callback_friend_message(receiver,message_cb);
    printf("READY ");
    for(size_t i=0;i<sizeof(dht);i++)printf("%02x",dht[i]);
    putchar(' ');
    for(size_t i=0;i<sizeof(address);i++)printf("%02x",address[i]);
    putchar('\n');fflush(stdout);
    sodium_memzero(dht,sizeof(dht));sodium_memzero(address,sizeof(address));
    signal(SIGTERM,stop);signal(SIGINT,stop);
    const struct timespec delay={.tv_sec=0,.tv_nsec=12000000};
    while(running){
        tox_iterate(bootstrap,NULL);
        tox_iterate(receiver,NULL);
        if(received>sent && online){
            const uint8_t *reply=sent==0?native_text:native_text_after;
            const size_t n=sent==0?sizeof(native_text)-1:
                                       sizeof(native_text_after)-1;
            Tox_Err_Friend_Send_Message err=TOX_ERR_FRIEND_SEND_MESSAGE_OK;
            tox_friend_send_message(receiver,0,TOX_MESSAGE_TYPE_NORMAL,
                                     reply,n,&err);
            if(err!=TOX_ERR_FRIEND_SEND_MESSAGE_OK){
                puts("ERROR native_send");fflush(stdout);break;
            }
            ++sent;
            puts("TEXT_SENT");fflush(stdout);
        }
        nanosleep(&delay,NULL);
    }
    tox_kill(receiver);tox_kill(bootstrap);
    return 0;
}
