package io.anilog.android;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import okhttp3.Credentials;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import java.util.concurrent.TimeUnit;

final class WebDavClient {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final MediaType XML = MediaType.get("application/xml; charset=utf-8");
    private static final long MAX_FILE_BYTES = 5L * 1024L * 1024L;
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build();

    static final class Download {
        final boolean found;
        final String etag;
        final String body;

        Download(boolean found, String etag, String body) {
            this.found = found;
            this.etag = etag;
            this.body = body;
        }
    }

    private Request.Builder request(WebDavStore.Config config, String url) {
        return new Request.Builder()
            .url(url)
            .header("Authorization", Credentials.basic(config.username, config.password, StandardCharsets.UTF_8))
            .header("User-Agent", "AniLog Android WebDAV sync");
    }

    private String collectionUrl(WebDavStore.Config config) {
        return config.baseUrl + "AniLog/";
    }

    private String fileUrl(WebDavStore.Config config) {
        return collectionUrl(config) + "anilog-sync.json";
    }

    private void requireCredentials(WebDavStore.Config config) throws IOException {
        if (config.baseUrl.isEmpty() || config.username.isEmpty() || config.password.isEmpty()) {
            throw new IOException("请先完整填写 WebDAV 地址、用户名和密码");
        }
    }

    void test(WebDavStore.Config config) throws IOException {
        requireCredentials(config);
        RequestBody body = RequestBody.create("<?xml version=\"1.0\"?><propfind xmlns=\"DAV:\"><prop><resourcetype/></prop></propfind>", XML);
        Request propfind = request(config, config.baseUrl).method("PROPFIND", body).header("Depth", "0").build();
        try (Response response = client.newCall(propfind).execute()) {
            int status = response.code();
            if (status == 401 || status == 403) throw new IOException("WebDAV 认证失败，请检查账号和应用密码");
            if ((status < 200 || status >= 300) && status != 207) throw new IOException("WebDAV 连接失败（HTTP " + status + "）");
        }
    }

    private void ensureCollection(WebDavStore.Config config) throws IOException {
        requireCredentials(config);
        Request request = request(config, collectionUrl(config)).method("MKCOL", RequestBody.create(new byte[0], null)).build();
        try (Response response = client.newCall(request).execute()) {
            int status = response.code();
            if (response.isSuccessful() || status == 405) return;
            if (status == 401 || status == 403) throw new IOException("WebDAV 认证失败，请检查账号和应用密码");
            throw new IOException("无法创建 AniLog 同步目录（HTTP " + status + "）");
        }
    }

    Download download(WebDavStore.Config config) throws IOException {
        ensureCollection(config);
        Request request = request(config, fileUrl(config)).get().header("Accept", "application/json").build();
        try (Response response = client.newCall(request).execute()) {
            if (response.code() == 404) return new Download(false, "", "");
            if (response.code() == 401 || response.code() == 403) throw new IOException("WebDAV 认证失败，请检查账号和应用密码");
            if (!response.isSuccessful()) throw new IOException("读取 WebDAV 同步文件失败（HTTP " + response.code() + "）");
            ResponseBody responseBody = response.body();
            if (responseBody == null) throw new IOException("WebDAV 同步文件为空");
            byte[] bytes = responseBody.bytes();
            if (bytes.length > MAX_FILE_BYTES) throw new IOException("WebDAV 同步文件超过 5 MB，已停止读取");
            return new Download(true, response.header("ETag", ""), new String(bytes, StandardCharsets.UTF_8));
        }
    }

    boolean upload(WebDavStore.Config config, String body, boolean remoteFound, String etag) throws IOException {
        ensureCollection(config);
        Request.Builder builder = request(config, fileUrl(config)).put(RequestBody.create(body, JSON));
        if (remoteFound) {
            if (etag != null && !etag.isEmpty()) builder.header("If-Match", etag);
        } else {
            builder.header("If-None-Match", "*");
        }
        try (Response response = client.newCall(builder.build()).execute()) {
            if (response.code() == 409 || response.code() == 412) return false;
            if (response.code() == 401 || response.code() == 403) throw new IOException("WebDAV 认证失败，请检查账号和应用密码");
            if (!response.isSuccessful()) throw new IOException("写入 WebDAV 同步文件失败（HTTP " + response.code() + "）");
            return true;
        }
    }
}
