import { cityMatchesWatch } from '../lib/cities.js';

const cases = [
  ['minsk', { city: 'gomel', venue: 'Гомельский городской молодёжный театр', title: '451 градус', url: 'https://24afisha.by/ru/gomel/event/451-gradus' }, false, 'gomel event vs minsk watch'],
  ['gomel', { city: 'gomel' }, true, 'same city slug'],
  ['Минск', { city: 'minsk' }, true, 'label vs slug'],
  ['minsk', { city: null, url: 'https://24afisha.by/ru/gomel/event/x' }, false, 'city from url'],
  ['minsk', { city: null, venue: 'Гомельский городской молодёжный театр' }, false, 'city from venue text'],
  ['minsk', { city: null, venue: 'Белорусский государственный молодёжный театр' }, false, 'venue text names another city'],
  ['minsk', { city: null }, true, 'no info at all → allow'],
  ['all', { city: 'gomel' }, true, 'all cities'],
  [null, { city: 'gomel' }, true, 'no watch city'],
  ['brest', { city: 'Гомель' }, false, 'label event city mismatched'],
  ['gomel', { city: 'Гомель' }, true, 'label event city same'],
  ['minsk', { city: null, venue: 'Минский областной театр кукол', url: 'https://24afisha.by/ru/molodechno/event/x' }, false, 'url wins over venue text'],
];

let failed = 0;
for (const [wc, ev, exp, label] of cases) {
  const got = cityMatchesWatch(wc, ev);
  if (got !== exp) { failed += 1; console.log('FAIL', label, '→', got, 'expected', exp); }
  else console.log('ok  ', label);
}
console.log(failed ? `${failed} failed` : 'all passed');
