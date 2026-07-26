/* ============================================================
   NATIVE SIGNER BRIDGE
   ------------------------------------------------------------
   When running inside the compiled Capacitor app, HMAC-SHA256 signing
   happens natively (BybitSignerPlugin.java) instead of via Web Crypto —
   keeping the real API secret out of the WebView's JS runtime as much
   as possible. Falls back to the existing Web-Crypto-based
   hmacSha256Hex() (trading.js) whenever the native plugin isn't
   available — e.g. testing in a plain browser instead of the compiled
   app — so nothing else in the app needs to know or care which path
   actually ran.

   Assumption worth flagging: this expects Capacitor's auto-injected
   runtime to expose `window.Capacitor.registerPlugin` for non-bundler
   ("vanilla") apps like this one. If that assumption turns out wrong
   for some Capacitor version, the try/catch below means it just falls
   back to JS signing silently rather than breaking anything — but if
   you ever see native signing NOT being used inside the compiled app,
   check this first.
   ============================================================ */
let BybitSignerNative = null;
if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
  try {
    BybitSignerNative = window.Capacitor.registerPlugin('BybitSigner');
  } catch (err) {
    console.warn('Native BybitSigner plugin not available, falling back to JS signing:', err);
  }
}

// Drop-in replacement for hmacSha256Hex(message, secret) — identical
// signature and return shape (Promise<hex string>). BybitOrderClient
// (trading.js) calls this instead of hmacSha256Hex directly.
async function signHmacSha256(message, secret) {
  if (BybitSignerNative) {
    try {
      const { signature } = await BybitSignerNative.sign({ message, secret });
      return signature;
    } catch (err) {
      console.warn('Native signing failed, falling back to JS signing:', err);
    }
  }
  return hmacSha256Hex(message, secret); // existing Web Crypto implementation, defined in trading.js
}
