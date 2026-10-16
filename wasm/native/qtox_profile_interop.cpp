/*
 * Independent TokTok/qTox profile-crypto interoperability CLI (CI ONLY).
 *
 * This binary links UNMODIFIED TokTok/qTox src/core/toxencrypt.cpp
 * at an exact pinned upstream commit, including its real Qt QString ->
 * UTF-8 passphrase handling and qTox profile ToxEncrypt key derivation.
 *
 * Original c-toxcore supplies real identity, savedata, and friend roster.
 * The test generates disposable profiles and never contacts a network.
 * This is not the full unmodified qTox GUI.
 */
#include <QByteArray>
#include <QString>
#include <QtGlobal>
#include <sodium.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include "src/core/toxencrypt.h"
#include "toxcore/tox.h"
#include "toxencryptsave/toxencryptsave.h"

namespace {
constexpr size_t kMaxRaw = 1024*1024;
const QString kPassword = QStringLiteral("wtox-qtox-Qt-test-only-interoperability");
// Exercise both UNMODIFIED upstream qTox APIs with a UTF-8 password:
// makeToxEncrypt cached key (normal profile) and direct encryptPass/decryptPass.
// QString::toUtf8() returns QByteArray; QByteArray::length() counts bytes.
// Fixture is disposable, NOT a user secret or claim about the full qTox GUI.
const QString kUnicodePassword=QString::fromUtf8("wtox-互通🔐-пароль-安全-2026");
const uint8_t kName[]="TokTok qTox upstream ToxEncrypt CI fixture";

bool parse_hex(const char *text,size_t n,uint8_t *bytes) {
    if (!text || std::strlen(text)!=2*n)return false;
    for(size_t i=0;i<n;i++){
        const char a=text[2*i],b=text[2*i+1];
        auto digit=[](char c)->int{
            if(c>='0'&&c<='9')return c-'0';
            if(c>='a'&&c<='f')return c-'a'+10;
            return -1;
        };
        const int hi=digit(a),lo=digit(b);
        if(hi<0||lo<0)return false;
        bytes[i]=uint8_t((hi<<4)|lo);
    }
    return true;
}
void print_hex(const uint8_t *bytes,size_t n) {
    static constexpr char digits[]="0123456789abcdef";
    for(size_t i=0;i<n;i++) {
        std::putchar(digits[bytes[i]>>4]);
        std::putchar(digits[bytes[i]&15]);
    }
}
Tox *create_tox(const uint8_t *raw,size_t rawLength) {
    Tox_Err_Options_New optionsErr=TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts=tox_options_new(&optionsErr);
    if(!opts || optionsErr!=TOX_ERR_OPTIONS_NEW_OK)return nullptr;
    tox_options_set_udp_enabled(opts,false);
    tox_options_set_ipv6_enabled(opts,false);
    tox_options_set_local_discovery_enabled(opts,false);
    if(raw) {
        if(rawLength==0||rawLength>kMaxRaw ||
           !tox_options_set_savedata_data(opts,raw,rawLength)){
            tox_options_free(opts);
            return nullptr;
        }
        tox_options_set_savedata_type(opts,TOX_SAVEDATA_TYPE_TOX_SAVE);
    }
    Tox_Err_New err=TOX_ERR_NEW_OK;
    Tox *tox=tox_new(opts,&err);
    tox_options_free(opts);
    if(err!=TOX_ERR_NEW_OK){if(tox)tox_kill(tox);return nullptr;}
    return tox;
}
bool write_file(const char *path,const QByteArray &bytes){
    FILE *file=std::fopen(path,"wb");
    if(!file)return false;
    const size_t n=size_t(bytes.size());
    const bool full=std::fwrite(bytes.constData(),1,n,file)==n;
    const int closed=std::fclose(file);
    const bool ok=full && closed==0;
    if(!ok)std::remove(path);
    return ok;
}
QByteArray read_file(const char *path){
    FILE *file=std::fopen(path,"rb");
    if(!file)return {};
    if(std::fseek(file,0,SEEK_END)!=0){std::fclose(file);return {};}
    const long n=std::ftell(file);
    if(n<=(long)ToxEncrypt::getMinBytes() ||
       n>(long)(kMaxRaw+TOX_PASS_ENCRYPTION_EXTRA_LENGTH) ||
       std::fseek(file,0,SEEK_SET)!=0){
        std::fclose(file);
        return {};
    }
    QByteArray data(int(n),char(0));
    const bool read=std::fread(data.data(),1,size_t(n),file)==size_t(n);
    std::fclose(file);
    return read?data:QByteArray{};
}
int create(const char *path,bool unicode,bool direct){
    Tox *owner=create_tox(nullptr,0),*friendTox=create_tox(nullptr,0);
    if(!owner||!friendTox){
        if(owner)tox_kill(owner);
        if(friendTox)tox_kill(friendTox);
        return 3;
    }
    uint8_t key[TOX_PUBLIC_KEY_SIZE]={},id[TOX_ADDRESS_SIZE]={};
    tox_self_get_public_key(friendTox,key);
    Tox_Err_Friend_Add fe=TOX_ERR_FRIEND_ADD_OK;
    const Tox_Friend_Number friendNumber=tox_friend_add_norequest(owner,key,&fe);
    Tox_Err_Set_Info ie=TOX_ERR_SET_INFO_OK;
    const bool hasName=tox_self_set_name(owner,kName,sizeof(kName)-1,&ie);
    int ret=4;
    if(friendNumber==0&&fe==TOX_ERR_FRIEND_ADD_OK&&hasName&&ie==TOX_ERR_SET_INFO_OK){
        const size_t rawLength=tox_get_savedata_size(owner);
        if(rawLength>0&&rawLength<=kMaxRaw){
            QByteArray raw(int(rawLength),char(0));
            tox_get_savedata(owner,reinterpret_cast<uint8_t*>(raw.data()));
            // Exercise qTox's actual profile encrypt() path, which first
            // derives and stores Tox_Pass_Key via makeToxEncrypt(password).
            QByteArray encrypted;
            const QString &pass=unicode?kUnicodePassword:kPassword;
            if(direct){
                encrypted=ToxEncrypt::encryptPass(pass,raw);
            }else{
                auto keyObj=ToxEncrypt::makeToxEncrypt(pass);
                encrypted=keyObj?keyObj->encrypt(raw):QByteArray{};
            }
            sodium_memzero(raw.data(),size_t(raw.length()));
            if(!encrypted.isEmpty()&&ToxEncrypt::isEncrypted(encrypted) &&
               write_file(path,encrypted)){
                tox_self_get_address(owner,id);
                std::fputs("CREATED ",stdout);
                print_hex(id,sizeof(id));
                std::putchar(' ');
                print_hex(key,sizeof(key));
                std::putchar('\n');
                std::fflush(stdout);
                ret=0;
            }else ret=5;
        }
    }
    sodium_memzero(key,sizeof(key));
    sodium_memzero(id,sizeof(id));
    tox_kill(owner);
    tox_kill(friendTox);
    return ret;
}
int verify(const char *path,const char *expectId,const char *expectKey,bool unicode,bool direct){
    uint8_t id[TOX_ADDRESS_SIZE]={},key[TOX_PUBLIC_KEY_SIZE]={};
    if(!parse_hex(expectId,sizeof(id),id) ||
       !parse_hex(expectKey,sizeof(key),key))return 2;
    const QByteArray encrypted=read_file(path);
    if(encrypted.isEmpty() || !ToxEncrypt::isEncrypted(encrypted))return 3;
    // Exercise qTox's actual profile LOAD path: derive key from the saved
    // salt, then decrypt with the preserved passkey.
    QByteArray raw;
    const QString &pass=unicode?kUnicodePassword:kPassword;
    if(direct){
        raw=ToxEncrypt::decryptPass(pass,encrypted);
    }else{
        auto passKey=ToxEncrypt::makeToxEncrypt(pass,encrypted);
        if(!passKey)return 4;
        raw=passKey->decrypt(encrypted);
    }
    if(raw.isEmpty() || size_t(raw.size())>kMaxRaw)return 4;
    Tox *owner=create_tox(reinterpret_cast<const uint8_t*>(raw.constData()),
                          size_t(raw.size()));
    sodium_memzero(raw.data(),size_t(raw.length()));
    if(!owner)return 5;
    uint8_t foundId[TOX_ADDRESS_SIZE]={},friendKey[TOX_PUBLIC_KEY_SIZE]={};
    tox_self_get_address(owner,foundId);
    Tox_Err_Friend_Get_Public_Key friendErr=TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK;
    const bool hasFriend=tox_friend_get_public_key(owner,0,friendKey,&friendErr);
    const size_t name_len=tox_self_get_name_size(owner);
    uint8_t actual_name[sizeof(kName)]={0};
    const bool name_size_ok=name_len==sizeof(kName)-1;
    if(name_size_ok)tox_self_get_name(owner,actual_name);
    const bool name_ok=name_size_ok &&
        sodium_memcmp(actual_name,kName,sizeof(kName)-1)==0;
    sodium_memzero(actual_name,sizeof(actual_name));
    const bool matched=name_ok &&
        tox_self_get_friend_list_size(owner)==1 &&
       hasFriend && friendErr==TOX_ERR_FRIEND_GET_PUBLIC_KEY_OK &&
       sodium_memcmp(foundId,id,sizeof(id))==0 &&
       sodium_memcmp(friendKey,key,sizeof(key))==0;
    if(matched)std::puts("VERIFIED unmodified upstream qTox ToxEncrypt and original Tox identity/friend");
    sodium_memzero(foundId,sizeof(foundId));
    sodium_memzero(friendKey,sizeof(friendKey));
    sodium_memzero(id,sizeof(id));
    sodium_memzero(key,sizeof(key));
    tox_kill(owner);
    return matched?0:6;
}
// Characterize the EXACT pinned qTox cached-key behavior without patching
// third-party GPL source or attempting to recover real user passwords.
int probe_unicode_cached_key()
{
    const QByteArray plain("stage32-qtox-unicode-cached-key-test",36);
    auto encryptor=ToxEncrypt::makeToxEncrypt(kUnicodePassword);
    if(!encryptor)return 3;
    const QByteArray encrypted=encryptor->encrypt(plain);
    if(encrypted.isEmpty() || !ToxEncrypt::isEncrypted(encrypted))return 4;
    auto decryptor=ToxEncrypt::makeToxEncrypt(kUnicodePassword,encrypted);
    if(!decryptor)return 5;
    const QByteArray roundtrip=decryptor->decrypt(encrypted);
    if(roundtrip!=plain){
        std::puts("UPSTREAM_QTOX_UNICODE_CACHED_KEY_FAILED");
        return 7;
    }
    std::puts("UPSTREAM_QTOX_UNICODE_CACHED_KEY_ROUNDTRIP_OK");
    return 0;
}
} // namespace

int main(int argc,char **argv){
    if(sodium_init()<0)return 10;
    if(argc==2&&std::strcmp(argv[1],"probe-unicode-cache")==0)
        return probe_unicode_cached_key();
    if(argc==3&&std::strcmp(argv[1],"create")==0)return create(argv[2],false,false);
    if(argc==3&&std::strcmp(argv[1],"create-unicode")==0)return create(argv[2],true,false);
    if(argc==3&&std::strcmp(argv[1],"create-unicode-direct")==0)return create(argv[2],true,true);
    if(argc==5&&std::strcmp(argv[1],"verify")==0)
        return verify(argv[2],argv[3],argv[4],false,false);
    if(argc==5&&std::strcmp(argv[1],"verify-unicode")==0)
        return verify(argv[2],argv[3],argv[4],true,false);
    if(argc==5&&std::strcmp(argv[1],"verify-unicode-direct")==0)
        return verify(argv[2],argv[3],argv[4],true,true);
    std::fputs("Usage: qtox-profile-interop probe-unicode-cache | create|create-unicode|create-unicode-direct FILE | verify|verify-unicode|verify-unicode-direct FILE TOX_ID FRIEND_PUBLIC_KEY\n",stderr);
    return 2;
}
