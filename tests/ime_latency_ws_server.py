"""Loopback WebSocket receiver with bounded, injected application read delay.

Used only by test_ime_ws_transport.js. It does not start X11 or model a native IME.
"""
import asyncio
import json

from websockets.asyncio.server import serve


async def receive(connection):
    config = json.loads(await connection.recv())
    delay = min(1000, max(0, int(config["read_delay_ms"]))) / 1000
    text = ""
    submissions = []
    messages = 0
    async for message in connection:
        await asyncio.sleep(delay)
        if message == "TEST_END":
            await connection.send(json.dumps({"submissions": submissions, "remaining": text,
                                               "messages": messages}, ensure_ascii=False))
            return
        messages += 1
        if message.startswith("co,end,"):
            text += message[7:]
        elif message.startswith("kd,"):
            key = int(message[3:])
            if key == 65293:
                submissions.append(text)
                text = ""
            elif 32 <= key < 127:
                text += chr(key)


async def main():
    async with serve(receive, "127.0.0.1", 0) as server:
        print(json.dumps({"port": server.sockets[0].getsockname()[1]}), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
