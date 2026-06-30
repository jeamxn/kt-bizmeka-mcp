import { writeFileSync } from "node:fs";
import { BizmekaClient } from "../src/client.ts";
const c = new BizmekaClient("kidtimes0927", "uC_NMuux8w@!nXq");
await c.submitCredentials();
await c.loadSecondStep();
await c.sendSms();
writeFileSync("/tmp/biz-pw-state.json", JSON.stringify(c.dumpState()));
console.log("OK: SMS sent.");
