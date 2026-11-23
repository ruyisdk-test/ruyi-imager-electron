const assert = require('node:assert/strict');
const test = require('node:test');
const { page, download, validImage } = require('../src/policy.cjs');
test('only the packaged imager page can call the bridge', () => {
  assert.ok(page('ruyi-imager://app/index.html'));
  for (const url of [
    'ruyi-imager://app/static/catalog.json',
    'ruyi-imager://other/index.html',
    'https://ruyisdk.org/tryruyi/imager',
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
test('accepts only a blob from the local imager for disk writes', () => {
  const image = {
    url: 'blob:ruyi-imager://app/6c3c55e7-34a1-4de2-9ab3-4ac242af8085',
    size: 512,
    sha256: 'a'.repeat(64),
  };
  assert.ok(validImage(image));
  for (const url of ['/dev/sda', 'file:///image', image.url.replace('//app/', '//remote/'), image.url + '/extra'])
    assert.equal(validImage({ ...image, url }), false);
});
