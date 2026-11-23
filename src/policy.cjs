const site = 'ruyi-imager://app';
function page(url) {
  return url === `${site}/index.html`;
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
    typeof image.url === 'string' &&
    /^blob:ruyi-imager:\/\/app\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(image.url)
  );
}
module.exports = { site, page, download, validImage };
