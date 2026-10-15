// SDK update check: version range and compare rules (shared/sdkversion.ts). Pure.
//   npm run test:sdkversion        (= npx tsx tests/sdkversion.ts)

import { classify, cmpVer, dayKey, inRange, nightDue, parseVer } from '../shared/sdkversion.ts';

let fail = 0;
const check = (what: string, cond: boolean) => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check('parse X.Y.Z', same(parseVer('0.3.296'), [0, 3, 296]));
check('parse rejects pre-release and junk', parseVer('1.0.0-beta.1') === null && parseVer('1.2') === null && parseVer(undefined) === null && parseVer('') === null);
check('compare numeric, not text', cmpVer([0, 3, 1000], [0, 3, 296]) > 0 && cmpVer([0, 3, 9], [0, 3, 10]) < 0 && cmpVer([1, 0, 0], [0, 9, 9]) > 0);

check('caret 0.x: same minor only', inRange('^0.3.296', '0.3.300') && inRange('^0.3.296', '0.3.296') && !inRange('^0.3.296', '0.4.0') && !inRange('^0.3.296', '1.0.0'));
check('caret 0.x: not below the base', !inRange('^0.3.296', '0.3.295'));
check('caret 1.x: same major', inRange('^1.2.3', '1.9.0') && !inRange('^1.2.3', '2.0.0') && !inRange('^1.2.3', '1.2.2'));
check('caret 0.0.x: exact', inRange('^0.0.3', '0.0.3') && !inRange('^0.0.3', '0.0.4'));
check('tilde and exact', inRange('~1.2.3', '1.2.9') && !inRange('~1.2.3', '1.3.0') && inRange('1.2.3', '1.2.3') && !inRange('1.2.3', '1.2.4'));
check('other range forms: no', !inRange('>=1.0.0', '1.2.0') && !inRange('*', '1.2.0') && !inRange('^1.2.3 || ^2', '1.2.4'));

check('newer in range is pending', same(classify('^0.3.296', '0.3.296', '0.3.301'), { pending: '0.3.301', bigger: null }));
check('newer minor is bigger, not pending', same(classify('^0.3.296', '0.3.296', '0.4.0'), { pending: null, bigger: '0.4.0' }));
check('same or older: nothing', same(classify('^0.3.296', '0.3.296', '0.3.296'), { pending: null, bigger: null }) && same(classify('^0.3.296', '0.3.300', '0.3.296'), { pending: null, bigger: null }));
check('junk latest: nothing', same(classify('^0.3.296', '0.3.296', '0.3.301-rc.1'), { pending: null, bigger: null }));

const at = (h: number, day = 14) => new Date(2026, 9, day, h, 5);
check('night run: 4 AM hour, once a day', nightDue(at(4), '') && !nightDue(at(3), '') && !nightDue(at(5), '') && !nightDue(at(4), dayKey(at(4))) && nightDue(at(4, 15), dayKey(at(4, 14))));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
