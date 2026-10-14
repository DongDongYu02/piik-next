# Ubuntu Docker 覆盖部署多人版

这是当前修改的开发快照，附有二进制、许可证、源码补丁、构建身份及校验和。
服务器无需安装 Node.js 或 Go；需要 Docker Engine、Compose 插件，并能拉取
Dockerfile 固定的基础镜像。不是上游正式发布版。

以下以原有端口为例，替换成自己的域名和公网 IP，保留 `https://share.example.com:7761`、SFU UDP `7882`、STUN UDP
`3478`。**已有服务优先沿用现有 Compose、环境配置和数据挂载，只更换镜像。**
包里的 `compose.yaml` 和 Nginx 配置是参考模板，不能直接替代尚未核对的原配置。
本地四浏览器的 SFU 媒体/生命周期验证通过；真实多机、公网和稳定 1080p60 待验收。

## 1. 解压并构建新镜像

```bash
uname -m
# x86_64 选择 amd64；aarch64 选择 arm64。只上传对应包及旁边的 SHA256SUMS。
# 校验选中的压缩包，避免另一架构没有上传而报错：
grep 'piik-multi-screen-linux-amd64-dev.tar.gz$' SHA256SUMS | sha256sum -c -
tar -xzf piik-multi-screen-linux-amd64-dev.tar.gz
cd piik-multi-screen-linux-amd64-dev
sha256sum -c SHA256SUMS
docker build --build-arg PIIK_REVISION="$(cat REVISION)" \
  --build-arg PIIK_SERVER_SHA256="$(sha256sum piik-server | cut -d' ' -f1)" \
  -t piik-multi-screen:development .
```

ARM 服务器将上述文件名中的 `amd64` 换成 `arm64`。保存这个解压目录，后面称
`PACKAGE_DIR`。`manifest.json` 记录架构、基线 commit 和 staged 源码补丁的 SHA-256。
`worktree.patch` 是相对基线的源码差异；运行时 `REVISION` 标识同一开发快照。

## 2. 找到原服务并备份

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
OLD_CONTAINER=你的原Piik容器名
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$OLD_CONTAINER"
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$OLD_CONTAINER"
docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$OLD_CONTAINER"
```

进入输出的原项目目录，继续使用原来的 `docker compose` 命令；如果原服务用了
`-p`、`-f` 或 `--env-file`，下面每个 Compose 命令都要保留那些参数。
若没有 Compose 标签，沿用你原来保存的 `docker run` 启动参数，仅替换镜像，并
按下面原则停旧、备份、保留原数据挂载；不要据模板猜测现有服务的参数。

```bash
cd /你的原Compose目录
SERVICE=实际的Piik服务名
PACKAGE_DIR=/刚才解压目录的绝对路径
BACKUP_DIR="$PWD/piik-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$BACKUP_DIR"
OLD_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$OLD_CONTAINER")
ROLLBACK_IMAGE="piik-server:before-multi-$(date +%Y%m%d-%H%M%S)"
docker image tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE"
printf '%s\n' "$ROLLBACK_IMAGE" > "$BACKUP_DIR/rollback-image.txt"
```

把实际使用的 Compose 文件、`.env` 及其他环境文件复制到 `BACKUP_DIR`，限制
文件权限为 `600`。不要打印或发送环境文件，其内含网站密码。
记录原数据挂载：`docker inspect --format '{{json .Mounts}}' "$OLD_CONTAINER"`。
从原配置确认数据库在容器内的实际绝对路径；标准镜像通常为
`/home/nonroot/rooms.sqlite`，有自定义 `ROOM_DATABASE_PATH` 时以原配置为准。

## 3. 校验配置并替换

原服务的 `image:` 改为 `piik-multi-screen:development`。若有 `build:`，本次移除
该服务的 `build:`，防止重新构建旧源码；其余端口、卷、工作目录、权限和环境保留。
确认原配置包含以下非秘密参数，密码继续使用原值：

```dotenv
PUBLIC_BASE_URL=https://share.example.com:7761
SFU_UDP_PORT=7882
SFU_PUBLIC_IP=198.51.100.5
SFU_ONLY=true
STUN_URLS=stun:share.example.com:3478
```

若设置了 `ALLOWED_ORIGINS`，其中应包含 `https://share.example.com:7761`。SFU 监听
应为容器可绑定的地址（通常 `0.0.0.0`），不要把公网 IP 用作监听地址。
保留或补齐 `7882:7882/udp`；原 Piik 自己承载 STUN 时保留 `3478:3478/udp`。
外部 STUN 独立服务可继续使用。数据库父目录和文件需可由镜像 UID/GID
`65532:65532` 写入；沿用原标准镜像的数据卷即可。

```bash
docker compose config --quiet
docker compose run --pull never --rm --no-deps "$SERVICE" --check-config
# 必须看到 config=ok；此命令不启动媒体/数据库服务，不占用已发布端口。

# 从这里开始短暂中断服务。停旧实例后再复制一致的数据库快照。
docker compose stop "$SERVICE"
DB_PATH=/home/nonroot/rooms.sqlite  # 改成上面已确认的实际路径
docker cp "$OLD_CONTAINER:$DB_PATH" "$BACKUP_DIR/rooms.sqlite"
chmod 600 "$BACKUP_DIR/rooms.sqlite"
# 如果数据库复制失败或仍存在未恢复的 journal，先处理备份，勿继续替换。
# :memory: 模式没有数据库文件；原房间会随停止丢失。

docker compose up --pull never --no-build -d --no-deps --force-recreate "$SERVICE"
docker compose ps "$SERVICE"
```

只重建实际的 Piik 服务；不要执行 `down -v`、删除数据卷或清理旧镜像。
不要用两个进程同时写同一个 SQLite 数据库。重启后重新输入网站密码、刷新
浏览器页面并重新共享，旧的实时媒体连接不会保留。

## 4. 检查原入口

```bash
# 使用原 Nginx upstream 对应的宿主端口；标准模板为 8787。
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/api/capabilities
curl -fsS https://share.example.com:7761/healthz
curl -fsS https://share.example.com:7761/api/capabilities
```

健康接口返回 `status:ok`，能力接口应有 `sfu:true`、`sfuOnly:true`、
`multiScreenRoom1:true`。原 Nginx 已能使用时保持原配置。若缺少 WebSocket 转发，
参考 `nginx.conf.example` 修改原站点，使用实际证书路径和原 upstream；
`sudo nginx -t` 成功后再 `sudo systemctl reload nginx`。不要重复增加监听 7761
的同域名站点；若 Nginx 在容器里，upstream 使用原 Docker 网络中的服务名，
不能把 Nginx 容器的 `127.0.0.1` 当成 Piik 容器。

公网与主机防火墙需允许 TCP7761、UDP7882，以及实际 STUN 服务的 UDP3478。
若服务器位于 NAT 后，UDP 外部7882必须映射到同一7882；通告的公网 IPv4应可达。
HTTPS/WSS 不转发视频，SFU 只有 UDP，没有 TURN/TCP 媒体兜底。

从两台电脑打开 `https://share.example.com:7761/multi`，创建/加入同一房间，分别
共享并互看。再检查停止、重新共享、成员退出和加入；最多四人。采集请求
1080p60，实际画质/帧率取决于浏览器、电脑与网络，尚无稳定四机1080p60验收。

## 回退

停止新服务，恢复备份的原 Compose/环境配置；将实际服务的 `image:` 设为
`rollback-image.txt` 中保存的旧镜像标签，然后沿用原参数执行
`docker compose up --pull never --no-build -d --no-deps --force-recreate "$SERVICE"`。
保留原数据卷。
本版没有数据库 schema 变更；只有数据库受损时才在服务完全停止后恢复快照，
否则不要用旧快照覆盖测试期间的新房间。随后复查原健康接口和投屏。

新装服务才使用包内 Compose：复制 `.env.example` 为 `.env`、设置本地密码并
`chmod 600 .env`，核对域名/IP/端口/数据后运行 `docker compose build`、
`docker compose run --pull never --rm --no-deps piik --check-config`、
`docker compose up --pull never --no-build -d`。
已有安装按上面的镜像替换流程操作，避免误用另一项目或数据卷。

开发者重新打包：stage 所有本次变更后执行 `npm run package:multi-screen-dev`。
基础配置参考 [Docker Compose 文档](https://docs.docker.com/reference/compose-file/services/)，
WebSocket 转发参考 [Nginx 文档](https://nginx.org/en/docs/http/websocket.html)。
