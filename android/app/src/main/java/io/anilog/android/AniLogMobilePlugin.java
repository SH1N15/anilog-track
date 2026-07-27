package io.anilog.android;

import android.Manifest;
import android.os.Build;
import android.app.AlarmManager;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.HashSet;
import java.util.Set;
import java.net.URI;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "AniLogMobile",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class AniLogMobilePlugin extends Plugin {
    private final WebDavClient webDav = new WebDavClient();

    @Override
    public void load() {
        NotificationScheduler.ensureChannel(getContext());
        BackgroundSync.schedulePeriodic(getContext());
    }

    @PluginMethod
    public void configure(PluginCall call) {
        JSArray requested = call.getArray("following", new JSArray());
        JSONArray before = MobileStore.following(getContext());
        boolean notificationsEnabled = call.getBoolean("notificationsEnabled", true);
        boolean createTasksEnabled = call.getBoolean("createTasksEnabled", true);
        MobileStore.configure(getContext(), requested, notificationsEnabled, createTasksEnabled);

        Set<Integer> currentIds = idsOf(requested);
        for (int index = 0; index < before.length(); index += 1) {
            JSONObject item = before.optJSONObject(index);
            if (item != null && !currentIds.contains(item.optInt("id"))) {
                NotificationScheduler.cancel(getContext(), item.optInt("id"));
            }
        }
        NotificationScheduler.scheduleAll(getContext());
        BackgroundSync.schedulePeriodic(getContext());
        call.resolve(status(new JSONArray(), false));
    }

    @PluginMethod
    public void consumeEvents(PluginCall call) {
        call.resolve(status(MobileStore.consumeEvents(getContext()), true));
    }

    @PluginMethod
    public void syncNow(PluginCall call) {
        execute(() -> {
            try {
                int updated = AniListScheduler.sync(getContext());
                JSObject result = status(new JSONArray(), false);
                result.put("updated", updated);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("AniList 同步失败：" + error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(permissionResult());
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PluginMethod
    public void requestExactScheduling(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || exactSchedulingGranted()) {
            call.resolve(permissionResult());
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
            Uri.parse("package:" + getContext().getPackageName())
        );
        getActivity().startActivity(intent);
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void getWebDavConfig(PluginCall call) {
        call.resolve(WebDavStore.publicConfig(getContext()));
    }

    @PluginMethod
    public void saveWebDavConfig(PluginCall call) {
        try {
            boolean enabled = call.getBoolean("enabled", false);
            String baseUrl = normalizeWebDavUrl(call.getString("baseUrl", ""));
            String username = call.getString("username", "").trim();
            boolean replacePassword = call.getData().has("password");
            String password = call.getString("password", "");
            WebDavStore.Config existing = WebDavStore.load(getContext());
            String effectivePassword = replacePassword ? password : existing.password;
            if (enabled && (baseUrl.isEmpty() || username.isEmpty() || effectivePassword.isEmpty())) {
                throw new IllegalArgumentException("启用同步前请完整填写地址、用户名和密码");
            }
            WebDavStore.save(getContext(), enabled, baseUrl, username, password, replacePassword);
            call.resolve(WebDavStore.publicConfig(getContext()));
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void testWebDavConnection(PluginCall call) {
        execute(() -> {
            try {
                webDav.test(WebDavStore.load(getContext()));
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("message", "WebDAV 连接成功");
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void webDavDownload(PluginCall call) {
        execute(() -> {
            try {
                WebDavClient.Download download = webDav.download(WebDavStore.load(getContext()));
                JSObject result = new JSObject();
                result.put("found", download.found);
                result.put("etag", download.etag);
                result.put("body", download.body);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void webDavUpload(PluginCall call) {
        execute(() -> {
            try {
                boolean uploaded = webDav.upload(
                    WebDavStore.load(getContext()),
                    call.getString("body", ""),
                    call.getBoolean("remoteFound", false),
                    call.getString("etag", "")
                );
                JSObject result = new JSObject();
                result.put("ok", uploaded);
                result.put("conflict", !uploaded);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void finishWebDavSync(PluginCall call) {
        String error = call.getString("error");
        WebDavStore.finishSync(getContext(), error);
        call.resolve(WebDavStore.publicConfig(getContext()));
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        call.resolve(permissionResult());
    }

    private JSObject permissionResult() {
        JSObject result = new JSObject();
        result.put(
            "granted",
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED
        );
        result.put("exactSchedulingGranted", exactSchedulingGranted());
        return result;
    }

    private JSObject status(JSONArray events, boolean consumeOpenTasks) {
        JSObject result = permissionResult();
        try {
            result.put("events", new JSArray(events.toString()));
            result.put("following", new JSArray(MobileStore.following(getContext()).toString()));
        } catch (JSONException error) {
            result.put("events", new JSArray());
            result.put("following", new JSArray());
        }
        result.put("syncedAt", MobileStore.lastSyncAt(getContext()));
        result.put("openTasks", consumeOpenTasks && MobileStore.consumeOpenTasks(getContext()));
        return result;
    }

    private boolean exactSchedulingGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager alarms = (AlarmManager) getContext().getSystemService(android.content.Context.ALARM_SERVICE);
        return alarms.canScheduleExactAlarms();
    }

    private Set<Integer> idsOf(JSONArray items) {
        Set<Integer> ids = new HashSet<>();
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject item = items.optJSONObject(index);
            if (item != null) ids.add(item.optInt("id"));
        }
        return ids;
    }

    private String normalizeWebDavUrl(String input) throws Exception {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) return "";
        URI uri = new URI(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("WebDAV 地址必须是无账号、参数或片段的 HTTPS 地址");
        }
        return value.replaceAll("/+$", "") + "/";
    }
}
