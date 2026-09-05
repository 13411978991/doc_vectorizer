import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
process.env.LC_ALL = "C";
process.env.LANG = "C";
const pgInstance = new EmbeddedPostgres({
  databaseDir: "./data/pg-test",
  user: "sag_test",
  password: "sag_test",
  port: 54329,
  persistent: true,
  initdbFlags: ["--no-locale", "--encoding=UTF8"],
});
await pgInstance.initialise();
await pgInstance.start();
try { await pgInstance.createDatabase("sag_test"); } catch {}
const c = new pg.Client({host:'127.0.0.1',port:54329,user:'sag_test',password:'sag_test',database:'sag_test'});
await c.connect();
try {
  // array as JS
  let r = await c.query("SELECT $1::jsonb as x", [['a','b','c']]);
  console.log("array as JS:", JSON.stringify(r.rows));
  // string
  r = await c.query("SELECT $1::jsonb as x", ['["a","b","c"]']);
  console.log("string as JS:", JSON.stringify(r.rows));
  // json_each on string
  r = await c.query("SELECT * FROM json_each($1::jsonb)", ['["a","b","c"]']);
  console.log("json_each on string:", JSON.stringify(r.rows));
} catch(e) {
  console.log('ERR:', e.message);
} finally {
  await c.end();
  await pgInstance.stop();
}
process.exit(0);