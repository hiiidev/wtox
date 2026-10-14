/*
 * Independently compiled original pinned c-toxcore savedata fixture.
 *
 * Modes: create FILE or verify FILE HEX_TOX_ID HEX_FRIEND_KEY.
 * Only public data are printed. Plaintext savedata and passphrase bytes
 * stay inside this LOCAL CI process. TEST PASSWORD IS NOT A REAL SECRET.
 * The program neither contacts the network nor uses wTox WASM functions.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sodium.h>
#include "toxcore/tox.h"
#include "toxencryptsave/toxencryptsave.h"

#define INTEROP_MAX_RAW (1024u*1024u)
static const uint8_t test_password[]="wtox-stage29-test-only-native-interoperability";
static const uint8_t native_name[]="Native Toxcore profile fixture";

static void wipe_free(void *p,size_t len)
{
    if(p){sodium_memzero(p,len);free(p);}
}
static Tox *create_original(const uint8_t *saved,size_t size)
{
    Tox_Err_Options_New oe=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts=tox_options_new(&oe);
    if(!opts || oe!=TOX_ERR_OPTIONS_NEW_OK)return NULL;
    tox_options_set_udp_enabled(opts,false);
    tox_options_set_ipv6_enabled(opts,false);
    tox_options_set_local_discovery_enabled(opts,false);
    if(saved){
        if(!size || size>INTEROP_MAX_RAW ||
           !tox_options_set_savedata_data(opts,saved,size)){
            tox_options_free(opts);return NULL;
        }
        tox_options_set_savedata_type(opts,TOX_SAVEDATA_TYPE_TOX_SAVE);
    }
    Tox_Err_New ne=TOX_ERR_NEW_OK;
    Tox *tox=tox_new(opts,&ne);
    tox_options_free(opts);
    if(ne!=TOX_ERR_NEW_OK){if(tox)tox_kill(tox);return NULL;}
    return tox;
}
static void to_hex(const uint8_t *bytes,size_t n,char *hex)
{
    static const char digits[]="0123456789abcdef";
    for(size_t i=0;i<n;i++){hex[2*i]=digits[bytes[i]>>4];hex[2*i+1]=digits[bytes[i]&15];}
    hex[2*n]=0;
}
static int from_hex(const char *str,size_t len,uint8_t *out)
{
    if(!str || strlen(str)!=2*len)return -1;
    for(size_t i=0;i<len;i++){
        const char a=str[i*2],b=str[i*2+1];
        const int x=(a>='0'&&a<='9')?a-'0':(a>='a'&&a<='f')?a-'a'+10:-1;
        const int y=(b>='0'&&b<='9')?b-'0':(b>='a'&&b<='f')?b-'a'+10:-1;
        if(x<0||y<0)return -1;
        out[i]=(uint8_t)((x<<4)|y);
    }
    return 0;
}
static int write_encrypted(const char *path,const uint8_t *data,size_t length)
{
    if(!data || !length || length>INTEROP_MAX_RAW)return -1;
    const size_t capacity=length+TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *encrypted=malloc(capacity);
    if(!encrypted)return -1;
    Tox_Err_Encryption error=TOX_ERR_ENCRYPTION_OK;
    const bool ok=tox_pass_encrypt(data,length,test_password,
                                   sizeof(test_password)-1,encrypted,&error);
    int ret=-1;
    if(ok && error==TOX_ERR_ENCRYPTION_OK){
        FILE *f=fopen(path,"wb");
        if(f){
            const bool fully_written=fwrite(encrypted,1,capacity,f)==capacity;
            const int closed=fclose(f);
            if(fully_written && closed==0)ret=0;
            else remove(path);
        }
    }
    wipe_free(encrypted,capacity);
    return ret;
}
static int read_and_decrypt(const char *path,uint8_t **out,size_t *out_len)
{
    *out=NULL;*out_len=0;
    FILE *f=fopen(path,"rb");
    if(!f)return -1;
    if(fseek(f,0,SEEK_END)!=0){fclose(f);return -1;}
    long end=ftell(f);
    if(end<=(long)TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
       end>(long)(INTEROP_MAX_RAW+TOX_PASS_ENCRYPTION_EXTRA_LENGTH) ||
       fseek(f,0,SEEK_SET)!=0){fclose(f);return -1;}
    const size_t length=(size_t)end;
    uint8_t *cipher=malloc(length);
    if(!cipher){fclose(f);return -1;}
    const bool full_read=fread(cipher,1,length,f)==length;
    const int closed=fclose(f);
    const bool complete=full_read && closed==0;
    if(!complete || !tox_is_data_encrypted(cipher)){
        wipe_free(cipher,length);return -1;
    }
    const size_t raw_len=length-TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *raw=malloc(raw_len);
    if(!raw){wipe_free(cipher,length);return -1;}
    Tox_Err_Decryption error=TOX_ERR_DECRYPTION_OK;
    const bool success=tox_pass_decrypt(cipher,length,test_password,
                            sizeof(test_password)-1,raw,&error);
    wipe_free(cipher,length);
    if(!success || error!=TOX_ERR_DECRYPTION_OK){
        wipe_free(raw,raw_len);return -1;
    }
    *out=raw;*out_len=raw_len;
    return 0;
}
static int create_file(const char *path)
{
    Tox *owner=create_original(NULL,0);
    Tox *friend=create_original(NULL,0);
    if(!owner || !friend){
        if(owner)tox_kill(owner);
        if(friend)tox_kill(friend);
        return 3;
    }
    uint8_t key[TOX_PUBLIC_KEY_SIZE],id[TOX_ADDRESS_SIZE];
    tox_self_get_public_key(friend,key);
    Tox_Err_Friend_Add fe=TOX_ERR_FRIEND_ADD_OK;
    Tox_Friend_Number number=tox_friend_add_norequest(owner,key,&fe);
    Tox_Err_Set_Info ie=TOX_ERR_SET_INFO_OK;
    const bool named=tox_self_set_name(owner,native_name,sizeof(native_name)-1,&ie);
    if(number!=0 || fe!=TOX_ERR_FRIEND_ADD_OK || !named ||
       ie!=TOX_ERR_SET_INFO_OK){
        tox_kill(owner);tox_kill(friend);
        return 4;
    }
    tox_self_get_address(owner,id);
    const size_t size=tox_get_savedata_size(owner);
    if(!size || size>INTEROP_MAX_RAW){tox_kill(owner);tox_kill(friend);return 5;}
    uint8_t *data=malloc(size);
    if(!data){tox_kill(owner);tox_kill(friend);return 5;}
    tox_get_savedata(owner,data);
    const int result=write_encrypted(path,data,size);
    wipe_free(data,size);
    if(result==0){
        char full[TOX_ADDRESS_SIZE*2+1],other[TOX_PUBLIC_KEY_SIZE*2+1];
        to_hex(id,TOX_ADDRESS_SIZE,full);
        to_hex(key,TOX_PUBLIC_KEY_SIZE,other);
        printf("CREATED %s %s\n",full,other);fflush(stdout);
    }
    sodium_memzero(key,sizeof(key));
    sodium_memzero(id,sizeof(id));
    tox_kill(owner);
    tox_kill(friend);
    return result==0?0:6;
}
static int verify_file(const char *path,const char *id_hex,
                       const char *key_hex)
{
    uint8_t id[TOX_ADDRESS_SIZE],key[TOX_PUBLIC_KEY_SIZE];
    if(from_hex(id_hex,sizeof(id),id)<0 ||
       from_hex(key_hex,sizeof(key),key)<0)return 2;
    uint8_t *saved=NULL;
    size_t size=0;
    if(read_and_decrypt(path,&saved,&size)!=0)return 3;
    Tox *owner=create_original(saved,size);
    wipe_free(saved,size);
    if(!owner)return 4;
    uint8_t actual_id[TOX_ADDRESS_SIZE],friend_key[TOX_PUBLIC_KEY_SIZE];
    tox_self_get_address(owner,actual_id);
    Tox_Err_Friend_Get_Public_Key error=TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK;
    const bool has_key=tox_friend_get_public_key(owner,0,friend_key,&error);
    const bool matching=tox_self_get_friend_list_size(owner)==1 &&
        has_key && error==TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK &&
        sodium_memcmp(actual_id,id,sizeof(id))==0 &&
        sodium_memcmp(friend_key,key,sizeof(key))==0;
    if(matching)puts("VERIFIED original native Tox ID and one friend public key");
    sodium_memzero(actual_id,sizeof(actual_id));
    sodium_memzero(friend_key,sizeof(friend_key));
    sodium_memzero(id,sizeof(id));
    sodium_memzero(key,sizeof(key));
    tox_kill(owner);
    return matching?0:5;
}
int main(int argc,char **argv)
{
    if(sodium_init()<0)return 10;
    if(argc==3 && strcmp(argv[1],"create")==0)return create_file(argv[2]);
    if(argc==5 && strcmp(argv[1],"verify")==0)
        return verify_file(argv[2],argv[3],argv[4]);
    fputs("Usage: tox-native-save-interop create FILE | verify FILE TOX_ID FRIEND_KEY\n",stderr);
    return 2;
}
