import { migrate, pool } from './db';

migrate()
  .then(() => { console.log('schema up to date'); return pool.end(); })
  .catch((e) => { console.error(e); process.exit(1); });
