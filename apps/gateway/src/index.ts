import { createGateway } from './server';
const gateway = createGateway();
gateway.server.listen(gateway.config.port, gateway.config.host, () => {
  console.log(
    `Read-only market-data gateway listening on ${gateway.config.host}:${gateway.config.port}`,
  );
  console.log('Feed: Alpaca IEX. Credentials remain on this server.');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
