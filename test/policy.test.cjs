const assert = require('node:assert/strict');
const test = require('node:test');
const { page, download, validImage } = require('../src/policy.cjs');
test('only deployed provision pages can call the bridge', () => {
  for (const route of [
    '/tryruyi/imager',
    '/de/tryruyi/device/',
    '/en/tryruyi/imager',
  ])
    assert.ok(page('https://ruyisdk.org' + route));
  for (const url of [
    'https://ruyisdk.org/',
    'http://ruyisdk.org/tryruyi/device',
    'https://ruyisdk.org.example/tryruyi/imager',
    'file:///tryruyi/imager',
  ])
    assert.equal(page(url), false);
  assert.ok(download('https://mirror.iscas.ac.cn/image'));
  assert.ok(download('https://github.com/vendor/images/releases/download/v1/board.img'));
  assert.ok(download('http://new-mirror.example:8080/image'));
  assert.equal(download('file:///image'), false);
  assert.equal(download('blob:https://mirror.iscas.ac.cn/image'), false);
  assert.equal(download('https://user@mirror.iscas.ac.cn/image'), false);
});
test('accepts only a workspace-relative extracted image', () => {
  const image = {
    directory: 'work',
    parts: ['RuyiImages', 'package', '1', 'images', 'sd.img'],
    size: 512,
    sha256: 'a'.repeat(64),
  };
  assert.ok(validImage(image));
  for (const part of ['..', '/dev/sda', 'C:\\', 'bad\0path'])
    assert.equal(
      validImage({ ...image, parts: [...image.parts, part] }),
      false,
    );
});
