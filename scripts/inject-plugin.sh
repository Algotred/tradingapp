#!/bin/bash
# Injects native-plugins/BybitSignerPlugin.java into the freshly-generated
# android/ project and registers it in MainActivity. Runs on every CI
# build (android/ is gitignored and regenerated from scratch each time,
# by design — see .github/workflows/build-android.yml) so this script,
# not a one-time manual edit, is the single source of truth for the
# native plugin wiring.
set -e

if [ ! -f capacitor.config.json ]; then
  echo "ERROR: run this from the repo root (capacitor.config.json not found here)."
  exit 1
fi

APP_ID=$(grep -o '"appId"[[:space:]]*:[[:space:]]*"[^"]*"' capacitor.config.json | sed -E 's/.*"([^"]+)"$/\1/')
if [ -z "$APP_ID" ]; then
  echo "ERROR: could not read appId from capacitor.config.json."
  exit 1
fi
PACKAGE_PATH=$(echo "$APP_ID" | tr '.' '/')
JAVA_DIR="android/app/src/main/java/$PACKAGE_PATH"

echo "App ID: $APP_ID"
echo "Target Java package dir: $JAVA_DIR"

if [ ! -d "$JAVA_DIR" ]; then
  echo "ERROR: $JAVA_DIR does not exist — did 'npx cap add android' run first, and does the appId match?"
  exit 1
fi

# 1. Copy the plugin source and fix its package declaration to match the real appId
cp native-plugins/BybitSignerPlugin.java "$JAVA_DIR/BybitSignerPlugin.java"
sed -i "s/^package .*/package $APP_ID;/" "$JAVA_DIR/BybitSignerPlugin.java"
echo "Copied BybitSignerPlugin.java into place."

# 2. Register it inside MainActivity.java's onCreate, before the bridge initializes
python3 - "$JAVA_DIR/MainActivity.java" << 'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    content = f.read()

if "BybitSignerPlugin" in content:
    print("MainActivity.java already references BybitSignerPlugin — skipping (already patched).")
    sys.exit(0)

if "import com.getcapacitor.BridgeActivity;" not in content:
    print("ERROR: expected BridgeActivity import not found in MainActivity.java — manual patch needed.")
    sys.exit(1)

content = content.replace(
    "import com.getcapacitor.BridgeActivity;",
    "import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;",
    1,
)

# Regex match tolerates whitespace/formatting variation in the generated
# file — only the class declaration line itself needs to match exactly.
pattern = re.compile(r'(public class MainActivity extends BridgeActivity\s*\{)')
if not pattern.search(content):
    print("ERROR: MainActivity class declaration pattern not found — manual patch needed.")
    sys.exit(1)

injection = (
    "\n"
    "  @Override\n"
    "  public void onCreate(Bundle savedInstanceState) {\n"
    "    registerPlugin(BybitSignerPlugin.class);\n"
    "    super.onCreate(savedInstanceState);\n"
    "  }\n"
)
content = pattern.sub(r"\1" + injection, content, count=1)

with open(path, "w") as f:
    f.write(content)
print("MainActivity.java patched successfully.")
PYEOF

echo "Plugin injection complete."
