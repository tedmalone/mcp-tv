# Fire TV Screenshots — Tips & Tricks

## The Problem with the `screenshot` Tool

The built-in `screenshot` MCP tool returns a full-resolution base64 PNG via the MCP response. At 1080p, this is ~1.8MB of PNG encoded as ~2.4MB of base64 — far too large to fit in an LLM context window. **Do not use the `screenshot` tool for viewing screen content during a session.**

## Recommended Approach: ADB Direct Capture

Capture directly to a local file using `adb exec-out`, then read the file with the `Read` tool (which renders images natively):

```bash
adb -s <IP>:5555 exec-out screencap -p > "D:/tmp_screen.png"
```

Then in Claude Code:
```
Read D:/tmp_screen.png
```

The `Read` tool renders PNG images inline — no base64 overhead.

## Resizing for Faster Iteration

If the raw PNG is still too large or slow to read, resize before saving. Requires ImageMagick (`convert`) or Python Pillow:

**ImageMagick:**
```bash
adb -s <IP>:5555 exec-out screencap -p | convert - -resize 50% D:/tmp_screen_small.png
```

**Python Pillow:**
```python
from PIL import Image
img = Image.open("D:/tmp_screen.png")
img = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
img.save("D:/tmp_screen_small.png")
```

At 33% scale (640×360 from 1920×1080), file sizes drop to ~150KB — fast and readable.

## API Level Considerations

| Android / Fire OS | ADB screencap behavior |
|---|---|
| Android 9 (SDK 28) — Fire TV Stick 4K Max | `adb exec-out screencap -p > file.png` works reliably |
| Android 10+ | Same approach works |
| Older Fire OS (SDK 22–25) | May need `adb shell screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png` |

> **Note:** On Windows with Git Bash, avoid `adb shell screencap -p /sdcard/...` — the shell mangles `/sdcard/` paths. Use `exec-out` piped directly to a Windows path instead.

## Why `get_screen_content` Fails on Some Apps

YouTube, Netflix, and other Cobalt/WebView-based apps do **not** expose their UI hierarchy to `uiautomator`. `get_screen_content` and `click_node` will return an error on these apps. Use screenshots + d-pad navigation instead.

Apps that **do** work with `get_screen_content`: native Android/Fire OS apps (Settings, Fire TV home, Amazon Video, most sideloaded apps).

## Quick Screenshot Helper Pattern

For iterative testing, use this pattern:

```bash
# Take and view in one step
adb -s 192.168.4.25:5555 exec-out screencap -p > "D:/tmp_screen.png"
# Then Read D:/tmp_screen.png
```

Add a `sleep 1` or `sleep 2` before capturing when waiting for animations or page loads:

```bash
sleep 2 && adb -s 192.168.4.25:5555 exec-out screencap -p > "D:/tmp_screen.png"
```
