"""Run only in an isolated test container with no logged-in messaging apps.

Set SELKIES_HIDDEN_STREAM_IDLE_SECONDS=2 and
SELKIES_ADAPTIVE_SLEEP_CHECK_SECONDS=1 for this short lifecycle probe.
"""
import asyncio
import json
from pathlib import Path
import urllib.request
import websockets


def post(path):
    with urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:38083/" + path, data=b"{}",
            headers={"Content-Type": "application/json"}), timeout=5) as response:
        return json.load(response)


async def main():
    Path("/config/state/notification-bridge.json").write_text(json.dumps({
        "adaptive_sleep_enabled": True, "adaptive_sleep_idle_seconds": 2700,
        "adaptive_sleep_idle_seconds_user_set": True,
    }))
    assert post("wake")["ok"]
    payload = dict(displayId="primary", initialClientWidth=640, initialClientHeight=360,
                   framerate=10, encoder="x264enc", use_cpu=True,
                   h264_crf=30, h264_streaming_mode=True, use_paint_over_quality=False)
    messages = asyncio.Queue()
    binary_count = 0
    async with websockets.connect("ws://127.0.0.1:8081", max_size=8 * 1024 * 1024) as ws:
        async def receive():
            nonlocal binary_count
            async for message in ws:
                if isinstance(message, str):
                    await messages.put(message)
                else:
                    binary_count += 1

        async def expect(expected, timeout=12):
            async with asyncio.timeout(timeout):
                while True:
                    message = await messages.get()
                    if message == expected:
                        return

        receiver = asyncio.create_task(receive())
        try:
            await ws.send("SETTINGS," + json.dumps(payload))
            await ws.send("CLIENT_AWAKE_STATE,1")
            # The initial frame may be static; lifecycle messages, capture
            # initialization and binary data together verify the real pipeline.
            await asyncio.sleep(2)
            await ws.send("START_VIDEO")
            await expect("VIDEO_STARTED")
            await asyncio.sleep(1)
            assert binary_count > 0, "no encoded frames before sleep"
            await ws.send("CLIENT_AWAKE_STATE,0")
            await expect("VIDEO_STOPPED")
            await ws.send("CLIENT_AWAKE_STATE,1")
            await expect("VIDEO_STARTED")
            print(json.dumps(dict(result="PASS", binary_frames=binary_count,
                                  hidden_capture_pause=True)))
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass


asyncio.run(main())
