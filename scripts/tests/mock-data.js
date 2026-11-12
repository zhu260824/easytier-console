/* 测试用假数据 —— 全部为占位符，不是任何真实环境
 *
 * IP 使用 RFC 5737 文档示例网段（192.0.2.0/24、198.51.100.0/24），
 * 主机名使用 node-a..node-f。请勿在提交前填回真实主机名或内网 IP。
 */

window.__TAURI_INTERNALS__ = undefined;
const REAL = {
  running: true,
  node: { hostname:'node-a', ipv4_addr:'192.0.2.11/24', peer_id:'1000000001',
    version:'2.7.0-8b7f1f01', nat_udp_label:'对称型', nat_tcp_label:'对称型',
    listeners:['tcp://0.0.0.0:11010','udp://0.0.0.0:11010'],
    proxy_cidrs:['192.168.31.0/24','192.16.110.0/23'],
    stun_info:{ public_ip:['198.51.100.20'], min_port:11010, max_port:11010 } },
  peers: [
    {hostname:'node-a',ipv4:'192.0.2.11',cidr:'192.0.2.11/24',cost:'Local',kind:'local',lat_ms:'-',loss_rate:'-',tunnel_proto:'-',nat_type:'Symmetric',nat_label:'对称型',version:'2.7.0-8b7f1f01',rx_bytes:'-',tx_bytes:'-',id:'1000000001'},
    {hostname:'node-b',ipv4:'192.0.2.12',cidr:'192.0.2.12/24',cost:'p2p',kind:'p2p',lat_ms:'1.05',loss_rate:'0.0%',tunnel_proto:'tcp',nat_type:'Symmetric',nat_label:'对称型',version:'2.7.0-8b7f1f01',rx_bytes:'8.65 MB',tx_bytes:'241.02 MB',id:'1000000002'},
    {hostname:'node-c',ipv4:'192.0.2.15',cidr:'192.0.2.15/24',cost:'p2p',kind:'p2p',lat_ms:'2.03',loss_rate:'0.0%',tunnel_proto:'tcp',nat_type:'Symmetric',nat_label:'对称型',version:'2.7.0-8b7f1f01',rx_bytes:'459.58 kB',tx_bytes:'610.52 kB',id:'1000000003'},
    {hostname:'node-e',ipv4:'',cidr:'',cost:'p2p',kind:'p2p',lat_ms:'12.72',loss_rate:'0.0%',tunnel_proto:'tcp',nat_type:'PortRestricted',nat_label:'端口限制锥形',version:'2.7.0-8b7f1f01',rx_bytes:'314.35 kB',tx_bytes:'374.99 kB',id:'1000000004'},
    {hostname:'node-d',ipv4:'192.0.2.31',cidr:'192.0.2.31/24',cost:'p2p',kind:'p2p',lat_ms:'24.98',loss_rate:'6.2%',tunnel_proto:'udp',nat_type:'PortRestricted',nat_label:'端口限制锥形',version:'2.6.4-abc12345',rx_bytes:'354.20 kB',tx_bytes:'480.65 kB',id:'1000000005'},
    {hostname:'node-f',ipv4:'',cidr:'',cost:'relay(2)',kind:'relay',lat_ms:'10.00',loss_rate:'0.0%',tunnel_proto:'udp',nat_type:'PortRestricted',nat_label:'端口限制锥形',version:'2.7.0-8b7f1f01',rx_bytes:'0 B',tx_bytes:'0 B',id:'1000000006'}
  ],
  proxies: [],
  routes: [
    {hostname:'node-a',ipv4:'192.0.2.11/24',next_hop_hostname:'Local',path_len:0,path_latency:0,proxy_cidrs:'192.168.31.0/24, 192.16.110.0/23'},
    {hostname:'node-b',ipv4:'192.0.2.12/24',next_hop_hostname:'DIRECT',path_len:1,path_latency:1.05,proxy_cidrs:''},
    {hostname:'node-d',ipv4:'192.0.2.31/24',next_hop_hostname:'node-b',path_len:2,path_latency:24.98,proxy_cidrs:''}
  ],
  forwards: [], port_forwards: []
};
const CFG_TEXT = `instance_name = "default"
hostname = "node-a"
ipv4 = "192.0.2.11"
dhcp = false

listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]

[network_identity]
network_name = "your-network"
network_secret = "your-secret"

[[peer]]
uri = "tcp://1.2.3.4:11010"

[[proxy_network]]
cidr = "192.168.31.0/24"

[[port_forward]]
bind_addr = "0.0.0.0:13389"
dst_addr = "127.0.0.1:3389"

[flags]
enable_encryption = true
enable_ipv6 = true
mtu = 1380
latency_first = false`;

const origFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/status')) return json({ ok:true, data:REAL });
  if (u.includes('/api/meta')) return json({ ok:true, data:{ config_path:'D:/easytier-console/config/config.toml', autostart:true, elevated:true, refresh_interval_ms:2000 } });
  if (u.includes('/api/config_text')) return json({ ok:true, data:CFG_TEXT });
  if (u.includes('/api/settings')) return json({ ok:true, data:{ stop_core_on_exit:false, confirm_on_exit:true, cleanup_orphan:true, minimize_to_tray:true, autostart:true, autostart_core:false, start_minimized:true } });
  if (u.includes('/api/orphan_check')) return json({ ok:true, data:{ total_cores:0, orphans:[] } });
  if (u.includes('/api/log')) return json({ ok:true, data:'2026-11-12 14:02:12 INFO tun device ready dev="et_6_8f80"\n2026-11-12 14:02:13 INFO new peer added id=1000000002\n2026-11-12 14:03:02 WARN peer node-d latency high 24.98ms\n2026-11-12 14:04:44 INFO handshake ok with id=1000000002' });
  if (u.includes('/api/latency_history')) {
    const pts=[]; let v=5;
    for(let i=0;i<360;i++){ v=Math.max(0.6,4.5+Math.sin(i/360*Math.PI*4)*2.5+(Math.random()-0.45)*2); pts.push({ts: Math.floor(Date.now()/1000)-(360-i)*240, lat:v, loss:0}); }
    return json({ ok:true, data:pts });
  }
  return json({ ok:true, data:{} });
};
function json(o){ return { ok:true, json: async()=>o }; }
