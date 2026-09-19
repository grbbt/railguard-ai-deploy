"""Bound the multipart request before it can spool an unlimited body to disk."""
from fastapi import HTTPException
from starlette.responses import JSONResponse

# Include space for multipart headers in addition to the accepted input bytes.
MAX_REQUEST_BYTES = 1500 * 1024**2 + 1024**2
DETAIL = 'PS3 uploads are limited to 1,500 MiB per batch. Split the batch and try again.'


class UploadBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('path') != '/api/ps3/jobs':
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        try:
            length = int(headers.get(b'content-length', b'0'))
        except ValueError:
            length = 0
        if length > MAX_REQUEST_BYTES:
            return await JSONResponse({'detail': DETAIL}, status_code=413)(scope, receive, send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message['type'] == 'http.request':
                received += len(message.get('body', b''))
                if received > MAX_REQUEST_BYTES:
                    raise HTTPException(status_code=413, detail=DETAIL)
            return message

        return await self.app(scope, bounded_receive, send)
