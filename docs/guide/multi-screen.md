# Share together in a browser

[简体中文](./multi-screen.zh-CN.md)

This development version adds a browser room for 2–4 participants. Use the server
built from this checkout; the upstream public demo does not have this extension.
Multi-source server forwarding has passed local four-browser lifecycle checks.
Public deployment and physical multi-device acceptance remain pending. Ubuntu
Docker development packages include a [deployment guide](../../deploy/multi-screen/README.zh-CN.md).

1. Open `/multi` on your Piik site, or select **Share together** in the header.
2. Enter your name and select **Create a shared room**. Copy the invitation for
   your friends, or let them enter the room code.
3. Each participant selects **Share my screen** and chooses their own screen,
   window or browser tab. Capture requires a supported desktop browser and HTTPS
   or localhost. People whose browsers cannot capture can still watch.
4. All participants appear in a responsive grid. Enlarge a card to focus on one
   screen, then select **Show all screens** to return.
5. **Stop my share** stops only your publication. **Leave room** closes your
   connections. Other participants can continue sharing.

Your preview is always muted. Other screens begin muted; use each video’s native
audio controls to listen if the browser captured screen audio. No microphone or
voice meeting is added. After a network disconnect, sharing stops; reconnect and
select Share again.

When the server has SFU enabled, each participant sends one publication to the
server and receives up to three other screens. This also supports sites with
`SFU_ONLY=true`. Without SFU, browsers connect directly and each publisher sends
up to three copies. Server forwarding needs a usable UDP connection to the
server; HTTPS alone does not carry video and there is no TURN/TCP media fallback.
Capture requests 1080p at 60 fps. P2P has an 8 Mbps video ceiling per direct copy.
The highest SFU encoding has an 8 Mbps ceiling; the existing publisher can also
upload a lower encoding with a 2 Mbps ceiling. Its combined configured video
ceiling can therefore reach 10 Mbps, excluding audio and transport overhead.
One upload connection does not imply one encoding. These are target parameters;
the source, device and network can reduce delivered resolution or cadence.
Real-device and cross-network performance still need checking.

[Run from source](../README.md#run-from-source) explains local startup.

## Start a Windows LAN preview

Run from this checkout. Install dependencies once; the launcher builds the Web
and Server, selects an active physical adapter and creates a local TLS certificate.

```powershell
npm ci
./scripts/start-multi-screen-lan.ps1
```

If more than one adapter is available, pass `-Address <LAN IPv4>`. The launcher prints:

- `http://<LAN IPv4>:18787/multi` for viewing.
- `https://<LAN IPv4>:18788/multi` for sharing from other computers.
- `http://<LAN IPv4>:18787/piik-lan.cer` to download the public certificate.

Before sharing on another Windows computer, download `piik-lan.cer`, compare its
SHA-256 with the server terminal, and run in the certificate's directory:

```powershell
certutil -user -addstore Root ./piik-lan.cer
```

Restart the browser, then use the HTTPS address. This trusts the specific Piik LAN
server certificate. Do not bypass browser certificate warnings instead of installing
it. Local checks currently use Chromium; other browsers' certificate trust and
physical capture compatibility need separate verification.

Distribute only the `.cer`. The ignored `build/lan` directory also contains the
private `.pfx` and its password in `config.json`; do not copy those to clients. The
launcher does not install anything in the OS trust store. Reimport the public
certificate when the LAN IP changes or a new certificate is generated.

The gateway binds the selected LAN address, and the firewall rule permits only
the local subnet and specified TCP ports. Keep the terminal running; Ctrl+C stops
the preview and clears temporary rooms. Use `-NoBuild` with an up-to-date build.
Production sites continue to use the existing HTTPS deployment method.

To test server forwarding on the LAN, use an unused UDP port:

```powershell
./scripts/start-multi-screen-lan.ps1 -Address <LAN IPv4> -SfuUdpPort 18882
```

The launcher binds SFU to the selected physical adapter, advertises that LAN IP,
sets `SFU_ONLY=true` and adds a local-subnet UDP firewall rule for the Server
executable. STUN stays disabled for this LAN preview. Omit `-SfuUdpPort` to use
P2P. With SFU enabled, `-SfuPublicIP <reachable IPv4>` overrides its advertised
address; it does not configure the router or widen the local-subnet firewall rule.

## Use your own HTTPS domain

With a trusted domain certificate, terminate TLS in Nginx and forward the original
paths to `http://127.0.0.1:18787`. Restart Piik with the public address so invitations
and allowed browser origins both include it:

```powershell
./scripts/start-multi-screen-lan.ps1 -Address <LAN IPv4> -PublicBaseUrl https://share.example.com:5200 -NoBuild
```

Add this server to Nginx's `http` configuration, replacing the domain and certificate
paths. A separate Nginx instance can use an independent configuration; run
`nginx -t` before activating it to protect existing sites.
Create that instance's `logs` and `temp` directories first. Use `-p` for its
directory prefix and `-c` for its configuration; use
`Start-Process -WindowStyle Hidden` for background startup on Windows.

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

Open `https://share.example.com:5200/multi`. A trusted domain certificate removes
the need to install the LAN certificate. For public access, forward external TCP
5200 to this computer's TCP 5200. For LAN-only use, internal DNS can resolve the
domain to the computer's LAN IP. Clients must be able to reach that port.
HTTPS carries pages and signaling. With SFU enabled, clients must also reach the
configured SFU UDP port; with P2P, they need a direct browser media path. For a
public SFU behind a router, forward that UDP port and advertise the reachable
public IPv4 with `-SfuPublicIP`. Permit those clients in the server firewall too;
the LAN launcher's UDP rule allows only the local subnet. A reachable HTTPS domain
does not establish media reachability. See the [official Nginx WebSocket documentation](https://nginx.org/en/docs/http/websocket.html).
