package com.algotred.tradingapp;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.GeneralSecurityException;
import java.io.IOException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import android.content.SharedPreferences;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "BybitSigner")
public class BybitSignerPlugin extends Plugin {

    private SharedPreferences prefs() throws GeneralSecurityException, IOException {
        MasterKey masterKey = new MasterKey.Builder(getContext())
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                getContext(),
                "bybit_secure_store",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    @PluginMethod
    public void saveCredentials(PluginCall call) {
        String apiKey = call.getString("apiKey");
        String apiSecret = call.getString("apiSecret");
        if (apiKey == null || apiKey.isEmpty() || apiSecret == null || apiSecret.isEmpty()) {
            call.reject("apiKey and apiSecret are required");
            return;
        }
        try {
            prefs().edit().putString("apiKey", apiKey).putString("apiSecret", apiSecret).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to save credentials: " + e.getMessage());
        }
    }

    @PluginMethod
    public void hasCredentials(PluginCall call) {
        try {
            SharedPreferences p = prefs();
            boolean has = p.contains("apiKey") && p.contains("apiSecret");
            JSObject ret = new JSObject();
            ret.put("hasCredentials", has);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to check credentials: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getApiKey(PluginCall call) {
        try {
            String key = prefs().getString("apiKey", null);
            JSObject ret = new JSObject();
            ret.put("apiKey", key);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read API key: " + e.getMessage());
        }
    }

    @PluginMethod
    public void clearCredentials(PluginCall call) {
        try {
            prefs().edit().clear().apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to clear credentials: " + e.getMessage());
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        try {
            SharedPreferences p = prefs();
            String secret = p.getString("apiSecret", null);
            String apiKey = p.getString("apiKey", null);
            if (secret == null || apiKey == null) {
                call.reject("No credentials stored — add your API key first");
                return;
            }
            String timestamp = call.getString("timestamp", "");
            String recvWindow = call.getString("recvWindow", "5000");
            String payload = call.getString("payload", "");

            String toSign = timestamp + apiKey + recvWindow + payload;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] hash = mac.doFinal(toSign.getBytes(StandardCharsets.UTF_8));

            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));

            JSObject ret = new JSObject();
            ret.put("signature", hex.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Signing failed: " + e.getMessage());
        }
    }
}
