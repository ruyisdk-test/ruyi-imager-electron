import hashlib
import io
import json
import re
import tarfile
import tempfile
import tomllib
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GITHUB = 'https://api.github.com/repos/ruyisdk-test/ruyi-image-mirror'
GITEE = 'https://gitee.com/ruyisdk/packages-index'
GITEE_API = 'https://gitee.com/api/v5/repos/ruyisdk/packages-index'
STATIC = Path(__file__).resolve().parents[1] / 'renderer' / 'static'


def fetch(url, accept='application/json'):
    with urlopen(Request(url, headers={'Accept': accept}), timeout=15) as response:
        return response.read()


def find_release(today, local_date=None):
    for days_ago in range(31):
        date = today - timedelta(days=days_ago)
        if local_date and date <= local_date:
            return None
        tag = date.strftime('%Y%m%d')
        missing = False
        for mirror in (GITHUB, GITEE_API):
            try:
                release = json.loads(fetch(f'{mirror}/releases/tags/{tag}'))
            except HTTPError as error:
                error.close()
                if error.code == 404:
                    missing = True
                else:
                    print(f'{mirror}: {error}', flush=True)
                continue
            except (URLError, TimeoutError) as error:
                print(f'{mirror}: {error}', flush=True)
                continue
            if release['tag_name'] != tag:
                raise ValueError(f'Expected release {tag} from {mirror}')
            return release
        if not missing:
            if local_date:
                print(f'Mirrors unavailable for {tag}; keeping local catalog', flush=True)
                return None
            raise RuntimeError(f'Could not query either release mirror for {tag}')
    if local_date:
        return None
    raise RuntimeError(f'No dated packages-index release from {today - timedelta(days=30)} through {today}')


def build_release(release, output):
    tag = release['tag_name']
    asset = next((item for item in release['assets'] if item['name'] == 'images.tar.zstd'), {})
    digest = asset.get('digest')
    urls = [asset.get('url') or asset.get('browser_download_url'),
            f'{GITEE}/releases/download/{tag}/images.tar.zstd',
            f'{GITHUB}/tarball/refs/tags/{tag}', f'{GITEE}/repository/archive/{tag}.tar.gz']
    for url in dict.fromkeys(filter(None, urls)):
        try:
            content = fetch(url, 'application/octet-stream')
        except (URLError, TimeoutError) as error:
            print(f'{url}: {error}', flush=True)
            continue
        source_archive = '/tarball/' in url or url.endswith('.tar.gz')
        if not source_archive and digest and digest != 'sha256:' + hashlib.sha256(content).hexdigest():
            raise ValueError(f'Checksum mismatch: {url}')
        try:
            snapshot = tarfile.open(fileobj=io.BytesIO(content))
        except tarfile.ReadError as error:
            print(f'{url}: {error}', flush=True)
            continue
        with snapshot as archive:
            members = {}
            for member in archive:
                parts = PurePosixPath(member.name).parts[int(source_archive):]
                if parts and all(re.fullmatch(r'[\w.@()+-]+', part) and part != '..' for part in parts):
                    members['/'.join(parts)] = member
            if {'config.toml', 'messages.toml', 'plugins/ruyi-device-provision-strategy-std/mod.star'} <= members.keys():
                build(archive, members, tag, output)
                return
    raise RuntimeError(f'No complete packages-index archive available for release {tag}')


def version_key(package):
    numeric, _, prerelease = package['version'].split('+')[0].partition('-')
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part) for part in prerelease.split('.'))
    return tuple(map(int, numeric.split('.'))), not prerelease, identifiers


def build(archive, members, tag, output):
    def read(name):
        return archive.extractfile(members[name]).read()

    mirrors = {row['id']: row['urls'] for row in tomllib.loads(read('config.toml').decode())['mirrors']}
    entities = {kind: {} for kind in ('device', 'device-variant', 'image-combo')}
    packages = {}
    modules = {}
    for name, member in members.items():
        parts = name.split('/')
        if parts[0] == 'plugins' and len(parts) >= 2:
            if member.issym() and len(parts) == 2:
                target = member.linkname
                if '/' in target or f'plugins/{target}/mod.star' not in members:
                    raise ValueError(f'Invalid plugin alias: {name}')
                modules[parts[1]] = f'{target}/mod.star'
            if member.isfile() and (name.endswith('.star') or 'data' in parts[2:]):
                dest = output.joinpath(*parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(read(name))
                if parts[2:] == ['mod.star']:
                    modules[parts[1]] = f'{parts[1]}/mod.star'
        elif parts[0] == 'entities' and len(parts) == 3 and parts[1] in entities and name.endswith('.toml'):
            data = tomllib.loads(read(name).decode())
            kind = parts[1]
            entities[kind][parts[-1][:-5]] = {**data[kind], 'related': data.get('related', [])}
        elif parts[0] == 'packages' and len(parts) == 4 and name.endswith('.toml'):
            data = tomllib.loads(read(name).decode())
            if 'provisionable' not in data:
                continue
            for spec in data['distfiles']:
                urls = []
                for url in spec['urls']:
                    if url.startswith('mirror://'):
                        mirror, _, path = url[9:].partition('/')
                        urls.extend(f'{base.rstrip("/")}/{path}' for base in mirrors[mirror])
                    else:
                        urls.append(url)
                spec['resolved_urls'] = list(dict.fromkeys(urls))
            packages.setdefault('/'.join(parts[1:3]), []).append({
                'package': parts[2], 'version': parts[-1][:-5],
                'data': {key: data[key] for key in ('blob', 'distfiles', 'provisionable')},
            })
    for versions in packages.values():
        versions.sort(key=version_key, reverse=True)
    catalog = dict(release=tag, entities=entities, packages=packages, modules=modules,
                   messages=read('messages.toml').decode())
    (output / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')
    (output / 'LICENSE-Apache.txt').write_bytes(read('LICENSE-Apache.txt'))


def main():
    today = datetime.now(UTC).date()
    try:
        catalog = json.loads((STATIC / 'catalog.json').read_text(encoding='utf-8'))
        local_date = datetime.strptime(catalog['release'], '%Y%m%d').date()
        if local_date > today or not all((STATIC / 'plugins' / path).is_file() for path in catalog['modules'].values()):
            local_date = None
    except (FileNotFoundError, KeyError, ValueError):
        local_date = None
    release = find_release(today, local_date)
    if release is None:
        print(f'Using local packages-index release {local_date:%Y%m%d}')
        return
    tag = release['tag_name']
    print(f'Building packages-index release {tag}', flush=True)
    with tempfile.TemporaryDirectory(dir=STATIC.parent) as temp:
        staged = Path(temp) / 'index'
        staged.mkdir()
        build_release(release, staged)
        previous = Path(temp) / 'previous'
        if STATIC.exists():
            STATIC.rename(previous)
        try:
            staged.rename(STATIC)
        except OSError:
            if previous.exists():
                previous.rename(STATIC)
            raise


if __name__ == '__main__':
    main()
