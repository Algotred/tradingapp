package com.yourname.tradingapp;
// NOTE: this package line is rewritten automatically by
// scripts/inject-plugin.sh to match whatever appId is set in
// capacitor.config.json — you don't need to edit it by hand unless
// you're placing this file manually instead of using the script.

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;

/**
 * Native HMAC-SHA256 signer for Bybit's V5 API auth scheme
 * (sign string = timestamp + apiKey + recvWindow + payload).
 *
 * Called from JS via native-signer.js's signHmacSha256(), which
 * automatically falls back to the existing Web Crypto implementation
 * in trading.js when this plugin isn't available (e.g. testing in a
 * plain browser instead of the compiled app) — so nothing else in the
 * app needs to know or care which path actually ran.
 */
@CapacitorPlugin(name = "BybitSigner")
public class BybitSignerPlugin extends Plugin {

    @PluginMethod
    public void sign(PluginCall call) {
        String message = call.getString("message");
        String secret = call.getString("secret");

        if (message == null || secret == null) {
            call.reject("Both 'message' and 'secret' are required");
            return;
        }

        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec keySpec = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(keySpec);
            byte[] rawHmac = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));

            StringBuilder hex = new StringBuilder();
            for (byte b : rawHmac) {
                hex.append(String.format("%02x", b));
            }

            JSObject result = new JSObject();
            result.put("signature", hex.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Signing failed: " + e.getMessage(), e);
        }
    }
}
