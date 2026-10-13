/*
 * Isolated Linux-native Tox peer (not WASM), linked against original pinned
 * c-toxcore. Standard public Tox friend APIs and real OS TCP socket to
 * ORIGINAL upstream TCP_Server; only peer DHT discovery is test-injected.
 * No public bootstrap servers, no UDP, no remote network, no user credentials.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sodium.h>
#include "toxcore/tox.h"
#include "toxcore/tox_options.h"
#include "toxcore/tox_struct.h"
#include "toxcore/Messenger.h"
#include "toxcore/friend_connection.h"
#include "toxcore/net_crypto.h"
#include "toxcore/TCP_connection.h"

#define COMMAND_LIMIT 256
#define TEXT_LIMIT 128
static Tox *client = NULL;
static int friendcon = -1;
static bool relay_attached = false;
static bool friend_online = false;
static unsigned message_count = 0;
static unsigned online_count = 0;
static const char reply[] = "From-B: independent Linux native Tox client";

static int parse_key(const char *hex, uint8_t out[32])
{
    if (!hex || strlen(hex) != 64) return -1;
    for (int i=0; i<32; ++i) {
        const char a=hex[2*i], b=hex[2*i+1];
        const int hi = a >= '0' && a <= '9' ? a-'0' :
                       a >= 'a' && a <= 'f' ? a-'a'+10 : -1;
        const int lo = b >= '0' && b <= '9' ? b-'0' :
                       b >= 'a' && b <= 'f' ? b-'a'+10 : -1;
        if (hi < 0 || lo < 0) return -1;
        out[i]=(uint8_t)((hi<<4)|lo);
    }
    return 0;
}
static void print_hex(const uint8_t *bytes, size_t len)
{
    for (size_t i=0;i<len;++i) printf("%02x",bytes[i]);
}
static void on_status(Tox *tox, Tox_Friend_Number id, Tox_Connection status, void *unused)
{
    (void)unused;
    if (tox!=client || id!=0 || friendcon!=0) return;
    const bool online=status!=TOX_CONNECTION_NONE;
    if (online && !friend_online) {
        ++online_count;
        printf("ONLINE\n");
        fflush(stdout);
    }
    friend_online=online;
}
static void on_message(Tox *tox, Tox_Friend_Number id, Tox_Message_Type type,
                       const uint8_t *message, size_t len, void *unused)
{
    (void)unused;
    if (tox!=client || id!=0 || friendcon!=0 ||
        type!=TOX_MESSAGE_TYPE_NORMAL || !message ||
        len==0 || len>TEXT_LIMIT || message_count!=0) {
        printf("ERROR invalid_native_message\n");
        fflush(stdout);
        return;
    }
    ++message_count;
    printf("MESSAGE ");
    print_hex(message,len);
    putchar('\n');
    fflush(stdout);
}
static int process_command(const char *line)
{
    if (!strncmp(line,"PEER ",5)) {
        if (friendcon>=0 || strlen(line)!=5+64+1+64 || line[69]!=' ') return -1;
        uint8_t real[32]={0}, dht[32]={0}, own[32]={0};
        char real_hex[65]={0}, dht_hex[65]={0};
        memcpy(real_hex,line+5,64);
        memcpy(dht_hex,line+70,64);
        if (parse_key(real_hex,real)!=0 || parse_key(dht_hex,dht)!=0) return -1;
        tox_self_get_public_key(client,own);
        if (sodium_memcmp(own,real,32)==0) return -1;
        Tox_Err_Friend_Add err=TOX_ERR_FRIEND_ADD_OK;
        Tox_Friend_Number number=tox_friend_add_norequest(client,real,&err);
        if (err!=TOX_ERR_FRIEND_ADD_OK || number!=0) return -1;
        const int id=getfriend_conn_id_pk(client->m->fr_c,real);
        if (id!=0) return -1;
        friendcon=id;
        set_dht_temp_pk(client->m->fr_c,id,dht,NULL);
        sodium_memzero(real,sizeof(real));
        sodium_memzero(dht,sizeof(dht));
        sodium_memzero(own,sizeof(own));
        printf("PEER_SET\n"); fflush(stdout);
        return 0;
    }
    if (!strcmp(line,"SEND")) {
        if (!friend_online || !relay_attached) return -1;
        Tox_Err_Friend_Send_Message err=TOX_ERR_FRIEND_SEND_MESSAGE_OK;
        tox_friend_send_message(client,0,TOX_MESSAGE_TYPE_NORMAL,
             (const uint8_t *)reply,strlen(reply),&err);
        if (err!=TOX_ERR_FRIEND_SEND_MESSAGE_OK) return -1;
        printf("SENT\n"); fflush(stdout);
        return 0;
    }
    return -1;
}
int main(int argc, char **argv)
{
    if (argc!=3 || sodium_init()<0) return 2;
    char *end=NULL;
    const unsigned long n=strtoul(argv[1],&end,10);
    if (!end || *end || n<1025 || n>65535) return 2;
    uint8_t relay_pk[32]={0};
    if (parse_key(argv[2],relay_pk)!=0) return 2;

    Tox_Err_Options_New options_error=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *options=tox_options_new(&options_error);
    if (!options || options_error!=TOX_ERR_OPTIONS_NEW_OK) return 3;
    tox_options_set_ipv6_enabled(options,false);
    tox_options_set_udp_enabled(options,false);
    tox_options_set_local_discovery_enabled(options,false);
    Tox_Err_New error=TOX_ERR_NEW_OK;
    client=tox_new(options,&error);
    tox_options_free(options);
    if (!client || error!=TOX_ERR_NEW_OK) return 4;
    Tox_Err_Bootstrap bootstrap=TOX_ERR_BOOTSTRAP_OK;
    const bool added=tox_add_tcp_relay(client,"127.0.0.1",(uint16_t)n,relay_pk,&bootstrap);
    sodium_memzero(relay_pk,sizeof(relay_pk));
    if (!added || bootstrap!=TOX_ERR_BOOTSTRAP_OK) {tox_kill(client);return 5;}
    tox_callback_friend_connection_status(client,on_status);
    tox_callback_friend_message(client,on_message);

    uint8_t real[32],dht[32];
    tox_self_get_public_key(client,real);
    tox_self_get_dht_id(client,dht);
    printf("READY ");
    print_hex(real,sizeof(real));
    putchar(' ');
    print_hex(dht,sizeof(dht));
    putchar('\n'); fflush(stdout);

    const int oldflags=fcntl(STDIN_FILENO,F_GETFL);
    if (oldflags<0 || fcntl(STDIN_FILENO,F_SETFL,oldflags|O_NONBLOCK)!=0)
        {tox_kill(client);return 6;}
    char buf[COMMAND_LIMIT]={0};
    size_t used=0;
    const struct timespec rest={.tv_sec=0,.tv_nsec=15000000};
    bool alive=true;
    while (alive) {
        char incoming[128];
        ssize_t count=read(STDIN_FILENO,incoming,sizeof(incoming));
        if (count==0) break;
        if (count<0 && errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR) break;
        for (ssize_t i=0;i<count;++i) {
            const char c=incoming[i];
            if (c=='\n') {
                buf[used]=0;
                if (process_command(buf)!=0) {
                    printf("ERROR invalid_native_command\n");
                    fflush(stdout);
                    alive=false;
                    break;
                }
                used=0;
            } else if ((unsigned char)c<32 || (unsigned char)c>126 ||
                       used+1>=sizeof(buf)) {
                alive=false;
                break;
            } else {
                buf[used++]=c;
            }
        }
        if (!alive) break;
        tox_iterate(client,NULL);
        if (friendcon==0 && !relay_attached) {
            const int id=friend_connection_crypt_connection_id(client->m->fr_c,0);
            TCP_Connections *tc=nc_get_tcp_c(client->m->net_crypto);
            if (tc && tcp_connected_relays_count(tc)==1 && id>=0) {
                if (id!=0 || add_tcp_number_relay_connection(tc,0,0)!=0) {
                    printf("ERROR native_relay_route\n"); fflush(stdout);
                    break;
                }
                relay_attached=true;
            }
        }
        nanosleep(&rest,NULL);
    }
    tox_kill(client);
    sodium_memzero(real,sizeof(real));
    sodium_memzero(dht,sizeof(dht));
    return 0;
}
