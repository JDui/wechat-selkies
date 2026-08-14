FROM rust:1.96-bookworm AS upload-sidecar-builder
WORKDIR /build
COPY upload-sidecar/Cargo.toml upload-sidecar/Cargo.lock ./
COPY upload-sidecar/src ./src
RUN cargo build --locked --release

# WeChat for Linux using Selkies baseimage
FROM ghcr.io/linuxserver/baseimage-selkies:ubuntunoble

# Metadata labels
LABEL org.opencontainers.image.title="WeChat Selkies"
LABEL org.opencontainers.image.description="WeChat Linux client in browser via Selkies WebRTC"
LABEL org.opencontainers.image.authors="nickrunning"
LABEL org.opencontainers.image.source="https://github.com/nickrunning/wechat-selkies"
LABEL org.opencontainers.image.documentation="https://github.com/nickrunning/wechat-selkies#readme"
LABEL org.opencontainers.image.vendor="WeChat Selkies Project"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"

# Build arguments for multi-arch support
ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG UBUNTU_APT_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/ubuntu/"
RUN echo "Building WeChat-Selkies on $BUILDPLATFORM, targeting $TARGETPLATFORM"

# set environment variables
RUN if [ -n "$UBUNTU_APT_MIRROR" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu/|${UBUNTU_APT_MIRROR%/}/|g; s|http://security.ubuntu.com/ubuntu/|${UBUNTU_APT_MIRROR%/}/|g" /etc/apt/sources.list; \
    fi

RUN apt-get update -o Acquire::Retries=5 && \
    apt-get install -y fonts-noto-cjk libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
    libxcb-render-util0 libxcb-xkb1 libxkbcommon-x11-0 \
    shared-mime-info desktop-file-utils libxcb1 libxcb-icccm4 libxcb-image0 \
    libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 libxcb-shape0 \
    libxcb-shm0 libxcb-sync1 libxcb-util1 libxcb-xfixes0 libxcb-xkb1 libxcb-xinerama0 \
    libxcb-xkb1 libxcb-glx0 libatk1.0-0 libatk-bridge2.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libfontconfig1 libgbm1 libgcc1 libgdk-pixbuf2.0-0 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
    libxss1 libxtst6 libatomic1 libxcomposite1 libxrender1 libxrandr2 libxkbcommon-x11-0 \
    libfontconfig1 libdbus-1-3 libnss3 libx11-xcb1 python3-tk stalonetray xprintidle xdotool \
    pulseaudio pulseaudio-utils alsa-utils

RUN pip install --no-cache-dir python-xlib pulsectl "zeroconf>=0.132,<1"

# Install WeChat based on target architecture (resolve latest URL/version from official Linux WeChat page)
RUN case "$TARGETPLATFORM" in \
    "linux/amd64") \
        WECHAT_ARCH_KEY="WeChatLinux_x86_64.deb"; \
        WECHAT_FALLBACK_URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb"; \
        WECHAT_ARCH="x86_64" ;; \
    "linux/arm64") \
        WECHAT_ARCH_KEY="WeChatLinux_arm64.deb"; \
        WECHAT_FALLBACK_URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb"; \
        WECHAT_ARCH="arm64" ;; \
    *) \
        echo "Unsupported platform: $TARGETPLATFORM" >&2; \
        echo "Supported platforms: linux/amd64, linux/arm64" >&2; \
        exit 1 ;; \
    esac && \
    WECHAT_PAGE_URL="https://linux.weixin.qq.com/" && \
    WECHAT_PAGE="$(curl -fsSL "$WECHAT_PAGE_URL" | tr -d '\n')" && \
    WECHAT_VERSION="$(echo "$WECHAT_PAGE" | sed -n 's/.*main-section__bd-version[^>]*>\([^<]*\)<.*/\1/p' | head -n 1)" && \
    WECHAT_URL="$(echo "$WECHAT_PAGE" | grep -o "https://[^\"]*${WECHAT_ARCH_KEY}" | head -n 1)" && \
    if [ -z "$WECHAT_URL" ]; then WECHAT_URL="$WECHAT_FALLBACK_URL"; fi && \
    echo "Downloading WeChat for $WECHAT_ARCH architecture from: $WECHAT_URL (version: ${WECHAT_VERSION:-unknown})" && \
    curl -fsSL -o wechat.deb "$WECHAT_URL" && \
    echo "Installing WeChat..." && \
    (dpkg -i wechat.deb || (apt-get update && apt-get install -f -y && dpkg -i wechat.deb)) && \
    INSTALLED_WECHAT_VERSION="$(dpkg-deb -f wechat.deb Version 2>/dev/null || echo "${WECHAT_VERSION:-unknown}")" && \
    rm -f wechat.deb && \
    echo "WeChat installation completed for $WECHAT_ARCH (installed version: ${INSTALLED_WECHAT_VERSION})"

# Install QQ based on target architecture (resolve latest URL from official Linux QQ config)
RUN case "$TARGETPLATFORM" in \
    "linux/amd64") \
        QQ_ARCH_KEY="x64DownloadUrl"; \
        QQ_FALLBACK_URL="https://dldir1v6.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.22_251203_amd64_01.deb"; \
        QQ_ARCH="x86_64" ;; \
    "linux/arm64") \
        QQ_ARCH_KEY="armDownloadUrl"; \
        QQ_FALLBACK_URL="https://dldir1v6.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.22_251203_arm64_01.deb"; \
        QQ_ARCH="arm64" ;; \
    *) \
        echo "Unsupported platform: $TARGETPLATFORM" >&2; \
        echo "Supported platforms: linux/amd64, linux/arm64" >&2; \
        exit 1 ;; \
    esac && \
    QQ_CONFIG_URL="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js" && \
    QQ_CONFIG="$(curl -fsSL "$QQ_CONFIG_URL" | tr -d '\n')" && \
    QQ_VERSION="$(echo "$QQ_CONFIG" | sed -n 's/.*\"version\":\"\([^\"]*\)\".*/\1/p')" && \
    QQ_URL="$(echo "$QQ_CONFIG" | sed -n "s/.*\"${QQ_ARCH_KEY}\":{\"deb\":\"\([^\"]*\)\".*/\1/p")" && \
    if [ -z "$QQ_URL" ]; then QQ_URL="$QQ_FALLBACK_URL"; fi && \
    echo "Downloading QQ for $QQ_ARCH architecture from: $QQ_URL (version: ${QQ_VERSION:-unknown})" && \
    curl -fsSL -o qq.deb "$QQ_URL" && \
    echo "Installing QQ..." && \
    (dpkg -i qq.deb || (apt-get update && apt-get install -f -y && dpkg -i qq.deb)) && \
    rm -f qq.deb && \
    echo "QQ installation completed for $QQ_ARCH"

# Clean up
RUN apt-get purge -y --autoremove
RUN apt-get autoclean && \
    rm -rf \
        /config/.cache \
        /config/.npm \
        /var/lib/apt/lists/* \
        /var/tmp/* \
        /tmp/*

# configure openbox dock mode for stalonetray
RUN sed -i '/<dock>/,/<\/dock>/s/<noStrut>no<\/noStrut>/<noStrut>yes<\/noStrut>/' /etc/xdg/openbox/rc.xml

# set app name
ENV TITLE="AXi-SNS-Box"
ENV TZ="Asia/Shanghai"
ENV LC_ALL="zh_CN.UTF-8"
ENV AUTO_START_WECHAT="true"
ENV AUTO_START_QQ="false"
ENV PROCESS_WATCHDOG="true"
ENV WATCHDOG_INTERVAL="10"
ENV WATCHDOG_TRAY="true"
ENV WATCHDOG_RESTART_WECHAT="true"
ENV WATCHDOG_RESTART_QQ="true"
ENV WATCHDOG_AUDIO="true"
ENV WATCHDOG_LOG_PATH="/config/logs/process-watchdog.log"
ENV NOTIFICATION_BRIDGE_PORT="38081"
ENV NOTIFICATION_BRIDGE_LOG_PATH="/config/logs/notification-bridge.log"
ENV NOTIFICATION_BRIDGE_LOG_MAX_BYTES="1048576"
ENV NOTIFICATION_BRIDGE_RAW_LOG_PATH="/config/logs/notification-bridge-raw.log"
ENV NOTIFICATION_BRIDGE_MODE_PATH="/config/state/notification-bridge.json"
ENV NOTIFICATION_BRIDGE_FALLBACK_POLL_MS="1200"
ENV NOTIFICATION_BRIDGE_IDLE_DEFOCUS_SECONDS="600"
ENV NOTIFICATION_BRIDGE_AUDIO_WECHAT_ENABLED="true"
ENV NOTIFICATION_BRIDGE_AUDIO_PEAK_THRESHOLD="0.095"
ENV NOTIFICATION_BRIDGE_AUDIO_MIN_MS="110"
ENV NOTIFICATION_BRIDGE_AUDIO_MAX_MS="3000"
ENV NOTIFICATION_BRIDGE_AUDIO_DEDUPE_SECONDS="10"
ENV SELKIES_SESSION_MODE="pin-takeover"
ENV SELKIES_SESSION_STATE_PATH="/run/selkies-active-session.json"
ENV SELKIES_SESSION_AUTH_PORT="38082"
ENV SELKIES_SESSION_COOKIE_NAME="selkies_session"
ENV SELKIES_UPLOAD_ENABLED="true"
ENV SELKIES_UPLOAD_PORT="38084"
ENV SELKIES_UPLOAD_DIR="/config/uploads"
ENV SELKIES_DOWNLOAD_ROOT="/config"
ENV SELKIES_UPLOAD_MAX_FILE_SIZE="2147483648"
ENV SELKIES_UPLOAD_CHUNK_SIZE="524288"
ENV SELKIES_UPLOAD_MAX_CONCURRENCY="3"
ENV SELKIES_UPLOAD_TOKEN_TTL_SECONDS="300"
ENV SELKIES_UPLOAD_RESUME_ENABLED="true"
ENV SELKIES_UPLOAD_CHECKSUM_ENABLED="true"
ENV SELKIES_UPLOAD_ALLOW_OVERWRITE="false"
ENV SELKIES_UPLOAD_MIN_FREE_BYTES="268435456"
ENV SELKIES_UPLOAD_ALLOWED_SUBDIRS=""
ENV SELKIES_LEGACY_UPLOAD_ENABLED="false"
ENV SELKIES_CONTAINER_SLEEP="false"
ENV SELKIES_CONTAINER_SLEEP_REQUIRE_PIN="true"
ENV SELKIES_CONTAINER_SLEEP_PORT="38083"
ENV SELKIES_CONTAINER_SLEEP_STATE_PATH="/run/selkies-container-sleep.json"
ENV SELKIES_CONTAINER_SLEEP_IDLE_SECONDS="180"
ENV SELKIES_CONTAINER_SLEEP_CHECK_SECONDS="5"
ENV SELKIES_CONTAINER_SLEEP_STARTUP_GRACE_SECONDS="180"
ENV CUSTOM_WS_PORT="8081"
ENV SELKIES_AUDIO_READY_TIMEOUT_SECONDS="15"
ENV SELKIES_PACTL_TIMEOUT_SECONDS="5"
ENV X11_WATCHDOG="true"
ENV X11_WATCHDOG_FAIL_THRESHOLD="6"
ENV X11_HEALTHCHECK_TIMEOUT="4"
ENV SELKIES_AWAKE_STATE_PATH="/tmp/selkies-client-awake.json"
ENV SELKIES_FRONTEND_ACTIVITY_STATE_PATH="/tmp/selkies-frontend-activity.json"
ENV SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS="3600"
ENV SELKIES_ADAPTIVE_SLEEP_CHECK_SECONDS="5"
ENV SELKIES_AUTO_SPLIT="false"
ENV QQ_EXTRA_FLAGS="--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-gpu --disable-gpu-compositing --disable-gpu-rasterization --disable-features=CalculateNativeWinOcclusion,UseSkiaRenderer"
ENV QQ_NICE_LEVEL="-2"
ENV QQ_WATCHDOG_HANG_DETECT="true"
ENV QQ_WATCHDOG_FAIL_THRESHOLD="3"
ENV QQ_WATCHDOG_X11_PING="true"
ENV QQ_WATCHDOG_X11_TIMEOUT="2"
ENV SELKIES_ENABLE_BINARY_CLIPBOARD="true"
ENV SELKIES_PASTE_IMAGE="true"
ENV SELKIES_ENCODER="x264enc,x264enc-striped,jpeg"
ENV SELKIES_DEFAULT_FRAMERATE="48"
ENV SELKIES_DISABLE_GAMEPAD="true"
ENV SELKIES_DEFAULT_BINARY_CLIPBOARD="true"
ENV SELKIES_DEFAULT_ENCODER="x264enc"
ENV SELKIES_DEFAULT_USE_CPU="false"
ENV SELKIES_DEFAULT_H264_STREAMING_MODE="true"
ENV SELKIES_DEFAULT_USE_PAINT_OVER_QUALITY="false"
ENV SELKIES_DEFAULT_H264_CRF="30"
ENV SELKIES_DYNAMIC_THROTTLE="true"
ENV SELKIES_DYNAMIC_LOW_LATENCY_HOLD_MS="15000"
ENV SELKIES_DYNAMIC_THROTTLE_MODE="idle-low-occupancy"
ENV SELKIES_DYNAMIC_LOW_LATENCY_FPS="8"
ENV SELKIES_DYNAMIC_LOW_LATENCY_H264_CRF="33"
ENV SELKIES_DYNAMIC_LOW_LATENCY_SAMPLE_PERCENT="91"
ENV SELKIES_STREAM_WAIT_THRESHOLD_MS="35000"
ENV SELKIES_STREAM_STALL_THRESHOLD_MS="18000"
ENV SELKIES_STREAM_STALL_RESTART_LIMIT="2"
ENV SELKIES_STREAM_RECOVER_COOLDOWN_MS="120000"
ENV SELKIES_VIDEO_CORRUPTION_WATCHDOG="false"
ENV SELKIES_VIDEO_SOFT_RECOVER_LIMIT="2"
ENV SELKIES_VIDEO_RECOVER_COOLDOWN_MS="120000"
ENV SELKIES_PAGE_STALL_WATCHDOG="true"
ENV SELKIES_PAGE_STALL_THRESHOLD_MS="45000"
ENV SELKIES_PAGE_STALL_RELOAD_THRESHOLD_MS="90000"
ENV SELKIES_PAGE_STALL_COOLDOWN_MS="300000"
ENV SELKIES_RENDER_STALL_WATCHDOG="true"
ENV SELKIES_RENDER_STALL_THRESHOLD_MS="12000"
ENV SELKIES_RENDER_STALL_COOLDOWN_MS="25000"
ENV SELKIES_AUDIO_WATCHDOG="true"
ENV SELKIES_AUDIO_START_INTERVAL_MS="8000"
ENV SELKIES_AUDIO_PACKET_STALL_MS="15000"
ENV SELKIES_IDLE_CLEANUP_MINUTES="20"
ENV SELKIES_LOCAL_LINK_OPEN="true"
ENV SELKIES_LOCAL_LINK_POLL_INTERVAL_MS="800"
ENV LOCAL_LINK_BRIDGE_PORT="38080"
ENV LOCAL_LINK_BRIDGE_MAX_EVENTS="256"
ENV LOCAL_LINK_BRIDGE_ALLOWED_SCHEMES="http,https,mailto"
ENV LOCAL_LINK_BRIDGE_LOG_PATH="/config/logs/local-link-bridge.log"
ENV LOCAL_LINK_BRIDGE_LOG_MAX_BYTES="1048576"
ENV SELKIES_LOCAL_LINK_LOG_PATH="/config/logs/local-link-open.log"
ENV LOCAL_LINK_LOG_RESET_INTERVAL_SECONDS="10800"
ENV SELKIES_LAN_DISCOVERY_DEFAULT_ENABLED="false"
ENV SELKIES_LAN_DISCOVERY_DEFAULT_NAME="AXISNSBOX-000"
ENV SELKIES_LAN_DISCOVERY_STATUS_PATH="/config/state/lan-discovery-status.json"
ENV ENABLE_STALONETRAY="false"
ENV WATCHDOG_TRAY="false"
ENV ENABLE_RIGHT_CLICK_SPLIT="true"
ENV ENABLE_SPLIT_FAB="false"
ENV SPLIT_FAB_LOG_PATH="/config/logs/split-fab.log"
ENV SPLIT_FAB_POSITION="bottom-center"

# update favicon
RUN cp /usr/share/icons/hicolor/512x512/apps/qq.png /usr/share/selkies/www/icon.png

# add local files
COPY /root /
COPY --from=upload-sidecar-builder /build/target/release/selkies-upload-sidecar /usr/local/bin/selkies-upload-sidecar

# normalize line endings for scripts copied from Windows worktrees
RUN sed -i 's/\r$//' \
    /etc/s6-overlay/s6-rc.d/init-nginx/run \
    /etc/cont-init.d/90-selkies-paste-config \
    /etc/cont-init.d/91-selkies-single-session-patch \
    /etc/cont-init.d/92-xvfb-maxclients-patch \
    /etc/cont-init.d/93-selkies-audio-wait-patch \
    /defaults/default.conf \
    /defaults/autostart \
    /defaults/dunstrc \
    /defaults/menu.xml \
    /scripts/start.sh \
    /etc/s6-overlay/s6-rc.d/svc-pulseaudio/run \
    /scripts/process-watchdog.sh \
    /scripts/ensure-audio-service.sh \
    /scripts/run-notification-bridge.sh \
    /scripts/size_limited_log_writer.py \
    /scripts/session_auth_bridge.py \
    /scripts/container_sleep_manager.py \
    /scripts/notification_bridge.py \
    /scripts/lan_discovery_common.py \
    /scripts/lan_discovery_service.py \
    /scripts/local-link-open-helper.sh \
    /scripts/local_link_bridge.py \
    /scripts/gio-wrapper.sh \
    /scripts/xdg-open-wrapper.sh \
    /scripts/x11-healthcheck.sh \
    /scripts/recover-xstack.sh \
    /scripts/recover-ui-services.sh \
    /scripts/healthcheck.sh \
    /scripts/cpu-diagnostics.sh \
    /scripts/window_tiler.py \
    /scripts/patch_openbox_rc.py \
    /scripts/split_fab.py \
    /scripts/wechat/*.sh \
    /scripts/qq/*.sh

# ensure custom cont-init scripts are executable
RUN chmod +x /etc/cont-init.d/90-selkies-paste-config \
    /etc/cont-init.d/91-selkies-single-session-patch \
    /etc/cont-init.d/92-xvfb-maxclients-patch \
    /etc/cont-init.d/93-selkies-audio-wait-patch \
    /etc/s6-overlay/s6-rc.d/init-nginx/run \
    /etc/s6-overlay/s6-rc.d/svc-pulseaudio/run \
    /scripts/start.sh \
    /scripts/process-watchdog.sh \
    /scripts/ensure-audio-service.sh \
    /scripts/run-notification-bridge.sh \
    /scripts/size_limited_log_writer.py \
    /scripts/session_auth_bridge.py \
    /scripts/container_sleep_manager.py \
    /scripts/notification_bridge.py \
    /scripts/lan_discovery_common.py \
    /scripts/lan_discovery_service.py \
    /scripts/local-link-open-helper.sh \
    /scripts/local_link_bridge.py \
    /scripts/gio-wrapper.sh \
    /scripts/xdg-open-wrapper.sh \
    /scripts/x11-healthcheck.sh \
    /scripts/recover-xstack.sh \
    /scripts/recover-ui-services.sh \
    /scripts/healthcheck.sh \
    /scripts/cpu-diagnostics.sh \
    /scripts/window_tiler.py \
    /scripts/patch_openbox_rc.py \
    /scripts/split_fab.py \
    /scripts/wechat/*.sh \
    /scripts/qq/*.sh \
    /usr/local/bin/selkies-upload-sidecar

RUN if [ -x /usr/bin/xdg-open ] && [ ! -x /usr/bin/xdg-open.real ]; then mv /usr/bin/xdg-open /usr/bin/xdg-open.real; fi && \
    cp /scripts/xdg-open-wrapper.sh /usr/bin/xdg-open && \
    chmod +x /usr/bin/xdg-open && \
    if [ -x /usr/bin/gio ] && [ ! -x /usr/bin/gio.real ]; then mv /usr/bin/gio /usr/bin/gio.real; fi && \
    if [ -x /usr/bin/gio.real ]; then cp /scripts/gio-wrapper.sh /usr/bin/gio && chmod +x /usr/bin/gio; fi
