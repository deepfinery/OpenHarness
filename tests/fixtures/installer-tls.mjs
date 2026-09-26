import tls from 'node:tls';
import net from 'node:net';
import { readFileSync } from 'node:fs';
// A certificate-verified TLS tunnel to the isolated gateway, for exercising the installer's wss:// path.
tls
  .createServer(
    { key: readFileSync('/test-tls/key.pem'), cert: readFileSync('/test-tls/cert.pem') },
    (socket) => {
      const upstream = net.connect(8090, 'gateway');
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    },
  )
  .listen(9443, '0.0.0.0');
