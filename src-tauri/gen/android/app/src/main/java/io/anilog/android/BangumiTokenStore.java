package io.anilog.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Bangumi access token 的 Android Keystore 安全存储。
 * 本类仅做凭据存取（Keystore 加解密 + SharedPreferences），绝不发起网络请求；
 * 需要后台纠偏时由调用方读取后逐请求注入 Authorization，token 本身不落入日志或同步文档。
 */
final class BangumiTokenStore {
    private static final String PREFS = "anilog_bangumi";
    private static final String KEY_ALIAS = "anilog_bangumi_token";
    private static final String TOKEN_CIPHER = "token_cipher";

    private BangumiTokenStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 读取 token；无存储记录或解密失败时返回 null（不抛异常、不打印 token）。 */
    static String load(Context context) {
        String stored = prefs(context).getString(TOKEN_CIPHER, null);
        if (stored == null || stored.isEmpty()) return null;
        try {
            return decrypt(stored);
        } catch (Exception ignored) {}
        return null;
    }

    /** 保存 token；null/空白串返回 false，加密失败返回 false（不抛异常）。 */
    static boolean save(Context context, String token) {
        if (token == null) return false;
        String trimmed = token.trim();
        if (trimmed.isEmpty()) return false;
        try {
            prefs(context).edit().putString(TOKEN_CIPHER, encrypt(trimmed)).apply();
            return true;
        } catch (Exception ignored) {}
        return false;
    }

    /** 清除 token 并删除对应 Keystore 密钥别名；SharedPreferences 写失败才返回 false。 */
    static boolean clear(Context context) {
        try {
            prefs(context).edit().remove(TOKEN_CIPHER).apply();
            try {
                KeyStore store = KeyStore.getInstance("AndroidKeyStore");
                store.load(null);
                if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
            } catch (Exception ignored) {}
            return true;
        } catch (Exception ignored) {}
        return false;
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
        if (value == null || value.isEmpty()) return null;
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
