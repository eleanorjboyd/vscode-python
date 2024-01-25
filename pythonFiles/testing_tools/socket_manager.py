# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import socket
import sys

# set the socket before it gets blocked or overwritten by a user tests
_SOCKET = socket.socket


class PipeManager:
    def __init__(self, name):
        self.name = name

    def __enter__(self):
        return self.connect()

    def __exit__(self, *_):
        self.close()

    def connect(self):
        if sys.platform == "win32":
            self._writer = open(self.name, "wt", encoding="utf-8")
        else:
            self._socket = _SOCKET(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket.connect(self.name)
        return self

    def close(self):
        if sys.platform == "win32":
            self._writer.close()
        else:
            # add exception catch
            self._socket.close()

    def write(self, data: str):
        # must include the carriage-return defined (as \r\n) for unix systems
        request = f"""content-length: {len(data)}\r\ncontent-type: application/json\r\n\r\n{data}"""
        if sys.platform == "win32":
            self._writer.write(request)
            self._writer.flush()
        else:
            self._socket.send(request.encode("utf-8"))
            # does this also need a flush on the socket?

    def read(self, bufsize=1024):
        """Read data from the socket.

        Args:
            bufsize (int): Number of bytes to read from the socket.

        Returns:
            data (bytes): Data received from the socket.
        """
        if sys.platform == "win32":
            return self._reader.read(bufsize)
        else:
            data = b""
            while True:
                part = self._socket.recv(bufsize)
                data += part
                if len(part) < bufsize:
                    # No more data, or less than bufsize data received
                    break
            return data


class SocketManager(object):
    """Create a socket and connect to the given address.

    The address is a (host: str, port: int) tuple.
    Example usage:

    ```
    with SocketManager(("localhost", 6767)) as sock:
        request = json.dumps(payload)
        result = s.socket.sendall(request.encode("utf-8"))
    ```
    """

    def __init__(self, addr):
        self.addr = addr
        self.socket = None

    def __enter__(self):
        return self.connect()

    def __exit__(self, *_):
        self.close()

    def connect(self):
        self.socket = socket.socket(
            socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP
        )
        if sys.platform == "win32":
            addr_use = socket.SO_EXCLUSIVEADDRUSE
        else:
            addr_use = socket.SO_REUSEADDR
        self.socket.setsockopt(socket.SOL_SOCKET, addr_use, 1)
        self.socket.connect(self.addr)

        return self

    def close(self):
        if self.socket:
            try:
                self.socket.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            self.socket.close()
