const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
require('dotenv').config();
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// ==================== 1. 环境变量与参数配置 ====================
const PORT = process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || '.npm';
// 强制使用指定的 UUID 或从环境变量读取
const UUID = process.env.UUID || '6e8d0787-a32b-4836-8561-ede8dee8d441';
const REALITY_PORT = 8080; // 固定为 8080 端口
const SERVER_NAME = "www.iij.ad.jp"; // Reality 伪装域名

// 严格的环境变量验证
if (!UUID) {
  console.error("【错误】环境变量验证失败：缺少 UUID！");
  process.exit(1);
}

console.log("【检查】环境变量验证通过：");
console.log(`- 运行目录: ${FILE_PATH}`);
console.log(`- 节点 UUID: ${UUID}`);
console.log(`- Reality 监听端口: ${REALITY_PORT}`);

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
}

// 随机生成核心文件名防扫描
function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
const webRandomName = generateRandomName();

// ==================== 2. 下载 sing-box 核心 ====================
function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(FILE_PATH, fileName);
    const writer = fs.createWriteStream(filePath);

    axios({ method: 'get', url: fileUrl, responseType: 'stream' })
      .then(response => {
        response.data.pipe(writer);
        writer.on('finish', () => { writer.close(); resolve(fileName); });
        writer.on('error', err => { fs.unlink(filePath, () => {}); reject(err.message); });
      })
      .catch(err => reject(err.message));
  });
}

// ==================== 3. 初始化并运行服务端 ====================
async function initializeAndRun() {
  const arch = getSystemArchitecture();
  const fileUrl = arch === 'arm' ? "https://arm64.ssss.nyc.mn/sb" : "https://amd64.ssss.nyc.mn/sb";
  const corePath = path.join(FILE_PATH, webRandomName);

  try {
    console.log(`【下载】正在下载 sing-box (${arch})...`);
    await downloadFile(webRandomName, fileUrl);
    fs.chmodSync(corePath, 0o775);

    // 生成或读取 Reality 密钥对
    const keyFilePath = path.join(FILE_PATH, 'key.txt');
    let privateKey = '', publicKey = '';
    
    if (fs.existsSync(keyFilePath)) {
      const content = fs.readFileSync(keyFilePath, 'utf8');
      privateKey = (content.match(/PrivateKey:\s*(.*)/) || [])[1] || '';
      publicKey = (content.match(/PublicKey:\s*(.*)/) || [])[1] || '';
    }
    
    if (!privateKey || !publicKey) {
      console.log(`【安全】正在生成 Reality 密钥对...`);
      const { stdout } = await exec(`${corePath} generate reality-keypair`);
      privateKey = (stdout.match(/PrivateKey:\s*(.*)/) || [])[1] || '';
      publicKey = (stdout.match(/PublicKey:\s*(.*)/) || [])[1] || '';
      fs.writeFileSync(keyFilePath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, 'utf8');
    }

    // 写入服务端 sing-box 配置文件
    const config = {
      log: { disabled: true, level: "error" },
      inbounds: [
        {
          tag: "vless-reality-in",
          type: "vless",
          listen: "::",
          listen_port: REALITY_PORT,
          users: [{ uuid: UUID, flow: "xtls-rprx-vision" }],
          tls: {
            enabled: true,
            server_name: SERVER_NAME,
            reality: {
              enabled: true,
              handshake: { server: SERVER_NAME, server_port: 443 },
              private_key: privateKey,
              short_id: [""]
            }
          }
        }
      ],
      outbounds: [{ type: "direct", tag: "direct" }]
    };

    const configPath = path.join(FILE_PATH, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // 在后台运行 sing-box 服务
    await exec(`nohup ${corePath} run -c ${configPath} >/dev/null 2>&1 &`);
    console.log(`【成功】VLESS-Reality 代理已在端口 ${REALITY_PORT} 成功运行！`);

  } catch (err) {
    console.error(`【错误】初始化失败:`, err);
  }
}

// ==================== 4. Web 服务与浏览器下载客户端配置 ====================
app.get('/', (req, res) => {
  res.send(`
    <h2>Proxy 服务运行正常</h2>
    <p>节点类型：VLESS-Reality-TLS (端口: ${REALITY_PORT})</p>
    <p>UUID：${UUID}</p>
    <hr>
    <a href="/download-config" style="font-size: 18px; color: blue;">点击此处下载 sing-box 客户端配置文件 (config.json)</a>
  `);
});

app.get('/download-config', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  const cleanHost = host.split(':')[0];

  // 生成可以直接导入客户端的完整 sing-box 客户端配置
  const clientConfig = {
    log: { disabled: false, level: "info" },
    inbounds: [{ type: "tun", tag: "tun-in", inet4_address: "172.19.0.1/30", auto_route: true }],
    outbounds: [
      {
        tag: "vless-reality-out",
        type: "vless",
        server: cleanHost,
        server_port: REALITY_PORT,
        uuid: UUID,
        flow: "xtls-rprx-vision",
        tls: {
          enabled: true,
          server_name: SERVER_NAME,
          utls: { enabled: true, fingerprint: "chrome" },
          reality: { enabled: true, public_key: getPublicKey() }
        }
      },
      { type: "direct", tag: "direct" }
    ]
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=sing-box-reality-config.json');
  res.send(JSON.stringify(clientConfig, null, 2));
});

function getPublicKey() {
  try {
    const content = fs.readFileSync(path.join(FILE_PATH, 'key.txt'), 'utf8');
    return (content.match(/PublicKey:\s*(.*)/) || [])[1] || '';
  } catch {
    return '';
  }
}

app.listen(PORT, () => {
  console.log(`【Web】主服务已启动，监听端口: ${PORT}`);
  initializeAndRun();
});
