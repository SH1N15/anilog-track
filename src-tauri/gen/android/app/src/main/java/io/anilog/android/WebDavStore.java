package io.anilog.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import app.tauri.plugin.JSObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class WebDavStore {
    private static final String PREFS = "anilog_webdav";
    private static final String KEY_ALIAS = "anilog_webdav_password";
    private static final String ENABLED = "enabled";
    private static final String BASE_URL = "base_url";
    private static final String USERNAME = "username";
    private static final String PASSWORD = "password";
    private static final String LAST_SYNC = "last_sync_at";
    private static final String LAST_ERROR = "last_error";

    private WebDavStore() {}

    static final class Config {
        final boolean enabled;
        final String baseUrl;
        final String username;
        final String password;
        final long lastSyncAt;
        final String lastError;

        Config(boolean enabled, String baseUrl, String username, String password, long lastSyncAt, String lastError) {
            this.enabled = enabled;
            this.baseUrl = baseUrl;
            this.username = username;
            this.password = password;
            this.lastSyncAt = lastSyncAt;
            this.lastError = lastError;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Config load(Context context) {
        SharedPreferences values = prefs(context);
        String password = "";
        try {
            password = decrypt(values.getString(PASSWORD, ""));
        } catch (Exception ignored) {}
        return new Config(
            values.getBoolean(ENABLED, false),
            values.getString(BASE_URL, ""),
            values.getString(USERNAME, ""),
            password,
            values.getLong(LAST_SYNC, 0),
            values.getString(LAST_ERROR, "")
        );
    }

    static Config save(Context context, boolean enabled, String baseUrl, String username, String password, boolean replacePassword) throws Exception {
        SharedPreferences.Editor editor = prefs(context).edit()
            .putBoolean(ENABLED, enabled)
            .putString(BASE_URL, baseUrl)
            .putString(USERNAME, username)
            .putString(LAST_ERROR, "");
        if (replacePassword) editor.putString(PASSWORD, password.isEmpty() ? "" : encrypt(password));
        editor.apply();
        return load(context);
    }

    static void finishSync(Context context, String error) {
        SharedPreferences.Editor editor = prefs(context).edit().putString(LAST_ERROR, error == null ? "" : error);
        if (error == null || error.isEmpty()) editor.putLong(LAST_SYNC, System.currentTimeMillis() / 1000L);
        editor.apply();
    }

    static JSObject publicConfig(Context context) {
        Config config = load(context);
        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("enabled", config.enabled);
        result.put("baseUrl", config.baseUrl);
        result.put("username", config.username);
        result.put("hasPassword", !config.password.isEmpty());
        result.put("lastSyncAt", config.lastSyncAt);
        result.put("lastError", config.lastError);
        return result;
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        return iv + "." + encrypted;
    }

    private static String decrypt(String value) throws Exception {
        if (value == null || value.isEmpty()) return "";
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) return "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
