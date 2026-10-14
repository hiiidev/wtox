/*
 * Research-only bounded IPv4 UDP datagram bridge for original c-toxcore
 * Network_Funcs. Single socket, 16 x 2048 byte queues, loopback-only.
 * This is a prerequisite transport test, NOT DHT discovery or production.
 */
#include <toxcore/DHT.h>
#define WTOX_VUDP_SOCKET 0x5755
#define WTOX_VUDP_MAX 2048
#define WTOX_VUDP_SLOTS 16
typedef struct Wtox_Udp_Datagram {
    uint16_t len;
    uint16_t port; /* host order; wire connector checks destination */
    uint8_t bytes[WTOX_VUDP_MAX];
} Wtox_Udp_Datagram;
static Wtox_Udp_Datagram vudp_tx[WTOX_VUDP_SLOTS];
static Wtox_Udp_Datagram vudp_rx[WTOX_VUDP_SLOTS];
static unsigned vudp_tx_head, vudp_tx_count, vudp_rx_head, vudp_rx_count;
static bool vudp_socket_open, vudp_socket_bound;
static uint16_t vudp_local_port;
static uint16_t vudp_bootstrap_port;
static Tox *vudp_tox;
static bool vudp_friend_requested=false;
static uint32_t vudp_friend_online_events=0;
static uint32_t vudp_friend_inbound=0;
static uint8_t vudp_friend_message[128]={0};
static uint16_t vudp_friend_message_length=0;
static void vudp_friend_status_cb(Tox *tox, Tox_Friend_Number id,
                                   Tox_Connection status, void *unused)
{
    (void)unused;
    if(tox==vudp_tox && id==0 && status!=TOX_CONNECTION_NONE)
        ++vudp_friend_online_events;
}
static void vudp_friend_text_cb(Tox *tox, Tox_Friend_Number id,
                                 Tox_Message_Type type, const uint8_t *text,
                                 size_t len, void *unused)
{
    (void)unused;
    if(tox!=vudp_tox || id!=0 || type!=TOX_MESSAGE_TYPE_NORMAL ||
       !text || !len || len>sizeof(vudp_friend_message) ||
       vudp_friend_message_length!=0)return;
    memcpy(vudp_friend_message,text,len);
    vudp_friend_message_length=(uint16_t)len;
    ++vudp_friend_inbound;
}
static Network vudp_network;
static Tox_System vudp_system;
static uint32_t vudp_rejected, vudp_backpressure, vudp_sent, vudp_received;

static void vudp_flush(void)
{
    sodium_memzero(vudp_tx,sizeof(vudp_tx));
    sodium_memzero(vudp_rx,sizeof(vudp_rx));
    vudp_tx_head=vudp_rx_head=vudp_tx_count=vudp_rx_count=0;
}
static bool vudp_valid(Socket sock)
{
    return vudp_socket_open && net_socket_to_native(sock)==WTOX_VUDP_SOCKET;
}
static bool vudp_port_valid(uint16_t port)
{
    return port>=1025;
}
static Socket vudp_socket_cb(void *unused, int family, int type, int protocol)
{
    (void)unused;
    if (!vudp_socket_open && family==TOX_AF_INET &&
        type==TOX_SOCK_DGRAM && protocol==TOX_PROTO_UDP) {
        vudp_socket_open=true;
        return net_socket_from_native(WTOX_VUDP_SOCKET);
    }
    errno=EAFNOSUPPORT;
    return net_invalid_socket();
}
static int vudp_close_cb(void *unused, Socket sock)
{
    (void)unused;
    if (!vudp_valid(sock)) {errno=EBADF;return -1;}
    vudp_flush();
    vudp_socket_open=vudp_socket_bound=false;
    vudp_local_port=0;
    return 0;
}
static int vudp_bind_cb(void *unused, Socket sock, const IP_Port *address)
{
    (void)unused;
    if(!vudp_valid(sock)||vudp_socket_bound||!address ||
       !net_family_is_ipv4(address->ip.family) ||
       !vudp_port_valid(net_ntohs(address->port))) {
        errno=EINVAL;return -1;
    }
    const IP4 loopback=get_ip4_loopback();
    const uint32_t ip=address->ip.ip.v4.uint32;
    if(ip!=0 && ip!=loopback.uint32) {errno=EACCES;return -1;}
    vudp_local_port=net_ntohs(address->port);
    vudp_socket_bound=true;
    return 0;
}
static int vudp_nonblock_cb(void *unused, Socket sock, bool enabled)
{
    (void)unused;
    if(!vudp_valid(sock) || !enabled) {errno=EINVAL;return -1;}
    return 0;
}
static int vudp_buffer_cb(void *unused, Socket sock)
{
    (void)unused;
    if(!vudp_valid(sock)) {errno=EBADF;return -1;}
    return (int)(vudp_rx_count * WTOX_VUDP_MAX);
}
static int vudp_sendto_cb(void *unused, Socket sock, const uint8_t *data,
                           size_t length, const IP_Port *dest)
{
    (void)unused;
    const IP4 loopback=get_ip4_loopback();
    if(!vudp_valid(sock)||!vudp_socket_bound||!data||!dest ||
       !net_family_is_ipv4(dest->ip.family) ||
       dest->ip.ip.v4.uint32!=loopback.uint32 ||
       !vudp_port_valid(net_ntohs(dest->port)) ||
       length==0 || length>WTOX_VUDP_MAX) {
        ++vudp_rejected;errno=EACCES;return -1;
    }
    if(vudp_tx_count==WTOX_VUDP_SLOTS) {
        ++vudp_backpressure;errno=EWOULDBLOCK;return -1;
    }
    Wtox_Udp_Datagram *pkt=&vudp_tx[(vudp_tx_head+vudp_tx_count)%WTOX_VUDP_SLOTS];
    pkt->len=(uint16_t)length;
    pkt->port=net_ntohs(dest->port);
    memcpy(pkt->bytes,data,length);
    ++vudp_tx_count;
    ++vudp_sent;
    return (int)length;
}
static int vudp_recvfrom_cb(void *unused, Socket sock, uint8_t *data,
                             size_t capacity, IP_Port *from)
{
    (void)unused;
    if(!vudp_valid(sock)||!vudp_socket_bound||!data||!from||!capacity) {
        errno=EINVAL;return -1;
    }
    if(!vudp_rx_count) {errno=EWOULDBLOCK;return -1;}
    Wtox_Udp_Datagram *pkt=&vudp_rx[vudp_rx_head];
    const size_t n=capacity<pkt->len?capacity:pkt->len;
    memcpy(data,pkt->bytes,n);
    memset(from,0,sizeof(*from));
    from->ip.family=net_family_ipv4();
    from->ip.ip.v4=get_ip4_loopback();
    from->port=net_htons(pkt->port);
    sodium_memzero(pkt,sizeof(*pkt));
    vudp_rx_head=(vudp_rx_head+1)%WTOX_VUDP_SLOTS;
    --vudp_rx_count;
    ++vudp_received;
    return (int)n; /* atomic datagram semantics, truncated if necessary */
}
static const Network_Funcs vudp_funcs={
    .close=vudp_close_cb,
    .accept=probe_accept,
    .bind=vudp_bind_cb,
    .listen=probe_listen,
    .connect=probe_connect,
    .recvbuf=vudp_buffer_cb,
    .recv=probe_recv,
    .recvfrom=vudp_recvfrom_cb,
    .send=probe_send,
    .sendto=vudp_sendto_cb,
    .socket=vudp_socket_cb,
    .socket_nonblock=vudp_nonblock_cb,
    .getsockopt=probe_getsockopt,
    .setsockopt=probe_setsockopt,
    .getaddrinfo=probe_getaddrinfo,
    .freeaddrinfo=probe_freeaddrinfo,
};
EMSCRIPTEN_KEEPALIVE
void wtox_vudp_probe_stop(void)
{
    if(vudp_tox) {tox_kill(vudp_tox);vudp_tox=NULL;}
    vudp_flush();
    vudp_socket_open=vudp_socket_bound=false;
    vudp_local_port=0;
    vudp_bootstrap_port=0;
    vudp_friend_requested=false;
    vudp_friend_online_events=vudp_friend_inbound=0;
    sodium_memzero(vudp_friend_message,sizeof(vudp_friend_message));
    vudp_friend_message_length=0;
    vudp_rejected=vudp_backpressure=vudp_sent=vudp_received=0;
}
/* Both fresh and restored identities use the SAME UDP Network_Funcs and
 * original tox_new_testing. Savedata is only ever provided to Toxcore in
 * plaintext inside WASM; callers may export only encrypted ToxEncryptSave. */
static int vudp_start_internal(const uint8_t *saved, size_t saved_len)
{
    if(vudp_tox || wtox_live || sodium_init()<0) return -1;
    if((saved && (!saved_len || saved_len>MAX_RAW_SAVEDATA)) ||
       (!saved && saved_len))return -1;
    wtox_vudp_probe_stop();
    vudp_network.funcs=&vudp_funcs;
    vudp_network.obj=NULL;
    vudp_system=tox_default_system();
    vudp_system.ns=&vudp_network;
    Tox_Options_Testing testing={.operating_system=&vudp_system};
    Tox_Err_Options_New oerr=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opt=tox_options_new(&oerr);
    if(!opt || oerr!=TOX_ERR_OPTIONS_NEW_OK){
        if(opt)tox_options_free(opt);
        return -2;
    }
    tox_options_set_udp_enabled(opt,true);
    tox_options_set_ipv6_enabled(opt,false);
    tox_options_set_local_discovery_enabled(opt,false);
    tox_options_set_experimental_disable_dns(opt,true);
    tox_options_set_start_port(opt,33447);
    tox_options_set_end_port(opt,33447);
    if(saved){
        if(!tox_options_set_savedata_data(opt,saved,saved_len)){
            tox_options_free(opt);
            return -3;
        }
        tox_options_set_savedata_type(opt,TOX_SAVEDATA_TYPE_TOX_SAVE);
    }
    Tox_Err_New terr=TOX_ERR_NEW_OK;
    Tox_Err_New_Testing perr=TOX_ERR_NEW_TESTING_OK;
    Tox *tox=tox_new_testing(opt,&terr,&testing,&perr);
    tox_options_free(opt);
    if(!tox || terr!=TOX_ERR_NEW_OK || perr!=TOX_ERR_NEW_TESTING_OK ||
       !vudp_socket_open || !vudp_socket_bound ||
       vudp_local_port!=33447 || tox_get_system(tox)->ns!=&vudp_network){
        if(tox)tox_kill(tox);
        wtox_vudp_probe_stop();
        return -4;
    }
    const size_t friend_count=tox_self_get_friend_list_size(tox);
    if(friend_count>1){
        tox_kill(tox);
        wtox_vudp_probe_stop();
        return -5; /* this research adapter deliberately supports one friend */
    }
    vudp_tox=tox;
    vudp_friend_requested=friend_count==1;
    tox_callback_friend_connection_status(tox,vudp_friend_status_cb);
    tox_callback_friend_message(tox,vudp_friend_text_cb);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_start(void)
{
    return vudp_start_internal(NULL,0);
}
EMSCRIPTEN_KEEPALIVE
size_t wtox_vudp_savedata_size(void)
{
    if(!vudp_tox)return 0;
    const size_t n=tox_get_savedata_size(vudp_tox);
    return n && n<=MAX_RAW_SAVEDATA?n:0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_export_encrypted(const uint8_t *password,size_t plen,
                                uint8_t *out,size_t capacity,size_t *written)
{
    if(!vudp_tox || !valid_password(password,plen) ||
       !out || !written || sodium_init()<0)return -1;
    *written=0;
    const size_t n=wtox_vudp_savedata_size();
    if(!n || n>SIZE_MAX-TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
       capacity<n+TOX_PASS_ENCRYPTION_EXTRA_LENGTH)return -2;
    uint8_t *plain=(uint8_t *)malloc(n);
    if(!plain)return -3;
    tox_get_savedata(vudp_tox,plain);
    Tox_Err_Encryption err=TOX_ERR_ENCRYPTION_OK;
    const bool ok=tox_pass_encrypt(plain,n,password,plen,out,&err);
    sodium_memzero(plain,n);
    free(plain);
    if(!ok || err!=TOX_ERR_ENCRYPTION_OK){
        sodium_memzero(out,capacity);
        return -4;
    }
    *written=n+TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_restore_encrypted(const uint8_t *encrypted,size_t length,
                                 const uint8_t *password,size_t plen)
{
    if(vudp_tox || wtox_live || !encrypted ||
       !valid_password(password,plen) ||
       length<=TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
       length>MAX_RAW_SAVEDATA+TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
       sodium_init()<0)return -1;
    if(!tox_is_data_encrypted(encrypted))return -2;
    const size_t n=length-TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *plain=(uint8_t *)malloc(n);
    if(!plain)return -3;
    Tox_Err_Decryption err=TOX_ERR_DECRYPTION_OK;
    const bool ok=tox_pass_decrypt(encrypted,length,password,plen,plain,&err);
    int result=-4;
    if(ok && err==TOX_ERR_DECRYPTION_OK)
        result=vudp_start_internal(plain,n);
    sodium_memzero(plain,n);
    free(plain);
    return result;
}
/* User data is sent through ORIGINAL ns_sendto, not straight into queue. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_send(const uint8_t *bytes, size_t len, uint16_t port)
{
    if(!vudp_tox || !bytes || !vudp_port_valid(port) ||
       len==0 || len>WTOX_VUDP_MAX) return -1;
    IP_Port target={0};
    target.ip.family=net_family_ipv4();
    target.ip.ip.v4=get_ip4_loopback();
    target.port=net_htons(port);
    return ns_sendto(&vudp_network,net_socket_from_native(WTOX_VUDP_SOCKET),
                     bytes,len,&target);
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_reject_remote(const uint8_t *bytes, size_t len, uint16_t port)
{
    if(!vudp_tox || !bytes || !len || len>WTOX_VUDP_MAX) return -1;
    IP_Port target={0};
    target.ip.family=net_family_ipv4();
    target.ip.ip.v4.uint8[0]=8;
    target.ip.ip.v4.uint8[1]=8;
    target.ip.ip.v4.uint8[2]=8;
    target.ip.ip.v4.uint8[3]=8;
    target.port=net_htons(port);
    return ns_sendto(&vudp_network,net_socket_from_native(WTOX_VUDP_SOCKET),
                     bytes,len,&target);
}
/* JS transport reads exactly one complete outbound datagram each call. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_take(uint8_t *out, size_t cap, uint16_t *port)
{
    if(!vudp_tox||!out||!port||!cap) return -1;
    if(!vudp_tx_count)return 0;
    Wtox_Udp_Datagram *pkt=&vudp_tx[vudp_tx_head];
    if(cap<pkt->len)return -2; /* do not drop oversized datagram */
    const int n=pkt->len;
    *port=pkt->port;
    memcpy(out,pkt->bytes,n);
    sodium_memzero(pkt,sizeof(*pkt));
    vudp_tx_head=(vudp_tx_head+1)%WTOX_VUDP_SLOTS;
    --vudp_tx_count;
    return n;
}
/* The bridge may deliver only pre-validated loopback source datagrams. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_push(const uint8_t *bytes, size_t len, uint16_t source_port)
{
    if(!vudp_tox||!bytes||!vudp_port_valid(source_port)||
       !len||len>WTOX_VUDP_MAX)return -1;
    if(vudp_rx_count==WTOX_VUDP_SLOTS) {
        ++vudp_backpressure;return -11;
    }
    Wtox_Udp_Datagram *pkt=&vudp_rx[(vudp_rx_head+vudp_rx_count)%WTOX_VUDP_SLOTS];
    pkt->len=(uint16_t)len;
    pkt->port=source_port;
    memcpy(pkt->bytes,bytes,len);
    ++vudp_rx_count;
    return (int)len;
}
/* Original ns_recvfrom must restore the source address and datagram. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_read(uint8_t *out, size_t cap, uint16_t *source_port)
{
    if(!vudp_tox||!out||!source_port||cap<WTOX_VUDP_MAX)return -1;
    IP_Port from={0};
    int n=ns_recvfrom(&vudp_network,net_socket_from_native(WTOX_VUDP_SOCKET),
                      out,WTOX_VUDP_MAX,&from);
    if(n<0) return errno==EWOULDBLOCK?0:-2;
    if(!net_family_is_ipv4(from.ip.family) ||
       from.ip.ip.v4.uint32!=get_ip4_loopback().uint32)return -3;
    *source_port=net_ntohs(from.port);
    return n;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_probe_stats(uint32_t out[8])
{
    if(!out)return -1;
    out[0]=vudp_socket_open?1:0;
    out[1]=vudp_socket_bound?vudp_local_port:0;
    out[2]=vudp_tx_count;out[3]=vudp_rx_count;
    out[4]=vudp_rejected;out[5]=vudp_backpressure;
    out[6]=vudp_sent;out[7]=vudp_received;
    return 0;
}

/* Stage 25d: original DHT bootstrap, not synthetic UDP echo. The only
 * reachable address is the isolated loopback UDP endpoint. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_bootstrap(uint16_t port, const uint8_t *public_key, size_t length)
{
    if (!vudp_tox || !vudp_port_valid(port) || !public_key ||
        length != TOX_PUBLIC_KEY_SIZE) return -1;
    Tox_Err_Bootstrap error = TOX_ERR_BOOTSTRAP_OK;
    bool ok=tox_bootstrap(vudp_tox,"127.0.0.1",port,public_key,&error);
    if (!ok || error != TOX_ERR_BOOTSTRAP_OK) return -2;
    vudp_bootstrap_port=port;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_tick(void)
{
    if (!vudp_tox) return -1;
    tox_iterate(vudp_tox,NULL);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_connection(void)
{
    if (!vudp_tox) return -1;
    return (int)tox_self_get_connection_status(vudp_tox);
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_dht_public(uint8_t *out, size_t capacity)
{
    if (!vudp_tox || !out || capacity != TOX_PUBLIC_KEY_SIZE) return -1;
    tox_self_get_dht_id(vudp_tox,out);
    return 0;
}

/* The upstream Tox self connection enum excludes LAN-only UDP peers from
 * UDP_CONNECTED. For isolated 127.0.0.1 DHT, use the authenticated DHT
 * client closelist instead of demanding false "public UDP" connectivity.
 * Compare native original DHT identity, source port and valid IPv4 entry. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_bootstrap_verified(const uint8_t *key, size_t len)
{
    if (!vudp_tox || !key || len!=TOX_PUBLIC_KEY_SIZE ||
        !vudp_port_valid(vudp_bootstrap_port)) return -1;
    const DHT *dht=vudp_tox->m->dht;
    if(!dht)return -2;
    const Client_data *list=dht_get_close_clientlist(dht);
    if(!list)return -2;
    for(uint32_t i=0;i<LCLIENT_LIST;i++){
        const Client_data *peer=&list[i];
        if(peer->assoc4.timestamp!=0 &&
           net_family_is_ipv4(peer->assoc4.ip_port.ip.family) &&
           peer->assoc4.ip_port.ip.ip.v4.uint32==get_ip4_loopback().uint32 &&
           net_ntohs(peer->assoc4.ip_port.port)==vudp_bootstrap_port &&
           sodium_memcmp(peer->public_key,key,TOX_PUBLIC_KEY_SIZE)==0)
            return 1;
    }
    return 0;
}

/* Genuine first-contact Tox ID API on UDP-enabled browser Toxcore.
 * This calls ONLY original tox_friend_add, no artificial peer DHT key. */
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_address(uint8_t *out,size_t cap)
{
    if(!vudp_tox || !out || cap!=TOX_ADDRESS_SIZE)return -1;
    tox_self_get_address(vudp_tox,out);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_friend_request(const uint8_t *address,size_t alen,
                                     const uint8_t *message,size_t mlen)
{
    if(!vudp_tox || vudp_friend_requested || !address ||
       alen!=TOX_ADDRESS_SIZE || !message || !mlen || mlen>128)
        return -1;
    Tox_Err_Friend_Add error=TOX_ERR_FRIEND_ADD_OK;
    Tox_Friend_Number index=tox_friend_add(vudp_tox,address,message,mlen,&error);
    if(error!=TOX_ERR_FRIEND_ADD_OK || index!=0)return -10-(int)error;
    vudp_friend_requested=true;
    tox_callback_friend_connection_status(vudp_tox,vudp_friend_status_cb);
    tox_callback_friend_message(vudp_tox,vudp_friend_text_cb);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_friend_state(uint32_t out[4])
{
    if(!vudp_tox || !out)return -1;
    out[0]=vudp_friend_requested?1:0;
    Tox_Err_Friend_Query error=TOX_ERR_FRIEND_QUERY_OK;
    Tox_Connection connection=TOX_CONNECTION_NONE;
    if(vudp_friend_requested)
        connection=tox_friend_get_connection_status(vudp_tox,0,&error);
    if(error!=TOX_ERR_FRIEND_QUERY_OK)return -2;
    out[1]=(uint32_t)connection;
    out[2]=vudp_friend_online_events;
    out[3]=vudp_friend_inbound;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_friend_send(const uint8_t *message,size_t length)
{
    if(!vudp_tox || !vudp_friend_requested || !message ||
       !length || length>128)return -1;
    Tox_Err_Friend_Send_Message err=TOX_ERR_FRIEND_SEND_MESSAGE_OK;
    tox_friend_send_message(vudp_tox,0,TOX_MESSAGE_TYPE_NORMAL,
                            message,length,&err);
    return err==TOX_ERR_FRIEND_SEND_MESSAGE_OK?0:-10-(int)err;
}
EMSCRIPTEN_KEEPALIVE
int wtox_vudp_native_friend_take(uint8_t *out,size_t capacity)
{
    if(!vudp_tox || !out || capacity<sizeof(vudp_friend_message))return -1;
    int n=vudp_friend_message_length;
    if(!n)return 0;
    memcpy(out,vudp_friend_message,(size_t)n);
    sodium_memzero(vudp_friend_message,sizeof(vudp_friend_message));
    vudp_friend_message_length=0;
    return n;
}
