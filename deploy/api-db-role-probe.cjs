// HAP-1562 done-when 3: READ-ONLY probe of the role the API's PostgreSQL connection runs as.
// Run inside the api-server container so it uses the API's own POSTGRES_* settings (never prints them):
//   docker compose ... exec -T api-server node - < deploy/api-db-role-probe.cjs
// One SELECT in a READ ONLY transaction, rolled back. Prints current_user and rolsuper; exits 0 only for
// rolsuper=false, 2 for a superuser connection, 1 when the probe itself fails.
const { Client } = require('pg');

const env = process.env;
const client = new Client({
  host: env.POSTGRES_HOST, port: Number(env.POSTGRES_PORT), database: env.POSTGRES_DB,
  user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, application_name: 'hap1562-role-probe',
  statement_timeout: 5000, connectionTimeoutMillis: 5000,
});

(async () => {
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      'SELECT current_user::text AS current_user, rolsuper FROM pg_roles WHERE rolname = current_user');
    await client.query('ROLLBACK');
    const [row] = rows;
    console.log(`current_user=${row.current_user} rolsuper=${row.rolsuper}`);
    process.exitCode = row.rolsuper === false ? 0 : 2;
  } finally {
    await client.end();
  }
})().catch(error => {
  // SQLSTATE/errno only: a connection error message can carry connection details.
  console.error(`probe failed: ${error.code ?? 'unknown error'}`);
  process.exitCode = 1;
});
