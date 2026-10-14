# 浏览器多人共享

[English](./multi-screen.md)

这个二次开发版本增加了 2–4 人的浏览器多人共享房间。请运行本工作目录构建的
服务器；上游公开演示站还没有这个扩展。
服务器转发已通过本地四浏览器媒体和生命周期验证；公网部署和真实多机验收尚未完成。
Ubuntu Docker 开发包附有[部署说明](../../deploy/multi-screen/README.zh-CN.md)。

1. 打开自己 Piik 站点的 `/multi`，或点击页头的「多人共享」。
2. 填写昵称，点击「创建多人房间」，复制邀请链接给朋友，也可以凭房间号进入。
3. 每个人点击「共享我的屏幕」，选择自己的屏幕、窗口或浏览器标签页。
   采集需要支持屏幕共享的桌面浏览器，并通过 HTTPS 或 localhost 打开页面；
   不能采集的浏览器仍可观看。
4. 页面以网格展示大家的画面，可以放大某一路，再点击「返回全部画面」。
5. 「停止我的共享」只停止自己的画面；「离开房间」关闭自己的连接，
   其他人仍可继续共享。

自己的预览始终静音，别人的画面默认静音。如果浏览器采集了屏幕声音，
可以用各视频自带的声音控件开启播放。本版没有添加麦克风或语音会议。
断线时会停止自己的采集；重连后需要重新点击共享。

服务器开启 SFU 后，每人向服务器上传一份画面，并接收最多三位成员的画面；
设置 `SFU_ONLY=true` 的站点也支持此模式。没有开启 SFU 时，浏览器直接连接，
每人最多发送三份副本。服务器转发需要客户端能通过 UDP 连接服务器；
HTTPS 本身不承载视频，本版没有 TURN 或 TCP 媒体兜底。
采集请求 1080p、60 fps；P2P 每份直连副本的视频上限为 8 Mbps。
SFU 最高分辨率编码的上限为 8 Mbps，现有发布器还可能同时上传上限为 2 Mbps
的低分辨率编码，因此配置的视频上限合计可达 10 Mbps，另有音频和传输开销。
一条上传连接不代表只生成一份编码。这些是目标参数，实际分辨率和帧率仍受
来源、设备和网络影响。真实设备与跨网络表现仍需实测。

本地启动方法见[从源码运行](../README.md#run-from-source)。

## Windows 局域网启动

在本工作目录中运行下面的命令。首次需要先安装项目依赖；启动脚本会构建网页和
服务端，选择正在使用的物理网卡，并创建仅本地保存的 HTTPS 证书。

```powershell
npm ci
./scripts/start-multi-screen-lan.ps1
```

存在多块网卡时，用 `-Address <本机局域网IPv4>` 指定地址。终端会打印实际入口：

- `http://<局域网IPv4>:18787/multi`：可以打开页面和观看。
- `https://<局域网IPv4>:18788/multi`：其他电脑共享屏幕时使用此入口。
- `http://<局域网IPv4>:18787/piik-lan.cer`：下载公开证书。

其他 Windows 电脑首次共享前，先下载 `piik-lan.cer`，核对其 SHA-256 与服务端
终端打印的值一致，然后在证书所在目录运行：

```powershell
certutil -user -addstore Root ./piik-lan.cer
```

关闭并重新打开浏览器，再使用 HTTPS 入口。该步骤只信任这份用于 Piik 局域网
地址的服务器证书；不要通过浏览器忽略证书警告来代替证书安装。当前本地验证
使用 Chromium；其他浏览器的证书信任和实际采集兼容性需要单独验证。

仅分发 `.cer`；`build/lan` 中的 `.pfx` 和 `config.json` 含私钥或解密口令，
不要复制给其他电脑。证书和配置均位于 Git 忽略目录中，脚本不会自动修改系统
证书信任。IP 地址变化或证书更新后，需要重新导入新的公开证书。

脚本仅监听选定局域网地址；防火墙规则仅允许同一子网访问指定 TCP 端口。
保持启动终端运行，Ctrl+C 停止预览并清空临时房间。
已有最新构建时，可加 `-NoBuild` 跳过构建。正式站点继续使用现有 HTTPS 部署方案。

要在局域网测试服务器转发，可选择一个未占用的 UDP 端口：

```powershell
./scripts/start-multi-screen-lan.ps1 -Address <本机局域网IPv4> -SfuUdpPort 18882
```

脚本将 SFU 监听和通告地址设为选定物理网卡的局域网 IP，设置 `SFU_ONLY=true`，
并为服务端程序添加仅允许本地子网的 UDP 防火墙规则。此局域网预览仍关闭 STUN。
省略 `-SfuUdpPort` 即使用 P2P。开启 SFU 时可用 `-SfuPublicIP <可达IPv4>`
覆盖通告地址；它不会配置路由器，也不会扩大本地子网防火墙规则的允许范围。

## 使用自己的 HTTPS 域名

有可信域名证书时，可用 Nginx 在域名端口终止 TLS，按原路径转发至本机
`http://127.0.0.1:18787`。用公共地址重启 Piik，邀请链接和允许的 Origin 会同步更新：

```powershell
./scripts/start-multi-screen-lan.ps1 -Address <本机局域网IPv4> -PublicBaseUrl https://share.example.com:5200 -NoBuild
```

Nginx 的 `http` 配置中增加以下 `server`，替换域名及证书路径。也可用独立配置
启动另一 Nginx 实例；先执行 `nginx -t` 验证，避免影响现有站点。
独立实例需提前创建自己的 `logs` 和 `temp` 目录，并用 `-p` 指定该目录前缀、
`-c` 指定配置文件；Windows 后台启动使用 `Start-Process -WindowStyle Hidden`。

```nginx
server {
    listen 5200 ssl;
    server_name share.example.com;
    ssl_certificate "C:/certs/fullchain.pem";
    ssl_certificate_key "C:/certs/privkey.pem";
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:18787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location = /signal {
        proxy_pass http://127.0.0.1:18787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

浏览器使用 `https://share.example.com:5200/multi`，证书可信时无需安装局域网证书。
若通过公网访问，路由器将外网 TCP 5200 转发到本机 TCP 5200；若仅在局域网使用，
内部 DNS 将域名解析到本机局域网 IP 即可。客户端必须能连接该端口。
HTTPS 反代承载页面和房间信令。开启 SFU 时，客户端还需能访问其 UDP 端口；
P2P 模式则需要浏览器之间的直连媒体路径。通过路由器向公网提供 SFU 时，
还需转发对应 UDP 端口，用 `-SfuPublicIP` 通告可达公网 IPv4，并允许这些客户端
通过服务端防火墙；局域网脚本的 UDP 规则只允许本地子网。
域名可访问不代表媒体一定可达。
WebSocket 转发依据 [Nginx 官方文档](https://nginx.org/en/docs/http/websocket.html)。
