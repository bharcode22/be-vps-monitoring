const { exec } = require('child_process');
const { Client } = require('ssh2');
const { decrypt } = require('../utils/crypto');

const DOCKER_FORMAT = '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}';

/**
 * Execute command on local host or remote SSH server
 */
function executeCommand(server, command) {
  return new Promise((resolve, reject) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout);
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          reject(new Error('Koneksi SSH ke server waktu habis (timeout 15 detik)'));
        }
      }, 15000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'root',
        readyTimeout: 10000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = decrypt(server.private_key);
      } else {
        sshConfig.password = decrypt(server.password);
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code, signal) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              if (code !== 0 && stderr.trim()) {
                return reject(new Error(stderr.trim()));
              }
              resolve(stdout);
            }
          }).on('data', (data) => {
            stdout += data.toString();
          }).stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      });

      conn.on('error', (err) => {
        if (!isHandled) {
          isHandled = true;
          clearTimeout(timeout);
          reject(new Error(`Gagal menghubungkan SSH: ${err.message}`));
        }
      });

      conn.connect(sshConfig);
    }
  });
}

/**
 * List all Docker containers on the server (docker ps -a) plus GUI apps (big-screen & small-screen)
 */
async function listDockerContainers(server) {
  const cmd = `docker ps -a --format '${DOCKER_FORMAT}' 2>/dev/null || echo ""; echo "---SYSTEM_APPS---"; ps aux | grep -v grep | grep -E "(usr/lib/big-screen|big-screen)" >/dev/null 2>&1 && echo "big-screen:running" || echo "big-screen:exited"; ps aux | grep -v grep | grep -E "(usr/lib/small-screen|small-screen)" >/dev/null 2>&1 && echo "small-screen:running" || echo "small-screen:exited";`;
  try {
    const stdout = await executeCommand(server, cmd);
    const parts = stdout.split('---SYSTEM_APPS---');
    const dockerOutput = parts[0] || '';
    const systemAppsOutput = parts[1] || '';

    const lines = dockerOutput.trim().split('\n').filter(line => line.trim() !== '');
    const containers = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        containers.push(parsed);
      } catch (e) {
        // Skip unparseable lines
      }
    }

    // Parse system GUI apps (big-screen & small-screen)
    if (systemAppsOutput) {
      if (systemAppsOutput.includes('big-screen:running')) {
        containers.push({
          id: 'sys-big-screen',
          name: 'big-screen',
          image: 'Native GUI App (/usr/lib/big-screen)',
          status: 'Up (running)',
          state: 'running',
          ports: 'System App',
          isSystemApp: true
        });
      } else if (systemAppsOutput.includes('big-screen:exited')) {
        containers.push({
          id: 'sys-big-screen',
          name: 'big-screen',
          image: 'Native GUI App (/usr/lib/big-screen)',
          status: 'Exited (0)',
          state: 'exited',
          ports: 'System App',
          isSystemApp: true
        });
      }

      if (systemAppsOutput.includes('small-screen:running')) {
        containers.push({
          id: 'sys-small-screen',
          name: 'small-screen',
          image: 'Native GUI App (/usr/lib/small-screen)',
          status: 'Up (running)',
          state: 'running',
          ports: 'System App',
          isSystemApp: true
        });
      } else if (systemAppsOutput.includes('small-screen:exited')) {
        containers.push({
          id: 'sys-small-screen',
          name: 'small-screen',
          image: 'Native GUI App (/usr/lib/small-screen)',
          status: 'Exited (0)',
          state: 'exited',
          ports: 'System App',
          isSystemApp: true
        });
      }
    }

    return containers;
  } catch (err) {
    throw new Error(`Gagal mengeksekusi pemeriksaan container & app: ${err.message}`);
  }
}

/**
 * Restart a Docker container or System GUI App by name
 */
async function restartDockerContainer(server, containerName) {
  // Sanitize containerName to prevent command injection
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  if (safeName === 'big-screen' || safeName === 'small-screen') {
    const cmd = `systemctl restart ${safeName} 2>/dev/null || systemctl --user restart ${safeName} 2>/dev/null || (pkill -9 -f "${safeName}" 2>/dev/null; sleep 1; DISPLAY=:0 nohup /usr/lib/${safeName}/${safeName} >/dev/null 2>&1 &); sleep 1; ps aux | grep -v grep | grep -E "${safeName}"`;
    try {
      const stdout = await executeCommand(server, cmd);
      return { success: true, container: safeName, output: stdout.trim() || `Aplikasi ${safeName} dimuat ulang.` };
    } catch (e) {
      return { success: true, container: safeName, output: `Sinyal restart dikirim ke ${safeName}.` };
    }
  }

  const cmd = `docker restart ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal memuat ulang (restart) container ${safeName}: ${err.message}`);
  }
}

/**
 * Stop a Docker container by name or ID
 */
async function stopDockerContainer(server, containerName) {
  // Sanitize containerName to prevent command injection
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  if (safeName === 'big-screen' || safeName === 'small-screen') {
    const cmd = `systemctl stop ${safeName} 2>/dev/null || systemctl --user stop ${safeName} 2>/dev/null || pkill -9 -f "${safeName}" 2>/dev/null || true`;
    try {
      const stdout = await executeCommand(server, cmd);
      return { success: true, container: safeName, output: stdout.trim() || `Aplikasi ${safeName} dihentikan.` };
    } catch (e) {
      return { success: true, container: safeName, output: `Sinyal stop dikirim ke ${safeName}.` };
    }
  }

  const cmd = `docker stop ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghentikan (stop) container ${safeName}: ${err.message}`);
  }
}

/**
 * Fetch last 100 lines of Docker container logs or System GUI App logs
 */
async function getDockerContainerLogs(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  if (safeName === 'big-screen' || safeName === 'small-screen') {
    const cmd = `journalctl -u ${safeName} -n 100 --no-pager 2>/dev/null || journalctl --user -u ${safeName} -n 100 --no-pager 2>/dev/null || tail -n 100 /home/pod/.config/${safeName}/*.log 2>/dev/null || tail -n 100 /home/pod/.config/${safeName}/logs/*.log 2>/dev/null || tail -n 100 /tmp/${safeName}.log 2>/dev/null || (echo "=== INFORMASI PROSES NATIVE SYSTEM LINUX (${safeName}) ===" && ps aux | grep -v grep | grep -E "${safeName}");`;
    try {
      const stdout = await executeCommand(server, cmd);
      return { success: true, container: safeName, logs: stdout.trim() || `Informasi proses ${safeName} aktif.` };
    } catch (err) {
      throw new Error(`Gagal mengambil log aplikasi ${safeName}: ${err.message}`);
    }
  }

  const cmd = `docker logs --tail 100 ${safeName} 2>&1`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, container: safeName, logs: stdout };
  } catch (err) {
    throw new Error(`Gagal mengambil log container ${safeName}: ${err.message}`);
  }
}

/**
 * Remove a Docker container (docker rm -f)
 */
async function removeDockerContainer(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

  const cmd = `docker rm -f ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghapus (docker rm) container ${safeName}: ${err.message}`);
  }
}

module.exports = {
  listDockerContainers,
  restartDockerContainer,
  stopDockerContainer,
  removeDockerContainer,
  getDockerContainerLogs
};
