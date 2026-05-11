const Database = require("/usr/local/lib/node_modules/n8n/node_modules/better-sqlite3");
const db = new Database("/home/node/.n8n/database.sqlite");
const r = db.prepare("DELETE FROM webhook_entity WHERE workflowId IN (?,?)").run("9j55DZtDoR0PfClq", "xykCCdQ3TyZCC3IS");
console.log("Deleted stale webhook rows:", r.changes);
db.close();
