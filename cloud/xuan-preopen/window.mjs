// Pre-identity gate: no credentials, network or financial data.
import fs from 'node:fs';
import {planPreopen} from './calendar.mjs';
const plan = planPreopen();
const enabled = plan.status === 'generate' && plan.windowEnabled;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
process.stdout.write(JSON.stringify({enabled, dataDate: plan.dataDate, slotId: plan.slotId,
  reason: enabled ? 'regular-preopen-window' : 'outside-window-or-closed'})+'\n');
