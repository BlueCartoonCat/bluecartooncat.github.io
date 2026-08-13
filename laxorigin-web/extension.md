# Using CORS Unblock with RADS Web

RADS Web reads the RADS bundle and manifest directly from Archive.org. Archive.org sends CORS headers that block normal browser requests from this page, so you need to disable CORS for the RADS Web tab before pressing `Start`.

## Install the Extension

Install **CORS Unblock** from the Chrome Web Store:

[CORS Unblock](https://chromewebstore.google.com/detail/cors-unblock/lfhmikememgdcahcdlaciloancbhjino)

## Enable It for RADS Web

1. Open RADS Web in your browser.
2. Click inside the RADS Web page so the site tab is focused.
3. Click the **CORS Unblock** extension icon.
4. Turn the extension on for the focused site.
5. Tick all available options, if still having issues, here's a picture of a working config.
6. <img width="912" height="912" alt="image" src="https://github.com/user-attachments/assets/a22a882d-8c77-4341-b0fc-49b3a8014807" />

7. Press start and keep the window open/minimized.
8. Return to RADS Web.
9. Press `Start`

If the page still shows `Archive.org request failed`, reload RADS Web after enabling the extension and press `Start` again.
