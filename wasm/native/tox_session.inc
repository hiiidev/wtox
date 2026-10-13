/* Native browser-memory-only session. Never exports unencrypted savedata.
 * No working Tox TCP/UDP socket adapter or bootstrapping in this phase. */
static Tox *wtox_live = NULL;
EMSCRIPTEN_KEEPALIVE
int wtox_session_start_new(uint8_t address[TOX_ADDRESS_SIZE]) {
    if (!address || wtox_live || sodium_init() < 0) return -1;
    Tox *tox = create_offline_tox(NULL, 0);
    if (!tox) return -2;
    tox_self_get_address(tox, address);
    wtox_live = tox;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_restore_encrypted(const uint8_t *backup, size_t len,
                                   const uint8_t *password, size_t pass_len,
                                   uint8_t address[TOX_ADDRESS_SIZE]) {
    if (wtox_live || !backup || !address || !valid_password(password, pass_len) ||
        len <= TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        len > MAX_RAW_SAVEDATA + TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        sodium_init() < 0) return -1;
    if (!tox_is_data_encrypted(backup)) return -2;
    const size_t plain_len = len - TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *plain = (uint8_t *)malloc(plain_len);
    if (!plain) return -3;
    Tox_Err_Decryption err = TOX_ERR_DECRYPTION_OK;
    bool ok = tox_pass_decrypt(backup, len, password, pass_len, plain, &err);
    Tox *instance = ok && err == TOX_ERR_DECRYPTION_OK
                    ? create_offline_tox(plain, plain_len) : NULL;
    sodium_memzero(plain, plain_len);
    free(plain);
    if (!ok || err != TOX_ERR_DECRYPTION_OK) return -4;
    if (!instance) return -5;
    tox_self_get_address(instance, address);
    wtox_live = instance;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
size_t wtox_session_savedata_size(void) {
    if (!wtox_live) return 0;
    const size_t len = tox_get_savedata_size(wtox_live);
    return len <= MAX_RAW_SAVEDATA ? len : 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_export_encrypted(const uint8_t *password, size_t pass_len,
                                  uint8_t *out, size_t capacity, size_t *written) {
    if (!wtox_live || !out || !written || !valid_password(password, pass_len) ||
        sodium_init() < 0) return -1;
    *written = 0;
    const size_t len = wtox_session_savedata_size();
    if (!len || len > SIZE_MAX - TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        len + TOX_PASS_ENCRYPTION_EXTRA_LENGTH > capacity) return -2;
    uint8_t *plain = (uint8_t *)malloc(len);
    if (!plain) return -3;
    tox_get_savedata(wtox_live, plain);
    Tox_Err_Encryption err = TOX_ERR_ENCRYPTION_OK;
    bool ok = tox_pass_encrypt(plain, len, password, pass_len, out, &err);
    sodium_memzero(plain, len);
    free(plain);
    if (!ok || err != TOX_ERR_ENCRYPTION_OK) {
        sodium_memzero(out, capacity);
        return -4;
    }
    *written = len + TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_set_name(const uint8_t *name, size_t len) {
    if (!wtox_live || len > TOX_MAX_NAME_LENGTH || (len > 0 && !name)) return -1;
    Tox_Err_Set_Info err = TOX_ERR_SET_INFO_OK;
    bool ok = tox_self_set_name(wtox_live, name, len, &err);
    return ok && err == TOX_ERR_SET_INFO_OK ? 0 : -2;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_get_name(uint8_t *name, size_t capacity) {
    if (!wtox_live || !name) return -1;
    size_t len = tox_self_get_name_size(wtox_live);
    if (len > TOX_MAX_NAME_LENGTH || len > capacity) return -2;
    if (len > 0) tox_self_get_name(wtox_live, name);
    return (int)len;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_iterate(void) {
    if (!wtox_live) return -1;
    tox_iterate(wtox_live, NULL);
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int wtox_session_iteration_interval(void) {
    if (!wtox_live) return -1;
    uint32_t interval = tox_iteration_interval(wtox_live);
    return interval > 60000 ? 60000 : (int)interval;
}
EMSCRIPTEN_KEEPALIVE
void wtox_session_close(void) {
    if (wtox_live) { tox_kill(wtox_live); wtox_live = NULL; }
}
