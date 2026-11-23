import test from 'node:test';
import assert from 'node:assert/strict';
import {formatShortDate,formatFullDate} from '../src/date-display.ts';
test('absent, corrupt and out-of-range date values never reach native formatting',()=>{
  for(const value of [null,undefined,'',' ','zz-invalid-date','2026-99-99',NaN,Infinity,8.64e15+1,new Date(NaN),{},[],true]){assert.equal(formatShortDate(value),'未知时间');assert.equal(formatFullDate(value),'未知时间');}
});
test('valid timestamp and calendar display match native formatting including epoch zero',()=>{
  for(const value of [0,1710000000000,'2024-02-29T00:00:00Z','2026-09-28T23:59:59+08:00',new Date('2026-01-01T00:00:00Z')]){
    const date=new Date(value);assert.equal(formatFullDate(value),date.toLocaleString('zh-CN'));
    for(const timeZone of ['Asia/Hong_Kong','America/New_York','UTC'])assert.equal(formatShortDate(value,timeZone),new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone}).format(date));
  }
});
