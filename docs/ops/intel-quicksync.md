# Intel Quick Sync（N355）

`AXiVer` 以 Intel Quick Sync 版本继续维护，起点为 AXiVer 1.76 工作区。`_AMDGPU` 保存改造前代码和当时未提交的输入法修复；首轮 Intel 改造从 `codex/intel-quicksync` 快进合入 `AXiVer`。AMD 分支与原有发布镜像不随本次改造修改。

## 实现

- 复用 Selkies / pixelflux 的全帧 H.264 VA-API 编码路径。界面的 `x264enc` 是原有协议名称，关闭 CPU 编码且设备可用时走硬件路径；不是新增 `h264_qsv` / oneVPL 后端。JPEG 与分片 H.264 继续使用 CPU。
- amd64 镜像安装 `intel-media-va-driver-non-free`、`i965-va-driver-shaders` 和 `vainfo`。N355 默认 `INTEL_VAAPI_DRIVER=iHD`；旧型号可选 `i965`，也可设 `auto` 依次探测。ARM64 保留 CPU 运行能力。
- `DRI_NODE=auto` 按 sysfs 的 Intel 厂商 ID `0x8086` 选择已映射的 render 节点，不假定 Intel 一定位于 `renderD128`。显式指定节点时只检查该节点，选错厂商或路径则回退 CPU。
- s6 的 `init-intel-gpu` 在基础镜像 `init-video` 完成设备权限配置之后运行，以实际桌面用户 `abc` 执行有 8 秒超时的 `vainfo`。H.264 普通 `EncSlice` 可用后才启用硬件；只解码或仅低功耗 `EncSliceLP` 不作为当前 pixelflux 路径可用的证据。
- 失败时清空 DRI 节点，并设置 `SELKIES_USE_CPU=true|locked` 与前端 CPU 默认值，避免旧浏览器设置重新打开失败的硬编路径。诊断结果写入 `/run/selkies-intel-gpu.json`，`/scripts/cpu-diagnostics.sh` 会显示它。

## 1.78：N355 初始化失败修正

1.77 的 N355 实测提供了设备 ID `0x46d3`、内核 `6.8.1-z4pro+-generic` 和 iHD `vaInitialize` 错误 1。`abc` 已具有设备组权限，root 探测也失败，因此不是简单的用户组权限遗漏。

镜像里的 `intel-media-va-driver-non-free 24.1.0+ds1-1` 对应上游源码只登记 `46D0/46D1/46D2`，缺少 `46D3`。1.78 按 [Intel 官方 PPA 安装说明](https://dgpu-docs.intel.com/legacy/installation-guides/installing-packages-from-the-intel-ppa.html) 更新用户态媒体组件。APT 仅对 iHD、GMM 和 libva 相关包提高该源优先级，不进行系统整体升级，也不修改 NAS 内核。

构建使用 iHD 26.4.1、GMM 22.10.2、libva 2.24.1；[新版驱动源码](https://github.com/intel/media-driver/blob/intel-media-26.4.1/media_driver/linux/gen12/ddi/media_sysinfo_g12.cpp) 明确登记 `46D3/46D4`。这修正了已确认的设备支持缺口，但仍需 N355 上重新运行初始化与真实推流，才能确认是否还有宿主机驱动或固件方面的问题。

1.78 已用现有 1.77 应用层构建。构建日志确认仅升级六个指定媒体组件，iHD 动态依赖检查无缺失，独立临时容器健康检查与无设备 CPU 回退通过。替换部署时导入 1.78 镜像，修改 `image: wechat-selkies:1.78` 并重建容器；原 `/config` 映射和 `/dev/dri` 映射可沿用。在容器终端直接执行 `cat /run/selkies-intel-gpu.json` 检查结果，不要在容器里再次使用 `docker exec`。

## 部署

宿主机须提供可用的 Intel 核显驱动和 `/dev/dri`。镜像只提供用户态驱动，不能替代 NAS 内核驱动与固件。

### 1.78 离线测试包

本地导出目录为 `dist/1.78-intel/`，包含 `wechat-selkies-1.78-intel.tar`、不含构建步骤的 `docker-compose.yml`、`.env.example` 和 `README.txt`。将这些文件放到 N355 的同一部署目录，执行：

```bash
docker load -i wechat-selkies-1.78-intel.tar
cp .env.example .env
# 编辑 .env，填写自己的 PASSWORD（访问 PIN）
docker compose up -d --no-build --pull never
```

该包为 `linux/amd64`，镜像标签 `wechat-selkies:1.78`。配置数据写入同目录 `./config`；迁移既有环境时应沿用原配置目录。端口默认 3000 / 3001，可在 `.env` 调整。

### 从源码构建

```bash
docker compose build
docker compose up -d
```

构建得到 `wechat-selkies:1.78`。若 QQ 官方下载返回 403，沿用项目现有 `QQ_LOCAL_URL` 参数指定可访问的 QQ 安装包地址。旧的 `wechat-selkies-1.76.tar` 不包含本次 Intel 改造。

本机已有当前 1.76 镜像时，可复用其应用安装层，避免再次下载微信 / QQ；Intel 驱动、源码覆盖层和上传组件仍从当前代码构建：

```bash
docker compose build --build-arg RUNTIME_BASE=wechat-selkies:1.76
docker compose up -d
```

`RUNTIME_BASE` 默认是 Dockerfile 中的 `app-base`，不传此参数仍走完整源码构建。指定已有镜像时应使用当前 1.76 基线及对应 CPU 架构，不要用更老或不相关的镜像。

Compose 已映射 `/dev/dri`，默认配置如下：

```yaml
environment:
  - DRI_NODE=auto
  - INTEL_VAAPI_DRIVER=iHD
  - SELKIES_DEFAULT_ENCODER=x264enc
  - SELKIES_DEFAULT_USE_CPU=false
```

多块 Intel GPU 时可通过 `.env` 指定 `DRI_NODE=/dev/dri/renderD129` 等实际节点。修改驱动或设备后需重建容器配置（`docker compose up -d --force-recreate`）。无 `/dev/dri` 的机器须先删除 Compose 的 `devices` 映射，否则 Docker 会在容器启动前报错；容器启动后会自动使用 CPU。

## N355 上的最小验收

```bash
docker exec wechat-selkies cat /run/selkies-intel-gpu.json
docker exec wechat-selkies /scripts/cpu-diagnostics.sh
docker logs wechat-selkies 2>&1 | grep -E 'intel-gpu|Mode: H264|VAAPI'
```

状态应显示 `backend: intel-vaapi`、`driver: iHD` 和实际 Intel 节点。随后用浏览器连接，选择全帧 H.264 并关闭 CPU 编码，确认画面正常、日志出现 `Mode: H264 (VAAPI) FullFrame`，再验证一次休眠唤醒。能力探测通过不代表真实编码成功；仍需这些运行时证据。

需要自动化推流探测时复用现有脚本（在能映射 Intel `/dev/dri` 的 Docker 环境运行）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ops/validate-1.28-encoders.ps1 -Image wechat-selkies:1.78 -IncludeVaapi
```

脚本的前置检查接受任意编号的 `renderD*` 字符设备；最终仍以实际 H.264 VA-API 推流日志判断通过。

参考：[Intel N355 产品规格](https://www.intel.com/content/www/us/en/products/sku/241639/intel-core-3-processor-n355-6m-cache-up-to-3-90-ghz/specifications.html)、[Intel Media Driver](https://github.com/intel/media-driver)、[Ubuntu Noble 完整 Intel 驱动包](https://packages.ubuntu.com/noble/intel-media-va-driver-non-free)。

## 本地验证（2026-11-15）

- 6 个针对性单元测试通过：多显卡选择、旧驱动回退、显式错误节点、CPU 锁定、手动 CPU 模式及能力探测超时 / 仅解码拒绝。
- Compose 配置检查通过。使用 `RUNTIME_BASE=wechat-selkies:1.76` 成功构建 `wechat-selkies:intel-quicksync`；镜像中完整 iHD 驱动、i965 驱动和 vainfo 已安装。
- 独立临时容器未挂载用户 `/config`，关闭微信 / QQ 自动启动，启动与健康检查通过。无 `/dev/dri` 时，s6 初始化写入 CPU 回退状态、后端 `true|locked` 和前端 `defaultUseCpu: true`，且不再设置 DRI 节点。
- 默认完整构建在 QQ 官方下载时遇到 HTTP 403，后续依赖下载也未完成；本次镜像验证使用现有 1.76 应用层。开发机没有可映射的 Intel GPU，因此没有声称 N355 真机硬编、实际浏览器画面或休眠唤醒通过。
