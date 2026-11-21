const assert = require('node:assert/strict');
const test = require('node:test');
const { DiskChoices } = require('../src/disk-choice.cjs');

test('disk choices are opaque, single-use and invalidated on refresh', () => {
  let sequence = 0;
  const choices = new DiskChoices(() => `choice-${++sequence}`);
  const first = choices.replace([{ id: 'writer-id', label: 'SD reader' }]);
  assert.deepEqual(first, [{ id: 'choice-1', label: 'SD reader' }]);
  assert.equal(choices.take('choice-1').id, 'writer-id');
  assert.equal(choices.take('choice-1'), null);

  const second = choices.replace([{ id: 'writer-id', label: 'SD reader' }]);
  choices.replace([]);
  assert.equal(choices.take(second[0].id), null);
});
