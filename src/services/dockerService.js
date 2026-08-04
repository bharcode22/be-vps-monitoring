const { exec } = require('child_process');
const { Client } = require('ssh2');

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
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
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
 * List all Docker containers on the server (docker ps -a)
 */
async function listDockerContainers(server) {
  const cmd = `docker ps -a --format '${DOCKER_FORMAT}'`;
  try {
    const stdout = await executeCommand(server, cmd);
    const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');
    const containers = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        containers.push(parsed);
      } catch (e) {
        // Skip unparseable lines
      }
    }

    return containers;
  } catch (err) {
    throw new Error(`Gagal mengeksekusi docker ps: ${err.message}`);
  }
}

/**
 * Restart a Docker container by name or ID
 */
async function restartDockerContainer(server, containerName) {
  // Sanitize containerName to prevent command injection
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

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

  const cmd = `docker stop ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, container: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghentikan (stop) container ${safeName}: ${err.message}`);
  }
}

/**
 * Fetch last 100 lines of Docker container logs
 */
async function getDockerContainerLogs(server, containerName) {
  const safeName = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama container tidak valid.');

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
