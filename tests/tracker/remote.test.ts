import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghRepo, sshHostname } from '../../src/tracker/remote.ts';
import { ExecRecorder } from '../helpers/exec-recorder.ts';

const hosts = (map: Record<string, string>) => {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    return map[host];
  };
  return { asked, resolve };
};

test('ghRepo reads an https origin as it is, asking ssh nothing', async () => {
  const h = hosts({});
  assert.equal(await ghRepo('https://github.com/Acme/App.git', h.resolve), 'github.com/acme/app');
  assert.deepEqual(h.asked, []);
});

test('ghRepo names the host an ssh alias connects to', async () => {
  const h = hosts({ 'gh-work': 'github.com', 'ghe-alias': 'GHE.Example.com' });
  assert.equal(await ghRepo('git@gh-work:Acme/App.git', h.resolve), 'github.com/acme/app');
  assert.equal(await ghRepo('ssh://git@ghe-alias:2222/acme/app', h.resolve), 'ghe.example.com/acme/app');
  assert.deepEqual(h.asked, ['gh-work', 'ghe-alias']);
});

test('ghRepo keeps the host when ssh cannot tell, and never asks about one starting with "-"', async () => {
  assert.equal(await ghRepo('git@gh-work:acme/app', hosts({}).resolve), 'gh-work/acme/app');
  assert.equal(
    await ghRepo('git@gh-work:acme/app', async () => {
      throw new Error('ssh not found on PATH');
    }),
    'gh-work/acme/app',
  );
  const h = hosts({ '-oProxyCommand=x': 'github.com' });
  assert.equal(await ghRepo('ssh://-oProxyCommand=x/acme/app', h.resolve), '-oproxycommand=x/acme/app');
  assert.deepEqual(h.asked, []);
});

test('sshHostname asks ssh -G for the hostname and gives undefined when ssh fails', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a.at(-1) === 'gh-work', { stdout: 'user git\nhostname github.com\nport 22\n' });
  rec.respond((a) => a.at(-1) === 'broken', { code: 255, stderr: 'bad config' });
  const resolve = sshHostname(rec.exec);
  assert.equal(await resolve('gh-work'), 'github.com');
  assert.deepEqual(rec.calls[0], { file: 'ssh', args: ['-G', '--', 'gh-work'] });
  assert.equal(await resolve('broken'), undefined);
});
