'use strict';

const { createServer } = require('./app');

const port = Number(process.env.PORT || 4000);

createServer().then(({ server, db }) => {
  server.listen(port, () => {
    console.log(`MDC Plan Room API listening on http://localhost:${port} (storage: ${db.dialect})`);
    console.log(`Pipeline dashboard:            http://localhost:${port}/dashboard`);
  });
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
