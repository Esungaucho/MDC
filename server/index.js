'use strict';

const { createServer } = require('./app');

const port = Number(process.env.PORT || 4000);
const { server } = createServer();

server.listen(port, () => {
  console.log(`MDC Plan Room API listening on http://localhost:${port}`);
  console.log(`Pipeline dashboard:            http://localhost:${port}/dashboard`);
});
