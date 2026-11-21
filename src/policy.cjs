const site = 'https://ruyisdk.org';
function page(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === site &&
      !parsed.username &&
      !parsed.password &&
      /^\/(?:(?:de|en|zh-Hans)\/)?tryruyi\/(?:imager|device)\/?$/.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}
function download(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
function validImage(image) {
  return (
    image &&
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    /^[a-f0-9]{64}$/.test(image.sha256) &&
    typeof image.directory === 'string' &&
    Array.isArray(image.parts) &&
    image.parts.length >= 5 &&
    image.parts.length <= 64 &&
    image.parts[0] === 'RuyiImages' &&
    image.parts[3] === 'images' &&
    image.parts.every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        part.length <= 255 &&
        part !== '.' &&
        part !== '..' &&
        !/[\\/:\x00-\x1f]/.test(part),
    )
  );
}
module.exports = { site, page, download, validImage };
