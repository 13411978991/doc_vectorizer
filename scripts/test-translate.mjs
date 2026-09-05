import { translateSqlFull } from "E:\\sag\\export\\dist\\src\\db\\sqlite-driver.js";
const sql = `
  select id, json_extract(metadata, '$.formerSourceId') as former
  from watched_folders
  where id in (
    select value from json_each($1)
  )
    and tenant_id = $2
    and source_id = $3
`;
const r = translateSqlFull(sql);
console.log("SQL:", r.sql);
console.log("paramOrder:", r.paramOrder);