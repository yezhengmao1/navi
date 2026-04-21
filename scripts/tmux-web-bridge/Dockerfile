# tmux-web-bridge server — relay only, no tmux needed in the container.
# Agents connect outbound from their own hosts; this image just runs server.py.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY server.py ./
COPY web ./web

# Non-root for defence-in-depth; server binds a high port so no caps needed.
RUN useradd --system --uid 10001 --no-create-home bridge \
 && chown -R bridge:bridge /app
USER bridge

EXPOSE 8787

# BRIDGE_TOKEN is read by server.py when --token isn't passed.
ENV BRIDGE_TOKEN=""

ENTRYPOINT ["python", "server.py"]
CMD ["--host", "0.0.0.0", "--port", "8787"]
