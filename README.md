# ShopShield (MVP)

## What it does
ShopShield helps reduce impulse online purchases by detecting checkout/payment UI, temporarily disabling it and showing a mindful pause modal with a configurable delay. If you override the pause, you can optionally add a short note (stored locally).

## Files
- manifest.json
- contentScript.js
- service_worker.js
- popup.html / popup.js
- options.html
- privacy_policy.html
- icons/ (provide icon16.png, icon48.png, icon128.png)

## How to load locally (unpacked):
1. Create a folder `shopshield/` and paste the files above into it.
2. Add placeholder icons in `icons/`.
3. Open Chrome -> `chrome://extensions/`
4. Toggle **Developer mode** on.
5. Click **Load unpacked** and choose the `shopshield/` folder.
6. Visit a shopping site, attempt to go to checkout — ShopShield should block and show the pause modal.

## Important notes
- For testing we use `"matches": ["<all_urls>"]` in manifest. For store publishing, replace with a curated shopping-domain list or switch to host-permission-on-demand.
- ShopShield intentionally **does not** read or store any payment form values.

## Publishing checklist (high-level)
- Replace `<all_urls>` with minimal host permissions or implement optional host permission request flow.
- Prepare store listing, privacy policy URL (host privacy_policy.html), icons & screenshots.
- Register as a Chrome Web Store developer, upload the ZIP, provide privacy policy URL and support contact, and respond to any reviewer questions.

