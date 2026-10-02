import test from 'node:test';
import assert from 'node:assert/strict';
import {preopenActionSlot,preopenWindow,scheduledWatchEnabled,PREOPEN_ACTION_WATCH_CRONS,slotStartEpoch,slotDueEpoch} from './xuan-ib-report-schedule.mjs';
test('European core regular open drives summer/winter independently of US DST', () => {
  for (const [date,hour] of [['2026-10-23',6],['2026-10-26',7],['2026-11-02',7],
    ['2027-03-12',7],['2027-03-15',7],['2027-03-26',7],['2027-03-29',6]]) {
    const slot=preopenActionSlot(date), start=Date.parse(`${date}T0${hour}:00:00Z`)/1000;
    assert.equal(slot.startEpoch,start); assert.equal(slot.dueEpoch,start+1800); assert.equal(slot.openEpoch,start+3600);
    assert.equal(slotStartEpoch(date,'pm'),start); assert.equal(slotDueEpoch(date,'pm'),start+1800);
    assert.deepEqual(PREOPEN_ACTION_WATCH_CRONS.map(c=>scheduledWatchEnabled(c,new Date(start*1000+1800000))),[hour===6,hour===7]);
  }
  assert.equal(slotStartEpoch('2026-10-02','pm'),Date.parse('2026-10-02T05:00:00Z')/1000);
});
test('pre-start, inactive winter candidate, open and weekend are outside window', () => {
  for (const time of ['2026-10-05T05:59:59Z','2026-10-05T07:00:00Z','2026-10-26T06:10:00Z','2026-10-03T06:00:00Z'])
    assert.equal(preopenWindow(new Date(time)).enabled,false,time);
  for (const time of ['2026-10-05T06:00:00Z','2026-10-05T06:59:59Z','2026-10-26T07:10:00Z'])
    assert.equal(preopenWindow(new Date(time)).enabled,true,time);
});
