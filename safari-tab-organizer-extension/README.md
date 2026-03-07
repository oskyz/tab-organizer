# Smart Tab Organizer (Safari)

This folder is a Safari-adapted version of the extension.

## What changed vs Chrome version

- Uses cross-browser API handling (`browser` when available, `chrome` fallback).
- Removes `tabGroups` permission from the manifest.
- If Safari does not expose tab grouping APIs, organize still deduplicates tabs and skips grouping safely.

## Build and install in Safari (macOS)

1. Ensure Xcode is installed.
2. Run:

```bash
xcrun safari-web-extension-converter /Users/defrutosj/Documents/Playground/safari-tab-organizer-extension --project-location /Users/defrutosj/Documents/Playground/safari-tab-organizer-app --app-name "Smart Tab Organizer"
```

3. Open the generated Xcode project in `/Users/defrutosj/Documents/Playground/safari-tab-organizer-app`.
4. Choose the macOS app target and click Run in Xcode.
5. In Safari, open `Safari > Settings > Extensions` and enable **Smart Tab Organizer**.

## Reload after changes

- Rebuild and run the Xcode app target to refresh the extension in Safari.
