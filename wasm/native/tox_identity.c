/*
 * Browser-only Tox identity / encrypted .tox backup proof of concept.
 * This module contains NO message transport or server API. Never log inputs.
 * SPDX-License-Identifier: GPL-3.0-or-later (c-toxcore linkage)
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sodium.h>
#include <toxcore/tox.h>
#include <toxcore/tox_options.h>
#include <toxencryptsave/toxencryptsave.h>
#include <emscripten/emscripten.h>

#define MAX_RAW_SAVEDATA (1024 * 1024)
#define MAX_PASSWORD_BYTES 1024

static int valid_password(const uint8_t *password, size_t password_len) {
    return password != NULL && password_len >= 8 && password_len <= MAX_PASSWORD_BYTES;
}

static Tox *create_offline_tox(const uint8_t *saved, size_t saved_len) {
    Tox_Err_Options_New opts_error = TOX_ERR_OPTIONS_NEW_OK;
    Tox_Options *opts = tox_options_new(&opts_error);
    if (opts == NULL || opts_error != TOX_ERR_OPTIONS_NEW_OK) {
        return NULL;
    }
    tox_options_set_udp_enabled(opts, false);
    tox_options_set_local_discovery_enabled(opts, false);
    if (saved != NULL) {
        if (saved_len == 0 || saved_len > MAX_RAW_SAVEDATA ||
            !tox_options_set_savedata_data(opts, saved, saved_len)) {
            tox_options_free(opts);
            return NULL;
        }
        tox_options_set_savedata_type(opts, TOX_SAVEDATA_TYPE_TOX_SAVE);
    }
    Tox_Err_New tox_error = TOX_ERR_NEW_OK;
    Tox *tox = tox_new(opts, &tox_error);
    tox_options_free(opts);
    if (tox_error != TOX_ERR_NEW_OK) {
        if (tox != NULL) {
            tox_kill(tox);
        }
        return NULL;
    }
    return tox;
}

/*
 * Create a new original Tox identity; return only a standard ToxEncryptSave
 * encrypted .tox backup and public Tox ID. Raw savedata remains WASM-local.
 * Return 0 on success, negative on failure.
 */
EMSCRIPTEN_KEEPALIVE
int wtox_create_encrypted(const uint8_t *password, size_t password_len,
                          uint8_t address[TOX_ADDRESS_SIZE],
                          uint8_t *encrypted, size_t encrypted_capacity,
                          size_t *written) {
    if (!valid_password(password, password_len) || address == NULL || encrypted == NULL ||
        written == NULL || sodium_init() < 0) {
        return -1;
    }
    *written = 0;
    Tox *tox = create_offline_tox(NULL, 0);
    if (tox == NULL) return -2;

    const size_t saved_len = tox_get_savedata_size(tox);
    if (saved_len == 0 || saved_len > MAX_RAW_SAVEDATA ||
        saved_len > SIZE_MAX - TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        saved_len + TOX_PASS_ENCRYPTION_EXTRA_LENGTH > encrypted_capacity) {
        tox_kill(tox);
        return -3;
    }
    uint8_t *plain = (uint8_t *)malloc(saved_len);
    if (plain == NULL) {
        tox_kill(tox);
        return -4;
    }
    tox_get_savedata(tox, plain);
    tox_self_get_address(tox, address);
    tox_kill(tox);

    Tox_Err_Encryption error = TOX_ERR_ENCRYPTION_OK;
    bool ok = tox_pass_encrypt(plain, saved_len, password, password_len,
                               encrypted, &error);
    sodium_memzero(plain, saved_len);
    free(plain);
    if (!ok || error != TOX_ERR_ENCRYPTION_OK) {
        sodium_memzero(address, TOX_ADDRESS_SIZE);
        sodium_memzero(encrypted, encrypted_capacity);
        return -5;
    }
    *written = saved_len + TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    return 0;
}

/*
 * Verify and import standard encrypted .tox entirely inside WASM.
 * Only the 38-byte public Tox address crosses back into JavaScript.
 * A future persistent client owns the plaintext in WASM memory while running.
 */
EMSCRIPTEN_KEEPALIVE
int wtox_inspect_encrypted(const uint8_t *backup, size_t backup_len,
                           const uint8_t *password, size_t password_len,
                           uint8_t address[TOX_ADDRESS_SIZE]) {
    if (!valid_password(password, password_len) || backup == NULL || address == NULL ||
        backup_len <= TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        backup_len > MAX_RAW_SAVEDATA + TOX_PASS_ENCRYPTION_EXTRA_LENGTH ||
        sodium_init() < 0) return -1;
    if (!tox_is_data_encrypted(backup)) return -2;
    const size_t saved_len = backup_len - TOX_PASS_ENCRYPTION_EXTRA_LENGTH;
    uint8_t *saved = (uint8_t *)malloc(saved_len);
    if (saved == NULL) return -3;
    Tox_Err_Decryption decrypt_error = TOX_ERR_DECRYPTION_OK;
    const bool ok = tox_pass_decrypt(backup, backup_len, password, password_len,
                                     saved, &decrypt_error);
    if (!ok || decrypt_error != TOX_ERR_DECRYPTION_OK) {
        sodium_memzero(saved, saved_len);
        free(saved);
        return -4;
    }
    Tox *tox = create_offline_tox(saved, saved_len);
    sodium_memzero(saved, saved_len);
    free(saved);
    if (tox == NULL) return -5;
    tox_self_get_address(tox, address);
    tox_kill(tox);
    return 0;
}

/* Included to reuse the verified offline Tox creation routine. */
static Tox *wtox_live = NULL;
#include "tox_events.inc"
#include "tox_session.inc"
#include "tox_virtual_tcp.inc"
#include "tox_net_probe.inc"
